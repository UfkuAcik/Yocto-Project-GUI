"""End-to-end TCP WebSocket integration test for YoctoBridgeApp."""

from __future__ import annotations

import asyncio
import json

import pytest

from bridge.server import YoctoBridgeApp
from bridge.ws_server import OPCODE_TEXT, read_ws_frame
from tests.test_ws_server import _build_masked_client_frame, _ws_connect


@pytest.mark.asyncio
async def test_live_bridge_ws_build_stream_and_shutdown() -> None:
    app = YoctoBridgeApp(mock=True, host="127.0.0.1", port=0)
    await app.start()
    try:
        reader, writer = await _ws_connect(app.port)
        try:
            # 1. Validate /mnt/c rejection over live WS
            req_bad = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "env.validate_path",
                    "params": {"path": "/mnt/c/yocto", "provider": "wsl2"},
                }
            ).encode("utf-8")
            writer.write(_build_masked_client_frame(OPCODE_TEXT, req_bad))
            await writer.drain()

            while True:
                _, _, payload = await asyncio.wait_for(read_ws_frame(reader), timeout=3.0)
                msg = json.loads(payload.decode("utf-8"))
                if msg.get("id") == 1:
                    assert msg["result"]["valid"] is False
                    assert msg["result"]["error_code"] == -32001
                    break

            # 2. Trigger fast mock build and observe streamed build.completed
            req_build = json.dumps(
                {
                    "jsonrpc": "2.0",
                    "id": 2,
                    "method": "build.start",
                    "params": {"target": "core-image-minimal", "tick_ms": 5},
                }
            ).encode("utf-8")
            writer.write(_build_masked_client_frame(OPCODE_TEXT, req_build))
            await writer.drain()

            saw_start_reply = False
            saw_completed = False
            for _ in range(300):
                _, _, payload = await asyncio.wait_for(read_ws_frame(reader), timeout=5.0)
                msg = json.loads(payload.decode("utf-8"))
                if msg.get("id") == 2:
                    saw_start_reply = True
                    assert msg["result"]["status"] == "running"
                if msg.get("method") == "build.completed":
                    saw_completed = True
                    assert msg["params"]["status"] == "succeeded"
                    break

            assert saw_start_reply
            assert saw_completed
        finally:
            writer.close()
    finally:
        await app.stop()
