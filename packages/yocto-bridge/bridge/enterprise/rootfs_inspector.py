"""Interactive RootFS size Treemap, oe-pkgdata-util reverse lookup, and bitbake-diffsigs explainer."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from bridge.i18n import tr_en

PKG_SIZE_LINE_RE = re.compile(r"^\s*(\d+)\s+KiB\s+([^\s]+)\s*$")


def categorize_package(pkg_name: str, recipe: str) -> str:
    low = f"{pkg_name} {recipe}".lower()
    if any(k in low for k in ("linux", "kernel-module", "firmware", "u-boot", "imx-boot", "optee")):
        return "Kernel & Firmware"
    if any(k in low for k in ("qt", "wayland", "weston", "mesa", "drm", "gstreamer", "opencv", "vulkan", "gtk")):
        return "Graphics & Multimedia"
    if any(k in low for k in ("systemd", "dbus", "udev", "busybox", "util-linux", "bash", "init", "kmod")):
        return "Systemd & Core OS"
    if any(k in low for k in ("ssl", "crypto", "openssh", "curl", "wpa", "bluez", "network", "mosquitto", "iptables")):
        return "Security & Networking"
    if any(k in low for k in ("python", "perl", "node", "rust")):
        return "Runtime & Scripting"
    if any(k in low for k in ("sensor", "gateway", "edge-ml", "custom", "telemetry")):
        return "Custom Applications"
    if low.startswith("lib") or "glibc" in low or "libstdc++" in low or "zlib" in low:
        return "Shared Libraries"
    return "Other Packages"


def _default_recipe_for_pkg(pkg_name: str) -> str:
    if pkg_name.startswith("kernel-module-") or pkg_name == "kernel-image":
        return "linux-imx"
    if pkg_name.startswith("libc6"):
        return "glibc"
    if pkg_name.startswith(("libcrypto", "libssl")):
        return "openssl"
    if pkg_name.startswith("libstdc++"):
        return "gcc-runtime"
    if pkg_name.startswith("python3-"):
        return "python3"
    if pkg_name.startswith("gstreamer1.0-"):
        return "gstreamer1.0-plugins-base"
    if pkg_name.startswith("qtbase"):
        return "qtbase"
    return pkg_name


def parse_installed_package_sizes(
    text: str,
    image: str = "core-image-minimal",
    machine: str = "imx8mp-lpddr4-evk",
    recipe_map: dict[str, str] | None = None,
    file_map: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """Parse buildhistory installed-package-sizes.txt into Treemap & category datasets."""
    items: list[dict[str, Any]] = []
    rmap = recipe_map or {}
    fmap = file_map or {}

    for raw in text.splitlines():
        m = PKG_SIZE_LINE_RE.match(raw)
        if not m:
            continue
        kb = int(m.group(1))
        pkg = m.group(2)
        recipe = rmap.get(pkg, _default_recipe_for_pkg(pkg))
        cat = categorize_package(pkg, recipe)
        samples = fmap.get(pkg, [f"/usr/lib/{pkg}.so" if pkg.startswith("lib") else f"/usr/bin/{pkg}"])
        items.append(
            {
                "name": pkg,
                "recipe": recipe,
                "category": cat,
                "size_bytes": kb * 1024,
                "size_kb": kb,
                "percent": 0.0,
                "file_count": max(1, len(samples)),
                "sample_files": samples,
            }
        )

    total_bytes = sum(i["size_bytes"] for i in items)
    cat_totals: dict[str, dict[str, Any]] = {}
    for item in items:
        item["percent"] = round((item["size_bytes"] / total_bytes) * 100.0, 2) if total_bytes else 0.0
        cat = item["category"]
        bucket = cat_totals.setdefault(
            cat, {"category": cat, "size_bytes": 0, "percent": 0.0, "package_count": 0}
        )
        bucket["size_bytes"] += item["size_bytes"]
        bucket["package_count"] += 1

    for bucket in cat_totals.values():
        bucket["percent"] = round((bucket["size_bytes"] / total_bytes) * 100.0, 2) if total_bytes else 0.0

    items.sort(key=lambda x: x["size_bytes"], reverse=True)
    categories = sorted(cat_totals.values(), key=lambda x: x["size_bytes"], reverse=True)

    return {
        "image": image,
        "machine": machine,
        "total_bytes": total_bytes,
        "package_count": len(items),
        "categories": categories,
        "packages": items,
    }


def lookup_path_in_index(query_path: str, pkg_index: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Match a target filesystem path against indexed oe-pkgdata-util mappings."""
    q = query_path.strip()
    if not q:
        return pkg_index[:10]
    q_low = q.lower()
    exact = [row for row in pkg_index if row["file_path"].lower() == q_low]
    if exact:
        return exact
    return [
        row
        for row in pkg_index
        if q_low in row["file_path"].lower()
        or q_low in row["package"].lower()
        or q_low in row["recipe"].lower()
    ]


def parse_pkgdata_find_path(find_path_out: str, recipe_name: str = "") -> list[dict[str, Any]]:
    """Parse `oe-pkgdata-util find-path /path/to/file` output lines (`pkg: /path`)."""
    matches: list[dict[str, Any]] = []
    for line in find_path_out.splitlines():
        s = line.strip()
        if ":" not in s:
            continue
        pkg, fp = s.split(":", 1)
        pkg_clean = pkg.strip()
        fp_clean = fp.strip()
        rec = recipe_name.strip() or _default_recipe_for_pkg(pkg_clean)
        matches.append(
            {
                "file_path": fp_clean,
                "package": pkg_clean,
                "recipe": rec,
                "recipe_file": f"recipes/{rec}/{rec}.bb",
                "layer": "openembedded-core",
                "version": "resolved",
                "size_bytes": 0,
            }
        )
    return matches


def parse_diffsigs_output(raw_text: str, recipe: str = "", task: str = "") -> dict[str, Any]:
    """Simplify verbose bitbake-diffsigs output into human-readable root causes."""
    causes: list[dict[str, Any]] = []
    lines = raw_text.splitlines()
    old_sig = ""
    new_sig = ""
    detected_task = task or "do_compile"
    detected_recipe = recipe or "unknown-recipe"

    base_re = re.compile(r"basehash changed from ([0-9a-f]+) to ([0-9a-f]+)", re.IGNORECASE)
    var_re = re.compile(r"Variable\s+([^\s]+)\s+value changed", re.IGNORECASE)
    file_re = re.compile(r"(?:Checksum|Hash) for (?:file|URL)\s+([^\s]+)\s+changed", re.IGNORECASE)
    dep_re = re.compile(r"Hash for dependent task\s+([^\s]+)\s+changed", re.IGNORECASE)
    hdr_re = re.compile(r"Task\s+([^\s:]+):([^\s]+)")

    i = 0
    while i < len(lines):
        line = lines[i]
        hm = hdr_re.search(line)
        if hm:
            detected_recipe = Path(hm.group(1)).stem.split("_")[0]
            detected_task = hm.group(2)

        bm = base_re.search(line)
        if bm:
            old_sig, new_sig = bm.group(1), bm.group(2)

        vm = var_re.search(line)
        if vm:
            sym = vm.group(1)
            before = lines[i + 1].strip() if i + 1 < len(lines) else ""
            after = lines[i + 2].strip() if i + 2 < len(lines) else ""
            causes.append(
                {
                    "cause_type": "variable_changed",
                    "symbol": sym,
                    "before": before.lstrip("- "),
                    "after": after.lstrip("+ "),
                    "explanation": tr_en(
                        f"Değişken '{sym}' değeri değiştiği için görev sstate imzası geçersizleşti.",
                        f"Task sstate signature invalidated because variable '{sym}' changed.",
                    ),
                    "impact": "high",
                }
            )

        fm = file_re.search(line)
        if fm:
            fpath = fm.group(1)
            causes.append(
                {
                    "cause_type": "file_changed",
                    "symbol": Path(fpath).name,
                    "before": "previous sha256",
                    "after": f"modified: {fpath}",
                    "explanation": tr_en(
                        f"Yerel kaynak/yama dosyası '{fpath}' içeriği değişti.",
                        f"Local source/patch file '{fpath}' content changed.",
                    ),
                    "impact": "high",
                }
            )

        dm = dep_re.search(line)
        if dm:
            dep_task = dm.group(1)
            causes.append(
                {
                    "cause_type": "dependency_changed",
                    "symbol": dep_task,
                    "before": "cached upstream task",
                    "after": "rebuilt dependency",
                    "explanation": tr_en(
                        f"Bağımlı görev '{dep_task}' yeniden derlendiği için kademeli rebuild tetiklendi.",
                        f"Cascading rebuild triggered because dependent task '{dep_task}' was rebuilt.",
                    ),
                    "impact": "medium",
                }
            )
        i += 1

    if not causes:
        causes.append(
            {
                "cause_type": "metadata_stamp",
                "symbol": f"{detected_recipe}:{detected_task}",
                "before": old_sig or "N/A",
                "after": new_sig or "N/A",
                "explanation": tr_en(
                    "Doğrudan değişken farkı görülmedi; "
                    "görev imzası metadata veya stamp güncellemesiyle değişti.",
                    "No direct variable delta found; "
                    "task signature changed via metadata or stamp update.",
                ),
                "impact": "low",
            }
        )

    summary = tr_en(
        f"{detected_recipe}:{detected_task} görevi {len(causes)} kök neden nedeniyle yeniden derlendi.",
        f"Task {detected_recipe}:{detected_task} rebuilt due to {len(causes)} root cause(s).",
    )
    return {
        "task": detected_task,
        "recipe": detected_recipe,
        "old_sig": old_sig or "8d4a1109e2f3c4b5",
        "new_sig": new_sig or "e91b7c42a08f12d4",
        "summary": summary,
        "causes": causes,
        "raw_output": raw_text,
    }
