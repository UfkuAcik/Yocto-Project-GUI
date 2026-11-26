"""Tests for the pure-stdlib RFC 6455 WebSocket + HTTP JSON-RPC server."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import struct
from typing import Any

import pytest

from bridge.ws_server import (
    OPCODE_PING,
    OPCODE_PONG,
    OPCODE_TEXT,
    AsyncJsonRpcServer,
    read_ws_frame,
)


def _build_masked_client_frame(opcode: int, payload: bytes) -> bytes:
    first = 0x80 | opcode
    length = len(payload)
    if length < 126:
        header = struct.pack("!BB", first, 0x80 | length)
    elif length < 65536:
        header = struct.pack("!BBH", first, 0x80 | 126, length)
    else:
        header = struct.pack("!BBQ", first, 0x80 | 127, length)
    mask = os.urandom(4)
    masked = bytes(payload[i] ^ mask[i % 4] for i in range(length))
    return header + mask + masked


async def _ws_connect(port: int) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    req = (
        f"GET /ws HTTP/1.1\r\n"
        f"Host: 127.0.0.1:{port}\r\n"
        f"Upgrade: websocket\r\n"
        f"Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        f"Sec-WebSocket-Version: 13\r\n\r\n"
    ).encode("ascii")
    writer.write(req)
    await writer.drain()
    head = await reader.readuntil(b"\r\n\r\n")
    expected_accept = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
    ).decode("ascii")
    text = head.decode("ascii")
    assert "101 Switching Protocols" in text
    assert expected_accept in text
    return reader, writer


@pytest.mark.asyncio
async def test_http_health_and_rpc() -> None:
    async def dispatcher(method: str, params: dict[str, Any]) -> Any:
        return {"echo_method": method, "params": params}

    srv = AsyncJsonRpcServer(
        dispatcher=dispatcher,
        health_provider=lambda: {"status": "ok", "mode": "mock"},
        port=0,
    )
    await srv.start()
    try:
        # GET /health
        r, w = await asyncio.open_connection("127.0.0.1", srv.port)
        w.write(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
        await w.drain()
        raw = await r.read()
        w.close()
        body = raw.split(b"\r\n\r\n", 1)[1]
        assert json.loads(body)["status"] == "ok"

        # POST /rpc
        payload = json.dumps({"jsonrpc": "2.0", "id": 42, "method": "test.echo", "params": {"x": 1}})
        r2, w2 = await asyncio.open_connection("127.0.0.1", srv.port)
        w2.write(
            (
                f"POST /rpc HTTP/1.1\r\nHost: localhost\r\n"
                f"Content-Length: {len(payload)}\r\n\r\n{payload}"
            ).encode()
        )
        await w2.drain()
        raw2 = await r2.read()
        w2.close()
        resp = json.loads(raw2.split(b"\r\n\r\n", 1)[1])
        assert resp["id"] == 42
        assert resp["result"]["echo_method"] == "test.echo"
    finally:
        await srv.stop()


@pytest.mark.asyncio
async def test_ws_ping_pong_and_extended_payload() -> None:
    async def dispatcher(method: str, params: dict[str, Any]) -> Any:
        return {"method": method, "len": len(params.get("blob", ""))}

    srv = AsyncJsonRpcServer(
        dispatcher=dispatcher,
        health_provider=lambda: {"status": "ok"},
        port=0,
    )
    await srv.start()
    try:
        reader, writer = await _ws_connect(srv.port)
        try:
            # Test Ping -> Pong
            writer.write(_build_masked_client_frame(OPCODE_PING, b"ping123"))
            await writer.drain()
            fin, opcode, payload = await read_ws_frame(reader)
            assert fin and opcode == OPCODE_PONG and payload == b"ping123"

            # Test >126 byte extended frame
            big_blob = "A" * 512
            req_bytes = json.dumps(
                {"jsonrpc": "2.0", "id": "big", "method": "big.test", "params": {"blob": big_blob}}
            ).encode("utf-8")
            writer.write(_build_masked_client_frame(OPCODE_TEXT, req_bytes))
            await writer.drain()

            fin2, opcode2, payload2 = await read_ws_frame(reader)
            assert fin2 and opcode2 == OPCODE_TEXT
            parsed = json.loads(payload2.decode("utf-8"))
            assert parsed["id"] == "big"
            assert parsed["result"]["len"] == 512
        finally:
            writer.close()
    finally:
        await srv.stop()
