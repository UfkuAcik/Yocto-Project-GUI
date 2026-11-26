"""Transparent CLI wrapper utilities (Phase 2/3 live BitBake/devtool/kas tools)."""

from __future__ import annotations

import asyncio
import os
import signal
from typing import Any


async def terminate_process_tree(proc: asyncio.subprocess.Process, timeout_sec: float = 4.0) -> int:
    """Send graceful SIGINT first (for BitBake server cleanup), escalating to SIGTERM/kill."""
    if proc.returncode is not None:
        return proc.returncode

    try:
        if os.name == "nt":
            proc.terminate()
        else:
            proc.send_signal(signal.SIGINT)
    except ProcessLookupError:
        return 0

    try:
        return await asyncio.wait_for(proc.wait(), timeout=timeout_sec)
    except asyncio.TimeoutError:
        try:
            proc.kill()
        except ProcessLookupError:
            pass
        return await proc.wait()


def format_command_preview(parts: list[str]) -> str:
    return " ".join(parts)


__all__ = ["terminate_process_tree", "format_command_preview", "Any"]
