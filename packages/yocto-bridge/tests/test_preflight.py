"""Unit & Mock E2E tests for Pre-Flight Inspector & Image Advisor (Module 9)."""

from __future__ import annotations

from typing import Any

import pytest

from bridge.event_monitor import EventMonitor
from bridge.mock_mode import MockYoctoEngine
from bridge.preflight import (
    analyze_features_licenses_and_bloat,
    apply_local_conf_fix,
    audit_layers,
    build_version_matrix,
    detect_bbappend_version_drift,
    estimate_setscene_hit_rate,
    generate_optimization_plan,
    parse_bitbake_s_output,
    parse_dryrun_errors,
    parse_layer_conf,
)


def test_layer_audit_catches_compat_mismatch_missing_dep_and_bbappend_drift() -> None:
    layer_conf_legacy = """
BBFILE_COLLECTIONS += "legacy-vendor"
LAYERDEPENDS_legacy-vendor = "core networking-layer"
LAYERSERIES_COMPAT_legacy-vendor = "kirkstone"
BBFILE_PRIORITY_legacy-vendor = "6"
"""
    parsed_conf = parse_layer_conf(layer_conf_legacy)
    assert parsed_conf["compat"] == ["kirkstone"]
    assert "networking-layer" in parsed_conf["depends"]

    layers = [
        {"name": "openembedded-core", "path": "/src/meta", "priority": 5, "compat": ["wrynose"]},
        {"name": "meta-legacy-vendor", "path": "/src/meta-legacy", "priority": 6},
    ]
    appends = [
        {
            "recipe": "my-sensor-daemon",
            "layer": "meta-legacy-vendor",
            "append_file": "/src/meta-legacy/recipes-apps/my-sensor-daemon_1.1.4.bbappend",
        }
    ]
    drifted = detect_bbappend_version_drift(appends, {"my-sensor-daemon": "1.2.0"})
    assert len(drifted) == 1
    assert drifted[0]["expected_pv"] == "1.1.4"
    assert drifted[0]["actual_pv"] == "1.2.0"

    checks, issues = audit_layers(
        layers=layers,
        active_series="wrynose",
        active_recipe_versions={"my-sensor-daemon": "1.2.0"},
        layer_confs={"meta-legacy-vendor": layer_conf_legacy},
        explicit_appends=appends,
    )
    assert len(checks) == 2
    ids = {i["id"] for i in issues}
    assert "fix-layer-compat-meta-legacy-vendor" in ids
    assert "fix-layer-dep-meta-legacy-vendor-networking-layer" in ids
    assert "fix-bbappend-drift-my-sensor-daemon" in ids


def test_version_matrix_catches_preferred_conflicts_and_bitbake_s() -> None:
    s_out = """
linux-yocto   :6.12.19-r0   :6.12.19-r0   :6.12.22
openssl       :3.0.14-r0    :3.0.14-r0
"""
    parsed = parse_bitbake_s_output(s_out)
    assert len(parsed) == 2
    assert parsed[0]["recipe"] == "linux-yocto"

    recipes = [
        {"pn": "openssl", "pv": "3.0.14", "layer": "openembedded-core", "priority": 5},
        {"pn": "linux-yocto", "pv": "6.12.19", "layer": "openembedded-core", "priority": 5},
    ]
    entries, issues = build_version_matrix(
        recipes,
        local_conf_vars={"PREFERRED_VERSION_linux-yocto": "6.6.10"},
        virtual_providers={"virtual/kernel": ["linux-yocto", "linux-imx"]},
    )
    assert any(e["upgrade_status"] == "security-risk" for e in entries)
    assert any(i["id"] == "fix-prefver-linux-yocto" for i in issues)
    assert any(i["id"] == "warn-prefprov-virtual/kernel" for i in issues)


def test_dryrun_features_license_shield_and_bloat_detection() -> None:
    dry_issues = parse_dryrun_errors("ERROR: Nothing PROVIDES 'libmissing-foo'")
    assert len(dry_issues) == 1
    assert dry_issues[0]["severity"] == "blocker"

    res = analyze_features_licenses_and_bloat(
        target="core-image-minimal",
        distro_features=["systemd", "sysvinit", "opengl"],
        machine_features=["alsa", "usbhost"],
        incompatible_licenses=["GPL-3.0*"],
        packages=[
            {"name": "bash", "version": "5.2.37", "license": "GPL-3.0-or-later"},
            {"name": "xserver-xorg", "version": "21.1", "license": "MIT"},
        ],
    )
    ids = {i["id"] for i in res["issues"]}
    assert "fix-init-conflict" in ids
    assert "warn-gpu-mismatch" in ids
    assert "fix-license-bash" in ids
    assert "fix-bloat-xserver-xorg" in ids
    assert len(res["license_violations"]) == 1
    assert len(res["bloat_items"]) == 1


def test_optimizer_psi_rm_work_sstate_and_lossless_diff() -> None:
    local_conf = "# Keep this header comment\nMACHINE ??= \"imx8mp-lpddr4-evk\"\nPACKAGE_CLASSES ?= \"package_rpm\"\n"
    plan = generate_optimization_plan(
        local_conf,
        {
            "cpu_cores": 8,
            "ram_total_gb": 16.0,
            "ram_available_gb": 12.0,
            "disk_free_gb": 90.0,
            "psi_supported": True,
            "provider": "wsl2",
        },
    )
    rec_ids = {r["id"] for r in plan["recommendations"]}
    assert {"opt-threads", "opt-psi", "opt-rm-work", "opt-pkg-ipk"} <= rec_ids

    psi_fix = next(r["auto_fix"] for r in plan["recommendations"] if r["id"] == "opt-psi")
    updated, diff = apply_local_conf_fix(local_conf, psi_fix)
    assert "# Keep this header comment" in updated
    assert "BB_PRESSURE_MAX_CPU" in updated
    assert "+BB_PRESSURE_MAX_MEMORY" in diff

    hit_pct, total, hits = estimate_setscene_hit_rate(
        "NOTE: Tasks Summary: Attempted 1000 tasks of which 780 didn't need to be rerun."
    )
    assert hit_pct == 78
    assert total == 1000
    assert hits == 780


@pytest.mark.asyncio
async def test_mock_preflight_audit_and_autofix_increases_score() -> None:
    events: list[tuple[str, dict[str, Any]]] = []

    async def capture(method: str, params: dict[str, Any]) -> None:
        events.append((method, params))

    engine = MockYoctoEngine(EventMonitor(capture))
    before = await engine.dispatch("preflight.runAudit", {"target": "core-image-minimal"})
    assert before["blockers"] >= 2
    assert before["score"] < 100

    first_blocker = next(i for i in before["issues"] if i["severity"] == "blocker" and i.get("auto_fix"))
    dry = await engine.dispatch(
        "preflight.applyFix",
        {"fix": first_blocker["auto_fix"], "dry_run": True, "target": "core-image-minimal"},
    )
    assert dry["applied"] is False
    assert dry["updated_score"] == before["score"]

    applied = await engine.dispatch(
        "preflight.applyFix",
        {"fix": first_blocker["auto_fix"], "dry_run": False, "target": "core-image-minimal"},
    )
    assert applied["applied"] is True
    assert applied["updated_score"] > before["score"]
    assert applied["updated_report"]["blockers"] == before["blockers"] - 1

    # Also verify VersionMatrix, checkUpgrades, probeSstate, getOptimizationPlan
    vm = await engine.dispatch("preflight.getVersionMatrix", {"target": "core-image-minimal"})
    assert len(vm["entries"]) >= 4
    upg = await engine.dispatch("preflight.checkUpgrades", {})
    assert upg["outdated_count"] >= 1
    sstate = await engine.dispatch("preflight.probeSstate", {"target": "core-image-minimal"})
    assert sstate["estimated_hit_percent"] > 0
    opt = await engine.dispatch("preflight.getOptimizationPlan", {})
    assert len(opt["recommendations"]) >= 1
