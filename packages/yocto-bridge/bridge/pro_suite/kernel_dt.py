"""Kernel .cfg fragment manager and Device Tree (.dts/.dtsi/.dtb) parser & validator."""

from __future__ import annotations

import difflib
import re
import shutil
import subprocess
from typing import Any

from bridge.i18n import tr_en

_CFG_SET_RE = re.compile(r"^(CONFIG_[A-Za-z0-9_]+)=(.+)$")
_CFG_UNSET_RE = re.compile(r"^#\s*(CONFIG_[A-Za-z0-9_]+)\s+is not set$")
_NODE_OPEN_RE = re.compile(r"^(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([A-Za-z0-9_,@+./-]+)\s*\{$")


def parse_kernel_config(text: str) -> dict[str, str]:
    """Parse kernel `.config` / `.cfg` assignments (`y`, `m`, string, or `n`)."""
    result: dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        m_set = _CFG_SET_RE.match(line)
        if m_set:
            result[m_set.group(1)] = m_set.group(2).strip()
            continue
        m_unset = _CFG_UNSET_RE.match(line)
        if m_unset:
            result[m_unset.group(1)] = "n"
    return result


def diff_kernel_config(before_cfg: str, after_cfg: str, search: str = "") -> dict[str, Any]:
    """Compute structured kernel config diffs, minimal `.cfg` fragment, and search matches."""
    before = parse_kernel_config(before_cfg)
    after = parse_kernel_config(after_cfg)
    all_keys = sorted(set(before) | set(after))

    changes: list[dict[str, Any]] = []
    frag_lines: list[str] = ["# Yocto Studio Managed Kernel Fragment"]
    for key in all_keys:
        old_v = before.get(key)
        new_v = after.get(key)
        if old_v == new_v:
            continue
        kind = "added" if old_v is None else ("removed" if new_v is None else "changed")
        changes.append({"symbol": key, "old_value": old_v, "new_value": new_v, "change": kind})
        if new_v is None or new_v == "n":
            frag_lines.append(f"# {key} is not set")
        else:
            frag_lines.append(f"{key}={new_v}")

    q = search.strip().upper()
    active_items = [
        {"symbol": k, "value": v}
        for k, v in sorted(after.items())
        if not q or q in k
    ][:120]

    return {
        "changes": changes,
        "fragment_content": "\n".join(frag_lines) + "\n",
        "search_matches": active_items,
        "total_symbols": len(after),
    }


def generate_kernel_bbappend_fragment(
    fragment_name: str,
    fragment_content: str,
    existing_bbappend: str = "",
) -> tuple[str, str]:
    """Ensure `linux-*.bbappend` includes `file://<fragment>.cfg` and return unified diff."""
    clean_name = fragment_name.strip()
    if not clean_name.endswith(".cfg"):
        clean_name += ".cfg"
    entry = f'SRC_URI += "file://{clean_name}"'
    base = existing_bbappend or 'FILESEXTRAPATHS:prepend := "${THISDIR}/files:"\n'
    if clean_name in base:
        updated = base
    else:
        sep = "" if base.endswith("\n") else "\n"
        updated = f"{base}{sep}{entry}\n"

    diff = "".join(
        difflib.unified_diff(
            base.splitlines(keepends=True),
            updated.splitlines(keepends=True),
            fromfile="a/linux-yocto_%.bbappend",
            tofile="b/linux-yocto_%.bbappend",
        )
    )
    _ = fragment_content
    return updated, diff


def _strip_dts_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    lines = []
    for line in text.splitlines():
        if "//" in line and not ('"' in line and line.find("//") > line.find('"')):
            line = line[: line.find("//")]
        lines.append(line)
    return "\n".join(lines)


def parse_dts_tree(dts_text: str) -> dict[str, Any]:
    """Parse `.dts`/`.dtsi` source into a hierarchical node tree for UI inspection."""
    cleaned = _strip_dts_comments(dts_text)
    root: dict[str, Any] = {
        "name": "/",
        "path": "/",
        "label": None,
        "compatible": None,
        "reg": None,
        "pinctrl": None,
        "status": None,
        "properties": {},
        "children": [],
    }
    stack: list[dict[str, Any]] = []

    for raw in cleaned.splitlines():
        line = raw.strip()
        if not line or line.startswith("/dts-v1/") or line.startswith("#include"):
            continue

        if line.startswith("};"):
            if len(stack) > 1:
                stack.pop()
            continue

        if line.endswith("{"):
            header = line[:-1].strip()
            if header == "/":
                stack = [root]
                continue
            m = _NODE_OPEN_RE.match(line)
            label = m.group(1) if m else None
            node_name = (m.group(2) if m else header.lstrip("&")).strip()
            parent = stack[-1] if stack else root
            if parent["path"] == "/":
                node_path = f"/{node_name}" if not header.startswith("&") else header
            else:
                node_path = f"{parent['path']}/{node_name}"

            existing = next((c for c in parent["children"] if c["path"] == node_path), None)
            if existing is None:
                node: dict[str, Any] = {
                    "name": node_name,
                    "path": node_path,
                    "label": label,
                    "compatible": None,
                    "reg": None,
                    "pinctrl": None,
                    "status": None,
                    "properties": {},
                    "children": [],
                }
                parent["children"].append(node)
            else:
                node = existing
            stack.append(node)
            continue

        if stack and "=" in line:
            clean_prop = line.rstrip(";").strip()
            k, v = clean_prop.split("=", 1)
            key = k.strip()
            val = v.strip().strip('"')
            cur = stack[-1]
            cur["properties"][key] = val
            if key == "compatible":
                cur["compatible"] = val
            elif key == "reg":
                cur["reg"] = val
            elif key.startswith("pinctrl-"):
                cur["pinctrl"] = val
            elif key == "status":
                cur["status"] = val
        elif stack and line.endswith(";"):
            flag = line[:-1].strip()
            if flag:
                stack[-1]["properties"][flag] = "true"

    return root


def validate_dts_syntax(dts_text: str) -> tuple[bool, list[str]]:
    """Run static brace/semicolon/status checks and invoke `dtc` if installed on host."""
    errors: list[str] = []
    cleaned = _strip_dts_comments(dts_text)
    if cleaned.count("{") != cleaned.count("}"):
        errors.append(
            tr_en(
                "Sözdizimi hatası: Açılan '{' ve kapanan '}' parantez sayıları eşit değil.",
                "Syntax error: Mismatched opening '{' and closing '}' braces.",
            )
        )

    for idx, raw in enumerate(cleaned.splitlines(), start=1):
        line = raw.strip()
        if not line or line.startswith(("#", "/dts-v1/", "{")) or line.endswith(("{", "};", ";")):
            continue
        errors.append(
            tr_en(
                f"Satır {idx}: ';' noktalı virgül eksik olabilir -> {line}",
                f"Line {idx}: Missing ';' semicolon -> {line}",
            )
        )

    dtc_bin = shutil.which("dtc")
    if dtc_bin and not errors:
        proc = subprocess.run(
            [dtc_bin, "-I", "dts", "-O", "dtb", "-o", "-", "-"],
            input=dts_text.encode("utf-8"),
            capture_output=True,
            check=False,
        )
        if proc.returncode != 0:
            err_msg = proc.stderr.decode("utf-8", errors="replace").strip()
            if err_msg:
                errors.append(f"dtc: {err_msg}")

    return len(errors) == 0, errors


def update_dts_node_status(dts_text: str, node_path: str, new_status: str) -> tuple[str, str]:
    """Update or insert `status = \"okay\"|\"disabled\";` inside the specified DTS node path."""
    if new_status not in {"okay", "disabled"}:
        raise ValueError("status must be 'okay' or 'disabled'")

    lines = dts_text.splitlines()
    target_parts = [p for p in node_path.strip("/").split("/") if p]
    target_leaf = target_parts[-1] if target_parts else node_path

    stack: list[str] = []
    node_start: int | None = None
    node_end: int | None = None

    for idx, raw in enumerate(lines):
        stripped = raw.strip()
        if stripped.endswith("{"):
            hdr = stripped[:-1].strip()
            if ":" in hdr:
                hdr = hdr.split(":", 1)[1].strip()
            stack.append(hdr)
            if hdr == target_leaf or "/".join(stack).lstrip("/") == "/".join(target_parts):
                node_start = idx
        elif stripped.startswith("};"):
            if node_start is not None and node_end is None and stack and stack[-1] == target_leaf:
                node_end = idx
                break
            if stack:
                stack.pop()

    if node_start is None or node_end is None:
        raise ValueError(
            tr_en(f"DTS düğümü bulunamadı: {node_path}", f"DTS node not found: {node_path}")
        )

    updated = list(lines)
    replaced = False
    for idx in range(node_start + 1, node_end):
        if re.match(r"^\s*status\s*=", updated[idx]):
            indent = updated[idx][: len(updated[idx]) - len(updated[idx].lstrip())]
            updated[idx] = f'{indent}status = "{new_status}";'
            replaced = True
            break

    if not replaced:
        parent_indent = lines[node_start][: len(lines[node_start]) - len(lines[node_start].lstrip())]
        updated.insert(node_end, f'{parent_indent}    status = "{new_status}";')

    new_text = "\n".join(updated) + ("\n" if dts_text.endswith("\n") else "")
    diff = "".join(
        difflib.unified_diff(
            dts_text.splitlines(keepends=True),
            new_text.splitlines(keepends=True),
            fromfile="a/board.dts",
            tofile="b/board.dts",
        )
    )
    return new_text, diff
