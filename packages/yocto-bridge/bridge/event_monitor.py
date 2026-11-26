"""Normalized BitBake event emitter (XML-RPC & simulated events -> JSON-RPC notifications)."""

from __future__ import annotations

import time
import xmlrpc.client
from collections.abc import Awaitable, Callable
from typing import Any

NotifyCallback = Callable[[str, dict[str, Any]], Awaitable[None]]


def normalize_bitbake_event(
    event_name: str,
    payload: dict[str, Any],
    build_id: str,
    seq: int = 1,
) -> tuple[str, dict[str, Any]] | None:
    """Map an authentic BitBake XML-RPC event to a canonical Yocto Studio notification."""
    ts = float(payload.get("ts") or time.time())
    if event_name == "bb.event.BuildStarted":
        return (
            "build.started",
            {
                "build_id": build_id,
                "target": str(payload.get("target", "core-image-minimal")),
                "machine": str(payload.get("machine", "qemux86-64")),
                "distro": str(payload.get("distro", "poky")),
                "total_tasks": int(payload.get("total", 0)),
                "ts": ts,
            },
        )

    if event_name in ("bb.runqueue.runQueueTaskStarted", "bb.runqueue.sceneQueueTaskStarted"):
        recipe = str(payload.get("pn", "unknown"))
        task = str(payload.get("taskname", "do_build"))
        return (
            "build.task_started",
            {
                "build_id": build_id,
                "task_id": f"{recipe}:{task}",
                "recipe": recipe,
                "task": task,
                "worker_slot": int(payload.get("slot", 0)),
                "from_sstate": event_name.endswith("sceneQueueTaskStarted"),
                "ts": ts,
            },
        )

    if event_name == "bb.runqueue.runQueueTaskProgress":
        recipe = str(payload.get("pn", "unknown"))
        task = str(payload.get("taskname", "do_build"))
        return (
            "build.task_progress",
            {
                "build_id": build_id,
                "task_id": f"{recipe}:{task}",
                "recipe": recipe,
                "task": task,
                "worker_slot": int(payload.get("slot", 0)),
                "progress": float(payload.get("progress", 0)),
                "ts": ts,
            },
        )

    if event_name in ("bb.runqueue.runQueueTaskCompleted", "bb.runqueue.sceneQueueTaskCompleted"):
        recipe = str(payload.get("pn", "unknown"))
        task = str(payload.get("taskname", "do_build"))
        return (
            "build.task_succeeded",
            {
                "build_id": build_id,
                "task_id": f"{recipe}:{task}",
                "recipe": recipe,
                "task": task,
                "worker_slot": int(payload.get("slot", 0)),
                "from_sstate": event_name.endswith("sceneQueueTaskCompleted"),
                "duration_ms": float(payload.get("duration_ms", 0.0)),
                "completed_tasks": int(payload.get("completed", 0)),
                "total_tasks": int(payload.get("total", 0)),
                "sstate_hits": int(payload.get("sstate_hits", 0)),
                "sstate_misses": int(payload.get("sstate_misses", 0)),
                "ts": ts,
            },
        )

    if event_name == "bb.runqueue.runQueueTaskFailed":
        recipe = str(payload.get("pn", "unknown"))
        task = str(payload.get("taskname", "do_compile"))
        return (
            "build.task_failed",
            {
                "build_id": build_id,
                "task_id": f"{recipe}:{task}",
                "recipe": recipe,
                "task": task,
                "worker_slot": int(payload.get("slot", 0)),
                "exit_code": int(payload.get("exitcode", 1)),
                "error_summary": str(payload.get("msg", "Task failed")),
                "log_path": str(payload.get("logfile", "")),
                "run_path": str(payload.get("runfile", "")),
                "ts": ts,
            },
        )

    if event_name == "bb.event.BuildCompleted":
        failures = int(payload.get("failures", 0))
        return (
            "build.completed",
            {
                "build_id": build_id,
                "target": str(payload.get("target", "core-image-minimal")),
                "status": "failed" if failures > 0 else "succeeded",
                "completed_tasks": int(payload.get("completed", 0)),
                "total_tasks": int(payload.get("total", 0)),
                "sstate_hits": int(payload.get("sstate_hits", 0)),
                "sstate_misses": int(payload.get("sstate_misses", 0)),
                "duration_ms": float(payload.get("duration_ms", 0.0)),
                "ts": ts,
            },
        )

    if event_name == "logging.LogRecord":
        level_raw = str(payload.get("levelname", "NOTE")).upper()
        level = level_raw if level_raw in ("NOTE", "WARNING", "ERROR", "DEBUG") else "NOTE"
        return (
            "build.log",
            {
                "build_id": build_id,
                "seq": seq,
                "level": level,
                "recipe": payload.get("pn"),
                "task": payload.get("taskname"),
                "message": str(payload.get("msg", "")),
                "ts": ts,
            },
        )

    return None


class BitBakeXmlRpcClient:
    """Thin stdlib XML-RPC client for connecting to an active BitBake server."""

    def __init__(self, server_url: str) -> None:
        self.server_url = server_url
        self._proxy = xmlrpc.client.ServerProxy(server_url, allow_none=True)

    def ping(self) -> bool:
        try:
            self._proxy.runCommand(["ping"])
            return True
        except Exception:  # noqa: BLE001
            return False

    def run_command(self, cmd: list[Any]) -> Any:
        return self._proxy.runCommand(cmd)

    def get_event(self) -> Any:
        return self._proxy.getEvent()


class EventMonitor:
    """Translates BitBake / mock build events into canonical Bridge notifications."""

    def __init__(self, notify: NotifyCallback) -> None:
        self._notify = notify
        self._seq = 0

    def next_seq(self) -> int:
        self._seq += 1
        return self._seq

    async def emit_bitbake_event(
        self, event_name: str, payload: dict[str, Any], build_id: str
    ) -> None:
        mapped = normalize_bitbake_event(event_name, payload, build_id, seq=self.next_seq())
        if mapped is not None:
            await self._notify(mapped[0], mapped[1])

    async def emit_command(
        self,
        cmd_id: str,
        command: str,
        cwd: str,
        provider: str,
        status: str,
    ) -> None:
        await self._notify(
            "command.executed",
            {
                "id": cmd_id,
                "command": command,
                "cwd": cwd,
                "provider": provider,
                "status": status,
                "ts": time.time(),
            },
        )

    async def emit_log(
        self,
        build_id: str,
        level: str,
        message: str,
        recipe: str | None = None,
        task: str | None = None,
    ) -> None:
        await self._notify(
            "build.log",
            {
                "build_id": build_id,
                "seq": self.next_seq(),
                "level": level,
                "recipe": recipe,
                "task": task,
                "message": message,
                "ts": time.time(),
            },
        )

    async def emit(self, method: str, params: dict[str, Any]) -> None:
        await self._notify(method, params)
