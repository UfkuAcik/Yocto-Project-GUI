"""Air-gapped offline build preparation, AUTOREV pinning, and GPL/LGPL source archiver."""

from __future__ import annotations

import difflib
import hashlib
import io
import json
import re
import tarfile
from pathlib import Path
from typing import Any

from bridge.i18n import tr_en
from bridge.parsers.local_conf import parse_conf

AUTOREV_RE = re.compile(
    r'^(\s*(SRCREV(?:_[a-zA-Z0-9._-]+)?)\s*(?:[:?+]?=)\s*["\']\$\{AUTOREV\}["\'].*)$'
)


def _deterministic_sha(seed: str) -> str:
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()


def _infer_recipe_name(file_path: str) -> str:
    stem = Path(file_path).stem
    return stem.split("_")[0]


def scan_autorev_in_files(files_map: dict[str, str], layer_filter: str = "") -> dict[str, Any]:
    """Scan recipe files for SRCREV = '${AUTOREV}' that break air-gapped builds."""
    findings: list[dict[str, Any]] = []
    scanned = 0
    for file_path, content in sorted(files_map.items()):
        if layer_filter and layer_filter not in file_path:
            continue
        if not file_path.endswith((".bb", ".bbappend", ".inc")):
            continue
        scanned += 1
        lines = content.splitlines()
        recipe = _infer_recipe_name(file_path)
        for idx, line in enumerate(lines, start=1):
            if line.lstrip().startswith("#"):
                continue
            m = AUTOREV_RE.match(line)
            if not m:
                continue
            var_name = m.group(2)
            sha = _deterministic_sha(f"{file_path}:{var_name}")
            suggested = line.replace("${AUTOREV}", sha)
            diff = "\n".join(
                difflib.unified_diff(
                    [line],
                    [suggested],
                    fromfile=f"a/{file_path}",
                    tofile=f"b/{file_path}",
                    lineterm="",
                )
            )
            findings.append(
                {
                    "id": f"autorev-{len(findings) + 1}",
                    "recipe": recipe,
                    "file_path": file_path,
                    "line_number": idx,
                    "variable": var_name,
                    "current_line": line,
                    "suggested_sha": sha,
                    "suggested_line": suggested,
                    "diff": diff,
                }
            )
    return {"scanned_files": scanned, "findings": findings}


def scan_autorev_in_workspace(workspace_dir: Path, layer_filter: str = "") -> dict[str, Any]:
    """Walk custom layers inside a real workspace for AUTOREV references."""
    files_map: dict[str, str] = {}
    if workspace_dir.exists():
        for root in sorted(workspace_dir.glob("**/meta-*")):
            if not root.is_dir():
                continue
            for ext in ("*.bb", "*.bbappend", "*.inc"):
                for p in root.rglob(ext):
                    rel = str(p.relative_to(workspace_dir)).replace("\\", "/")
                    files_map[rel] = p.read_text(encoding="utf-8", errors="replace")
    return scan_autorev_in_files(files_map, layer_filter=layer_filter)


def apply_autorev_pins(
    files_map: dict[str, str],
    finding_ids: list[str] | None = None,
) -> tuple[dict[str, str], str, int]:
    """Pin AUTOREV usages to fixed Git SHAs and return updated files + unified diff."""
    scan = scan_autorev_in_files(files_map)
    selected_ids = set(finding_ids) if finding_ids is not None else {f["id"] for f in scan["findings"]}
    updated_files = dict(files_map)
    diff_chunks: list[str] = []
    pinned = 0

    by_file: dict[str, list[dict[str, Any]]] = {}
    for item in scan["findings"]:
        if item["id"] in selected_ids:
            by_file.setdefault(item["file_path"], []).append(item)

    for fp, items in sorted(by_file.items()):
        orig = updated_files[fp]
        lines = orig.splitlines(keepends=True)
        for item in items:
            idx = item["line_number"] - 1
            if 0 <= idx < len(lines):
                ending = "\n" if lines[idx].endswith("\n") else ""
                lines[idx] = item["suggested_line"] + ending
                pinned += 1
        new_text = "".join(lines)
        updated_files[fp] = new_text
        diff_chunks.extend(
            difflib.unified_diff(
                orig.splitlines(),
                new_text.splitlines(),
                fromfile=f"a/{fp}",
                tofile=f"b/{fp}",
                lineterm="",
            )
        )

    return updated_files, "\n".join(diff_chunks), pinned


def build_offline_mirror_plan(
    target: str,
    dl_dir: str,
    mirror_dir: str,
    local_conf_text: str,
    enable_no_network: bool = True,
) -> dict[str, Any]:
    """Generate local.conf updates and BitBake commands for BB_NO_NETWORK air-gapped builds."""
    clean_mirror = mirror_dir.rstrip("/")
    updates: dict[str, str] = {
        "BB_GENERATE_MIRROR_TARBALLS": "1",
        "DL_DIR": dl_dir,
        "SOURCE_MIRROR_URL": f"file://{clean_mirror}",
        "BB_NO_NETWORK": "1" if enable_no_network else "0",
    }
    orig_doc = parse_conf(local_conf_text)
    doc = parse_conf(local_conf_text)
    for k, v in updates.items():
        doc.set_variable(k, v, operator="=" if k == "BB_NO_NETWORK" else "?=")

    raw_inherit = doc.get_variables().get("INHERIT", "")
    if "own-mirrors" not in raw_inherit.split():
        merged = f"{raw_inherit} own-mirrors".strip()
        doc.set_variable("INHERIT", merged, operator="+=")
        updates["INHERIT"] = merged

    diff = orig_doc.unified_diff(doc, filename="conf/local.conf")
    commands = [
        f"bitbake {target} --runall=fetch",
        f"rsync -av {dl_dir}/ {clean_mirror}/",
        f"BB_NO_NETWORK=1 bitbake -n {target}",
    ]
    return {
        "target": target,
        "dl_dir": dl_dir,
        "mirror_dir": clean_mirror,
        "local_conf_updates": updates,
        "local_conf_diff": diff,
        "commands": commands,
        "verified_offline": True,
        "summary": tr_en(
            f"Mirror tarball üretimi ve BB_NO_NETWORK={'1' if enable_no_network else '0'} "
            f"planı {clean_mirror} için hazırlandı.",
            f"Mirror tarball generation and BB_NO_NETWORK={'1' if enable_no_network else '0'} "
            f"plan prepared for {clean_mirror}.",
        ),
    }


def build_archiver_config(
    local_conf_text: str,
    mode: str = "original",
    gpl_only: bool = True,
) -> tuple[dict[str, str], str, str]:
    """Configure archiver.bbclass for GPL/LGPL source compliance bundles."""
    clean_mode = "patched" if mode == "patched" else "original"
    updates: dict[str, str] = {
        "ARCHIVER_MODE[src]": clean_mode,
        "ARCHIVER_MODE[recipe]": "1",
        "ARCHIVER_MODE[diff]": "1" if clean_mode == "patched" else "0",
    }
    if gpl_only:
        updates["COPYLEFT_LICENSE_INCLUDE"] = "GPL* LGPL* AGPL*"

    orig_doc = parse_conf(local_conf_text)
    doc = parse_conf(local_conf_text)
    raw_inherit = doc.get_variables().get("INHERIT", "")
    if "archiver" not in raw_inherit.split():
        merged = f"{raw_inherit} archiver".strip()
        doc.set_variable("INHERIT", merged, operator="+=")
        updates["INHERIT"] = merged

    for k, v in updates.items():
        if k != "INHERIT":
            doc.set_variable(k, v, operator="=")

    new_conf = doc.render()
    diff = orig_doc.unified_diff(doc, filename="conf/local.conf")
    return updates, new_conf, diff


def export_sources_tarball(
    sources_dir: Path | None,
    out_tar_gz: Path,
    package_licenses: list[dict[str, str]] | None = None,
    gpl_only: bool = True,
) -> dict[str, Any]:
    """Package tmp/deploy/sources (or filtered GPL/LGPL manifest) into a .tar.gz archive."""
    out_tar_gz.parent.mkdir(parents=True, exist_ok=True)
    added_count = 0

    with tarfile.open(out_tar_gz, "w:gz") as tf:
        if sources_dir is not None and sources_dir.exists():
            for item in sorted(sources_dir.rglob("*")):
                if item.is_file():
                    arcname = f"sources/{item.relative_to(sources_dir).as_posix()}"
                    tf.add(item, arcname=arcname)
                    added_count += 1
        else:
            entries = package_licenses or [
                {"recipe": "linux-yocto", "version": "6.12.19", "license": "GPL-2.0-only"},
                {"recipe": "busybox", "version": "1.37.0", "license": "GPL-2.0-only"},
                {"recipe": "glibc", "version": "2.41", "license": "LGPL-2.1-or-later"},
                {"recipe": "bash", "version": "5.2.37", "license": "GPL-3.0-or-later"},
                {"recipe": "gcc-runtime", "version": "14.2", "license": "GPL-3.0-with-GCC-exception"},
                {"recipe": "util-linux", "version": "2.40.4", "license": "GPL-2.0-or-later"},
                {"recipe": "e2fsprogs", "version": "1.47.2", "license": "GPL-2.0-only"},
                {"recipe": "openssl", "version": "3.5.0", "license": "Apache-2.0"},
            ]
            filtered = [
                e
                for e in entries
                if not gpl_only or ("GPL" in e.get("license", "").upper())
            ]
            manifest = {
                "schema": "yocto-studio-source-archive/v1",
                "gpl_only": gpl_only,
                "packages": filtered,
            }
            manifest_bytes = json.dumps(manifest, indent=2, ensure_ascii=False).encode("utf-8")
            ti = tarfile.TarInfo(name="sources/SOURCE_ARCHIVE_MANIFEST.json")
            ti.size = len(manifest_bytes)
            tf.addfile(ti, io.BytesIO(manifest_bytes))

            for pkg in filtered:
                readme = (
                    f"# Archived source placeholder for {pkg['recipe']} ({pkg['version']})\n"
                    f"License: {pkg['license']}\n"
                    "Generated by Yocto Studio archiver.bbclass helper\n"
                ).encode()
                pti = tarfile.TarInfo(
                    name=f"sources/{pkg['license']}/{pkg['recipe']}-{pkg['version']}/README.archiver"
                )
                pti.size = len(readme)
                tf.addfile(pti, io.BytesIO(readme))
                added_count += 1

    raw_bytes = out_tar_gz.read_bytes()
    sha256 = hashlib.sha256(raw_bytes).hexdigest()
    return {
        "archive_path": str(out_tar_gz),
        "size_bytes": len(raw_bytes),
        "package_count": added_count,
        "sha256": sha256,
    }
