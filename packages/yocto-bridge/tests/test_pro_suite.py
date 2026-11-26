"""Unit & Mock E2E tests for Modül 10 — Pro Suite."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import Any

import pytest

from bridge.event_monitor import EventMonitor
from bridge.mock_mode import MockYoctoEngine
from bridge.pro_suite import (
    analyze_buildstats_records,
    build_openvex_document,
    diff_kernel_config,
    export_cra_compliance_bundle,
    generate_cicd_pipeline,
    generate_kernel_bbappend_fragment,
    generate_secure_boot_inc,
    parse_dts_tree,
    update_dts_node_status,
    validate_dts_syntax,
)


def test_kernel_fragment_and_dts_tree_parser_updater() -> None:
    diff_res = diff_kernel_config(
        "# CONFIG_CAN_FLEXCAN is not set\nCONFIG_USB_GADGET=y\n",
        "CONFIG_CAN_FLEXCAN=y\nCONFIG_USB_GADGET=y\nCONFIG_WIREGUARD=m\n",
        search="CAN",
    )
    assert len(diff_res["changes"]) == 2
    assert "CONFIG_CAN_FLEXCAN=y" in diff_res["fragment_content"]
    bbappend, bb_diff = generate_kernel_bbappend_fragment("can-enable.cfg", diff_res["fragment_content"])
    assert 'file://can-enable.cfg' in bbappend
    assert "+SRC_URI" in bb_diff

    dts = """/dts-v1/;
/ {
    flexcan1: can@308c0000 {
        compatible = "fsl,imx8mp-flexcan";
        reg = <0x308c0000 0x10000>;
        status = "disabled";
    };
};
"""
    valid, errors = validate_dts_syntax(dts)
    assert valid is True
    assert errors == []
    tree = parse_dts_tree(dts)
    assert tree["children"][0]["name"] == "can@308c0000"
    assert tree["children"][0]["status"] == "disabled"

    updated_dts, dts_diff = update_dts_node_status(dts, "/can@308c0000", "okay")
    assert 'status = "okay";' in updated_dts
    assert '+        status = "okay";' in dts_diff


def test_openvex_cra_bundle_and_secure_boot_and_buildstats_and_cicd(tmp_path: Path) -> None:
    vex = build_openvex_document(
        [
            {
                "cve_id": "CVE-2025-1234",
                "package": "busybox",
                "version": "1.37.0",
                "status": "not_affected",
                "justification": "vulnerable_code_not_in_execute_path",
                "impact_statement": "httpd disabled",
            }
        ],
        product_purl="pkg:yocto/poky/imx8mp@6.0",
    )
    assert vex["@context"] == "https://openvex.dev/ns/v0.2.0"
    assert vex["statements"][0]["justification"] == "vulnerable_code_not_in_execute_path"

    bundle = export_cra_compliance_bundle(
        tmp_path, "cra-test.zip", {"packages": []}, vex, "package,license\nbusybox,GPL-2.0-only\n"
    )
    assert bundle["ok"] is True
    with zipfile.ZipFile(bundle["bundle_path"], "r") as zf:
        names = set(zf.namelist())
        assert {"sbom.spdx.json", "openvex.json", "licenses.csv", "SHA256SUMS.txt"} <= names
        parsed_vex = json.loads(zf.read("openvex.json"))
        assert parsed_vex["@context"] == "https://openvex.dev/ns/v0.2.0"

    sb = generate_secure_boot_inc(enable_fit_sign=True, key_bits=4096, enable_dm_verity=True)
    assert 'UBOOT_SIGN_ENABLE = "1"' in sb["inc_content"]
    assert 'DM_VERITY_IMAGE = "core-image-minimal"' in sb["inc_content"]
    assert "HSM" in sb["production_warning"]

    bs = analyze_buildstats_records(
        [
            {"recipe": "linux-yocto", "task": "do_compile", "started_ts": 10.0, "ended_ts": 110.0, "cpu_percent": 90.0},
            {"recipe": "busybox", "task": "do_compile", "started_ts": 20.0, "ended_ts": 35.0, "cpu_percent": 50.0},
        ]
    )
    assert bs["top_tasks"][0]["recipe"] == "linux-yocto"

    gl = generate_cicd_pipeline("gitlab", "kas", "imx8mp-evk", "core-image-minimal")
    assert gl["filename"] == ".gitlab-ci.yml"
    assert "ghcr.io/siemens/kas/kas:latest" in gl["yaml_content"]
    gh = generate_cicd_pipeline("github", "oe-init-build-env", "imx8mp-evk", "core-image-minimal")
    assert gh["filename"] == ".github/workflows/yocto-ci.yml"
    assert "upload-artifact@v4" in gh["yaml_content"]


@pytest.mark.asyncio
async def test_mock_pro_suite_end_to_end(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, Any]]] = []

    async def capture(method: str, params: dict[str, Any]) -> None:
        events.append((method, params))

    engine = MockYoctoEngine(EventMonitor(capture))

    dt_list = await engine.dispatch("pro.dt.listFiles", {})
    dts_path = dt_list["files"][0]["path"]
    dt_res = await engine.dispatch(
        "pro.dt.updateNodeStatus",
        {"path": dts_path, "node_path": "/can@308c0000", "new_status": "okay"},
    )
    assert dt_res["valid"] is True

    qa_res = await engine.dispatch("pro.qa.runHardwareSmoke", {"machine": "imx8mp-lpddr4-evk"})
    assert qa_res["total_boot_ms"] > 1000
    assert "<!DOCTYPE html>" in qa_res["html_report"]

    vex_up = await engine.dispatch(
        "pro.cra.updateVex",
        {
            "cve_id": "CVE-2025-41203",
            "status": "not_affected",
            "justification": "inline_mitigations_already_exist",
            "impact_statement": "Firewall drops unauthenticated MQTT.",
        },
    )
    assert vex_up["entry"]["status"] == "not_affected"

    cra_zip = await engine.dispatch("pro.cra.exportBundle", {"output_dir": str(tmp_path)})
    assert Path(cra_zip["bundle_path"]).exists()
