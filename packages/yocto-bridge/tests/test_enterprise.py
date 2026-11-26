"""Unit & integration tests for Modül 11: Enterprise & Completeness Pack."""

from __future__ import annotations

import json
import subprocess
import tarfile
from pathlib import Path

import pytest

from bridge.enterprise import (
    apply_autorev_pins,
    apply_migration_fixes,
    build_archiver_config,
    build_mcdepends_expression,
    build_offline_mirror_plan,
    build_remote_sstate_analytics,
    export_sources_tarball,
    generate_multiconfig_conf,
    generate_vscode_debug_configs,
    list_workspace_layer_repos,
    lookup_path_in_index,
    parse_diffsigs_output,
    parse_git_status_porcelain,
    parse_installed_package_sizes,
    parse_live_telemetry_output,
    parse_multiconfig_text,
    run_git_action,
    save_workspace_multiconfig,
    scan_autorev_in_files,
    scan_migration_files,
    sync_bbmulticonfig_in_local_conf,
)
from bridge.event_monitor import EventMonitor
from bridge.mock_mode import MockYoctoEngine


async def _noop_notify(_method: str, _params: dict) -> None:
    return None


def test_multiconfig_generation_and_local_conf_sync(tmp_path: Path) -> None:
    entry = save_workspace_multiconfig(
        tmp_path,
        name="cortex-m7-rtos",
        machine="imx8mp-m7-freertos",
        tmpdir="${TOPDIR}/tmp-m7",
        distro="baremetal",
        description="M7 RTOS",
    )
    assert entry["machine"] == "imx8mp-m7-freertos"
    assert (tmp_path / "conf" / "multiconfig" / "cortex-m7-rtos.conf").exists()

    dep = build_mcdepends_expression("cortex-a53-linux", "cortex-m7-rtos", "zephyr-fw", "do_deploy")
    assert dep["expression"] == "mc:cortex-a53-linux:cortex-m7-rtos:zephyr-fw:do_deploy"

    raw_local = '# Yocto local.conf\nMACHINE ??= "imx8mp-lpddr4-evk"\n'
    updated, diff = sync_bbmulticonfig_in_local_conf(raw_local, ["cortex-a53-linux", "cortex-m7-rtos"], [dep])
    assert "# Yocto local.conf" in updated
    assert 'BBMULTICONFIG = "cortex-a53-linux cortex-m7-rtos"' in updated
    assert "mc:cortex-a53-linux:cortex-m7-rtos:zephyr-fw:do_deploy" in updated
    assert "+BBMULTICONFIG" in diff

    reparsed = parse_multiconfig_text("test", generate_multiconfig_conf("test", "qemux86-64", "${TOPDIR}/tmp-t"))
    assert reparsed["machine"] == "qemux86-64"


def test_offline_archiver_autorev_pin_and_tarball(tmp_path: Path) -> None:
    files = {
        "meta-custom/recipes-app/demo/demo_git.bb": 'SRC_URI = "git://example.com/a.git"\nSRCREV = "${AUTOREV}"\n',
        "meta-custom/recipes-app/other/other_1.0.bb": 'SRCREV = "deadbeef12345678"\n',
    }
    scan = scan_autorev_in_files(files)
    assert scan["scanned_files"] == 2
    assert len(scan["findings"]) == 1
    assert scan["findings"][0]["recipe"] == "demo"

    pinned_files, diff, count = apply_autorev_pins(files)
    assert count == 1
    assert "${AUTOREV}" not in pinned_files["meta-custom/recipes-app/demo/demo_git.bb"]
    assert "-SRCREV" in diff and "+SRCREV" in diff

    plan = build_offline_mirror_plan("core-image-minimal", "/dl", "/mirror", 'MACHINE = "imx8mp"\n')
    assert plan["local_conf_updates"]["BB_NO_NETWORK"] == "1"
    assert "bitbake core-image-minimal --runall=fetch" in plan["commands"]

    updates, _, arch_diff = build_archiver_config('MACHINE = "imx8mp"\n', mode="patched", gpl_only=True)
    assert updates["ARCHIVER_MODE[src]"] == "patched"
    assert "archiver" in arch_diff

    tar_out = tmp_path / "gpl-src.tar.gz"
    res = export_sources_tarball(None, tar_out, gpl_only=True)
    assert tar_out.exists()
    assert res["package_count"] >= 5
    with tarfile.open(tar_out, "r:gz") as tf:
        names = tf.getnames()
        assert "sources/SOURCE_ARCHIVE_MANIFEST.json" in names
        assert all("Apache-2.0" not in n for n in names)


def test_rootfs_treemap_pkgdata_and_diffsigs() -> None:
    raw_sizes = "\n".join(f"{1000 + i * 500}\tKiB\tpkg-{i:02d}" for i in range(42))
    raw_sizes += "\n12400\tKiB\tlibcrypto3\n8500\tKiB\tlinux-imx\n"
    treemap = parse_installed_package_sizes(raw_sizes)
    assert treemap["package_count"] == 44
    assert treemap["total_bytes"] > 0
    assert abs(sum(c["percent"] for c in treemap["categories"]) - 100.0) < 0.5

    matches = lookup_path_in_index(
        "/usr/lib/libcrypto.so.3",
        [{"file_path": "/usr/lib/libcrypto.so.3", "package": "libcrypto3", "recipe": "openssl"}],
    )
    assert len(matches) == 1
    assert matches[0]["recipe"] == "openssl"

    raw_sig = (
        "Task meta-custom/my-app_1.0.bb:do_compile basehash changed from abc123 to def456\n"
        "Variable CFLAGS value changed:\n"
        '- "-O2"\n'
        '+ "-O2 -DDEBUG"\n'
        "Checksum for file file://fix.patch changed from 111 to 222\n"
        "Hash for dependent task glibc_2.41.bb:do_populate_sysroot changed\n"
    )
    parsed = parse_diffsigs_output(raw_sig, recipe="my-app", task="do_compile")
    assert parsed["old_sig"] == "abc123"
    assert parsed["new_sig"] == "def456"
    assert len(parsed["causes"]) == 3


def test_remote_debug_ide_export_and_telemetry_parser() -> None:
    exported = generate_vscode_debug_configs("my-sensor-daemon", target_host="10.0.0.42", gdb_port=2345)
    launch = json.loads(exported["launch_json"])
    cpp = json.loads(exported["c_cpp_properties_json"])
    assert launch["configurations"][0]["miDebuggerServerAddress"] == "10.0.0.42:2345"
    assert cpp["configurations"][0]["name"] == "Yocto eSDK (my-sensor-daemon)"

    raw_tel = (
        "=== TIME ===\n2026-11-25T11:30:00Z\n"
        "=== UPTIME ===\n900.0 1800.0\n"
        "=== LOAD ===\n1.20 0.90 0.70 1/90 420\n"
        "=== MEM ===\nMemTotal: 2048000 kB\nMemAvailable: 1024000 kB\n"
        "=== DF ===\n/dev/mmcblk2p2 10485760 3145728 7340032 30% /\n"
        "=== THERMAL ===\nthermal_zone0|cpu-thermal|51200\n"
        "=== SYSTEMD ===\nmy-bad.service loaded failed failed Bad Service\n"
        "=== JOURNAL ===\nNov 25 11:30:00 target app[10]: ready\n"
    )
    tel = parse_live_telemetry_output(raw_tel, "10.0.0.42")
    assert tel["ram_total_mb"] == 2000
    assert tel["thermal_zones"][0]["temp_c"] == 51.2
    assert len(tel["failed_services"]) == 1
    assert len(tel["journal_lines"]) == 1


def test_migration_linter_auto_migrate_preserves_workdir_build() -> None:
    files = {
        "meta-test/conf/layer.conf": 'LAYERSERIES_COMPAT_meta-test = "scarthgap"\n',
        "meta-test/recipes-app/foo/foo_1.0.bb": (
            'S = "${WORKDIR}/git"\n'
            'B = "${WORKDIR}/build"\n'
            'DEPENDS_append = " openssl"\n'
        ),
        "meta-test/recipes-core/images/custom-image.bb": (
            'INHERIT += "cve-check"\n'
            'EXTRA_IMAGE_FEATURES += "debug-tweaks"\n'
        ),
        "meta-test/conf/distro/my.conf": 'BB_ENV_EXTRAWHITE = "DL_DIR"\n',
    }
    scan = scan_migration_files(files, from_lts="scarthgap", to_lts="wrynose", layer_name="meta-test")
    rule_ids = {f["rule_id"] for f in scan["findings"]}
    assert rule_ids == {
        "LAYERSERIES_COMPAT_OUTDATED",
        "WORKDIR_TO_UNPACKDIR",
        "LEGACY_OVERRIDE_SYNTAX",
        "CVE_CHECK_TO_SBOM",
        "DEBUG_TWEAKS_REMOVED",
        "BB_ENV_EXTRAWHITE_RENAMED",
    }

    updated, res = apply_migration_fixes(files, from_lts="scarthgap", to_lts="wrynose", layer_name="meta-test")
    assert res["applied_count"] == 6
    assert len(res["remaining_findings"]) == 0
    # Verify ${WORKDIR}/build was NOT converted to ${UNPACKDIR}/build
    assert 'B = "${WORKDIR}/build"' in updated["meta-test/recipes-app/foo/foo_1.0.bb"]
    assert 'S = "${UNPACKDIR}/git"' in updated["meta-test/recipes-app/foo/foo_1.0.bb"]
    assert "DEPENDS:append" in updated["meta-test/recipes-app/foo/foo_1.0.bb"]
    assert "wrynose" in updated["meta-test/conf/layer.conf"]
    assert "sbom-cve-check" in updated["meta-test/recipes-core/images/custom-image.bb"]
    assert "debug-tweaks" not in updated["meta-test/recipes-core/images/custom-image.bb"]
    assert "BB_ENV_PASSTHROUGH_ADDITIONS" in updated["meta-test/conf/distro/my.conf"]


def test_multi_git_real_temp_repo(tmp_path: Path) -> None:
    layers_dir = tmp_path / "layers"
    repo = layers_dir / "meta-sample"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "config", "user.email", "ci@yoctostudio.dev"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Yocto CI"], cwd=repo, check=True)

    recipe = repo / "sample.bb"
    recipe.write_text('SUMMARY = "v1"\n', encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=repo, check=True)
    subprocess.run(["git", "commit", "-m", "initial commit"], cwd=repo, check=True, capture_output=True)

    recipe.write_text('SUMMARY = "v2"\n', encoding="utf-8")
    repos = list_workspace_layer_repos(tmp_path)
    assert len(repos) == 1
    assert repos[0]["layer_name"] == "meta-sample"
    assert repos[0]["dirty_count"] == 1

    diff_res = run_git_action(repo, "diff")
    assert diff_res["ok"] and '+SUMMARY = "v2"' in (diff_res["diff"] or "")

    commit_res = run_git_action(repo, "commit", message="bump summary")
    assert commit_res["ok"]
    assert commit_res["updated_status"]["dirty_count"] == 0

    parsed = parse_git_status_porcelain("meta-x", "/x", "## main...origin/main [ahead 2, behind 1]\n M a.bb\n?? b.bb\n")
    assert parsed["ahead"] == 2 and parsed["behind"] == 1
    assert parsed["dirty_count"] == 1 and parsed["untracked_count"] == 1


@pytest.mark.asyncio
async def test_mock_engine_enterprise_end_to_end() -> None:
    engine = MockYoctoEngine(EventMonitor(_noop_notify))

    mc_list = await engine.dispatch("enterprise.multiconfig.list", {})
    assert len(mc_list["configs"]) >= 3
    mc_saved = await engine.dispatch(
        "enterprise.multiconfig.save",
        {"name": "dsp-core", "machine": "imx8mp-dsp", "tmpdir": "${TOPDIR}/tmp-dsp"},
    )
    assert any(c["name"] == "dsp-core" for c in mc_saved["configs"])
    mc_del = await engine.dispatch("enterprise.multiconfig.delete", {"name": "dsp-core"})
    assert mc_del["ok"] is True

    auto_scan = await engine.dispatch("enterprise.offline.scanAutorev", {})
    assert len(auto_scan["findings"]) == 3
    pinned = await engine.dispatch(
        "enterprise.offline.pinAutorev",
        {"finding_ids": [auto_scan["findings"][0]["id"]]},
    )
    assert pinned["pinned_count"] == 1
    assert len(pinned["remaining_findings"]) == 2

    mirror = await engine.dispatch("enterprise.offline.prepareMirror", {"enable_no_network": True})
    assert mirror["verified_offline"] is True
    arch = await engine.dispatch("enterprise.offline.configureArchiver", {"mode": "patched", "gpl_only": True})
    assert arch["ok"] is True and len(arch["sha256"]) == 64

    treemap = await engine.dispatch("enterprise.rootfs.getTreemap", {})
    assert treemap["package_count"] >= 40
    found = await engine.dispatch("enterprise.rootfs.findPath", {"path": "/usr/lib/libcrypto.so.3"})
    assert found["matches"][0]["recipe"] == "openssl"
    sigs = await engine.dispatch("enterprise.rootfs.diffSigs", {"recipe": "my-sensor-daemon"})
    assert len(sigs["causes"]) >= 2

    ide = await engine.dispatch("enterprise.debug.exportIdeConfig", {"recipe": "my-sensor-daemon"})
    assert "launch_json" in ide and "c_cpp_properties_json" in ide
    gdb = await engine.dispatch(
        "enterprise.debug.startGdbserver",
        {"target_host": "192.168.10.50", "remote_binary": "/usr/bin/my-sensor-daemon"},
    )
    assert gdb["ok"] is True
    tel = await engine.dispatch("enterprise.debug.getLiveTelemetry", {"target_host": "192.168.10.50"})
    assert tel["ram_total_mb"] > 0 and len(tel["journal_lines"]) >= 3

    mig_scan = await engine.dispatch(
        "enterprise.migration.scan",
        {"from_lts": "scarthgap", "to_lts": "wrynose", "layer_name": "meta-custom-iot"},
    )
    assert len(mig_scan["findings"]) == 6
    mig_applied = await engine.dispatch(
        "enterprise.migration.applyAll",
        {"from_lts": "scarthgap", "to_lts": "wrynose", "layer_name": "meta-custom-iot"},
    )
    assert mig_applied["applied_count"] == 6
    assert len(mig_applied["remaining_findings"]) == 0

    git_list = await engine.dispatch("enterprise.git.statusAll", {})
    assert len(git_list["layers"]) >= 5
    git_diff = await engine.dispatch("enterprise.git.runAction", {"layer_name": "meta-custom-iot", "action": "diff"})
    assert git_diff["ok"] and git_diff["diff"]

    sstate_report = await engine.dispatch("enterprise.sstate.getRunnerAnalytics", {"time_range": "7d"})
    assert len(sstate_report["runners"]) == 5
    assert sstate_report["fleet_hit_rate_percent"] > 60.0
    assert any(a["runner_id"] == "gh-ubuntu22-legacy" for a in sstate_report["anomalies"])


def test_remote_sstate_runner_analytics_from_bitbake_logs() -> None:
    logs = [
        {
            "runner_id": "ci-1",
            "runner_name": "ubuntu24-fast",
            "nativelsbstring": "ubuntu-24.04",
            "log_text": (
                "NOTE: Sstate summary: Wanted 1000 Local 200 Mirrors 700 Missed 100 "
                "Current 0 (90% match, 90% complete)\n"
                "NOTE: Hash Equivalence unihash reused: 85\n"
            ),
        },
        {
            "runner_id": "ci-2",
            "runner_name": "ubuntu22-cold",
            "nativelsbstring": "ubuntu-22.04",
            "log_text": (
                'NATIVELSBSTRING = "ubuntu-22.04"\n'
                "NOTE: Sstate summary: Wanted 1000 Local 10 Mirrors 190 Missed 800 "
                "Current 0 (20% match, 20% complete)\n"
                "NOTE: Hash Equivalence unihash reused: 5\n"
            ),
        },
    ]
    report = build_remote_sstate_analytics(
        mirror_url="/tmp/sstate",
        hashserve_endpoint="auto",
        time_range="24h",
        runner_logs=logs,
        mock=False,
    )
    assert report["runners"][0]["hit_rate_percent"] == 90.0
    assert report["runners"][1]["status"] == "cold"
    assert any(a["severity"] == "critical" and a["runner_id"] == "ci-2" for a in report["anomalies"])
