"""Pure-stdlib parser and serializer for Yocto WIC kickstart (.wks) files."""

from __future__ import annotations

import re
import shlex
from typing import Any

_SIZE_RE = re.compile(r"^(\d+(?:\.\d+)?)\s*([kKmMgG])?[bB]?$")


def _parse_size_mb(raw: str) -> int | None:
    match = _SIZE_RE.match(raw.strip())
    if not match:
        return None
    value = float(match.group(1))
    unit = (match.group(2) or "M").upper()
    if unit == "K":
        return max(1, round(value / 1024.0))
    if unit == "G":
        return round(value * 1024.0)
    return round(value)


def _format_size_mb(size_mb: int) -> str:
    if size_mb >= 1024 and size_mb % 1024 == 0:
        return f"{size_mb // 1024}G"
    return f"{size_mb}M"


def _consume_opt_value(tokens: list[str], index: int) -> tuple[str, str | None, int]:
    """Read `--flag=val` or `--flag val` starting at `index`."""
    tok = tokens[index]
    if "=" in tok:
        flag, val = tok.split("=", 1)
        return flag, val, index + 1
    if index + 1 < len(tokens) and not tokens[index + 1].startswith("-"):
        return tok, tokens[index + 1], index + 2
    return tok, None, index + 1


def parse_wks(content: str, path: str = "") -> dict[str, Any]:
    """Parse a `.wks` kickstart layout into structured bootloader and partition records."""
    partitions: list[dict[str, Any]] = []
    bootloader: dict[str, Any] = {"ptable": "gpt", "timeout": None, "append": None, "raw": ""}
    comments: list[str] = []

    for line_no, raw_line in enumerate(content.splitlines(), start=1):
        stripped = raw_line.strip()
        if not stripped:
            continue
        if stripped.startswith("#"):
            comments.append(stripped.lstrip("#").strip())
            continue

        try:
            tokens = shlex.split(stripped)
        except ValueError:
            tokens = stripped.split()
        if not tokens:
            continue

        directive = tokens[0]
        if directive == "bootloader":
            bootloader["raw"] = stripped
            idx = 1
            while idx < len(tokens):
                flag, val, idx = _consume_opt_value(tokens, idx)
                if flag == "--ptable" and val is not None:
                    bootloader["ptable"] = val
                elif flag == "--timeout" and val is not None:
                    try:
                        bootloader["timeout"] = int(val)
                    except ValueError:
                        pass
                elif flag == "--append" and val is not None:
                    bootloader["append"] = val
            continue

        if directive != "part":
            continue

        part: dict[str, Any] = {
            "id": f"part-{len(partitions) + 1}",
            "line": line_no,
            "name": "",
            "mountpoint": None,
            "fstype": None,
            "source": None,
            "size_mb": None,
            "fixed_size_mb": None,
            "align_kb": None,
            "offset_kb": None,
            "ondisk": None,
            "part_type": None,
            "uuid": None,
            "active": False,
            "no_table": False,
            "exclude_path": [],
            "extra_args": [],
        }

        idx = 1
        while idx < len(tokens):
            tok = tokens[idx]
            if not tok.startswith("-"):
                if part["mountpoint"] is None:
                    part["mountpoint"] = tok
                else:
                    part["extra_args"].append(tok)
                idx += 1
                continue

            flag, val, next_idx = _consume_opt_value(tokens, idx)
            if flag == "--label" and val is not None:
                part["name"] = val
            elif flag == "--part-name" and val is not None and not part["name"]:
                part["name"] = val
            elif flag == "--fstype" and val is not None:
                part["fstype"] = val
            elif flag == "--source" and val is not None:
                part["source"] = val
            elif flag == "--size" and val is not None:
                part["size_mb"] = _parse_size_mb(val)
            elif flag == "--fixed-size" and val is not None:
                part["fixed_size_mb"] = _parse_size_mb(val)
                if part["size_mb"] is None:
                    part["size_mb"] = part["fixed_size_mb"]
            elif flag == "--align" and val is not None:
                try:
                    part["align_kb"] = int(val)
                except ValueError:
                    part["extra_args"].append(f"--align={val}")
            elif flag == "--offset" and val is not None:
                offset_val = _parse_size_mb(val)
                try:
                    part["offset_kb"] = int(val)
                except ValueError:
                    if offset_val is not None:
                        part["offset_kb"] = offset_val * 1024
            elif flag == "--ondisk" and val is not None:
                part["ondisk"] = val
            elif flag == "--part-type" and val is not None:
                part["part_type"] = val
            elif flag == "--uuid" and val is not None:
                part["uuid"] = val
            elif flag == "--active":
                part["active"] = True
                next_idx = idx + 1
            elif flag == "--no-table":
                part["no_table"] = True
                next_idx = idx + 1
            elif flag == "--exclude-path" and val is not None:
                part["exclude_path"].append(val)
            else:
                if val is not None:
                    part["extra_args"].append(f"{flag}={val}")
                else:
                    part["extra_args"].append(flag)
            idx = next_idx

        if not part["name"]:
            if part["mountpoint"] and part["mountpoint"] != "/":
                part["name"] = part["mountpoint"].strip("/").replace("/", "-")
            elif part["mountpoint"] == "/":
                part["name"] = "rootfs"
            elif part["source"]:
                part["name"] = str(part["source"])
            else:
                part["name"] = f"part{len(partitions) + 1}"

        partitions.append(part)

    total_size_mb = sum(
        int(p.get("fixed_size_mb") or p.get("size_mb") or 0) for p in partitions
    )

    return {
        "path": path,
        "bootloader": bootloader,
        "comments": comments,
        "partitions": partitions,
        "total_size_mb": total_size_mb,
        "raw_text": content,
    }


def serialize_wks(wks_data: dict[str, Any]) -> str:
    """Serialize structured `.wks` data back into valid Yocto kickstart syntax."""
    lines: list[str] = []
    comments = wks_data.get("comments") or []
    for comment in comments[:3]:
        lines.append(f"# {comment}")
    if comments:
        lines.append("")

    for part in wks_data.get("partitions") or []:
        tokens: list[str] = ["part"]
        mountpoint = part.get("mountpoint")
        if mountpoint:
            tokens.append(str(mountpoint))
        if part.get("source"):
            tokens.extend(["--source", str(part["source"])])
        if part.get("ondisk"):
            tokens.extend(["--ondisk", str(part["ondisk"])])
        if part.get("fstype"):
            tokens.append(f"--fstype={part['fstype']}")
        name = part.get("name")
        if name and name != "raw":
            tokens.extend(["--label", str(name)])
        if part.get("active"):
            tokens.append("--active")
        if part.get("no_table"):
            tokens.append("--no-table")
        if part.get("fixed_size_mb"):
            tokens.extend(["--fixed-size", _format_size_mb(int(part["fixed_size_mb"]))])
        elif part.get("size_mb"):
            tokens.extend(["--size", _format_size_mb(int(part["size_mb"]))])
        if part.get("align_kb"):
            tokens.extend(["--align", str(int(part["align_kb"]))])
        if part.get("offset_kb"):
            tokens.extend(["--offset", str(int(part["offset_kb"]))])
        if part.get("part_type"):
            tokens.extend(["--part-type", str(part["part_type"])])
        if part.get("uuid"):
            tokens.extend(["--uuid", str(part["uuid"])])
        for exc in part.get("exclude_path") or []:
            tokens.extend(["--exclude-path", str(exc)])
        for extra in part.get("extra_args") or []:
            tokens.append(str(extra))
        lines.append(" ".join(tokens))

    bootloader = wks_data.get("bootloader") or {}
    if bootloader.get("ptable") or bootloader.get("timeout") is not None or bootloader.get("append"):
        btoks = ["bootloader"]
        if bootloader.get("ptable"):
            btoks.extend(["--ptable", str(bootloader["ptable"])])
        if bootloader.get("timeout") is not None:
            btoks.extend(["--timeout", str(int(bootloader["timeout"]))])
        if bootloader.get("append"):
            append_val = str(bootloader["append"]).replace('"', '\\"')
            btoks.append(f'--append="{append_val}"')
        lines.append(" ".join(btoks))

    return "\n".join(lines).rstrip() + "\n"
