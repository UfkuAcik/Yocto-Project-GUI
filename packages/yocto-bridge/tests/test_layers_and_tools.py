"""Tests for Yocto layer tools, compatibility checks, and LiveYoctoEngine."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from bridge.event_monitor import EventMonitor
from bridge.live_engine import LiveYoctoEngine
from bridge.tools.yocto_tools import (
    check_layer_compatibility,
    create_layer_skeleton,
    parse_show_appends,
    parse_show_layers,
    parse_show_overlayed,
)


def test_create_layer_skeleton_and_parsers(tmp_path: Path) -> None:
    created = create_layer_skeleton(
        tmp_path,
        name="custom-sensor",
        priority=9,
        compat=["wrynose", "scarthgap"],
        description="Test sensor layer",
    )
    assert len(created) == 4
    layer_conf = (tmp_path / "meta-custom-sensor" / "conf" / "layer.conf").read_text(encoding="utf-8")
    assert 'BBFILE_PRIORITY_meta-custom-sensor = "9"' in layer_conf
    assert 'LAYERSERIES_COMPAT_meta-custom-sensor = "wrynose scarthgap"' in layer_conf

    sample_layers = (
        "NOTE: Starting bitbake server...\n"
        "layer                 path                                      priority\n"
        "==========================================================================\n"
        "meta                  /yocto/layers/meta                        5\n"
        "meta-oe               /yocto/layers/meta-oe                     6\n"
    )
    parsed_layers = parse_show_layers(sample_layers)
    assert len(parsed_layers) == 2
    assert parsed_layers[1]["priority"] == 6

    sample_appends = "busybox_1.37.0.bb:\n  /yocto/meta-custom/recipes-core/busybox/busybox_%.bbappend\n"
    appends = parse_show_appends(sample_appends)
    assert len(appends) == 1
    assert appends[0]["recipe"] == "busybox_1.37.0.bb"

    sample_overlay = (
        "openssl_3.5.0.bb:\n"
        "  /yocto/meta-custom/recipes-connectivity/openssl/openssl_3.5.0.bb\n"
        "  /yocto/meta/recipes-connectivity/openssl/openssl_3.5.0.bb\n"
    )
    overlayed = parse_show_overlayed(sample_overlay)
    assert len(overlayed) == 1
    assert overlayed[0]["active_layer"] == "meta-custom"


def test_compatibility_detects_series_mismatch_and_priority_collision() -> None:
    report = check_layer_compatibility(
        [
            {"name": "meta-a", "priority": 7, "compat": ["wrynose"]},
            {"name": "meta-b", "priority": 7, "compat": ["kirkstone"]},
        ],
        active_series="wrynose",
    )
    assert report["ok"] is False
    kinds = {i["kind"] for i in report["issues"]}
    assert "compat_mismatch" in kinds
    assert "priority_collision" in kinds


@pytest.mark.asyncio
async def test_live_engine_on_temp_workspace(tmp_path: Path) -> None:
    conf_dir = tmp_path / "build" / "conf"
    conf_dir.mkdir(parents=True)
    (conf_dir / "local.conf").write_text(
        '# Keep my comment\nMACHINE ??= "qemux86-64"\nDISTRO ?= "poky"\n',
        encoding="utf-8",
    )
    (conf_dir / "bblayers.conf").write_text(
        'BBLAYERS ?= " \\\n  /yocto/meta \\\n"\n',
        encoding="utf-8",
    )

    events: list[tuple[str, dict[str, Any]]] = []

    async def capture(m: str, p: dict[str, Any]) -> None:
        events.append((m, p))

    engine = LiveYoctoEngine(EventMonitor(capture), str(tmp_path))
    conf_state = await engine.dispatch("config.get_local_conf", {})
    assert conf_state["variables"]["MACHINE"] == "qemux86-64"
    assert conf_state["comments_count"] == 1

    applied = await engine.dispatch("config.apply_changes", {"updates": {"MACHINE": "qemuarm64"}})
    assert "# Keep my comment" in applied["content"]
    assert applied["variables"]["MACHINE"] == "qemuarm64"

    created = await engine.dispatch(
        "layers.create_layer", {"name": "meta-test-bsp", "priority": 9}
    )
    assert created["layer"]["name"] == "meta-test-bsp"
    assert (tmp_path / "layers" / "meta-test-bsp" / "conf" / "layer.conf").exists()
