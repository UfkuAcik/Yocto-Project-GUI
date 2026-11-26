"""Process-group subprocess runner with graceful SIGINT shutdown and 100k+ log ring buffer."""

from __future__ import annotations

import asyncio
import os
import signal
import subprocess
from collections import deque
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class ManagedSubprocess:
    proc: asyncio.subprocess.Process
    pid: int


async def spawn_managed_process(
    *args: str,
    cwd: str | None = None,
    env: dict[str, str] | None = None,
) -> ManagedSubprocess:
    """Spawn a subprocess in its own process group so SIGINT/kill cleans up child trees."""
    kwargs: dict[str, Any] = {
        "cwd": cwd,
        "env": env,
        "stdout": asyncio.subprocess.PIPE,
        "stderr": asyncio.subprocess.PIPE,
    }
    if os.name == "nt":
        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    else:
        kwargs["start_new_session"] = True

    proc = await asyncio.create_subprocess_exec(*args, **kwargs)
    return ManagedSubprocess(proc=proc, pid=proc.pid)


def _kill_process_tree_windows(pid: int) -> None:
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW,
            check=False,
        )
    except OSError:
        pass


async def terminate_gracefully(
    proc: asyncio.subprocess.Process,
    timeout_sec: float = 2.0,
) -> int:
    """Send SIGINT first (BitBake clean shutdown), escalating to full process-tree kill."""
    if proc.returncode is not None:
        return proc.returncode

    if os.name == "nt":
        try:
            proc.send_signal(signal.CTRL_BREAK_EVENT)
        except (OSError, ProcessLookupError, ValueError):
            try:
                proc.terminate()
            except ProcessLookupError:
                return 0
    else:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGINT)
        except (ProcessLookupError, PermissionError):
            try:
                proc.send_signal(signal.SIGINT)
            except ProcessLookupError:
                return 0

    try:
        return await asyncio.wait_for(proc.wait(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        if os.name == "nt":
            _kill_process_tree_windows(proc.pid)
        else:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
        try:
            return await asyncio.wait_for(proc.wait(), timeout=2.0)
        except asyncio.TimeoutError:
            return -9


class LogRingBuffer:
    """High-throughput bounded log buffer supporting 100,000+ lines with fast filtering."""

    def __init__(self, max_lines: int = 120_000) -> None:
        self._buf: deque[dict[str, Any]] = deque(maxlen=max_lines)

    def append(self, entry: dict[str, Any]) -> None:
        self._buf.append(entry)

    def append_many(self, entries: list[dict[str, Any]]) -> None:
        self._buf.extend(entries)

    def __len__(self) -> int:
        return len(self._buf)

    def filter(
        self,
        level: str | None = None,
        query: str | None = None,
        limit: int = 2000,
    ) -> list[dict[str, Any]]:
        q = (query or "").strip().lower()
        lvl = level if level and level != "ALL" else None
        out: list[dict[str, Any]] = []
        for entry in self._buf:
            if lvl and entry.get("level") != lvl:
                continue
            if q and q not in entry.get("message", "").lower():
                continue
            out.append(entry)
        if len(out) > limit:
            return out[-limit:]
        return out
