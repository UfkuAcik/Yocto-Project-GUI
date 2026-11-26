"""End-to-end Phase 4 mock engine RPC tests (WIC, QEMU, SDK, SPDX/CVE, Host Copy)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from bridge.event_monitor import EventMonitor
from bridge.mock_mode import MockYoctoEngine


@pytest.mark.asyncio
async def test_phase4_wic_qemu_sdk_and_artifacts_flows(tmp_path: Path) -> None:
    events: list[tuple[str, dict[str, Any]]] = []

    async def capture(method: str, params: dict[str, Any]) -> None:
        events.append((method, params))

    monitor = EventMonitor(capture)
    engine = MockYoctoEngine(monitor)

    # 1. WIC list -> parse -> edit partition size -> serialize -> create image
    wks_list = await engine.dispatch("wic.list_wks", {})
    assert len(wks_list["files"]) >= 2
    first_wks = wks_list["files"][0]["path"]

    parsed = await engine.dispatch("wic.parse_wks", {"path": first_wks})
    assert len(parsed["partitions"]) >= 3
    parsed["partitions"][1]["size_mb"] = 256

    serialized = await engine.dispatch(
        "wic.serialize_wks", {"wks": parsed, "save_path": first_wks}
    )
    assert serialized["saved"] is True
    assert "256M" in serialized["raw_text"]

    wic_res = await engine.dispatch(
        "wic.create_image",
        {
            "wks_path": first_wks,
            "image_name": "core-image-minimal",
            "wks_content": serialized["raw_text"],
        },
    )
    assert wic_res["ok"] is True
    assert ".wic.bz2" in wic_res["output_image"]

    # 2. QEMU launch -> PTY write -> stop
    qres = await engine.dispatch(
        "qemu.launch", {"machine": "imx8mp-lpddr4-evk", "image": "core-image-minimal", "mode": "nographic"}
    )
    assert qres["ok"] is True
    assert qres["pty_session_id"]
    await engine.dispatch("pty.write", {"session_id": qres["pty_session_id"], "data": "uname -a\r"})
    stop_res = await engine.dispatch("qemu.stop", {"session_id": qres["session_id"]})
    assert stop_res["ok"] is True

    # 3. SDK list & build eSDK
    sdk_before = await engine.dispatch("sdk.list", {})
    assert len(sdk_before["sdks"]) >= 1
    esdk_res = await engine.dispatch(
        "sdk.build", {"target": "core-image-minimal", "kind": "esdk"}
    )
    assert esdk_res["ok"] is True
    assert esdk_res["sdk"]["kind"] == "esdk"
    assert "populate_sdk_ext" in esdk_res["command"]

    # 4. CVE (both formats), License Matrix export & Host artifact copy
    cves_wrynose = await engine.dispatch("artifacts.get_cves", {"format": "sbom-cve-check"})
    assert cves_wrynose["summary"]["total"] == 3
    cves_scarthgap = await engine.dispatch("artifacts.get_cves", {"format": "cve-check"})
    assert "Scarthgap" in cves_scarthgap["tool"]

    lic_csv = await engine.dispatch("artifacts.export_licenses", {"format": "csv"})
    assert lic_csv["package_count"] >= 4
    assert "linux-yocto" in lic_csv["content"]

    src_artifact = tmp_path / "core-image-minimal.wic.bz2"
    src_artifact.write_bytes(b"wic-payload-test")
    dst_dir = tmp_path / "host_out"
    copy_res = await engine.dispatch(
        "artifacts.copy_to_host",
        {"source_path": str(src_artifact), "dest_dir": str(dst_dir)},
    )
    assert copy_res["ok"] is True
    assert copy_res["bytes_copied"] == 16
    assert (dst_dir / "core-image-minimal.wic.bz2").read_bytes() == b"wic-payload-test"
