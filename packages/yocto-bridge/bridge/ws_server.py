"""Pure Python stdlib asyncio HTTP/1.1 + RFC 6455 WebSocket + JSON-RPC 2.0 server."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import struct
import urllib.parse
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from bridge.i18n import set_lang
from bridge.protocol import (
    RpcError,
    RpcErrorCode,
    make_error,
    make_notification,
    make_result,
    parse_rpc_request,
)

LOGGER = logging.getLogger("yocto_bridge.ws")

WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_HTTP_BODY_BYTES = 16 * 1024 * 1024
MAX_WS_FRAME_BYTES = 16 * 1024 * 1024
_ALLOWED_ORIGIN_RE = re.compile(
    r"^(?:https?://(?:localhost|127\.0\.0\.1|\[::1\]|tauri\.localhost)(?::\d{1,5})?|tauri://localhost)$",
    re.IGNORECASE,
)
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}

OPCODE_CONTINUATION = 0x0
OPCODE_TEXT = 0x1
OPCODE_BINARY = 0x2
OPCODE_CLOSE = 0x8
OPCODE_PING = 0x9
OPCODE_PONG = 0xA


def is_allowed_origin(origin: str | None) -> bool:
    """Allow local Tauri/Vite/dev origins or absent Origin (CLI/test clients), block arbitrary web origins."""
    if origin is None or origin == "":
        return True
    trimmed = origin.strip()
    if trimmed.lower() == "null":
        return False
    return bool(_ALLOWED_ORIGIN_RE.match(trimmed))


def is_allowed_host(host_header: str | None, bind_host: str) -> bool:
    """Reject DNS rebinding Host headers when bound to a loopback interface."""
    if bind_host not in _LOOPBACK_HOSTS or not host_header:
        return True
    raw = host_header.strip()
    if raw.startswith("["):
        end = raw.find("]")
        hostname = raw[: end + 1] if end != -1 else raw
    else:
        hostname = raw.split(":", 1)[0]
    return hostname.lower() in {"localhost", "127.0.0.1", "[::1]", "::1"}


def build_ws_frame(opcode: int, payload: bytes, fin: bool = True) -> bytes:
    """Build an unmasked RFC 6455 server-to-client WebSocket frame."""
    first_byte = (0x80 if fin else 0x00) | (opcode & 0x0F)
    length = len(payload)
    if length < 126:
        header = struct.pack("!BB", first_byte, length)
    elif length < 65536:
        header = struct.pack("!BBH", first_byte, 126, length)
    else:
        header = struct.pack("!BBQ", first_byte, 127, length)
    return header + payload


async def read_ws_frame(
    reader: asyncio.StreamReader, max_frame_bytes: int = MAX_WS_FRAME_BYTES
) -> tuple[bool, int, bytes]:
    """Read a single RFC 6455 WebSocket frame from an asyncio StreamReader."""
    header = await reader.readexactly(2)
    b1, b2 = header[0], header[1]
    fin = bool(b1 & 0x80)
    opcode = b1 & 0x0F
    masked = bool(b2 & 0x80)
    length = b2 & 0x7F

    if length == 126:
        ext = await reader.readexactly(2)
        (length,) = struct.unpack("!H", ext)
    elif length == 127:
        ext = await reader.readexactly(8)
        (length,) = struct.unpack("!Q", ext)

    if length > max_frame_bytes:
        raise ValueError("WebSocket frame exceeds maximum size limit")

    mask_key = await reader.readexactly(4) if masked else b""
    payload = await reader.readexactly(length) if length > 0 else b""

    if masked and payload:
        payload = bytes(payload[i] ^ mask_key[i % 4] for i in range(length))

    return fin, opcode, payload


@dataclass(eq=False)
class WebSocketClient:
    writer: asyncio.StreamWriter
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    closed: bool = False

    async def send_text(self, text: str) -> None:
        if self.closed:
            return
        frame = build_ws_frame(OPCODE_TEXT, text.encode("utf-8"))
        async with self.send_lock:
            if self.closed:
                return
            self.writer.write(frame)
            await self.writer.drain()

    async def send_json(self, obj: dict[str, Any]) -> None:
        await self.send_text(json.dumps(obj, separators=(",", ":")))

    async def send_pong(self, payload: bytes) -> None:
        if self.closed:
            return
        frame = build_ws_frame(OPCODE_PONG, payload)
        async with self.send_lock:
            if self.closed:
                return
            self.writer.write(frame)
            await self.writer.drain()

    async def close(self, code: int = 1000) -> None:
        if self.closed:
            return
        self.closed = True
        try:
            frame = build_ws_frame(OPCODE_CLOSE, struct.pack("!H", code))
            async with self.send_lock:
                self.writer.write(frame)
                await self.writer.drain()
        except OSError:
            pass
        try:
            self.writer.close()
        except OSError:
            pass


RpcDispatcher = Callable[[str, dict[str, Any]], Awaitable[Any]]
HealthProvider = Callable[[], dict[str, Any]]


class AsyncJsonRpcServer:
    """Self-contained stdlib HTTP/1.1 + WebSocket server for JSON-RPC 2.0."""

    def __init__(
        self,
        dispatcher: RpcDispatcher,
        health_provider: HealthProvider,
        host: str = "127.0.0.1",
        port: int = 18765,
        auth_token: str | None = None,
    ) -> None:
        self._dispatcher = dispatcher
        self._health_provider = health_provider
        self._host = host
        self._port = port
        self._auth_token = auth_token
        self._server: asyncio.Server | None = None
        self._clients: set[WebSocketClient] = set()
        self._client_tasks: set[asyncio.Task[None]] = set()

    def _is_authorized(self, headers: dict[str, str], query_string: str) -> bool:
        if not self._auth_token:
            return True
        candidate: str | None = None
        auth_hdr = headers.get("authorization", "")
        if auth_hdr.lower().startswith("bearer "):
            candidate = auth_hdr[7:].strip()
        elif headers.get("x-yocto-token"):
            candidate = headers["x-yocto-token"].strip()
        elif query_string:
            qs = urllib.parse.parse_qs(query_string)
            tok_list = qs.get("token")
            if tok_list:
                candidate = tok_list[0]
        return bool(candidate) and hmac.compare_digest(candidate, self._auth_token)

    @property
    def port(self) -> int:
        if self._server and self._server.sockets:
            return int(self._server.sockets[0].getsockname()[1])
        return self._port

    @property
    def active_clients(self) -> int:
        return len(self._clients)

    async def start(self) -> None:
        self._server = await asyncio.start_server(
            self._handle_connection,
            host=self._host,
            port=self._port,
            reuse_address=True,
        )

    async def stop(self) -> None:
        for client in list(self._clients):
            await client.close(1001)
        self._clients.clear()

        for task in list(self._client_tasks):
            task.cancel()
        if self._client_tasks:
            await asyncio.gather(*self._client_tasks, return_exceptions=True)
        self._client_tasks.clear()

        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    async def broadcast_notification(self, method: str, params: dict[str, Any]) -> None:
        if not self._clients:
            return
        msg = json.dumps(make_notification(method, params), separators=(",", ":"))
        dead: list[WebSocketClient] = []
        for client in list(self._clients):
            try:
                await client.send_text(msg)
            except (OSError, ConnectionError, RuntimeError):
                dead.append(client)
        for client in dead:
            self._clients.discard(client)
            await client.close()

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._client_tasks.add(task)
        try:
            raw_head = await reader.readuntil(b"\r\n\r\n")
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, OSError):
            writer.close()
            if task is not None:
                self._client_tasks.discard(task)
            return

        try:
            lines = raw_head.decode("latin-1").split("\r\n")
            request_line = lines[0].split(" ")
            if len(request_line) < 2:
                await self._send_http(writer, 400, {"error": "Bad Request"})
                return

            method = request_line[0].upper()
            path, _, query_string = request_line[1].partition("?")
            headers: dict[str, str] = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip().lower()] = v.strip()

            origin = headers.get("origin")
            host_hdr = headers.get("host")
            if not is_allowed_host(host_hdr, self._host):
                await self._send_http(writer, 403, {"error": "Forbidden host"}, origin=origin)
                return
            if not is_allowed_origin(origin):
                await self._send_http(writer, 403, {"error": "Forbidden origin"}, origin=origin)
                return

            if method == "OPTIONS":
                await self._send_http(writer, 204, None, origin=origin)
                return

            if method == "GET" and path == "/health":
                payload = self._health_provider()
                payload["active_clients"] = self.active_clients
                await self._send_http(writer, 200, payload, origin=origin)
                return

            if method == "POST" and path == "/rpc":
                if not self._is_authorized(headers, query_string):
                    await self._send_http(writer, 401, {"error": "Unauthorized"}, origin=origin)
                    return
                try:
                    content_length = int(headers.get("content-length", "0"))
                except ValueError:
                    await self._send_http(writer, 400, {"error": "Invalid Content-Length"}, origin=origin)
                    return
                if content_length < 0:
                    await self._send_http(writer, 400, {"error": "Invalid Content-Length"}, origin=origin)
                    return
                if content_length > MAX_HTTP_BODY_BYTES:
                    await self._send_http(writer, 413, {"error": "Payload Too Large"}, origin=origin)
                    return
                body = await reader.readexactly(content_length) if content_length > 0 else b""
                resp = await self._process_rpc_text(body.decode("utf-8", errors="replace"))
                await self._send_http(writer, 200, resp, origin=origin)
                return

            if (
                method == "GET"
                and path == "/ws"
                and headers.get("upgrade", "").lower() == "websocket"
            ):
                if not self._is_authorized(headers, query_string):
                    await self._send_http(writer, 401, {"error": "Unauthorized"}, origin=origin)
                    return
                ws_key = headers.get("sec-websocket-key")
                if not ws_key:
                    await self._send_http(writer, 400, {"error": "Missing Sec-WebSocket-Key"}, origin=origin)
                    return
                await self._upgrade_and_serve_ws(reader, writer, ws_key)
                return

            await self._send_http(writer, 404, {"error": f"Not found: {method} {path}"}, origin=origin)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            LOGGER.debug("Connection error: %s", exc)
        finally:
            try:
                writer.close()
            except OSError:
                pass
            if task is not None:
                self._client_tasks.discard(task)

    async def _send_http(
        self,
        writer: asyncio.StreamWriter,
        status: int,
        body: Any,
        origin: str | None = None,
    ) -> None:
        reason = {
            200: "OK",
            204: "No Content",
            400: "Bad Request",
            401: "Unauthorized",
            403: "Forbidden",
            404: "Not Found",
            413: "Payload Too Large",
        }.get(status, "OK")
        encoded = b"" if body is None else json.dumps(body).encode("utf-8")
        headers = [
            f"HTTP/1.1 {status} {reason}",
            "Access-Control-Allow-Methods: GET, POST, OPTIONS",
            "Access-Control-Allow-Headers: Content-Type, Authorization, X-Yocto-Token",
            f"Content-Length: {len(encoded)}",
            "Connection: close",
        ]
        if origin and is_allowed_origin(origin):
            headers.insert(1, f"Access-Control-Allow-Origin: {origin}")
            headers.insert(2, "Vary: Origin")
        if body is not None:
            headers.append("Content-Type: application/json; charset=utf-8")
        raw = ("\r\n".join(headers) + "\r\n\r\n").encode("ascii") + encoded
        writer.write(raw)
        await writer.drain()

    async def _upgrade_and_serve_ws(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        ws_key: str,
    ) -> None:
        accept_raw = hashlib.sha1((ws_key + WS_MAGIC).encode("ascii")).digest()
        accept_val = base64.b64encode(accept_raw).decode("ascii")
        handshake = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept_val}\r\n\r\n"
        ).encode("ascii")
        writer.write(handshake)
        await writer.drain()

        client = WebSocketClient(writer=writer)
        self._clients.add(client)
        fragments: list[bytes] = []
        fragment_opcode: int | None = None
        fragment_total_bytes = 0

        try:
            while not client.closed:
                fin, opcode, payload = await read_ws_frame(reader)

                if opcode == OPCODE_CLOSE:
                    await client.close(1000)
                    break
                if opcode == OPCODE_PING:
                    await client.send_pong(payload)
                    continue
                if opcode == OPCODE_PONG:
                    continue

                if opcode in (OPCODE_TEXT, OPCODE_BINARY):
                    if fin:
                        if opcode == OPCODE_TEXT:
                            await self._handle_ws_text(client, payload.decode("utf-8"))
                    else:
                        fragments = [payload]
                        fragment_opcode = opcode
                        fragment_total_bytes = len(payload)
                elif opcode == OPCODE_CONTINUATION and fragment_opcode is not None:
                    fragment_total_bytes += len(payload)
                    if fragment_total_bytes > MAX_WS_FRAME_BYTES:
                        await client.close(1009)
                        break
                    fragments.append(payload)
                    if fin:
                        full_payload = b"".join(fragments)
                        if fragment_opcode == OPCODE_TEXT:
                            await self._handle_ws_text(client, full_payload.decode("utf-8"))
                        fragments.clear()
                        fragment_opcode = None
                        fragment_total_bytes = 0
        except ValueError:
            await client.close(1009)
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            pass
        finally:
            self._clients.discard(client)
            await client.close()

    async def _handle_ws_text(self, client: WebSocketClient, text: str) -> None:
        response = await self._process_rpc_text(text)
        if response is not None:
            await client.send_json(response)

    async def _process_rpc_text(self, text: str) -> dict[str, Any] | None:
        req, err = parse_rpc_request(text)
        if err is not None:
            return err
        assert req is not None

        req_id = req.get("id")
        method = req["method"]
        params = req.get("params") or {}
        if isinstance(req.get("lang"), str):
            set_lang(req["lang"])

        try:
            result = await self._dispatcher(method, params)
            if req_id is None:
                return None
            return make_result(req_id, result)
        except RpcError as exc:
            if req_id is None:
                return None
            return make_error(req_id, exc.code, exc.message, exc.data)
        except Exception as exc:  # noqa: BLE001
            LOGGER.exception("Unhandled RPC error for %s", method)
            if req_id is None:
                return None
            return make_error(req_id, RpcErrorCode.INTERNAL_ERROR, str(exc))
