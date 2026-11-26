"""Parsers and generators for bitbake-layers, bitbake-config-build, and bitbake-setup."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from bridge.i18n import tr_en


def parse_show_layers(stdout: str) -> list[dict[str, Any]]:
    """Parse `bitbake-layers show-layers` table output."""
    layers: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        stripped = line.strip()
        if (
            not stripped
            or stripped.startswith("NOTE:")
            or stripped.startswith("layer ")
            or set(stripped) <= {"=", "-", " "}
        ):
            continue
        parts = stripped.split()
        if len(parts) >= 3 and parts[-1].lstrip("-").isdigit():
            layers.append(
                {
                    "name": parts[0],
                    "path": " ".join(parts[1:-1]),
                    "priority": int(parts[-1]),
                    "branch": "unknown",
                    "compat": [],
                    "compatible_with_active": True,
                    "warning": None,
                    "appends_count": 0,
                }
            )
    return layers


def parse_show_appends(stdout: str) -> list[dict[str, Any]]:
    """Parse `bitbake-layers show-appends` output."""
    appends: list[dict[str, Any]] = []
    current_recipe: str | None = None
    for line in stdout.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("NOTE:") or stripped.startswith("==="):
            continue
        if stripped.endswith(":") and not stripped.startswith("/"):
            current_recipe = stripped[:-1].strip()
        elif current_recipe and ".bbappend" in stripped:
            parts = stripped.replace("\\", "/").split("/")
            layer_guess = next((p for p in parts if p.startswith("meta")), "unknown")
            appends.append(
                {
                    "recipe": current_recipe,
                    "layer": layer_guess,
                    "append_file": stripped,
                }
            )
    return appends


def parse_show_overlayed(stdout: str) -> list[dict[str, Any]]:
    """Parse `bitbake-layers show-overlayed` output."""
    overlayed: list[dict[str, Any]] = []
    current_recipe: str | None = None
    entries: list[tuple[str, int]] = []
    for line in stdout.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("NOTE:") or stripped.startswith("==="):
            continue
        if stripped.endswith(":") and not stripped.startswith("/"):
            if current_recipe and len(entries) >= 2:
                overlayed.append(
                    {
                        "recipe": current_recipe,
                        "active_layer": entries[0][0],
                        "active_priority": entries[0][1],
                        "shadowed_layer": entries[1][0],
                        "shadowed_priority": entries[1][1],
                    }
                )
            current_recipe = stripped[:-1].strip()
            entries = []
        elif current_recipe and ".bb" in stripped:
            parts = stripped.replace("\\", "/").split("/")
            layer = next((p for p in parts if p.startswith("meta")), "meta")
            entries.append((layer, 5))

    if current_recipe and len(entries) >= 2:
        overlayed.append(
            {
                "recipe": current_recipe,
                "active_layer": entries[0][0],
                "active_priority": entries[0][1],
                "shadowed_layer": entries[1][0],
                "shadowed_priority": entries[1][1],
            }
        )
    return overlayed


def check_layer_compatibility(
    layers: list[dict[str, Any]], active_series: str
) -> dict[str, Any]:
    """Detect LAYERSERIES_COMPAT mismatches and BBFILE_PRIORITY collisions."""
    issues: list[dict[str, Any]] = []

    for lyr in layers:
        compat = lyr.get("compat") or []
        if compat and active_series not in compat:
            issues.append(
                {
                    "severity": "error",
                    "kind": "compat_mismatch",
                    "layers": [lyr["name"]],
                    "message": tr_en(
                        f"'{lyr['name']}' katmanının LAYERSERIES_COMPAT={compat} değeri "
                        f"aktif '{active_series}' serisiyle uyumsuz.",
                        f"Layer '{lyr['name']}' LAYERSERIES_COMPAT={compat} is incompatible "
                        f"with active series '{active_series}'.",
                    ),
                    "fix_hint": tr_en(
                        f"Katmanı '{active_series}' dalına güncelleyin veya LAYERSERIES_COMPAT kontrolü yapın.",
                        f"Update the layer to the '{active_series}' branch or check LAYERSERIES_COMPAT.",
                    ),
                }
            )

    by_prio: dict[int, list[str]] = {}
    for lyr in layers:
        prio = int(lyr.get("priority", 0))
        name = str(lyr.get("name", ""))
        # Core meta & meta-yocto-bsp intentionally share priority 5
        if prio == 5 and name in ("meta", "meta-yocto-bsp", "meta-poky"):
            continue
        by_prio.setdefault(prio, []).append(name)

    for prio, names in by_prio.items():
        if len(names) > 1:
            issues.append(
                {
                    "severity": "warn",
                    "kind": "priority_collision",
                    "layers": names,
                    "message": tr_en(
                        f"Öncelik çakışması (BBFILE_PRIORITY = {prio}): {', '.join(names)}",
                        f"Priority collision (BBFILE_PRIORITY = {prio}): {', '.join(names)}",
                    ),
                    "fix_hint": tr_en(
                        "Üst katmanın conf/layer.conf içindeki BBFILE_PRIORITY değerini yükseltin.",
                        "Increase BBFILE_PRIORITY in the upper layer's conf/layer.conf.",
                    ),
                }
            )

    return {
        "ok": len([i for i in issues if i["severity"] == "error"]) == 0,
        "active_series": active_series,
        "issues": issues,
    }


def create_layer_skeleton(
    parent_dir: Path,
    name: str,
    priority: int = 6,
    compat: list[str] | None = None,
    description: str = "Custom OpenEmbedded layer created by Yocto Studio",
) -> list[str]:
    """Create a valid `meta-*` OpenEmbedded layer directory structure."""
    clean_name = name.strip()
    if not clean_name.startswith("meta-"):
        clean_name = f"meta-{clean_name}"
    if not re.match(r"^meta-[a-zA-Z0-9_-]+$", clean_name):
        raise ValueError(tr_en(f"Geçersiz katman adı: {name}", f"Invalid layer name: {name}"))

    compat_list = compat or ["wrynose", "scarthgap"]
    collection = clean_name[5:]
    layer_dir = parent_dir / clean_name
    conf_dir = layer_dir / "conf"
    example_dir = layer_dir / "recipes-example" / "example"

    conf_dir.mkdir(parents=True, exist_ok=True)
    example_dir.mkdir(parents=True, exist_ok=True)

    layer_conf = (
        f"# We have a conf and classes directory, add to BBPATH\n"
        f'BBPATH .= ":${{LAYERDIR}}"\n\n'
        f"# We have recipes-* directories, add to BBFILES\n"
        f'BBFILES += "${{LAYERDIR}}/recipes-*/*/*.bb \\\n'
        f'            ${{LAYERDIR}}/recipes-*/*/*.bbappend"\n\n'
        f'BBFILE_COLLECTIONS += "{clean_name}"\n'
        f'BBFILE_PATTERN_{clean_name} = "^${{LAYERDIR}}/"\n'
        f'BBFILE_PRIORITY_{clean_name} = "{priority}"\n\n'
        f'LAYERDEPENDS_{clean_name} = "core"\n'
        f'LAYERSERIES_COMPAT_{clean_name} = "{" ".join(compat_list)}"\n'
    )
    (conf_dir / "layer.conf").write_text(layer_conf, encoding="utf-8")

    readme = f"{clean_name}\n{'=' * len(clean_name)}\n\n{description}\n"
    (layer_dir / "README").write_text(readme, encoding="utf-8")

    copying = "Permission is hereby granted, free of charge, MIT License.\n"
    (layer_dir / "COPYING.MIT").write_text(copying, encoding="utf-8")

    example_bb = (
        f'SUMMARY = "Example recipe for {collection}"\n'
        'LICENSE = "MIT"\n'
        'LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/MIT;md5=0835ade698e0bcf8506ecda2f7b4f302"\n\n'
        "do_compile() {\n"
        f'    bbnote "Hello from {clean_name}"\n'
        "}\n"
    )
    (example_dir / "example_0.1.bb").write_text(example_bb, encoding="utf-8")

    return [
        str(conf_dir / "layer.conf"),
        str(layer_dir / "README"),
        str(layer_dir / "COPYING.MIT"),
        str(example_dir / "example_0.1.bb"),
    ]


def parse_config_build_fragments(stdout: str) -> list[dict[str, Any]]:
    """Parse `bitbake-config-build list-fragments` output."""
    fragments: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("Available") or stripped.startswith("---"):
            continue
        enabled = "*" in stripped or "[enabled]" in stripped.lower()
        clean = stripped.replace("*", "").replace("[enabled]", "").strip()
        parts = clean.split(None, 1)
        if not parts:
            continue
        fid = parts[0]
        desc = parts[1].lstrip("-:").strip() if len(parts) > 1 else fid
        cat = "security" if "root" in fid or "sec" in fid else "toolchain" if "clang" in fid else "build"
        fragments.append(
            {
                "id": fid,
                "name": fid.split("/")[-1],
                "description": desc,
                "category": cat,
                "enabled": enabled,
            }
        )
    return fragments
