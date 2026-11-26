"""Tests for the MockYoctoEngine (builds, failure logs, SIGINT cancel, config, PTY)."""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from bridge.event_monitor import EventMonitor
from bridge.mock_mode import MockYoctoEngine


@pytest.mark.asyncio
async def test_mock_build_succeeds_and_streams_events() -> None:
    events: list[tuple[str, dict[str, Any]]] = []

    async def capture(method: str, params: dict[str, Any]) -> None:
        events.append((method, params))

    engine = MockYoctoEngine(EventMonitor(capture))
    res = await engine.dispatch(
        "build.start", {"target": "core-image-minimal", "tick_ms": 5}
    )
    assert res["status"] == "running"

    # Wait for build completion
    for _ in range(100):
        st = await engine.dispatch("build.status", {})
        if st["status"] != "running":
            break
        await asyncio.sleep(0.03)

    st = await engine.dispatch("build.status", {})
    assert st["status"] == "succeeded"
    assert st["completed_tasks"] == st["total_tasks"]
    assert st["sstate_hits"] > 0
    assert st["sstate_misses"] > 0

    methods = {m for m, _ in events}
    assert "command.executed" in methods
    assert "build.started" in methods
    assert "build.task_started" in methods
    assert "build.task_succeeded" in methods
    assert "build.log" in methods
    assert "build.completed" in methods


@pytest.mark.asyncio
async def test_mock_build_simulated_failure_and_task_log() -> None:
    events: list[tuple[str, dict[str, Any]]] = []

    async def capture(method: str, params: dict[str, Any]) -> None:
        events.append((method, params))

    engine = MockYoctoEngine(EventMonitor(capture))
    await engine.dispatch(
        "build.start",
        {"target": "core-image-minimal", "simulate_failure": True, "tick_ms": 5},
    )

    for _ in range(100):
        st = await engine.dispatch("build.status", {})
        if st["status"] != "running":
            break
        await asyncio.sleep(0.03)

    st = await engine.dispatch("build.status", {})
    assert st["status"] == "failed"
    assert st["failed_task"] is not None
    assert st["failed_task"]["recipe"] == "my-sensor-daemon"
    assert st["failed_task"]["task"] == "do_compile"

    log_res = await engine.dispatch(
        "build.get_task_log", {"recipe": "my-sensor-daemon", "task": "do_compile"}
    )
    assert "mosquitto_lib_version" in log_res["log_content"]
    assert "cmake_runcmake_build" in log_res["run_content"]


@pytest.mark.asyncio
async def test_mock_build_cancel_leaves_no_active_tasks() -> None:
    async def noop(_m: str, _p: dict[str, Any]) -> None:
        return None

    engine = MockYoctoEngine(EventMonitor(noop))
    await engine.dispatch("build.start", {"target": "core-image-minimal", "tick_ms": 50})
    await asyncio.sleep(0.04)

    cancel_res = await engine.dispatch("build.cancel", {})
    assert cancel_res["ok"] is True
    assert cancel_res["status"] == "cancelled"

    st = await engine.dispatch("build.status", {})
    assert st["status"] == "cancelled"
    assert st["active_tasks"] == []


@pytest.mark.asyncio
async def test_comment_preserving_local_conf_and_fragments_and_pty() -> None:
    events: list[tuple[str, dict[str, Any]]] = []

    async def capture(method: str, params: dict[str, Any]) -> None:
        events.append((method, params))

    engine = MockYoctoEngine(EventMonitor(capture))
    diff_res = await engine.dispatch(
        "config.preview_diff", {"updates": {"MACHINE": "qemuarm64"}}
    )
    assert "# Yocto Studio Managed Configuration" in diff_res["new_content"]
    assert '-MACHINE ??= "imx8mp-lpddr4-evk"' in diff_res["diff"]
    assert '+MACHINE ??= "qemuarm64"' in diff_res["diff"]

    applied = await engine.dispatch(
        "config.apply_changes", {"updates": {"MACHINE": "qemuarm64"}}
    )
    assert applied["variables"]["MACHINE"] == "qemuarm64"
    assert "# Hedef Donanım (Machine Selection)" in applied["content"]

    insp = await engine.dispatch("config.inspect_variable", {"name": "MACHINE"})
    assert insp["final_value"] == "qemuarm64"
    assert len(insp["history"]) >= 2

    frags = await engine.dispatch(
        "config.toggle_fragment", {"id": "toolchain/clang-target", "enabled": True}
    )
    assert any(f["id"] == "toolchain/clang-target" and f["enabled"] for f in frags["fragments"])

    pty_res = await engine.dispatch("pty.open", {})
    sid = pty_res["session_id"]
    await engine.dispatch("pty.write", {"session_id": sid, "data": "bitbake --version\n"})
    assert any(
        m == "pty.output" and "BitBake Build Tool Core" in p["data"] for m, p in events
    )
    await engine.dispatch("pty.close", {"session_id": sid})
