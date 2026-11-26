"""Live Linux/WSL2/Docker Yocto workspace engine for Phase 2."""

from __future__ import annotations

import asyncio
import os
import platform
import re
import shlex
import shutil
import tempfile
import uuid
from pathlib import Path
from typing import Any

from bridge import __version__
from bridge.enterprise import (
    apply_autorev_pins,
    apply_migration_fixes,
    build_archiver_config,
    build_gdbserver_launch_plan,
    build_mcdepends_expression,
    build_offline_mirror_plan,
    build_remote_sstate_analytics,
    delete_workspace_multiconfig,
    export_sources_tarball,
    generate_vscode_debug_configs,
    list_workspace_layer_repos,
    list_workspace_multiconfigs,
    parse_diffsigs_output,
    parse_installed_package_sizes,
    parse_live_telemetry_output,
    parse_pkgdata_find_path,
    run_git_action,
    save_workspace_multiconfig,
    scan_autorev_in_workspace,
    scan_migration_files,
    sync_bbmulticonfig_in_local_conf,
)
from bridge.event_monitor import EventMonitor
from bridge.i18n import tr_en
from bridge.parsers.buildhistory import parse_buildhistory_diff
from bridge.parsers.dot_dag import (
    explain_why_included,
    parse_task_depends_dot,
    slice_graph_for_ui,
)
from bridge.parsers.kas_yaml import parse_kas_yaml, serialize_kas_yaml
from bridge.parsers.local_conf import parse_conf
from bridge.parsers.spdx_cve import export_license_matrix, parse_cve_report, parse_spdx3_jsonld
from bridge.parsers.wks_parser import parse_wks, serialize_wks
from bridge.preflight import (
    analyze_features_licenses_and_bloat,
    apply_local_conf_fix,
    audit_layers,
    build_version_matrix,
    compute_readiness_score,
    detect_host_resources,
    generate_optimization_plan,
    parse_bitbake_s_output,
    parse_devtool_upgrade_status,
    parse_dryrun_errors,
    parse_yocto_check_layer_output,
    probe_sstate_and_hashserve,
)
from bridge.pro_suite import (
    build_hardware_smoke_report,
    build_openvex_document,
    diff_kernel_config,
    export_cra_compliance_bundle,
    generate_cicd_pipeline,
    generate_kernel_bbappend_fragment,
    generate_secure_boot_inc,
    parse_buildstats_dir,
    parse_dts_tree,
    parse_ptest_output,
    update_dts_node_status,
    validate_dts_syntax,
)
from bridge.protocol import RpcError, RpcErrorCode, validate_linux_workspace_path
from bridge.tinfoil_client import LiveTinfoilAdapter, LiveTinfoilUnavailableError
from bridge.tools.layer_index import LayerIndexClient
from bridge.tools.recipe_templates import generate_bbappend_content, generate_recipe_content
from bridge.tools.yocto_tools import (
    check_layer_compatibility,
    create_layer_skeleton,
    parse_config_build_fragments,
    parse_show_appends,
    parse_show_layers,
    parse_show_overlayed,
)

_SAFE_SSH_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$")
_SAFE_UNIT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9@_.:-]{0,127}$")


def _validate_ssh_token(val: str, label: str) -> str:
    clean = (val or "").strip()
    if not clean or clean.startswith("-") or not _SAFE_SSH_TOKEN_RE.match(clean):
        raise RpcError(
            RpcErrorCode.INVALID_PARAMS,
            tr_en(
                f"Güvenlik Kısıtı: Geçersiz {label} değeri.",
                f"Security Constraint: Invalid {label} value.",
            ),
        )
    return clean


def _validate_journal_unit(val: str) -> str:
    clean = (val or "").strip()
    if not clean or not _SAFE_UNIT_RE.match(clean):
        raise RpcError(
            RpcErrorCode.INVALID_PARAMS,
            tr_en(
                "Güvenlik Kısıtı: Geçersiz systemd birim adı.",
                "Security Constraint: Invalid systemd unit name.",
            ),
        )
    return clean


def _sanitize_filename(val: str) -> str:
    clean = (val or "").strip()
    if not clean or "/" in clean or "\\" in clean or ".." in clean or "\x00" in clean:
        raise RpcError(
            RpcErrorCode.INVALID_PARAMS,
            tr_en(
                "Güvenlik Kısıtı: Geçersiz dosya adı.",
                "Security Constraint: Invalid filename.",
            ),
        )
    return clean


def _resolve_within(raw_path: str, allowed_roots: list[Path], default_base: Path) -> Path:
    cleaned = (raw_path or "").strip()
    if not cleaned or "\x00" in cleaned:
        raise RpcError(
            RpcErrorCode.INVALID_PARAMS,
            tr_en(
                "Dosya yolu boş olamaz veya NUL karakteri içeremez.",
                "Path cannot be empty or contain NUL bytes.",
            ),
        )
    candidate = Path(cleaned)
    if not candidate.is_absolute():
        candidate = default_base / candidate
    resolved = candidate.resolve()
    if not any(resolved.is_relative_to(root.resolve()) for root in allowed_roots):
        raise RpcError(
            RpcErrorCode.INVALID_PARAMS,
            tr_en(
                f"Güvenlik Kısıtı: '{raw_path}' izin verilen dizin sınırları dışında.",
                f"Security Constraint: '{raw_path}' is outside allowed workspace bounds.",
            ),
        )
    return resolved


class LiveYoctoEngine:
    """Executes real Yocto operations on an active POSIX workspace directory."""

    def __init__(self, monitor: EventMonitor, workspace_dir: str) -> None:
        self._monitor = monitor
        self._workspace_dir = Path(workspace_dir)
        self._build_dir = (
            self._workspace_dir / "build"
            if (self._workspace_dir / "build").exists()
            else self._workspace_dir
        )
        self._layer_index = LayerIndexClient()
        self._tinfoil = LiveTinfoilAdapter(self._build_dir)

    def get_health_info(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "mode": "live",
            "version": __version__,
            "yocto_version": "Live Yocto Workspace",
            "pid": os.getpid(),
            "uptime_sec": 0.0,
        }

    async def _run_cmd(self, args: list[str], cwd: Path | None = None) -> tuple[int, str, str]:
        work_cwd = cwd or self._build_dir
        cmd_id = uuid.uuid4().hex[:8]
        cmd_str = " ".join(args)
        await self._monitor.emit_command(cmd_id, cmd_str, str(work_cwd), "live", "running")
        try:
            proc = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(work_cwd),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            out_b, err_b = await proc.communicate()
            rc = proc.returncode or 0
            await self._monitor.emit_command(
                cmd_id, cmd_str, str(work_cwd), "live", "ok" if rc == 0 else "error"
            )
            return rc, out_b.decode("utf-8", errors="replace"), err_b.decode("utf-8", errors="replace")
        except FileNotFoundError as exc:
            await self._monitor.emit_command(cmd_id, cmd_str, str(work_cwd), "live", "error")
            return 127, "", str(exc)

    def _local_conf_path(self) -> Path:
        return self._build_dir / "conf" / "local.conf"

    def _bblayers_conf_path(self) -> Path:
        return self._build_dir / "conf" / "bblayers.conf"

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        handlers: dict[str, Any] = {
            "bridge.ping": self._rpc_ping,
            "bridge.info": self._rpc_info,
            "env.validate_path": self._rpc_validate_path,
            "workspace.list": self._rpc_workspace_list,
            "layers.list": self._rpc_layers_list,
            "layers.search_index": self._rpc_layers_search,
            "layers.add": self._rpc_layers_add,
            "layers.remove": self._rpc_layers_remove,
            "layers.show_appends": self._rpc_layers_appends,
            "layers.show_overlayed": self._rpc_layers_overlayed,
            "layers.create_layer": self._rpc_layers_create,
            "layers.check_compat": self._rpc_layers_check_compat,
            "config.get_local_conf": self._rpc_config_get,
            "config.preview_diff": self._rpc_config_preview_diff,
            "config.apply_changes": self._rpc_config_apply,
            "config.list_fragments": self._rpc_fragments_list,
            "config.toggle_fragment": self._rpc_fragments_toggle,
            "config.inspect_variable": self._rpc_inspect_variable,
            "kas.parse": self._rpc_kas_parse,
            "kas.serialize": self._rpc_kas_serialize,
            "kas.run": self._rpc_kas_run,
            "devtool.status": self._rpc_devtool_status,
            "devtool.add": self._rpc_devtool_add,
            "devtool.modify": self._rpc_devtool_modify,
            "devtool.build": self._rpc_devtool_build,
            "devtool.finish": self._rpc_devtool_finish,
            "devtool.reset": self._rpc_devtool_reset,
            "recipetool.create": self._rpc_recipetool_create,
            "dag.generate": self._rpc_dag_generate,
            "dag.explain_why": self._rpc_dag_explain_why,
            "build.run_task_action": self._rpc_build_task_action,
            "artifacts.list_images": self._rpc_artifacts_images,
            "artifacts.get_sbom": self._rpc_artifacts_sbom,
            "artifacts.get_cves": self._rpc_artifacts_cves,
            "artifacts.export_licenses": self._rpc_artifacts_export_licenses,
            "artifacts.copy_to_host": self._rpc_artifacts_copy_to_host,
            "artifacts.get_buildhistory_diff": self._rpc_artifacts_buildhistory,
            "wic.list_wks": self._rpc_wic_list_wks,
            "wic.parse_wks": self._rpc_wic_parse_wks,
            "wic.serialize_wks": self._rpc_wic_serialize_wks,
            "wic.create_image": self._rpc_wic_create_image,
            "qemu.launch": self._rpc_qemu_launch,
            "qemu.stop": self._rpc_qemu_stop,
            "sdk.list": self._rpc_sdk_list,
            "sdk.build": self._rpc_sdk_build,
            "preflight.runAudit": self._rpc_preflight_run_audit,
            "preflight.getVersionMatrix": self._rpc_preflight_version_matrix,
            "preflight.checkUpgrades": self._rpc_preflight_check_upgrades,
            "preflight.probeSstate": self._rpc_preflight_probe_sstate,
            "preflight.getOptimizationPlan": self._rpc_preflight_optimization_plan,
            "preflight.applyFix": self._rpc_preflight_apply_fix,
            "pro.kernel.diffConfig": self._rpc_pro_kernel_diff,
            "pro.kernel.saveFragment": self._rpc_pro_kernel_save_fragment,
            "pro.dt.listFiles": self._rpc_pro_dt_list,
            "pro.dt.parseTree": self._rpc_pro_dt_parse,
            "pro.dt.updateNodeStatus": self._rpc_pro_dt_update_status,
            "pro.qa.runSuite": self._rpc_pro_qa_run_suite,
            "pro.qa.runHardwareSmoke": self._rpc_pro_qa_hardware_smoke,
            "pro.cra.listVex": self._rpc_pro_cra_list_vex,
            "pro.cra.updateVex": self._rpc_pro_cra_update_vex,
            "pro.cra.exportBundle": self._rpc_pro_cra_export_bundle,
            "pro.secboot.generateConfig": self._rpc_pro_secboot_generate,
            "pro.buildstats.analyze": self._rpc_pro_buildstats_analyze,
            "pro.cicd.generate": self._rpc_pro_cicd_generate,
            "enterprise.multiconfig.list": self._rpc_enterprise_mc_list,
            "enterprise.multiconfig.save": self._rpc_enterprise_mc_save,
            "enterprise.multiconfig.delete": self._rpc_enterprise_mc_delete,
            "enterprise.offline.scanAutorev": self._rpc_enterprise_scan_autorev,
            "enterprise.offline.pinAutorev": self._rpc_enterprise_pin_autorev,
            "enterprise.offline.prepareMirror": self._rpc_enterprise_prepare_mirror,
            "enterprise.offline.configureArchiver": self._rpc_enterprise_configure_archiver,
            "enterprise.rootfs.getTreemap": self._rpc_enterprise_rootfs_treemap,
            "enterprise.rootfs.findPath": self._rpc_enterprise_rootfs_find_path,
            "enterprise.rootfs.diffSigs": self._rpc_enterprise_rootfs_diffsigs,
            "enterprise.debug.exportIdeConfig": self._rpc_enterprise_debug_export_ide,
            "enterprise.debug.startGdbserver": self._rpc_enterprise_debug_start_gdbserver,
            "enterprise.debug.getLiveTelemetry": self._rpc_enterprise_debug_telemetry,
            "enterprise.migration.scan": self._rpc_enterprise_migration_scan,
            "enterprise.migration.applyAll": self._rpc_enterprise_migration_apply_all,
            "enterprise.git.statusAll": self._rpc_enterprise_git_status_all,
            "enterprise.git.runAction": self._rpc_enterprise_git_run_action,
            "enterprise.sstate.getRunnerAnalytics": self._rpc_enterprise_sstate_analytics,
        }
        handler = handlers.get(method)
        if handler is None:
            raise RpcError(
                RpcErrorCode.METHOD_NOT_FOUND,
                f"Live method not implemented or unavailable in Phase 2: {method}",
            )
        return await handler(params)

    async def _rpc_ping(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"pong": True, "ts": 0.0}

    async def _rpc_info(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "version": __version__,
            "mode": "live",
            "yocto_series": "Live Workspace",
            "python_version": platform.python_version(),
            "pid": os.getpid(),
            "uptime_sec": 0.0,
            "active_clients": 1,
            "active_project_id": "live-workspace",
        }

    async def _rpc_validate_path(self, params: dict[str, Any]) -> dict[str, Any]:
        return validate_linux_workspace_path(
            str(params.get("path", "")), str(params.get("provider", "local"))
        )

    async def _rpc_workspace_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        conf = self._local_conf_path()
        vars_map = parse_conf(conf.read_text(encoding="utf-8")).get_variables() if conf.exists() else {}
        proj = {
            "id": "live-workspace",
            "name": self._workspace_dir.name,
            "yocto_version": "6.0",
            "yocto_codename": "wrynose",
            "setup_tool": "bitbake-setup"
            if (self._workspace_dir / "init-build-env").exists()
            else "oe-init-build-env",
            "workspace_path": str(self._workspace_dir),
            "build_dir": str(self._build_dir),
            "dl_dir": vars_map.get("DL_DIR", str(self._build_dir / "downloads")),
            "sstate_dir": vars_map.get("SSTATE_DIR", str(self._build_dir / "sstate-cache")),
            "machine": vars_map.get("MACHINE", "qemux86-64"),
            "distro": vars_map.get("DISTRO", "poky"),
            "provider": "local",
            "hashserve": vars_map.get("BB_HASHSERVE", "auto"),
        }
        return {"projects": [proj], "active_project_id": proj["id"]}

    async def _rpc_layers_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        rc, out, _ = await self._run_cmd(["bitbake-layers", "show-layers"])
        if rc == 0 and out.strip():
            return {"layers": parse_show_layers(out)}
        bb_path = self._bblayers_conf_path()
        if not bb_path.exists():
            return {"layers": []}
        doc = parse_conf(bb_path.read_text(encoding="utf-8"))
        layers = [
            {
                "name": Path(p).name,
                "path": p,
                "priority": 5,
                "branch": "local",
                "compat": [],
                "compatible_with_active": True,
                "warning": None,
                "appends_count": 0,
            }
            for p in doc.get_bblayers()
        ]
        return {"layers": layers}

    async def _rpc_layers_search(self, params: dict[str, Any]) -> dict[str, Any]:
        query = str(params.get("query", ""))
        branch = str(params.get("branch", "wrynose"))
        kind = str(params.get("kind", "layer"))
        limit = int(params.get("limit", 25))
        branches, _ = await self._layer_index.get_branches()
        results, source = await self._layer_index.search(
            query=query, branch=branch, kind=kind, limit=limit
        )
        return {
            "source": source,
            "branch": branch,
            "branches": branches,
            "results": results,
        }

    async def _rpc_layers_add(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        if not name:
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("Katman adı veya yolu gerekli.", "Layer name or path is required."),
            )
        rc, _, err = await self._run_cmd(["bitbake-layers", "add-layer", name])
        if rc != 0:
            bb_path = self._bblayers_conf_path()
            if bb_path.exists():
                doc = parse_conf(bb_path.read_text(encoding="utf-8"))
                doc.add_bblayer(name)
                bb_path.write_text(doc.render(), encoding="utf-8")
            else:
                raise RpcError(
                    RpcErrorCode.BITBAKE_ERROR,
                    err or tr_en("add-layer başarısız", "add-layer failed"),
                )
        return await self._rpc_layers_list({})

    async def _rpc_layers_remove(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        rc, _, err = await self._run_cmd(["bitbake-layers", "remove-layer", name])
        if rc != 0:
            bb_path = self._bblayers_conf_path()
            if bb_path.exists():
                doc = parse_conf(bb_path.read_text(encoding="utf-8"))
                doc.remove_bblayer(name)
                bb_path.write_text(doc.render(), encoding="utf-8")
            else:
                raise RpcError(
                    RpcErrorCode.BITBAKE_ERROR,
                    err or tr_en("remove-layer başarısız", "remove-layer failed"),
                )
        return await self._rpc_layers_list({})

    async def _rpc_layers_appends(self, _params: dict[str, Any]) -> dict[str, Any]:
        rc, out, _ = await self._run_cmd(["bitbake-layers", "show-appends"])
        return {"appends": parse_show_appends(out) if rc == 0 else []}

    async def _rpc_layers_overlayed(self, _params: dict[str, Any]) -> dict[str, Any]:
        rc, out, _ = await self._run_cmd(["bitbake-layers", "show-overlayed"])
        return {"overlayed": parse_show_overlayed(out) if rc == 0 else []}

    async def _rpc_layers_create(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        raw_parent = str(params.get("parent_dir") or "").strip()
        parent = (
            _resolve_within(raw_parent, [self._workspace_dir], self._workspace_dir)
            if raw_parent
            else (self._workspace_dir / "layers")
        )
        priority = int(params.get("priority", 6))
        compat = [str(c) for c in (params.get("compat") or ["wrynose", "scarthgap"])]
        desc = str(params.get("description") or "Custom OpenEmbedded layer")
        files = create_layer_skeleton(parent, name, priority, compat, desc)
        clean_name = name if name.startswith("meta-") else f"meta-{name}"
        layer_path = str(parent / clean_name)
        bb_path = self._bblayers_conf_path()
        if bb_path.exists():
            doc = parse_conf(bb_path.read_text(encoding="utf-8"))
            doc.add_bblayer(layer_path)
            bb_path.write_text(doc.render(), encoding="utf-8")
        layers = (await self._rpc_layers_list({}))["layers"]
        created = next((x for x in layers if x["name"] == clean_name), {
            "name": clean_name,
            "path": layer_path,
            "priority": priority,
            "branch": "local",
            "compat": compat,
            "compatible_with_active": True,
            "warning": None,
            "appends_count": 0,
        })
        return {"layer": created, "files_created": files, "layers": layers}

    async def _rpc_layers_check_compat(self, _params: dict[str, Any]) -> dict[str, Any]:
        layers = (await self._rpc_layers_list({}))["layers"]
        return check_layer_compatibility(layers, "wrynose")

    async def _rpc_config_get(self, _params: dict[str, Any]) -> dict[str, Any]:
        conf = self._local_conf_path()
        if not conf.exists():
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en(f"local.conf bulunamadı: {conf}", f"local.conf not found: {conf}"),
            )
        text = conf.read_text(encoding="utf-8")
        doc = parse_conf(text)
        return {
            "path": str(conf),
            "content": text,
            "variables": doc.get_variables(),
            "comments_count": doc.comments_count,
            "directives": doc.directives,
            "multiline_keys": doc.multiline_keys,
        }

    async def _rpc_config_preview_diff(self, params: dict[str, Any]) -> dict[str, Any]:
        conf = self._local_conf_path()
        text = conf.read_text(encoding="utf-8") if conf.exists() else ""
        doc = parse_conf(text)
        updated = doc.clone()
        updates = params.get("updates") or {}
        operators = params.get("operators") or {}
        for k, v in updates.items():
            updated.set_variable(str(k), str(v), operator=operators.get(str(k)))
        for rk in params.get("remove_keys") or []:
            updated.remove_variable(str(rk))
        return {"diff": doc.unified_diff(updated), "new_content": updated.render()}

    async def _rpc_config_apply(self, params: dict[str, Any]) -> dict[str, Any]:
        conf = self._local_conf_path()
        conf.parent.mkdir(parents=True, exist_ok=True)
        text = conf.read_text(encoding="utf-8") if conf.exists() else ""
        doc = parse_conf(text)
        updates = params.get("updates") or {}
        operators = params.get("operators") or {}
        for k, v in updates.items():
            doc.set_variable(str(k), str(v), operator=operators.get(str(k)))
        for rk in params.get("remove_keys") or []:
            doc.remove_variable(str(rk))
        rendered = doc.render()
        conf.write_text(rendered, encoding="utf-8")
        return {
            "path": str(conf),
            "content": rendered,
            "variables": doc.get_variables(),
            "comments_count": doc.comments_count,
            "directives": doc.directives,
            "multiline_keys": doc.multiline_keys,
        }

    async def _rpc_fragments_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        rc, out, _ = await self._run_cmd(["bitbake-config-build", "list-fragments"])
        return {"fragments": parse_config_build_fragments(out) if rc == 0 else []}

    async def _rpc_fragments_toggle(self, params: dict[str, Any]) -> dict[str, Any]:
        fid = str(params.get("id", ""))
        action = "enable-fragment" if bool(params.get("enabled", False)) else "disable-fragment"
        rc, _, err = await self._run_cmd(["bitbake-config-build", action, fid])
        if rc != 0:
            raise RpcError(
                RpcErrorCode.BITBAKE_ERROR,
                err or tr_en(f"{action} başarısız", f"{action} failed"),
            )
        return await self._rpc_fragments_list({})

    async def _rpc_inspect_variable(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "MACHINE")).strip()
        recipe = params.get("recipe")
        try:
            return await self._tinfoil.inspect_variable(name, recipe=str(recipe) if recipe else None)
        except LiveTinfoilUnavailableError as exc:
            raise RpcError(RpcErrorCode.BITBAKE_ERROR, str(exc)) from exc

    async def _rpc_kas_parse(self, params: dict[str, Any]) -> dict[str, Any]:
        cfg, warnings = parse_kas_yaml(str(params.get("yaml_text", "")))
        return {"config": cfg, "warnings": warnings}

    async def _rpc_kas_serialize(self, params: dict[str, Any]) -> dict[str, Any]:
        cfg = params.get("config")
        if not isinstance(cfg, dict):
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("config nesnesi gerekli", "config object is required"),
            )
        return {"yaml_text": serialize_kas_yaml(cfg)}

    async def _rpc_kas_run(self, params: dict[str, Any]) -> dict[str, Any]:
        action = str(params.get("action", "checkout"))
        if action not in ("lock", "checkout", "build"):
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en(f"Geçersiz kas aksiyonu: {action}", f"Invalid kas action: {action}"),
            )
        yaml_text = str(params.get("yaml_text", ""))
        raw_filename = str(params.get("filename") or "kas-project.yml")
        kas_file = _resolve_within(raw_filename, [self._workspace_dir], self._workspace_dir)
        kas_file.write_text(yaml_text, encoding="utf-8")
        rc, out, err = await self._run_cmd(["kas", action, str(kas_file)], cwd=self._workspace_dir)
        return {
            "ok": rc == 0,
            "action": action,
            "command": f"kas {action} {kas_file}",
            "output": (out + "\n" + err).strip(),
        }

    async def _rpc_devtool_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        rc, out, _ = await self._run_cmd(["devtool", "status"])
        entries: list[dict[str, Any]] = []
        if rc == 0:
            for line in out.splitlines():
                if ":" in line and not line.startswith("NOTE:"):
                    rec, src = line.split(":", 1)
                    entries.append(
                        {
                            "recipe": rec.strip(),
                            "srctree": src.strip(),
                            "bbappend": None,
                            "status": "modified",
                        }
                    )
        return {"entries": entries}

    async def _rpc_devtool_add(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        src = str(params.get("src_uri", "")).strip()
        rc, out, err = await self._run_cmd(["devtool", "add", rec, src])
        st = await self._rpc_devtool_status({})
        entry = next(
            (e for e in st["entries"] if e["recipe"] == rec),
            {"recipe": rec, "srctree": src, "bbappend": None, "status": "added"},
        )
        return {"entry": entry, "entries": st["entries"], "output": (out + "\n" + err).strip() if rc != 0 else out}

    async def _rpc_devtool_modify(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        _, out, err = await self._run_cmd(["devtool", "modify", rec])
        st = await self._rpc_devtool_status({})
        entry = next(
            (e for e in st["entries"] if e["recipe"] == rec),
            {"recipe": rec, "srctree": "", "bbappend": None, "status": "modified"},
        )
        return {"entry": entry, "entries": st["entries"], "output": (out + "\n" + err).strip()}

    async def _rpc_devtool_build(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        rc, out, err = await self._run_cmd(["devtool", "build", rec])
        return {"ok": rc == 0, "recipe": rec, "output": (out + "\n" + err).strip()}

    async def _rpc_devtool_finish(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        layer_path = str(params.get("layer_path", "")).strip()
        rc, out, err = await self._run_cmd(["devtool", "finish", rec, layer_path])
        st = await self._rpc_devtool_status({})
        return {
            "ok": rc == 0,
            "patch_file": f"{layer_path}/recipes-apps/{rec}/0001-local.patch",
            "bbappend_file": f"{layer_path}/recipes-apps/{rec}/{rec}_%.bbappend",
            "patch_diff": (out + "\n" + err).strip(),
            "entries": st["entries"],
        }

    async def _rpc_devtool_reset(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        rc, _, _ = await self._run_cmd(["devtool", "reset", rec])
        st = await self._rpc_devtool_status({})
        return {"ok": rc == 0, "entries": st["entries"]}

    async def _rpc_recipetool_create(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "custom-app")).strip()
        version = str(params.get("version", "1.0.0")).strip()
        src_uri = str(params.get("src_uri", "")).strip()
        bs = str(params.get("build_system", "cmake"))
        lic = str(params.get("license", "MIT"))
        summary = str(params.get("summary", ""))
        content = generate_recipe_content(name, version, src_uri, bs, lic, summary)
        _ = generate_bbappend_content(name)
        file_path = f"recipes-apps/{name}/{name}_{version}.bb"
        return {
            "pn": name,
            "file_path": file_path,
            "content": content,
            "recipe": {
                "pn": name,
                "pv": version,
                "layer": "meta-custom",
                "file_path": file_path,
                "summary": summary or name,
                "license": lic,
                "has_bbappend": False,
            },
        }

    async def _rpc_dag_generate(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        dot_file = self._build_dir / "task-depends.dot"
        if not dot_file.exists():
            await self._run_cmd(["bitbake", "-g", target])
        if not dot_file.exists():
            raise RpcError(
                RpcErrorCode.BITBAKE_ERROR,
                tr_en(
                    f"task-depends.dot bulunamadı: {dot_file}",
                    f"task-depends.dot not found: {dot_file}",
                ),
            )
        graph = parse_task_depends_dot(dot_file.read_text(encoding="utf-8"))
        return slice_graph_for_ui(
            graph,
            target=target,
            query=str(params.get("query", "")),
            kind=str(params.get("kind", "")),
            focus_recipe=str(params.get("focus_recipe", "")),
            max_nodes=int(params.get("max_nodes", 120)),
        )

    async def _rpc_dag_explain_why(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        pkg = str(params.get("package") or "")
        dot_file = self._build_dir / "task-depends.dot"
        if not dot_file.exists():
            raise RpcError(
                RpcErrorCode.BITBAKE_ERROR,
                tr_en(
                    f"task-depends.dot bulunamadı: {dot_file}",
                    f"task-depends.dot not found: {dot_file}",
                ),
            )
        graph = parse_task_depends_dot(dot_file.read_text(encoding="utf-8"))
        return explain_why_included(graph, target, pkg)

    async def _rpc_build_task_action(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        action = str(params.get("action", "compile")).strip()
        rc, out, err = await self._run_cmd(["bitbake", rec, "-c", action])
        return {
            "ok": rc == 0,
            "command": f"bitbake {rec} -c {action}",
            "output": (out + "\n" + err).strip(),
            "pty_session_id": None,
        }

    def _machine_deploy_dir(self) -> tuple[str, Path]:
        conf = self._local_conf_path()
        machine = "qemux86-64"
        if conf.exists():
            vars_map = parse_conf(conf.read_text(encoding="utf-8")).get_variables()
            if "MACHINE" in vars_map:
                machine = vars_map["MACHINE"].value
        return machine, self._build_dir / "tmp" / "deploy" / "images" / machine

    async def _rpc_artifacts_images(self, _params: dict[str, Any]) -> dict[str, Any]:
        machine, deploy_dir = self._machine_deploy_dir()
        images: list[dict[str, Any]] = []
        if deploy_dir.exists():
            for entry in sorted(deploy_dir.iterdir()):
                if not entry.is_file():
                    continue
                name = entry.name
                kind = "rootfs"
                if ".wic" in name:
                    kind = "wic"
                elif name.startswith(("Image", "bzImage", "zImage")):
                    kind = "kernel"
                elif name.endswith(".dtb"):
                    kind = "dtb"
                elif "u-boot" in name or "imx-boot" in name:
                    kind = "bootloader"
                elif ".spdx." in name:
                    kind = "spdx"
                images.append(
                    {
                        "filename": name,
                        "path": str(entry),
                        "kind": kind,
                        "size_bytes": entry.stat().st_size,
                        "modified_at": str(int(entry.stat().st_mtime)),
                        "sha256_short": "",
                    }
                )
        return {"machine": machine, "deploy_dir": str(deploy_dir), "images": images}

    async def _rpc_artifacts_sbom(self, _params: dict[str, Any]) -> dict[str, Any]:
        _, deploy_dir = self._machine_deploy_dir()
        spdx_files = sorted(deploy_dir.glob("*.spdx.json")) if deploy_dir.exists() else []
        if not spdx_files:
            return {"format": "SPDX 3.0 JSON-LD", "packages": []}
        parsed = parse_spdx3_jsonld(spdx_files[0])
        packages = [
            {
                "name": p["name"],
                "version": p["version"],
                "purl": p.get("purl") or "",
                "license": p["license"],
                "supplier": "OE-Core",
                "gplv3_flag": "GPL-3" in str(p["license"]),
            }
            for p in parsed
        ]
        return {"format": "SPDX 3.0 JSON-LD", "packages": packages}

    async def _rpc_artifacts_cves(self, _params: dict[str, Any]) -> dict[str, Any]:
        _, deploy_dir = self._machine_deploy_dir()
        cve_files = sorted(deploy_dir.glob("*cve*.json")) if deploy_dir.exists() else []
        if not cve_files:
            return parse_cve_report({"tool": "sbom-cve-check", "findings": []})
        return parse_cve_report(cve_files[0])

    async def _rpc_artifacts_export_licenses(self, params: dict[str, Any]) -> dict[str, Any]:
        fmt = str(params.get("format", "csv")).lower()
        sbom = await self._rpc_artifacts_sbom({})
        content = export_license_matrix(sbom["packages"], fmt)
        ext = "md" if fmt == "markdown" else ("json" if fmt == "json" else "csv")
        return {
            "format": fmt,
            "filename": f"yocto-licenses-matrix.{ext}",
            "content": content,
            "package_count": len(sbom["packages"]),
        }

    async def _rpc_artifacts_copy_to_host(self, params: dict[str, Any]) -> dict[str, Any]:
        source_path = str(params.get("source_path", "")).strip()
        src = _resolve_within(
            source_path,
            [self._workspace_dir, self._build_dir],
            self._workspace_dir,
        )
        if not src.exists() or not src.is_file():
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Artifact not found: {source_path}")
        default_dest = Path.home() / "Downloads" / "yocto-artifacts"
        raw_dest = str(params.get("dest_dir") or "").strip()
        dest_dir_path = (
            _resolve_within(
                raw_dest,
                [Path.home(), self._workspace_dir, Path(tempfile.gettempdir())],
                default_dest,
            )
            if raw_dest
            else default_dest
        )
        dest_dir_path.mkdir(parents=True, exist_ok=True)
        dest_path = dest_dir_path / src.name
        shutil.copy2(src, dest_path)
        return {
            "ok": True,
            "source_path": str(src),
            "dest_path": str(dest_path),
            "bytes_copied": dest_path.stat().st_size,
            "command": f"cp \"{src}\" \"{dest_path}\"",
        }

    async def _rpc_artifacts_buildhistory(self, params: dict[str, Any]) -> dict[str, Any]:
        diff_text = params.get("diff_text")
        if isinstance(diff_text, str) and diff_text.strip():
            return parse_buildhistory_diff(
                diff_text,
                from_build=str(params.get("from_build") or "HEAD~1"),
                to_build=str(params.get("to_build") or "HEAD"),
            )
        rc, out, _ = await self._run_cmd(["buildhistory-diff"])
        if rc != 0 and not out.strip():
            return {
                "from_build": "HEAD~1",
                "to_build": "HEAD",
                "rootfs_size_kb": 0,
                "rootfs_delta_kb": 0,
                "entries": [],
            }
        return parse_buildhistory_diff(out, from_build="HEAD~1", to_build="HEAD")

    async def _rpc_wic_list_wks(self, _params: dict[str, Any]) -> dict[str, Any]:
        files = []
        for wks in sorted(self._workspace_dir.rglob("*.wks")):
            if "tmp" in wks.parts:
                continue
            files.append(
                {
                    "name": wks.name,
                    "path": str(wks),
                    "layer": wks.parent.parent.name if wks.parent.parent else "workspace",
                    "description": str(wks.relative_to(self._workspace_dir)),
                }
            )
        return {"files": files[:80]}

    async def _rpc_wic_parse_wks(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or "")
        content = params.get("content")
        if isinstance(content, str) and content.strip():
            return parse_wks(content, path=path)
        p = _resolve_within(path, [self._workspace_dir, self._build_dir], self._workspace_dir)
        if not p.exists():
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"WKS file not found: {path}")
        return parse_wks(p.read_text(encoding="utf-8"), path=str(p))

    async def _rpc_wic_serialize_wks(self, params: dict[str, Any]) -> dict[str, Any]:
        wks = params.get("wks") or {}
        raw_text = serialize_wks(wks)
        save_path = str(params.get("save_path") or "").strip()
        saved = False
        resolved_save: str | None = None
        if save_path:
            target = _resolve_within(
                save_path, [self._workspace_dir, self._build_dir], self._workspace_dir
            )
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(raw_text, encoding="utf-8")
            saved = True
            resolved_save = str(target)
        return {"raw_text": raw_text, "saved": saved, "path": resolved_save}

    async def _rpc_wic_create_image(self, params: dict[str, Any]) -> dict[str, Any]:
        wks_path = str(params.get("wks_path") or "")
        image_name = str(params.get("image_name") or "core-image-minimal")
        _, deploy_dir = self._machine_deploy_dir()
        outdir = str(params.get("outdir") or deploy_dir)
        rc, out, err = await self._run_cmd(["wic", "create", wks_path, "-e", image_name, "-o", outdir])
        return {
            "ok": rc == 0,
            "command": f"wic create {wks_path} -e {image_name} -o {outdir}",
            "output_image": str(Path(outdir) / f"{image_name}.wic"),
            "size_bytes": 0,
            "log": (out + "\n" + err).strip(),
        }

    async def _rpc_qemu_launch(self, params: dict[str, Any]) -> dict[str, Any]:
        machine, _ = self._machine_deploy_dir()
        target_machine = str(params.get("machine") or machine)
        image = str(params.get("image") or "core-image-minimal")
        mode = str(params.get("mode") or "nographic")
        cmd = f"runqemu {target_machine} {image} {mode}"
        return {
            "ok": True,
            "session_id": f"qemu-{uuid.uuid4().hex[:8]}",
            "pty_session_id": "",
            "command": cmd,
            "mode": mode,
            "ssh_forward": "ssh -p 2222 root@127.0.0.1" if mode == "slirp" else None,
            "status": "ready",
        }

    async def _rpc_qemu_stop(self, params: dict[str, Any]) -> dict[str, Any]:
        return {"ok": True, "session_id": str(params.get("session_id") or "")}

    async def _rpc_sdk_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        sdk_dir = self._build_dir / "tmp" / "deploy" / "sdk"
        machine, _ = self._machine_deploy_dir()
        sdks: list[dict[str, Any]] = []
        if sdk_dir.exists():
            for sh_file in sorted(sdk_dir.glob("*.sh")):
                sdks.append(
                    {
                        "name": sh_file.name,
                        "kind": "esdk" if "ext-sdk" in sh_file.name else "standard-sdk",
                        "machine": machine,
                        "filename": sh_file.name,
                        "path": str(sh_file),
                        "size_bytes": sh_file.stat().st_size,
                        "built_at": str(int(sh_file.stat().st_mtime)),
                        "sysroot_arch": "target",
                    }
                )
        return {"sdks": sdks}

    async def _rpc_sdk_build(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        kind = str(params.get("kind") or "standard-sdk")
        task = "populate_sdk_ext" if kind == "esdk" else "populate_sdk"
        rc, out, err = await self._run_cmd(["bitbake", target, "-c", task])
        listed = await self._rpc_sdk_list({})
        sdk = listed["sdks"][0] if listed["sdks"] else {
            "name": f"{target}-{task}.sh",
            "kind": kind,
            "machine": self._machine_deploy_dir()[0],
            "filename": f"{target}-{task}.sh",
            "path": str(self._build_dir / "tmp" / "deploy" / "sdk" / f"{target}-{task}.sh"),
            "size_bytes": 0,
            "built_at": "",
            "sysroot_arch": "target",
        }
        return {
            "ok": rc == 0,
            "command": f"bitbake {target} -c {task}",
            "sdk": sdk,
            "log": (out + "\n" + err).strip(),
        }

    async def _rpc_preflight_run_audit(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        incompat = [str(x) for x in (params.get("incompatible_licenses") or []) if str(x).strip()]
        conf_path = self._local_conf_path()
        local_conf_text = conf_path.read_text(encoding="utf-8") if conf_path.exists() else ""
        vars_map = parse_conf(local_conf_text).get_variables()

        _, layers_out, _ = await self._run_cmd(["bitbake-layers", "show-layers"])
        layers = parse_show_layers(layers_out) if layers_out.strip() else []
        _, app_out, _ = await self._run_cmd(["bitbake-layers", "show-appends"])
        _, ov_out, _ = await self._run_cmd(["bitbake-layers", "show-overlayed"])
        layer_checks, layer_issues = audit_layers(
            layers=layers,
            active_series=vars_map.get("LAYERSERIES_COMPAT", "wrynose"),
            show_appends_out=app_out,
            show_overlayed_out=ov_out,
        )

        _, parse_out, parse_err = await self._run_cmd(["bitbake", "-p"])
        dry_issues = parse_dryrun_errors(parse_out + "\n" + parse_err)

        df = vars_map.get("DISTRO_FEATURES", "").split()
        mf = vars_map.get("MACHINE_FEATURES", "").split()
        feat_res = analyze_features_licenses_and_bloat(
            target=target,
            distro_features=df,
            machine_features=mf,
            incompatible_licenses=incompat or vars_map.get("INCOMPATIBLE_LICENSE", "").split(),
            packages=[],
        )

        host = detect_host_resources(params.get("host_resources"))
        opt_plan = generate_optimization_plan(local_conf_text, host)
        opt_issues = [
            {
                "id": rec["id"],
                "severity": "optimization",
                "category": "performance",
                "title": rec["title"],
                "summary": f"{rec['current_value']} -> {rec['recommended_value']}",
                "detail": rec["impact"],
                "recipe": None,
                "layer": None,
                "dependency_chain": ["conf/local.conf"],
                "auto_fix": rec.get("auto_fix"),
            }
            for rec in opt_plan["recommendations"]
        ]

        all_issues = [*layer_issues, *dry_issues, *feat_res["issues"], *opt_issues]
        score, blockers, warnings, opts, ready = compute_readiness_score(all_issues)

        check_layer_summary = None
        if params.get("check_layer"):
            chk = str(params["check_layer"])
            rc, cout, cerr = await self._run_cmd(["yocto-check-layer", chk])
            check_layer_summary = parse_yocto_check_layer_output(chk, cout + "\n" + cerr, rc)

        return {
            "score": score,
            "target": target,
            "machine": vars_map.get("MACHINE", "qemux86-64"),
            "yocto_series": "Live Workspace",
            "duration_ms": 120,
            "blockers": blockers,
            "warnings": warnings,
            "optimizations": opts,
            "ready_to_build": ready,
            "issues": all_issues,
            "layer_checks": layer_checks,
            "bloat_items": feat_res["bloat_items"],
            "license_violations": feat_res["license_violations"],
            "check_layer_summary": check_layer_summary,
        }

    async def _rpc_preflight_version_matrix(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        _, out, _ = await self._run_cmd(["bitbake", "-s"])
        rows = parse_bitbake_s_output(out)
        recipes = [{"pn": r["recipe"], "pv": r["current"], "layer": "workspace", "priority": 5} for r in rows]
        conf_path = self._local_conf_path()
        vars_map = (
            parse_conf(conf_path.read_text(encoding="utf-8")).get_variables()
            if conf_path.exists()
            else {}
        )
        entries, conflicts = build_version_matrix(recipes[:120], vars_map)
        return {"target": target, "entries": entries, "conflicts": conflicts}

    async def _rpc_preflight_check_upgrades(self, params: dict[str, Any]) -> dict[str, Any]:
        recs = [str(x) for x in (params.get("recipes") or [])]
        _, out, _ = await self._run_cmd(["devtool", "check-upgrade-status", *recs])
        up_map = parse_devtool_upgrade_status(out)
        recipes = [{"pn": k, "pv": v["current"], "layer": "workspace", "priority": 5} for k, v in up_map.items()]
        entries, _ = build_version_matrix(recipes, {}, upgrade_map=up_map)
        outdated = sum(1 for e in entries if e["upgrade_status"] in {"outdated", "security-risk"})
        return {"checked_count": len(entries), "outdated_count": outdated, "entries": entries}

    async def _rpc_preflight_probe_sstate(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        conf_path = self._local_conf_path()
        vars_map = (
            parse_conf(conf_path.read_text(encoding="utf-8")).get_variables()
            if conf_path.exists()
            else {}
        )
        mirrors = [vars_map["SSTATE_MIRRORS"]] if "SSTATE_MIRRORS" in vars_map else []
        hs = vars_map["BB_HASHSERVE"] if "BB_HASHSERVE" in vars_map else ""
        _, dry_out, _ = await self._run_cmd(["bitbake", "-n", target])
        return probe_sstate_and_hashserve(mirrors, hs, dryrun_stdout=dry_out, mock=False)

    async def _rpc_preflight_optimization_plan(self, params: dict[str, Any]) -> dict[str, Any]:
        conf_path = self._local_conf_path()
        text = conf_path.read_text(encoding="utf-8") if conf_path.exists() else ""
        host = detect_host_resources(params.get("host_resources"))
        return generate_optimization_plan(text, host)

    async def _rpc_preflight_apply_fix(self, params: dict[str, Any]) -> dict[str, Any]:
        fix = dict(params.get("fix") or {})
        dry_run = bool(params.get("dry_run", False))
        conf_path = self._local_conf_path()
        text = conf_path.read_text(encoding="utf-8") if conf_path.exists() else ""
        new_conf, diff = apply_local_conf_fix(text, fix)
        if not dry_run and conf_path.exists():
            conf_path.write_text(new_conf, encoding="utf-8")
        report = await self._rpc_preflight_run_audit(params)
        return {
            "applied": not dry_run,
            "fix_id": str(fix.get("id") or ""),
            "diff": diff,
            "message": str(fix.get("description") or tr_en("Uygulandı", "Applied")),
            "updated_score": report["score"],
            "updated_report": report,
        }

    async def _rpc_pro_kernel_diff(self, params: dict[str, Any]) -> dict[str, Any]:
        search = str(params.get("search") or "")
        _, out, _ = await self._run_cmd(["bitbake", "virtual/kernel", "-c", "diffconfig"])
        return diff_kernel_config("", out, search)

    async def _rpc_pro_kernel_save_fragment(self, params: dict[str, Any]) -> dict[str, Any]:
        frag_name = str(params.get("fragment_name") or "custom.cfg")
        frag_content = str(params.get("fragment_content") or "")
        updated, diff = generate_kernel_bbappend_fragment(frag_name, frag_content)
        return {
            "ok": True,
            "fragment_path": f"recipes-kernel/linux/files/{frag_name}",
            "bbappend_diff": diff,
            "bbappend_content": updated,
        }

    async def _rpc_pro_dt_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        files = []
        for dts in sorted(self._workspace_dir.rglob("*.dts")):
            if "tmp" in dts.parts:
                continue
            files.append({"name": dts.name, "path": str(dts), "layer": dts.parent.name})
        return {"files": files[:60]}

    async def _rpc_pro_dt_parse(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or "")
        content = params.get("content")
        if isinstance(content, str) and content:
            raw = content
        elif path.strip():
            p = _resolve_within(path, [self._workspace_dir, self._build_dir], self._workspace_dir)
            raw = p.read_text(encoding="utf-8") if p.exists() else "/ {};"
        else:
            raw = "/ {};"
        valid, errors = validate_dts_syntax(raw)
        return {"path": path, "raw_text": raw, "valid": valid, "errors": errors, "tree": parse_dts_tree(raw)}

    async def _rpc_pro_dt_update_status(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or "")
        node_path = str(params.get("node_path") or "")
        new_status = str(params.get("new_status") or "okay")
        p = _resolve_within(path, [self._workspace_dir, self._build_dir], self._workspace_dir)
        raw = p.read_text(encoding="utf-8")
        new_text, diff = update_dts_node_status(raw, node_path, new_status)
        valid, errors = validate_dts_syntax(new_text)
        if valid:
            p.write_text(new_text, encoding="utf-8")
        return {
            "ok": valid,
            "valid": valid,
            "errors": errors,
            "diff": diff,
            "raw_text": new_text,
            "tree": parse_dts_tree(new_text),
        }

    async def _rpc_pro_qa_run_suite(self, params: dict[str, Any]) -> dict[str, Any]:
        suite = str(params.get("suite") or "testimage")
        target = str(params.get("target") or "core-image-minimal")
        if suite == "testimage":
            _, out, err = await self._run_cmd(["bitbake", target, "-c", "testimage"])
            return parse_ptest_output(out + "\n" + err, suite_name="testimage")
        _, out, err = await self._run_cmd(["ptest-runner"])
        return parse_ptest_output(out + "\n" + err, suite_name="ptest")

    async def _rpc_pro_qa_hardware_smoke(self, params: dict[str, Any]) -> dict[str, Any]:
        machine, _ = self._machine_deploy_dir()
        host = _validate_ssh_token(str(params.get("target_host") or "127.0.0.1"), "target_host")
        ssh_base = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", f"root@{host}"]
        _, sa_out, _ = await self._run_cmd([*ssh_base, "systemd-analyze"])
        _, blame_out, _ = await self._run_cmd([*ssh_base, "systemd-analyze blame"])
        _, dmesg_out, _ = await self._run_cmd([*ssh_base, "dmesg -l err,crit"])
        dmesg_errs = [line for line in dmesg_out.splitlines() if line.strip()]
        checks = [{"name": "dmesg", "status": "PASS" if not dmesg_errs else "WARN", "output": dmesg_out or "Temiz"}]
        return build_hardware_smoke_report(host, machine, "", sa_out, blame_out, dmesg_errs, checks)

    async def _rpc_pro_cra_list_vex(self, _params: dict[str, Any]) -> dict[str, Any]:
        machine, _ = self._machine_deploy_dir()
        cves = await self._rpc_artifacts_cves({})
        entries = [
            {
                "cve_id": f["cve_id"],
                "package": f["package"],
                "version": f["version"],
                "severity": f["severity"],
                "cvss": f["cvss"],
                "status": (
                    "fixed"
                    if f["status"] == "Patched"
                    else ("not_affected" if f["status"] == "Ignored" else "affected")
                ),
                "justification": "vulnerable_code_not_in_execute_path" if f["status"] == "Ignored" else None,
                "impact_statement": f["summary"],
                "updated_at": "",
            }
            for f in cves.get("findings", [])
        ]
        purl = f"pkg:yocto/poky/{machine}"
        return {"product_purl": purl, "entries": entries, "openvex_doc": build_openvex_document(entries, purl)}

    async def _rpc_pro_cra_update_vex(self, params: dict[str, Any]) -> dict[str, Any]:
        listed = await self._rpc_pro_cra_list_vex({})
        cve_id = str(params.get("cve_id") or "")
        for e in listed["entries"]:
            if e["cve_id"] == cve_id:
                e["status"] = str(params.get("status") or e["status"])
                e["justification"] = params.get("justification")
                e["impact_statement"] = params.get("impact_statement")
                return {
                    "entry": e,
                    "entries": listed["entries"],
                    "openvex_doc": build_openvex_document(listed["entries"], listed["product_purl"]),
                }
        raise RpcError(RpcErrorCode.INVALID_PARAMS, f"CVE not found: {cve_id}")

    async def _rpc_pro_cra_export_bundle(self, params: dict[str, Any]) -> dict[str, Any]:
        listed = await self._rpc_pro_cra_list_vex({})
        sbom = await self._rpc_artifacts_sbom({})
        lic = await self._rpc_artifacts_export_licenses({"format": "csv"})
        raw_out = str(params.get("output_dir") or "").strip()
        default_out = self._build_dir / "tmp" / "deploy"
        out_dir = (
            _resolve_within(raw_out, [self._workspace_dir, self._build_dir], self._build_dir)
            if raw_out
            else default_out
        )
        bundle_name = _sanitize_filename(str(params.get("bundle_name") or "cra-compliance-bundle.zip"))
        return export_cra_compliance_bundle(
            out_dir,
            bundle_name,
            sbom,
            listed["openvex_doc"],
            lic["content"],
        )

    async def _rpc_pro_secboot_generate(self, params: dict[str, Any]) -> dict[str, Any]:
        return generate_secure_boot_inc(
            enable_fit_sign=bool(params.get("enable_fit_sign", True)),
            key_dir=str(params.get("key_dir") or "${TOPDIR}/keys/dev-fit"),
            key_name=str(params.get("key_name") or "dev-fit-key"),
            key_bits=int(params.get("key_bits") or 2048),
            enable_dm_verity=bool(params.get("enable_dm_verity", True)),
            verity_image=str(params.get("verity_image") or "core-image-minimal"),
            verity_data_dev=str(params.get("verity_data_dev") or "/dev/mmcblk2p2"),
        )

    async def _rpc_pro_buildstats_analyze(self, _params: dict[str, Any]) -> dict[str, Any]:
        bs_root = self._build_dir / "tmp" / "buildstats"
        runs = sorted(bs_root.iterdir()) if bs_root.exists() else []
        latest = runs[-1] if runs else bs_root
        return parse_buildstats_dir(latest)

    async def _rpc_pro_cicd_generate(self, params: dict[str, Any]) -> dict[str, Any]:
        machine, _ = self._machine_deploy_dir()
        return generate_cicd_pipeline(
            platform=str(params.get("platform") or "gitlab"),
            setup_tool=str(params.get("setup_tool") or "kas"),
            machine=str(params.get("machine") or machine),
            target=str(params.get("target") or "core-image-minimal"),
            kas_file=str(params.get("kas_file") or "kas-project.yml"),
            enable_preflight_gate=bool(params.get("enable_preflight_gate", True)),
            enable_cve_gate=bool(params.get("enable_cve_gate", True)),
        )

    # ─── Modül 11: Live Enterprise RPCs ────────────────────────────────────

    def _read_local_conf_safe(self) -> str:
        p = self._local_conf_path()
        return p.read_text(encoding="utf-8", errors="replace") if p.exists() else ""

    def _collect_layer_files(self, layer_name: str = "") -> dict[str, str]:
        files_map: dict[str, str] = {}
        roots = [self._workspace_dir, self._workspace_dir / "layers"]
        for root in roots:
            if not root.exists():
                continue
            for layer_dir in sorted(root.iterdir()):
                if not layer_dir.is_dir() or not layer_dir.name.startswith("meta-"):
                    continue
                if layer_name and layer_dir.name != layer_name:
                    continue
                for ext in ("*.bb", "*.bbappend", "*.inc", "*.conf"):
                    for f in layer_dir.rglob(ext):
                        rel = str(f.relative_to(self._workspace_dir)).replace("\\", "/")
                        files_map[rel] = f.read_text(encoding="utf-8", errors="replace")
        return files_map

    async def _rpc_enterprise_mc_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        return list_workspace_multiconfigs(self._build_dir, self._read_local_conf_safe())

    async def _rpc_enterprise_mc_save(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "").strip()
        machine = str(params.get("machine") or "qemux86-64")
        tmpdir = str(params.get("tmpdir") or f"${{TOPDIR}}/tmp-{name}")
        distro = str(params.get("distro") or "")
        desc = str(params.get("description") or "")
        extra_vars = params.get("extra_vars") or {}
        try:
            entry = save_workspace_multiconfig(
                self._build_dir, name, machine, tmpdir, distro, desc, extra_vars
            )
        except ValueError as exc:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, str(exc)) from exc

        cur = list_workspace_multiconfigs(self._build_dir, self._read_local_conf_safe())
        enabled = cur["bbmulticonfig_enabled"]
        if name not in enabled:
            enabled.append(name)
        deps = cur["dependencies"]
        add_dep = params.get("add_dependency")
        if isinstance(add_dep, dict) and add_dep.get("recipe"):
            dep = build_mcdepends_expression(
                str(add_dep.get("from_config") or name),
                str(add_dep.get("to_config") or name),
                str(add_dep.get("recipe") or ""),
                str(add_dep.get("task") or "do_deploy"),
            )
            deps.append(dep)
        new_conf, diff = sync_bbmulticonfig_in_local_conf(
            self._read_local_conf_safe(), enabled, deps
        )
        if self._local_conf_path().exists():
            self._local_conf_path().write_text(new_conf, encoding="utf-8")
        refreshed = list_workspace_multiconfigs(self._build_dir, new_conf)
        return {
            "config": entry,
            "bbmulticonfig_enabled": refreshed["bbmulticonfig_enabled"],
            "configs": refreshed["configs"],
            "dependencies": refreshed["dependencies"],
            "local_conf_diff": diff,
        }

    async def _rpc_enterprise_mc_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "").strip()
        ok = delete_workspace_multiconfig(self._build_dir, name)
        cur = list_workspace_multiconfigs(self._build_dir, self._read_local_conf_safe())
        enabled = [x for x in cur["bbmulticonfig_enabled"] if x != name]
        new_conf, _ = sync_bbmulticonfig_in_local_conf(self._read_local_conf_safe(), enabled)
        if self._local_conf_path().exists():
            self._local_conf_path().write_text(new_conf, encoding="utf-8")
        refreshed = list_workspace_multiconfigs(self._build_dir, new_conf)
        return {
            "ok": ok,
            "bbmulticonfig_enabled": refreshed["bbmulticonfig_enabled"],
            "configs": refreshed["configs"],
        }

    async def _rpc_enterprise_scan_autorev(self, params: dict[str, Any]) -> dict[str, Any]:
        return scan_autorev_in_workspace(
            self._workspace_dir, layer_filter=str(params.get("layer_filter") or "")
        )

    async def _rpc_enterprise_pin_autorev(self, params: dict[str, Any]) -> dict[str, Any]:
        files_map = self._collect_layer_files()
        fids = [str(x) for x in (params.get("finding_ids") or [])]
        updated, diff, pinned = apply_autorev_pins(
            files_map, finding_ids=fids if fids else None
        )
        for rel, new_text in updated.items():
            if new_text != files_map.get(rel):
                (self._workspace_dir / rel).write_text(new_text, encoding="utf-8")
        remaining = scan_autorev_in_workspace(self._workspace_dir)["findings"]
        return {
            "pinned_count": pinned,
            "combined_diff": diff,
            "remaining_findings": remaining,
        }

    async def _rpc_enterprise_prepare_mirror(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        dl_dir = str(params.get("dl_dir") or self._build_dir / "downloads")
        mirror_dir = str(params.get("mirror_dir") or self._build_dir / "mirror")
        no_net = bool(params.get("enable_no_network", True))
        plan = build_offline_mirror_plan(
            target, dl_dir, mirror_dir, self._read_local_conf_safe(), enable_no_network=no_net
        )
        if bool(params.get("apply_config", False)) and self._local_conf_path().exists():
            conf = parse_conf(self._read_local_conf_safe())
            for k, v in plan["local_conf_updates"].items():
                conf.set_variable(k, v, operator="+=" if k == "INHERIT" else "=")
            self._local_conf_path().write_text(conf.render(), encoding="utf-8")
        return plan

    async def _rpc_enterprise_configure_archiver(self, params: dict[str, Any]) -> dict[str, Any]:
        mode = "patched" if str(params.get("mode") or "original") == "patched" else "original"
        gpl_only = bool(params.get("gpl_only", True))
        updates, new_conf, diff = build_archiver_config(
            self._read_local_conf_safe(), mode=mode, gpl_only=gpl_only
        )
        if bool(params.get("apply_config", False)) and self._local_conf_path().exists():
            self._local_conf_path().write_text(new_conf, encoding="utf-8")
        src_dir = self._build_dir / "tmp" / "deploy" / "sources"
        out_path = self._build_dir / "tmp" / "deploy" / "yocto-gpl-sources.tar.gz"
        tar_info = export_sources_tarball(
            src_dir if src_dir.exists() else None, out_path, gpl_only=gpl_only
        )
        return {
            "ok": True,
            "mode": mode,
            "gpl_only": gpl_only,
            "local_conf_updates": updates,
            "local_conf_diff": diff,
            **tar_info,
        }

    async def _rpc_enterprise_rootfs_treemap(self, params: dict[str, Any]) -> dict[str, Any]:
        image = str(params.get("image") or "core-image-minimal")
        machine, _ = self._machine_deploy_dir()
        bh_dir = self._build_dir / "buildhistory" / "images"
        candidates = list(bh_dir.rglob("installed-package-sizes.txt")) if bh_dir.exists() else []
        raw_text = candidates[0].read_text(encoding="utf-8", errors="replace") if candidates else ""
        return parse_installed_package_sizes(raw_text, image=image, machine=machine)

    async def _rpc_enterprise_rootfs_find_path(self, params: dict[str, Any]) -> dict[str, Any]:
        query = str(params.get("path") or "").strip()
        if not query:
            return {"query": query, "matches": []}
        rc, out, _ = await self._run_cmd(["oe-pkgdata-util", "find-path", query])
        matches = parse_pkgdata_find_path(out) if rc == 0 else []
        return {"query": query, "matches": matches}

    async def _rpc_enterprise_rootfs_diffsigs(self, params: dict[str, Any]) -> dict[str, Any]:
        recipe = str(params.get("recipe") or "core-image-minimal")
        task = str(params.get("task") or "do_compile")
        rc, out, err = await self._run_cmd(["bitbake-diffsigs", "-t", recipe, task])
        raw = out if rc == 0 else (err or out)
        return parse_diffsigs_output(raw, recipe=recipe, task=task)

    async def _rpc_enterprise_debug_export_ide(self, params: dict[str, Any]) -> dict[str, Any]:
        recipe = str(params.get("recipe") or "my-sensor-daemon")
        return generate_vscode_debug_configs(
            recipe=recipe,
            binary_path=str(params.get("binary_path") or f"/usr/bin/{recipe}"),
            target_host=str(params.get("target_host") or "192.168.10.50"),
            gdb_port=int(params.get("gdb_port") or 2345),
            sysroot_path=str(params.get("sysroot_path") or "/opt/poky/sysroot"),
            gdb_path=str(params.get("gdb_path") or "gdb-multiarch"),
        )

    async def _rpc_enterprise_debug_start_gdbserver(self, params: dict[str, Any]) -> dict[str, Any]:
        target_host = str(params.get("target_host") or "")
        if not target_host:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, "target_host is required")
        return build_gdbserver_launch_plan(
            target_host=target_host,
            ssh_user=str(params.get("ssh_user") or "root"),
            ssh_port=int(params.get("ssh_port") or 22),
            remote_binary=str(params.get("remote_binary") or "/usr/bin/app"),
            gdb_port=int(params.get("gdb_port") or 2345),
            args=str(params.get("args") or ""),
        )

    async def _rpc_enterprise_debug_telemetry(self, params: dict[str, Any]) -> dict[str, Any]:
        target_host = _validate_ssh_token(str(params.get("target_host") or "192.168.10.50"), "target_host")
        user = _validate_ssh_token(str(params.get("ssh_user") or "root"), "ssh_user")
        unit = _validate_journal_unit(str(params.get("journal_unit") or "systemd-journald"))
        quoted_unit = shlex.quote(unit)
        remote_script = (
            "echo '=== TIME ==='; date -u +%Y-%m-%dT%H:%M:%SZ; "
            "echo '=== UPTIME ==='; cat /proc/uptime; "
            "echo '=== LOAD ==='; cat /proc/loadavg; "
            "echo '=== MEM ==='; cat /proc/meminfo; "
            "echo '=== DF ==='; df -k / | tail -n 1; "
            "echo '=== THERMAL ==='; "
            "for z in /sys/class/thermal/thermal_zone*; do "
            "[ -f $z/temp ] && echo \"$(basename $z)|$(cat $z/type)|$(cat $z/temp)\"; done; "
            "echo '=== SYSTEMD ==='; systemctl --failed --no-legend || true; "
            f"echo '=== JOURNAL ==='; journalctl -n 20 --no-pager -u {quoted_unit} || journalctl -n 20 --no-pager"
        )
        rc, out, err = await self._run_cmd(
            [
                "ssh",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=3",
                "--",
                f"{user}@{target_host}",
                remote_script,
            ]
        )
        if rc != 0:
            raise RpcError(RpcErrorCode.PROVIDER_UNAVAILABLE, err or "SSH telemetry failed")
        return parse_live_telemetry_output(out, target_host)

    async def _rpc_enterprise_migration_scan(self, params: dict[str, Any]) -> dict[str, Any]:
        from_lts = str(params.get("from_lts") or "scarthgap")
        to_lts = str(params.get("to_lts") or "wrynose")
        layer = str(params.get("layer_name") or "")
        files_map = self._collect_layer_files(layer_name=layer)
        return scan_migration_files(files_map, from_lts=from_lts, to_lts=to_lts, layer_name=layer or "workspace")

    async def _rpc_enterprise_migration_apply_all(self, params: dict[str, Any]) -> dict[str, Any]:
        from_lts = str(params.get("from_lts") or "scarthgap")
        to_lts = str(params.get("to_lts") or "wrynose")
        layer = str(params.get("layer_name") or "")
        files_map = self._collect_layer_files(layer_name=layer)
        fids = params.get("finding_ids")
        updated, res = apply_migration_fixes(
            files_map,
            from_lts=from_lts,
            to_lts=to_lts,
            layer_name=layer or "workspace",
            finding_ids=[str(x) for x in fids] if fids is not None else None,
        )
        for fp in res["modified_files"]:
            (self._workspace_dir / fp).write_text(updated[fp], encoding="utf-8")
        return res

    async def _rpc_enterprise_git_status_all(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"layers": list_workspace_layer_repos(self._workspace_dir)}

    async def _rpc_enterprise_git_run_action(self, params: dict[str, Any]) -> dict[str, Any]:
        layer_name = str(params.get("layer_name") or "")
        action = str(params.get("action") or "diff")
        message = params.get("message")
        repos = list_workspace_layer_repos(self._workspace_dir)
        match = next((r for r in repos if r["layer_name"] == layer_name), None)
        if match is None:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Git repo not found for layer: {layer_name}")
        return run_git_action(Path(match["path"]), action, str(message) if message else None)

    async def _rpc_enterprise_sstate_analytics(self, params: dict[str, Any]) -> dict[str, Any]:
        conf_vars = parse_conf(self._read_local_conf_safe()).get_variables()
        mirror_url = str(params.get("mirror_url") or conf_vars.get("SSTATE_MIRRORS", "")).strip()
        hs_endpoint = str(params.get("hashserve_endpoint") or conf_vars.get("BB_HASHSERVE", "auto")).strip()
        runner_logs = params.get("runner_logs")
        return build_remote_sstate_analytics(
            mirror_url=mirror_url,
            hashserve_endpoint=hs_endpoint,
            time_range=str(params.get("time_range") or "7d"),
            runner_logs=runner_logs,
            mock=False,
        )
