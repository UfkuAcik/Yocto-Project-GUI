"""Pure-stdlib parser for Yocto `buildhistory-diff` output."""

from __future__ import annotations

import re
from typing import Any

_IMAGESIZE_RE = re.compile(r"IMAGESIZE:\s*(\d+)\s*->\s*(\d+)")
_PKG_PATH_RE = re.compile(r"^(?:packages|images)/[^/]+/([^/:]+)(?:/([^:]+))?:\s*(.+)$")
_VERSION_ARROW_RE = re.compile(r"(?:PV|Version(?:\s+changed)?)\s*:\s*([^\s]+)\s*->\s*([^\s]+)")
_PKGSIZE_RE = re.compile(r"PKGSIZE:\s*(\d+)\s*->\s*(\d+)")
_PLUS_MINUS_RE = re.compile(r"^([+\-])\s+([^\s(]+)(?:\s*\(([^)]+)\))?")
_MODIFIED_SUMMARY_RE = re.compile(
    r"^M\s+([^\s:]+):\s*([^\s]+)\s*->\s*([^\s]+)(?:\s*\(([+\-]?\d+)\s*KB\))?",
    re.IGNORECASE,
)


def parse_buildhistory_diff(
    text: str,
    from_build: str = "previous",
    to_build: str = "current",
) -> dict[str, Any]:
    """Parse `buildhistory-diff` text into structured package/image deltas."""
    entries_by_pkg: dict[str, dict[str, Any]] = {}
    rootfs_size_kb = 0
    rootfs_delta_kb = 0

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue

        img_match = _IMAGESIZE_RE.search(line)
        if img_match:
            old_kb = int(img_match.group(1))
            new_kb = int(img_match.group(2))
            rootfs_size_kb = new_kb
            rootfs_delta_kb = new_kb - old_kb
            continue

        mod_match = _MODIFIED_SUMMARY_RE.match(line)
        if mod_match:
            pkg, old_v, new_v, delta_s = mod_match.groups()
            delta_kb = int(delta_s) if delta_s else 0
            entries_by_pkg[pkg] = {
                "package": pkg,
                "change": "upgraded",
                "old_version": old_v,
                "new_version": new_v,
                "size_delta_kb": delta_kb,
            }
            continue

        pm_match = _PLUS_MINUS_RE.match(line)
        if pm_match:
            sign, pkg, ver = pm_match.groups()
            if sign == "+":
                entries_by_pkg[pkg] = {
                    "package": pkg,
                    "change": "added",
                    "old_version": None,
                    "new_version": ver or "unknown",
                    "size_delta_kb": 0,
                }
            else:
                entries_by_pkg[pkg] = {
                    "package": pkg,
                    "change": "removed",
                    "old_version": ver or "unknown",
                    "new_version": None,
                    "size_delta_kb": 0,
                }
            continue

        path_match = _PKG_PATH_RE.match(line)
        if path_match:
            recipe, subpkg, detail = path_match.groups()
            pkg = subpkg or recipe
            entry = entries_by_pkg.setdefault(
                pkg,
                {
                    "package": pkg,
                    "change": "upgraded",
                    "old_version": None,
                    "new_version": None,
                    "size_delta_kb": 0,
                },
            )
            ver_match = _VERSION_ARROW_RE.search(detail)
            if ver_match:
                entry["old_version"] = ver_match.group(1)
                entry["new_version"] = ver_match.group(2)
            size_match = _PKGSIZE_RE.search(detail)
            if size_match:
                old_b = int(size_match.group(1))
                new_b = int(size_match.group(2))
                entry["size_delta_kb"] = round((new_b - old_b) / 1024.0)

    entries = list(entries_by_pkg.values())
    if rootfs_delta_kb == 0 and entries:
        rootfs_delta_kb = sum(int(e.get("size_delta_kb") or 0) for e in entries)

    summary = {
        "total_changes": len(entries),
        "added": sum(1 for e in entries if e["change"] == "added"),
        "removed": sum(1 for e in entries if e["change"] == "removed"),
        "upgraded": sum(1 for e in entries if e["change"] == "upgraded"),
    }

    return {
        "from_build": from_build,
        "to_build": to_build,
        "rootfs_size_kb": rootfs_size_kb,
        "rootfs_delta_kb": rootfs_delta_kb,
        "summary": summary,
        "entries": entries,
    }
