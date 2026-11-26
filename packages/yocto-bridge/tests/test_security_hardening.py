"""Security hardening tests for AsyncJsonRpcServer and LiveYoctoEngine."""

from __future__ import annotations

import asyncio
import base64
import json
import os
from pathlib import Path
from typing import Any

import pytest

from bridge.event_monitor import EventMonitor
from bridge.live_engine import LiveYoctoEngine
from bridge.protocol import RpcError, RpcErrorCode
from bridge.ws_server import (
    MAX_HTTP_BODY_BYTES,
    AsyncJsonRpcServer,
    is_allowed_host,
    is_allowed_origin,
)


async def _raw_http(port: int, request_bytes: bytes) -> tuple[int, dict[str, str], bytes]:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        writer.write(request_bytes)
        await writer.drain()
        raw = await reader.read()
    finally:
        writer.close()
    head_bytes, _, body = raw.partition(b"\r\n\r\n")
    lines = head_bytes.decode("latin-1").split("\r\n")
    status = int(lines[0].split(" ", 2)[1])
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return status, headers, body


async def _raw_ws_handshake(port: int, extra_headers: str = "", path: str = "/ws") -> int:
    reader, writer = await asyncio.open_connection("127.0.0.1", port)
    try:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: 127.0.0.1:{port}\r\n"
            f"Upgrade: websocket\r\n"
            f"Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n"
            f"{extra_headers}\r\n"
        ).encode("ascii")
        writer.write(req)
        await writer.drain()
        head = await reader.readuntil(b"\r\n\r\n")
        status_line = head.decode("latin-1").split("\r\n", 1)[0]
        return int(status_line.split(" ", 2)[1])
    finally:
        writer.close()


def test_origin_and_host_validation_helpers() -> None:
    assert is_allowed_origin(None) is True
    assert is_allowed_origin("") is True
    assert is_allowed_origin("http://localhost:1420") is True
    assert is_allowed_origin("http://127.0.0.1:5173") is True
    assert is_allowed_origin("https://tauri.localhost") is True
    assert is_allowed_origin("tauri://localhost") is True
    assert is_allowed_origin("null") is False
    assert is_allowed_origin("https://evil.example") is False
    assert is_allowed_origin("http://localhost.evil.com") is False

    assert is_allowed_host("127.0.0.1:18765", "127.0.0.1") is True
    assert is_allowed_host("localhost:18765", "127.0.0.1") is True
    assert is_allowed_host("[::1]:18765", "127.0.0.1") is True
    assert is_allowed_host("attacker.evil:18765", "127.0.0.1") is False


@pytest.mark.asyncio
async def test_ws_server_blocks_untrusted_origin_host_and_oversized_body() -> None:
    async def dispatcher(method: str, params: dict[str, Any]) -> Any:
        return {"method": method, "params": params}

    srv = AsyncJsonRpcServer(
        dispatcher=dispatcher,
        health_provider=lambda: {"status": "ok"},
        host="127.0.0.1",
        port=0,
    )
    await srv.start()
    try:
        # 1. Untrusted Origin rejected on GET /health, OPTIONS /rpc, POST /rpc, and /ws
        for req in [
            b"GET /health HTTP/1.1\r\nHost: localhost\r\nOrigin: https://evil.example\r\n\r\n",
            b"OPTIONS /rpc HTTP/1.1\r\nHost: localhost\r\nOrigin: https://evil.example\r\n\r\n",
            b"POST /rpc HTTP/1.1\r\nHost: localhost\r\nOrigin: null\r\nContent-Length: 2\r\n\r\n{}",
        ]:
            status, _, _ = await _raw_http(srv.port, req)
            assert status == 403

        ws_status = await _raw_ws_handshake(srv.port, extra_headers="Origin: https://evil.example\r\n")
        assert ws_status == 403

        # 2. DNS rebinding Host rejected
        status_host, _, _ = await _raw_http(
            srv.port,
            b"GET /health HTTP/1.1\r\nHost: attacker.evil:18765\r\n\r\n",
        )
        assert status_host == 403

        # 3. Allowed local origins reflected explicitly (never '*')
        status_ok, hdrs_ok, _ = await _raw_http(
            srv.port,
            b"GET /health HTTP/1.1\r\nHost: localhost\r\nOrigin: http://localhost:1420\r\n\r\n",
        )
        assert status_ok == 200
        assert hdrs_ok.get("access-control-allow-origin") == "http://localhost:1420"
        assert hdrs_ok.get("vary") == "Origin"

        ws_tauri = await _raw_ws_handshake(srv.port, extra_headers="Origin: tauri://localhost\r\n")
        assert ws_tauri == 101

        # 4. Content-Length validation
        status_huge, _, _ = await _raw_http(
            srv.port,
            f"POST /rpc HTTP/1.1\r\nHost: localhost\r\nContent-Length: {MAX_HTTP_BODY_BYTES + 1}\r\n\r\n".encode(),
        )
        assert status_huge == 413

        for bad_cl in ("-5", "not-a-number"):
            status_bad, _, _ = await _raw_http(
                srv.port,
                f"POST /rpc HTTP/1.1\r\nHost: localhost\r\nContent-Length: {bad_cl}\r\n\r\n".encode(),
            )
            assert status_bad == 400
    finally:
        await srv.stop()


@pytest.mark.asyncio
async def test_ws_server_enforces_auth_token_when_configured() -> None:
    async def dispatcher(method: str, params: dict[str, Any]) -> Any:
        return {"ok": True, "method": method}

    srv = AsyncJsonRpcServer(
        dispatcher=dispatcher,
        health_provider=lambda: {"status": "ok"},
        host="127.0.0.1",
        port=0,
        auth_token="secret-bridge-token",
    )
    await srv.start()
    try:
        rpc_body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "bridge.ping", "params": {}})

        # Unauthenticated POST /rpc -> 401
        st_no_auth, _, _ = await _raw_http(
            srv.port,
            f"POST /rpc HTTP/1.1\r\nHost: localhost\r\nContent-Length: {len(rpc_body)}\r\n\r\n{rpc_body}".encode(),
        )
        assert st_no_auth == 401

        # Bearer token -> 200
        st_bearer, _, body_ok = await _raw_http(
            srv.port,
            (
                f"POST /rpc HTTP/1.1\r\nHost: localhost\r\n"
                f"Authorization: Bearer secret-bridge-token\r\n"
                f"Content-Length: {len(rpc_body)}\r\n\r\n{rpc_body}"
            ).encode(),
        )
        assert st_bearer == 200
        assert json.loads(body_ok)["result"]["ok"] is True

        # Unauthenticated WS -> 401; ?token=... -> 101
        assert await _raw_ws_handshake(srv.port, path="/ws") == 401
        assert await _raw_ws_handshake(srv.port, path="/ws?token=secret-bridge-token") == 101
    finally:
        await srv.stop()


@pytest.mark.asyncio
async def test_live_engine_blocks_path_traversal_and_ssh_injection(tmp_path: Path) -> None:
    ws = tmp_path / "workspace"
    (ws / "build" / "conf").mkdir(parents=True)
    (ws / "layers").mkdir(parents=True)

    async def noop_notify(_m: str, _p: dict[str, Any]) -> None:
        return None

    engine = LiveYoctoEngine(EventMonitor(notify=noop_notify), str(ws))

    # Path traversal checks across live file RPCs
    traversal_calls = [
        ("kas.run", {"action": "checkout", "filename": "../../outside.yml", "yaml_text": "header:\n  version: 14\n"}),
        ("wic.parse_wks", {"path": "../../outside.wks"}),
        ("wic.serialize_wks", {"wks": {"parts": []}, "save_path": "../../outside.wks"}),
        ("pro.dt.parseTree", {"path": "../../outside.dts"}),
        ("pro.dt.updateNodeStatus", {"path": "../../outside.dts", "node_path": "/soc", "new_status": "okay"}),
        ("pro.cra.exportBundle", {"output_dir": "../../outside", "bundle_name": "bundle.zip"}),
        ("pro.cra.exportBundle", {"bundle_name": "../escape.zip"}),
        ("layers.create_layer", {"name": "custom", "parent_dir": "../../outside"}),
    ]
    for method, params in traversal_calls:
        with pytest.raises(RpcError) as exc_info:
            await engine.dispatch(method, params)
        assert exc_info.value.code == RpcErrorCode.INVALID_PARAMS, f"Expected INVALID_PARAMS for {method}"

    # SSH option & shell metacharacter injection checks
    for bad_host in ["-oProxyCommand=id", "192.168.10.50; id", "root@host name"]:
        with pytest.raises(RpcError) as exc_info:
            await engine.dispatch("pro.qa.runHardwareSmoke", {"target_host": bad_host})
        assert exc_info.value.code == RpcErrorCode.INVALID_PARAMS

        with pytest.raises(RpcError) as exc_info:
            await engine.dispatch("enterprise.debug.getLiveTelemetry", {"target_host": bad_host})
        assert exc_info.value.code == RpcErrorCode.INVALID_PARAMS

    with pytest.raises(RpcError) as exc_info:
        await engine.dispatch(
            "enterprise.debug.getLiveTelemetry",
            {"target_host": "192.168.10.50", "journal_unit": "ssh; id"},
        )
    assert exc_info.value.code == RpcErrorCode.INVALID_PARAMS
