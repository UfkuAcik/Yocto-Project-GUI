"""Tests for recipetool (6 build systems), devtool workflow, .bbappend, and interactive PTY."""

from __future__ import annotations

from typing import Any

import pytest

from bridge.event_monitor import EventMonitor
from bridge.mock_mode import MockYoctoEngine


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("bs", "expected_inherit"),
    [
        ("cmake", "inherit cmake"),
        ("meson", "inherit meson"),
        ("autotools", "inherit autotools"),
        ("cargo", "inherit cargo"),
        ("python", "inherit python_setuptools_build_meta"),
        ("go", "inherit go-mod"),
    ],
)
async def test_recipetool_generates_all_six_build_systems(bs: str, expected_inherit: str) -> None:
    async def noop(_m: str, _p: dict[str, Any]) -> None:
        return None

    engine = MockYoctoEngine(EventMonitor(noop))
    res = await engine.dispatch(
        "recipetool.create",
        {
            "name": f"sample-{bs}",
            "version": "2.1.0",
            "src_uri": "git://github.com/example/sample.git;branch=main",
            "build_system": bs,
        },
    )
    assert res["pn"] == f"sample-{bs}"
    assert expected_inherit in res["content"]


@pytest.mark.asyncio
async def test_devtool_lifecycle_bbappend_and_menuconfig_pty() -> None:
    events: list[tuple[str, dict[str, Any]]] = []

    async def capture(m: str, p: dict[str, Any]) -> None:
        events.append((m, p))

    engine = MockYoctoEngine(EventMonitor(capture))

    bbap = await engine.dispatch("recipes.create_bbappend", {"pn": "systemd", "template": "systemd"})
    assert bbap["pn"] == "systemd.bbappend"
    assert "systemd_system_unitdir" in bbap["content"]

    added = await engine.dispatch(
        "devtool.add", {"recipe": "edge-agent", "src_uri": "https://example.org/edge.tar.gz"}
    )
    assert added["entry"]["status"] == "added"

    built = await engine.dispatch("devtool.build", {"recipe": "edge-agent"})
    assert built["ok"] is True

    deployed = await engine.dispatch(
        "devtool.deploy_target", {"recipe": "edge-agent", "target_host": "10.0.0.42"}
    )
    assert "10.0.0.42" in deployed["output"]

    finished = await engine.dispatch(
        "devtool.finish", {"recipe": "edge-agent", "layer_path": "meta-custom-iot"}
    )
    assert finished["ok"] is True
    assert ".patch" in finished["patch_file"]
    assert all(e["recipe"] != "edge-agent" for e in finished["entries"])

    act = await engine.dispatch(
        "build.run_task_action", {"recipe": "linux-yocto", "action": "menuconfig"}
    )
    assert act["pty_session_id"] is not None
    sid = act["pty_session_id"]
    await engine.dispatch("pty.write", {"session_id": sid, "data": "j"})
    await engine.dispatch("pty.write", {"session_id": sid, "data": " "})
    await engine.dispatch("pty.write", {"session_id": sid, "data": "q"})
    assert any(
        m == "pty.output" and ".config kaydedildi" in p["data"] for m, p in events
    )
