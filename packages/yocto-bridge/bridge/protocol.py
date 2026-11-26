"""JSON-RPC 2.0 protocol helpers, error codes, and WSL2/ext4 workspace path validation."""

from __future__ import annotations

import json
import posixpath
import re
from dataclasses import dataclass
from typing import Any

from bridge.i18n import tr_en

JSON_RPC_VERSION = "2.0"


class RpcErrorCode:
    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603
    NTFS_PATH_FORBIDDEN = -32001
    PROVIDER_UNAVAILABLE = -32002
    BUILD_ALREADY_RUNNING = -32003
    BUILD_NOT_FOUND = -32004
    BITBAKE_ERROR = -32005


@dataclass(slots=True)
class RpcError(Exception):
    code: int
    message: str
    data: Any = None


_WINDOWS_DRIVE_RE = re.compile(r"^[a-zA-Z]:[\\/]")
_UNC_PATH_RE = re.compile(r"^(\\\\|//)[^\\/]+")
_WSL_DRVFS_RE = re.compile(r"^/mnt/([a-zA-Z])(?:/|$)")


def validate_linux_workspace_path(path: str, provider: str = "wsl2") -> dict[str, Any]:
    """Validate that a Yocto workspace path resides on POSIX case-sensitive storage.

    Blocks Windows NTFS mounts (/mnt/c, /mnt/d, ...), Windows drive paths (C:\\...),
    UNC shares, relative paths, and '..' traversal segments.
    """
    raw = (path or "").strip()
    if not raw:
        return {
            "valid": False,
            "error_code": RpcErrorCode.INVALID_PARAMS,
            "reason": tr_en("Çalışma alanı yolu boş olamaz.", "Workspace path cannot be empty."),
            "recommendation": "/home/yocto/yocto-studio/my-project",
            "normalized_path": "",
        }

    if _WINDOWS_DRIVE_RE.match(raw) or _UNC_PATH_RE.match(raw):
        return {
            "valid": False,
            "error_code": RpcErrorCode.NTFS_PATH_FORBIDDEN,
            "reason": tr_en(
                "Windows sürücü veya UNC yolları (C:\\..., \\\\...) BitBake için yasaktır. "
                "BitBake POSIX izinleri, pseudo (fakeroot) ve case-sensitive ext4 gerektirir.",
                "Windows drive or UNC paths (C:\\..., \\\\...) are forbidden for BitBake. "
                "BitBake requires POSIX permissions, pseudo (fakeroot), and case-sensitive ext4.",
            ),
            "recommendation": "/home/yocto/yocto-studio/my-project",
            "normalized_path": raw,
        }

    if not raw.startswith("/"):
        return {
            "valid": False,
            "error_code": RpcErrorCode.INVALID_PARAMS,
            "reason": tr_en(
                "Yocto çalışma alanı yolu mutlak POSIX yolu ('/' ile başlayan) olmalıdır.",
                "Yocto workspace path must be an absolute POSIX path (starting with '/').",
            ),
            "recommendation": f"/home/yocto/yocto-studio/{raw.lstrip('./')}",
            "normalized_path": raw,
        }

    parts = [p for p in raw.split("/") if p]
    if any(part == ".." for part in parts):
        return {
            "valid": False,
            "error_code": RpcErrorCode.INVALID_PARAMS,
            "reason": tr_en(
                "Güvenlik nedeniyle '..' içeren yollar kabul edilmez.",
                "Paths containing '..' are rejected for security reasons.",
            ),
            "recommendation": "/home/yocto/yocto-studio/my-project",
            "normalized_path": raw,
        }

    normalized = posixpath.normpath(raw)
    drvfs_match = _WSL_DRVFS_RE.match(normalized)
    if drvfs_match:
        drive_letter = drvfs_match.group(1).lower()
        tail = normalized[len(f"/mnt/{drive_letter}") :].lstrip("/")
        suggested = f"/home/yocto/yocto-studio/{tail or 'my-project'}"
        return {
            "valid": False,
            "error_code": RpcErrorCode.NTFS_PATH_FORBIDDEN,
            "reason": tr_en(
                f"'{normalized}' yolu Windows NTFS (9p/DrvFs) bağlama noktasıdır. "
                "BitBake burada şiddetli I/O darboğazı, sembolik/sabit bağlantı hataları ve "
                "büyük/küçük harf çakışmaları yaşar. WSL2 içinde yerel ext4 kullanılmalıdır.",
                f"Path '{normalized}' is a Windows NTFS (9p/DrvFs) mount point. "
                "BitBake suffers severe I/O bottlenecks, symlink/hardlink failures, and "
                "case-sensitivity collisions here. Native ext4 inside WSL2 is required.",
            ),
            "recommendation": suggested,
            "normalized_path": normalized,
        }

    if provider == "wsl2" and normalized in ("/", "/mnt", "/proc", "/sys", "/dev"):
        return {
            "valid": False,
            "error_code": RpcErrorCode.INVALID_PARAMS,
            "reason": tr_en(
                f"'{normalized}' sistem kökü çalışma alanı olarak kullanılamaz.",
                f"System root '{normalized}' cannot be used as a workspace.",
            ),
            "recommendation": "/home/yocto/yocto-studio/my-project",
            "normalized_path": normalized,
        }

    return {
        "valid": True,
        "error_code": None,
        "reason": tr_en(
            "Geçerli POSIX case-sensitive dosya sistemi yolu (ext4 uyumlu).",
            "Valid POSIX case-sensitive filesystem path (ext4 compatible).",
        ),
        "recommendation": None,
        "normalized_path": normalized,
    }


def parse_rpc_request(raw_text: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    """Parse a JSON-RPC 2.0 request string. Returns (request_dict, error_response)."""
    try:
        payload = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        return None, make_error(None, RpcErrorCode.PARSE_ERROR, f"Parse error: {exc.msg}")

    if not isinstance(payload, dict):
        return None, make_error(None, RpcErrorCode.INVALID_REQUEST, "Request must be a JSON object")

    req_id = payload.get("id")
    if payload.get("jsonrpc") != JSON_RPC_VERSION or not isinstance(payload.get("method"), str):
        return None, make_error(
            req_id if isinstance(req_id, (str, int)) else None,
            RpcErrorCode.INVALID_REQUEST,
            "Invalid JSON-RPC 2.0 envelope",
        )

    if req_id is not None and not isinstance(req_id, (str, int)):
        return None, make_error(None, RpcErrorCode.INVALID_REQUEST, "Invalid request id")

    params = payload.get("params")
    if params is not None and not isinstance(params, dict):
        return None, make_error(req_id, RpcErrorCode.INVALID_PARAMS, "params must be an object")

    return payload, None


def make_result(req_id: str | int, result: Any) -> dict[str, Any]:
    return {"jsonrpc": JSON_RPC_VERSION, "id": req_id, "result": result}


def make_error(
    req_id: str | int | None,
    code: int,
    message: str,
    data: Any = None,
) -> dict[str, Any]:
    err: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    return {"jsonrpc": JSON_RPC_VERSION, "id": req_id, "error": err}


def make_notification(method: str, params: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": JSON_RPC_VERSION, "method": method, "params": params}
