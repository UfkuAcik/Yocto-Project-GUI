"""Yocto LTS Migration Linter & Auto-Migrate Diff Engine (Kirkstone 4.0 -> Scarthgap 5.0 -> Wrynose 6.0)."""

from __future__ import annotations

import difflib
import re
from typing import Any

from bridge.i18n import tr_en

# Legacy BitBake underscore overrides converted to ':' syntax (introduced in Honister/Kirkstone, strictly enforced).
LEGACY_OVERRIDE_RE = re.compile(
    r"^(\s*[A-Za-z0-9_.${}-]+?)"
    r"(_append|_prepend|_remove|_class-target|_class-native|_class-nativesdk|_forcevariable)"
    r"(\s*(?:[:?+]?=|\.=|=\.))(.*)$"
)

WORKDIR_SOURCE_RE = re.compile(
    r'(\$\{WORKDIR\}/(?!build\b|recipe-sysroot|temp\b|image\b|package\b|deploy)[A-Za-z0-9_./-]+)'
)

DEBUG_TWEAKS_RE = re.compile(
    r'^(\s*(?:EXTRA_IMAGE_FEATURES|IMAGE_FEATURES)\s*[:?+]?=\s*["\'][^"\']*)\bdebug-tweaks\b([^"\']*["\'].*)$'
)

CVE_CHECK_RE = re.compile(r'^(\s*INHERIT\s*[:+]?=\s*["\'][^"\']*)(?<!sbom-)\bcve-check\b([^"\']*["\'].*)$')

BB_ENV_EXTRAWHITE_RE = re.compile(r"\bBB_ENV_EXTRAWHITE\b")

LAYERSERIES_RE = re.compile(r'^(\s*LAYERSERIES_COMPAT_[A-Za-z0-9_-]+\s*=\s*["\'])([^"\']*)(["\'].*)$')


def _replace_workdir_for_unpackdir(line: str) -> str | None:
    """Convert source-unpack ${WORKDIR}/... paths to ${UNPACKDIR}/... without touching ${WORKDIR}/build."""
    if "${WORKDIR}" not in line:
        return None
    # Skip ${WORKDIR}/build or ${WORKDIR}/recipe-sysroot or ${WORKDIR}/temp
    new_line = WORKDIR_SOURCE_RE.sub(
        lambda m: m.group(1).replace("${WORKDIR}/sources-unpack", "${UNPACKDIR}").replace("${WORKDIR}", "${UNPACKDIR}"),
        line,
    )
    if new_line == line:
        return None
    return new_line


def scan_migration_files(
    files_map: dict[str, str],
    from_lts: str = "scarthgap",
    to_lts: str = "wrynose",
    layer_name: str = "meta-custom-iot",
) -> dict[str, Any]:
    """Scan layer metadata files for LTS migration breaking changes and build unified diffs."""
    findings: list[dict[str, Any]] = []
    updated_files: dict[str, str] = {}
    scanned = 0
    migration_path = f"{from_lts} -> {to_lts}"

    for fp, content in sorted(files_map.items()):
        if not fp.endswith((".bb", ".bbappend", ".inc", ".conf")):
            continue
        scanned += 1
        orig_lines = content.splitlines()
        new_lines = list(orig_lines)

        for idx, line in enumerate(orig_lines, start=1):
            stripped = line.lstrip()
            if stripped.startswith("#"):
                continue

            current_after = line

            # Rule 1: Legacy underscore overrides -> colon syntax
            lm = LEGACY_OVERRIDE_RE.match(current_after)
            if lm:
                new_override = ":" + lm.group(2)[1:]
                after = f"{lm.group(1)}{new_override}{lm.group(3)}{lm.group(4)}"
                findings.append(
                    {
                        "id": f"mig-{len(findings) + 1}",
                        "rule_id": "LEGACY_OVERRIDE_SYNTAX",
                        "severity": "error",
                        "file_path": fp,
                        "line_number": idx,
                        "before_line": current_after,
                        "after_line": after,
                        "reason": tr_en(
                            f"Eski '{lm.group(2)}' alt çizgi override sözdizimi "
                            f"'{new_override}' ile değiştirilmelidir.",
                            f"Legacy '{lm.group(2)}' underscore override syntax must be replaced "
                            f"with '{new_override}'.",
                        ),
                        "migration_path": migration_path,
                        "auto_fixable": True,
                    }
                )
                current_after = after

            # Rule 2: WORKDIR -> UNPACKDIR (Scarthgap/Wrynose source unpack transition)
            if to_lts in ("scarthgap", "wrynose"):
                unpacked = _replace_workdir_for_unpackdir(current_after)
                if unpacked:
                    findings.append(
                        {
                            "id": f"mig-{len(findings) + 1}",
                            "rule_id": "WORKDIR_TO_UNPACKDIR",
                            "severity": "error" if to_lts == "wrynose" else "warning",
                            "file_path": fp,
                            "line_number": idx,
                            "before_line": current_after,
                            "after_line": unpacked,
                            "reason": tr_en(
                                "Yocto 5.0+/6.0 Wrynose'da yerel dosyalar ve S artık ${UNPACKDIR} altına açılır "
                                "(${WORKDIR}/build korunur).",
                                "In Yocto 5.0+/6.0 Wrynose, local files and S unpack under ${UNPACKDIR} "
                                "(${WORKDIR}/build is preserved).",
                            ),
                            "migration_path": migration_path,
                            "auto_fixable": True,
                        }
                    )
                    current_after = unpacked

            # Rule 3: debug-tweaks removed
            dm = DEBUG_TWEAKS_RE.match(current_after)
            if dm:
                replacement_tokens = "allow-empty-password empty-root-password allow-root-login"
                after = f"{dm.group(1)}{replacement_tokens}{dm.group(2)}"
                findings.append(
                    {
                        "id": f"mig-{len(findings) + 1}",
                        "rule_id": "DEBUG_TWEAKS_REMOVED",
                        "severity": "error",
                        "file_path": fp,
                        "line_number": idx,
                        "before_line": current_after,
                        "after_line": after,
                        "reason": tr_en(
                            "'debug-tweaks' kaldırıldı; açık güvenlik bayrakları "
                            "('allow-empty-password empty-root-password allow-root-login') kullanılmalıdır.",
                            "'debug-tweaks' was removed; use explicit security flags "
                            "('allow-empty-password empty-root-password allow-root-login').",
                        ),
                        "migration_path": migration_path,
                        "auto_fixable": True,
                    }
                )
                current_after = after

            # Rule 4: cve-check -> sbom-cve-check in Wrynose 6.0
            if to_lts == "wrynose":
                cm = CVE_CHECK_RE.match(current_after)
                if cm:
                    after = f"{cm.group(1)}sbom-cve-check{cm.group(2)}"
                    findings.append(
                        {
                            "id": f"mig-{len(findings) + 1}",
                            "rule_id": "CVE_CHECK_TO_SBOM",
                            "severity": "warning",
                            "file_path": fp,
                            "line_number": idx,
                            "before_line": current_after,
                            "after_line": after,
                            "reason": tr_en(
                                "Yocto 6.0 Wrynose'da klasik 'cve-check' yerine 'sbom-cve-check' önerilir.",
                                "Yocto 6.0 Wrynose recommends 'sbom-cve-check' instead of legacy 'cve-check'.",
                            ),
                            "migration_path": migration_path,
                            "auto_fixable": True,
                        }
                    )
                    current_after = after

            # Rule 5: BB_ENV_EXTRAWHITE -> BB_ENV_PASSTHROUGH_ADDITIONS
            if BB_ENV_EXTRAWHITE_RE.search(current_after):
                after = BB_ENV_EXTRAWHITE_RE.sub("BB_ENV_PASSTHROUGH_ADDITIONS", current_after)
                findings.append(
                    {
                        "id": f"mig-{len(findings) + 1}",
                        "rule_id": "BB_ENV_EXTRAWHITE_RENAMED",
                        "severity": "error",
                        "file_path": fp,
                        "line_number": idx,
                        "before_line": current_after,
                        "after_line": after,
                        "reason": tr_en(
                            "BB_ENV_EXTRAWHITE kaldırıldı; BB_ENV_PASSTHROUGH_ADDITIONS kullanın.",
                            "BB_ENV_EXTRAWHITE was removed; use BB_ENV_PASSTHROUGH_ADDITIONS instead.",
                        ),
                        "migration_path": migration_path,
                        "auto_fixable": True,
                    }
                )
                current_after = after

            # Rule 6: LAYERSERIES_COMPAT update
            lsm = LAYERSERIES_RE.match(current_after)
            if lsm:
                existing = [tok for tok in lsm.group(2).split() if tok]
                if to_lts not in existing:
                    merged = " ".join([*existing, to_lts])
                    after = f"{lsm.group(1)}{merged}{lsm.group(3)}"
                    findings.append(
                        {
                            "id": f"mig-{len(findings) + 1}",
                            "rule_id": "LAYERSERIES_COMPAT_OUTDATED",
                            "severity": "error",
                            "file_path": fp,
                            "line_number": idx,
                            "before_line": current_after,
                            "after_line": after,
                            "reason": tr_en(
                                f"Katman LAYERSERIES_COMPAT listesinde '{to_lts}' eksik.",
                                f"Layer LAYERSERIES_COMPAT list is missing '{to_lts}'.",
                            ),
                            "migration_path": migration_path,
                            "auto_fixable": True,
                        }
                    )
                    current_after = after

            new_lines[idx - 1] = current_after

        new_text = "\n".join(new_lines) + ("\n" if content.endswith("\n") else "")
        if new_text != content:
            updated_files[fp] = new_text

    diff_chunks: list[str] = []
    for fp, new_text in sorted(updated_files.items()):
        diff_chunks.extend(
            difflib.unified_diff(
                files_map[fp].splitlines(),
                new_text.splitlines(),
                fromfile=f"a/{fp}",
                tofile=f"b/{fp}",
                lineterm="",
            )
        )

    return {
        "from_lts": from_lts,
        "to_lts": to_lts,
        "layer_name": layer_name,
        "scanned_files": scanned,
        "findings": findings,
        "combined_diff": "\n".join(diff_chunks),
    }


def apply_migration_fixes(
    files_map: dict[str, str],
    from_lts: str = "scarthgap",
    to_lts: str = "wrynose",
    layer_name: str = "meta-custom-iot",
    finding_ids: list[str] | None = None,
) -> tuple[dict[str, str], dict[str, Any]]:
    """Apply migration auto-fixes (all or selected finding IDs) and verify remaining issues."""
    scan = scan_migration_files(files_map, from_lts=from_lts, to_lts=to_lts, layer_name=layer_name)
    selected = (
        set(finding_ids)
        if finding_ids is not None
        else {f["id"] for f in scan["findings"] if f["auto_fixable"]}
    )

    updated = dict(files_map)
    modified_files: list[str] = []
    applied_count = 0

    by_file_line: dict[tuple[str, int], list[dict[str, Any]]] = {}
    for item in scan["findings"]:
        if item["id"] in selected:
            by_file_line.setdefault((item["file_path"], item["line_number"]), []).append(item)

    touched_lines_by_file: dict[str, dict[int, str]] = {}
    for (fp, line_no), items in sorted(by_file_line.items()):
        # Chain items sequentially on the same line if multiple rules triggered on one line
        final_after = items[-1]["after_line"]
        touched_lines_by_file.setdefault(fp, {})[line_no] = final_after
        applied_count += len(items)

    diff_chunks: list[str] = []
    for fp, line_updates in sorted(touched_lines_by_file.items()):
        orig = updated[fp]
        lines = orig.splitlines()
        for line_no, replacement in line_updates.items():
            if 1 <= line_no <= len(lines):
                lines[line_no - 1] = replacement
        new_text = "\n".join(lines) + ("\n" if orig.endswith("\n") else "")
        updated[fp] = new_text
        modified_files.append(fp)
        diff_chunks.extend(
            difflib.unified_diff(
                orig.splitlines(),
                new_text.splitlines(),
                fromfile=f"a/{fp}",
                tofile=f"b/{fp}",
                lineterm="",
            )
        )

    rescan = scan_migration_files(updated, from_lts=from_lts, to_lts=to_lts, layer_name=layer_name)
    return updated, {
        "applied_count": applied_count,
        "modified_files": modified_files,
        "combined_diff": "\n".join(diff_chunks),
        "remaining_findings": rescan["findings"],
    }
