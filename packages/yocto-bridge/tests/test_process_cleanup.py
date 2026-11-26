"""Tests for SIGINT graceful shutdown and zero orphan process tree cleanup."""

from __future__ import annotations

import asyncio
import os
import sys
import time

import pytest

from bridge.tools.process_runner import spawn_managed_process, terminate_gracefully


def _is_pid_alive(pid: int) -> bool:
    if os.name == "nt":
        import ctypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            if ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return code.value == STILL_ACTIVE
            return False
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


@pytest.mark.asyncio
async def test_terminate_gracefully_leaves_zero_orphan_processes() -> None:
    child_script = (
        "import subprocess, sys, time; "
        "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); "
        "print(c.pid, flush=True); "
        "time.sleep(30)"
    )
    managed = await spawn_managed_process(sys.executable, "-c", child_script)
    assert managed.proc.stdout is not None
    raw_pid = await asyncio.wait_for(managed.proc.stdout.readline(), timeout=5.0)
    grandchild_pid = int(raw_pid.decode().strip())
    assert _is_pid_alive(managed.pid)
    assert _is_pid_alive(grandchild_pid)

    await terminate_gracefully(managed.proc, timeout_sec=0.5)

    # Give OS a brief moment to reap handles
    deadline = time.time() + 2.0
    while time.time() < deadline and (_is_pid_alive(managed.pid) or _is_pid_alive(grandchild_pid)):
        await asyncio.sleep(0.05)

    assert not _is_pid_alive(managed.pid)
    assert not _is_pid_alive(grandchild_pid)
