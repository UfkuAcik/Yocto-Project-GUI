"""CLI entrypoint for the Yocto Studio Linux-side daemon (`yocto-bridge`)."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
from typing import Any

from bridge.event_monitor import EventMonitor
from bridge.live_engine import LiveYoctoEngine
from bridge.mock_mode import MockYoctoEngine
from bridge.ws_server import AsyncJsonRpcServer

LOGGER = logging.getLogger("yocto_bridge")


class YoctoBridgeApp:
    """Coordinates the JSON-RPC/WebSocket server, EventMonitor, and active engine."""

    def __init__(
        self,
        mock: bool = True,
        host: str = "127.0.0.1",
        port: int = 18765,
        workspace: str | None = None,
        auth_token: str | None = None,
    ) -> None:
        self.mock = mock
        self.host = host
        self.requested_port = port
        self.workspace = workspace
        self.stop_event = asyncio.Event()

        self.server = AsyncJsonRpcServer(
            dispatcher=self._dispatch,
            health_provider=self._health,
            host=host,
            port=port,
            auth_token=auth_token,
        )
        self.monitor = EventMonitor(notify=self.server.broadcast_notification)
        self.engine: Any = (
            MockYoctoEngine(self.monitor)
            if mock
            else LiveYoctoEngine(self.monitor, workspace or ".")
        )

    @property
    def port(self) -> int:
        return self.server.port

    def _health(self) -> dict[str, Any]:
        return self.engine.get_health_info()

    async def _dispatch(self, method: str, params: dict[str, Any]) -> Any:
        if method == "bridge.shutdown":
            self.stop_event.set()
            return {"ok": True}
        return await self.engine.dispatch(method, params)

    async def start(self) -> None:
        await self.server.start()
        if hasattr(self.engine, "start_background_tasks"):
            self.engine.start_background_tasks()

    async def stop(self) -> None:
        if hasattr(self.engine, "stop_background_tasks"):
            await self.engine.stop_background_tasks()
        await self.server.stop()

    async def run_forever(self) -> None:
        await self.start()
        mode = "mock" if self.mock else "live"
        ready_payload = json.dumps({"port": self.port, "host": self.host, "mode": mode})
        print(f"YOCTO_BRIDGE_READY {ready_payload}", flush=True)

        loop = asyncio.get_running_loop()
        for sig_name in ("SIGINT", "SIGTERM"):
            sig = getattr(signal, sig_name, None)
            if sig is not None:
                try:
                    loop.add_signal_handler(sig, self.stop_event.set)
                except NotImplementedError:
                    pass

        try:
            await self.stop_event.wait()
        finally:
            await self.stop()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Yocto Studio JSON-RPC 2.0 / WebSocket bridge")
    parser.add_argument("--mock", action="store_true", default=False, help="Run in mock mode")
    parser.add_argument("--live", action="store_true", default=False, help="Run against a real Yocto workspace")
    parser.add_argument("--workspace", default=None, help="Path to Yocto workspace for --live mode")
    parser.add_argument("--host", default="127.0.0.1", help="Bind host")
    parser.add_argument("--port", type=int, default=18765, help="Bind port (0 for ephemeral)")
    parser.add_argument(
        "--token",
        default=os.environ.get("YOCTO_BRIDGE_TOKEN") or None,
        help="Optional shared bearer token for HTTP/WS authentication",
    )
    parser.add_argument("--log-level", default="INFO", help="Logging level")
    args = parser.parse_args(argv)

    use_mock = not args.live
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )

    app = YoctoBridgeApp(
        mock=use_mock,
        host=args.host,
        port=args.port,
        workspace=args.workspace,
        auth_token=args.token,
    )
    try:
        asyncio.run(app.run_forever())
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
