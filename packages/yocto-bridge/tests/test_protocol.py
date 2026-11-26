"""Tests for JSON-RPC 2.0 protocol helpers and /mnt/c NTFS workspace path protection."""

from __future__ import annotations

from bridge.protocol import (
    RpcErrorCode,
    make_error,
    make_result,
    parse_rpc_request,
    validate_linux_workspace_path,
)


def test_parse_valid_rpc_request() -> None:
    req, err = parse_rpc_request('{"jsonrpc":"2.0","id":1,"method":"bridge.ping","params":{}}')
    assert err is None
    assert req is not None
    assert req["method"] == "bridge.ping"


def test_parse_invalid_json_returns_parse_error() -> None:
    req, err = parse_rpc_request("{broken json")
    assert req is None
    assert err is not None
    assert err["error"]["code"] == RpcErrorCode.PARSE_ERROR


def test_make_result_and_error() -> None:
    res = make_result("abc", {"ok": True})
    assert res == {"jsonrpc": "2.0", "id": "abc", "result": {"ok": True}}
    err = make_error("abc", RpcErrorCode.NTFS_PATH_FORBIDDEN, "Forbidden")
    assert err["error"]["code"] == -32001


def test_blocks_mnt_c_and_other_drvfs_mounts() -> None:
    for bad in [
        "/mnt/c",
        "/mnt/c/",
        "/mnt/c/Users/dev/yocto",
        "/mnt/D/builds/wrynose",
        "/mnt/e/proj",
        "/home/../mnt/c/yocto",
    ]:
        res = validate_linux_workspace_path(bad, "wsl2")
        assert res["valid"] is False, f"Expected blocked for {bad}"


def test_blocks_windows_drive_and_unc_and_relative_paths() -> None:
    for bad, expected_code in [
        ("C:\\Users\\dev\\yocto", RpcErrorCode.NTFS_PATH_FORBIDDEN),
        ("d:/yocto/build", RpcErrorCode.NTFS_PATH_FORBIDDEN),
        ("\\\\wsl$\\Ubuntu\\home\\yocto", RpcErrorCode.NTFS_PATH_FORBIDDEN),
        ("relative/yocto/dir", RpcErrorCode.INVALID_PARAMS),
        ("", RpcErrorCode.INVALID_PARAMS),
        ("/home/yocto/../etc", RpcErrorCode.INVALID_PARAMS),
    ]:
        res = validate_linux_workspace_path(bad, "wsl2")
        assert res["valid"] is False
        assert res["error_code"] == expected_code


def test_allows_valid_ext4_posix_paths() -> None:
    for good in [
        "/home/yocto/yocto-studio/poky-wrynose",
        "/var/lib/yocto/builds/core-image-minimal",
        "/opt/yocto/mnt-like-name/project",
    ]:
        res = validate_linux_workspace_path(good, "wsl2")
        assert res["valid"] is True
        assert res["error_code"] is None
