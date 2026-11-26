"""BSP & layer compatibility, dependency, .bbappend version drift, and overlay audit."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from bridge.i18n import tr_en
from bridge.tools.yocto_tools import parse_show_appends, parse_show_overlayed

_LAYER_VAR_RE = re.compile(
    r'^(LAYERSERIES_COMPAT|LAYERDEPENDS|LAYERVERSION|BBFILE_PRIORITY)_[A-Za-z0-9_+-]+\s*'
    r'(?:\?\?=|\?=|:=|\+=|=)\s*"([^"]*)"',
    re.MULTILINE,
)
_COLLECTIONS_RE = re.compile(r'^BBFILE_COLLECTIONS\s*(?:\+=|=)\s*"([^"]*)"', re.MULTILINE)
_CHECK_LINE_RE = re.compile(r"INFO:\s+(.*?)\s+\.\.\.\s+(PASS|FAIL|SKIPPED)")


def parse_layer_conf(text: str) -> dict[str, Any]:
    """Extract LAYERSERIES_COMPAT, LAYERDEPENDS, LAYERVERSION, priority, and collection names."""
    collections = [c for c in " ".join(_COLLECTIONS_RE.findall(text)).split() if c]
    compat: list[str] = []
    depends: list[str] = []
    layer_version: str | None = None
    priority: int | None = None

    for kind, val in _LAYER_VAR_RE.findall(text):
        tokens = [t.strip() for t in val.split() if t.strip()]
        if kind == "LAYERSERIES_COMPAT":
            compat.extend(tokens)
        elif kind == "LAYERDEPENDS":
            for tok in tokens:
                dep_name = tok.split("(", 1)[0].strip()
                if dep_name and dep_name not in depends:
                    depends.append(dep_name)
        elif kind == "LAYERVERSION" and tokens:
            layer_version = tokens[0]
        elif kind == "BBFILE_PRIORITY" and tokens:
            try:
                priority = int(tokens[0])
            except ValueError:
                pass

    return {
        "collections": collections,
        "compat": list(dict.fromkeys(compat)),
        "depends": depends,
        "layer_version": layer_version,
        "priority": priority,
    }


def detect_bbappend_version_drift(
    appends: list[dict[str, Any]],
    active_recipe_versions: dict[str, str],
) -> list[dict[str, Any]]:
    """Detect version-pinned `.bbappend` files that no longer match the active recipe version."""
    drifted: list[dict[str, Any]] = []
    for item in appends:
        recipe = str(item.get("recipe") or "")
        append_file = str(item.get("append_file") or "")
        fname = Path(append_file).name
        if not fname.endswith(".bbappend"):
            continue
        stem = fname[: -len(".bbappend")]
        if "_" not in stem:
            continue
        rec_name, pinned_pv = stem.rsplit("_", 1)
        if pinned_pv == "%" or pinned_pv == "":
            continue
        target_rec = recipe or rec_name
        actual_pv = active_recipe_versions.get(target_rec)
        if actual_pv and actual_pv != pinned_pv:
            drifted.append(
                {
                    "recipe": target_rec,
                    "layer": str(item.get("layer") or "unknown"),
                    "append_file": append_file,
                    "expected_pv": pinned_pv,
                    "actual_pv": actual_pv,
                }
            )
    return drifted


def parse_yocto_check_layer_output(layer: str, stdout: str, rc: int) -> dict[str, Any]:
    """Summarize `yocto-check-layer` output into pass/fail counts."""
    passed = 0
    failed = 0
    for _, status in _CHECK_LINE_RE.findall(stdout):
        if status == "PASS":
            passed += 1
        elif status == "FAIL":
            failed += 1
    return {
        "layer": layer,
        "status": "PASS" if rc == 0 and failed == 0 else "FAIL",
        "passed": passed,
        "failed": failed,
        "output": stdout.strip(),
    }


def audit_layers(
    layers: list[dict[str, Any]],
    active_series: str,
    show_appends_out: str = "",
    show_overlayed_out: str = "",
    active_recipe_versions: dict[str, str] | None = None,
    layer_confs: dict[str, str] | None = None,
    git_branches: dict[str, str] | None = None,
    explicit_appends: list[dict[str, Any]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Run layer compatibility, dependency, branch, overlay, and `.bbappend` drift audits."""
    series = active_series.lower().strip() or "wrynose"
    present_names = {str(lyr.get("name", "")) for lyr in layers}
    appends = (
        explicit_appends
        if explicit_appends is not None
        else (parse_show_appends(show_appends_out) if show_appends_out else [])
    )
    overlayed = parse_show_overlayed(show_overlayed_out) if show_overlayed_out else []
    drifted_all = detect_bbappend_version_drift(appends, active_recipe_versions or {})

    layer_checks: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []

    for lyr in layers:
        name = str(lyr.get("name") or "")
        path = str(lyr.get("path") or "")
        conf_meta = parse_layer_conf(layer_confs[name]) if (layer_confs and name in layer_confs) else {}
        compat = list(conf_meta.get("compat") or lyr.get("compat") or [])
        branch = str((git_branches or {}).get(name) or lyr.get("branch") or series)
        depends = list(conf_meta.get("depends") or lyr.get("depends") or [])
        compat_ok = (not compat) or (series in [c.lower() for c in compat])
        missing_deps = [
            dep for dep in depends if dep not in present_names and dep != "core"
        ]
        if "core" in depends and "openembedded-core" not in present_names and "meta" not in present_names:
            missing_deps.append("openembedded-core")

        lyr_drifted = [d for d in drifted_all if d["layer"] == name or d["append_file"].startswith(path)]
        lyr_overlayed = [o for o in overlayed if o.get("shadowed_layer") == name]

        layer_checks.append(
            {
                "name": name,
                "path": path,
                "priority": int(lyr.get("priority") or 5),
                "branch": branch,
                "compat": compat,
                "active_series": series,
                "compat_ok": compat_ok,
                "missing_depends": missing_deps,
                "drifted_appends": lyr_drifted,
                "overlayed_count": len(lyr_overlayed),
            }
        )

        if not compat_ok:
            issues.append(
                {
                    "id": f"fix-layer-compat-{name}",
                    "severity": "blocker",
                    "category": "layer",
                    "title": tr_en(
                        f"LAYERSERIES_COMPAT uyumsuzluğu: {name}",
                        f"LAYERSERIES_COMPAT mismatch: {name}",
                    ),
                    "summary": tr_en(
                        f"'{name}' katmanı {compat or ['unknown']} serisi için ayarlı "
                        f"(Git dalı: {branch}); aktif proje Yocto {series} kullanıyor.",
                        f"Layer '{name}' targets {compat or ['unknown']} "
                        f"(Git branch: {branch}); active project uses Yocto {series}.",
                    ),
                    "detail": tr_en(
                        f"conf/layer.conf içindeki LAYERSERIES_COMPAT tanımı '{series}' serisini "
                        "içermediği için BitBake parse adımında derlemeyi durdurur.",
                        f"conf/layer.conf omits '{series}' in LAYERSERIES_COMPAT, "
                        "causing BitBake parse to abort.",
                    ),
                    "layer": name,
                    "recipe": None,
                    "dependency_chain": [name, f"LAYERSERIES_COMPAT -> {series}"],
                    "auto_fix": {
                        "id": f"fix-layer-compat-{name}",
                        "label": tr_en(
                            f"{name} için '{series}' Uyumunu Ekle",
                            f"Add '{series}' Compatibility for {name}",
                        ),
                        "description": tr_en(
                            f"{name}/conf/layer.conf içine '{series}' serisini ekler.",
                            f"Adds '{series}' to {name}/conf/layer.conf.",
                        ),
                        "kind": "layer_compat_update",
                        "target_file": f"{path}/conf/layer.conf",
                        "changes": {"LAYERSERIES_COMPAT": f"{' '.join(compat)} {series}".strip()},
                        "layer_name": name,
                    },
                }
            )

        for dep in missing_deps:
            issues.append(
                {
                    "id": f"fix-layer-dep-{name}-{dep}",
                    "severity": "blocker",
                    "category": "layer",
                    "title": tr_en(
                        f"Eksik LAYERDEPENDS: {dep} ({name} gerektiriyor)",
                        f"Missing LAYERDEPENDS: {dep} (required by {name})",
                    ),
                    "summary": tr_en(
                        f"'{name}' katmanı '{dep}' katmanına bağımlı ancak bblayers.conf içinde yok.",
                        f"Layer '{name}' depends on '{dep}', which is missing from bblayers.conf.",
                    ),
                    "detail": tr_en(
                        "OpenEmbedded Layer Index üzerinden bağımlı katmanı çalışma alanına ekleyebilirsiniz.",
                        "Add the required dependency layer to the workspace from OpenEmbedded Layer Index.",
                    ),
                    "layer": dep,
                    "recipe": None,
                    "dependency_chain": [name, "LAYERDEPENDS", dep],
                    "auto_fix": {
                        "id": f"fix-layer-dep-{name}-{dep}",
                        "label": tr_en(
                            f"Layer Index'ten {dep} Katmanını Ekle",
                            f"Add {dep} Layer from Layer Index",
                        ),
                        "description": tr_en(
                            f"{dep} katmanını bblayers.conf'a ekler.",
                            f"Adds {dep} layer to bblayers.conf.",
                        ),
                        "kind": "layer_add",
                        "target_file": "conf/bblayers.conf",
                        "changes": {"BBLAYERS": dep},
                        "layer_name": dep,
                    },
                }
            )

    for drift in drifted_all:
        rec = drift["recipe"]
        issues.append(
            {
                "id": f"fix-bbappend-drift-{rec}",
                "severity": "blocker",
                "category": "layer",
                "title": tr_en(
                    f"Sürüm kayması olan .bbappend: {rec}",
                    f"Version-drifted .bbappend: {rec}",
                ),
                "summary": tr_en(
                    f"{Path(drift['append_file']).name}, {drift['expected_pv']} sürümüne sabitlenmiş; "
                    f"aktif tarif sürümü {drift['actual_pv']}.",
                    f"{Path(drift['append_file']).name} is pinned to {drift['expected_pv']}; "
                    f"active recipe version is {drift['actual_pv']}.",
                ),
                "detail": tr_en(
                    "Ana tarif sürümü yükseldiğinde sürüm sabitli .bbappend BitBake tarafından "
                    "reddedilir veya sessizce devre dışı kalır. Joker (_%.bbappend) önerilir.",
                    "When the base recipe upgrades, a version-pinned .bbappend is rejected by BitBake "
                    "or silently ignored. Wildcard (_%.bbappend) is recommended.",
                ),
                "layer": drift["layer"],
                "recipe": rec,
                "dependency_chain": [drift["layer"], Path(drift["append_file"]).name, f"{rec} ({drift['actual_pv']})"],
                "auto_fix": {
                    "id": f"fix-bbappend-drift-{rec}",
                    "label": tr_en(
                        f"{rec}_%.bbappend Olarak Güncelle",
                        f"Update to {rec}_%.bbappend",
                    ),
                    "description": tr_en(
                        f"Sürüm sabitli append dosyasını {rec}_%.bbappend biçimine taşır.",
                        f"Renames version-pinned append file to {rec}_%.bbappend.",
                    ),
                    "kind": "bbappend_wildcard",
                    "target_file": drift["append_file"],
                    "changes": {rec: f"{rec}_%.bbappend"},
                    "layer_name": drift["layer"],
                },
            }
        )

    for ov in overlayed:
        issues.append(
            {
                "id": f"warn-overlay-{ov['recipe']}",
                "severity": "warning",
                "category": "layer",
                "title": tr_en(
                    f"Örtüşen (Overlayed) Tarif: {ov['recipe']}",
                    f"Overlayed Recipe: {ov['recipe']}",
                ),
                "summary": tr_en(
                    f"{ov['active_layer']} katmanı, {ov['shadowed_layer']} içindeki "
                    f"{ov['recipe']} tarifini gölgeliyor.",
                    f"{ov['active_layer']} shadows {ov['recipe']} inside {ov['shadowed_layer']}.",
                ),
                "detail": tr_en(
                    "İstenmeyen gölgelemeleri önlemek için BBFILE_PRIORITY değerlerini kontrol edin.",
                    "Verify BBFILE_PRIORITY values to avoid unintended recipe shadowing.",
                ),
                "layer": ov["active_layer"],
                "recipe": ov["recipe"],
                "dependency_chain": [ov["active_layer"], "shadows", ov["shadowed_layer"]],
                "auto_fix": None,
            }
        )

    return layer_checks, issues
