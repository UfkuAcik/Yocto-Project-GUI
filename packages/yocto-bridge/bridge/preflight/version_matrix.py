"""Recipe/library version matrix, PREFERRED_VERSION/PROVIDER conflicts, and upgrade status."""

from __future__ import annotations

import re
from typing import Any

from bridge.i18n import tr_en

_BITBAKE_S_LINE_RE = re.compile(r"^([A-Za-z0-9_+.-]+)\s+:([^\s]+)(?:\s+:([^\s]+))?(?:\s+:([^\s]+))?$")

KNOWN_SECURITY_ADVISORIES: dict[tuple[str, str], str] = {
    ("openssl", "3.0."): "OpenSSL 3.0 serisi eski; CVE güncellemeleri için 3.5.x önerilir.",
    ("mosquitto", "2.0.18"): "Mosquitto 2.0.18 içinde bilinen MQTT v5 paket doğrulama riski (2.0.20+ önerilir).",
    ("mosquitto", "2.0.20"): "Mosquitto 2.0.20 için CVE-2025-41203 yaması veya 2.0.21 yükseltmesi kontrol edilmeli.",
}
KNOWN_SECURITY_ADVISORIES_EN: dict[tuple[str, str], str] = {
    ("openssl", "3.0."): "OpenSSL 3.0 series is aging; 3.5.x is recommended for CVE fixes.",
    ("mosquitto", "2.0.18"): "Known MQTT v5 packet validation risk in Mosquitto 2.0.18 (2.0.20+ recommended).",
    ("mosquitto", "2.0.20"): "Verify CVE-2025-41203 backport patch or upgrade to Mosquitto 2.0.21.",
}


def parse_bitbake_s_output(stdout: str) -> list[dict[str, Any]]:
    """Parse `bitbake -s` package version table output."""
    rows: list[dict[str, Any]] = []
    for raw in stdout.splitlines():
        line = raw.strip()
        if not line or line.startswith(("Loading", "Parsing", "Recipe", "NOTE:", "=")):
            continue
        match = _BITBAKE_S_LINE_RE.match(line)
        if not match:
            continue
        recipe, current, preferred, latest = match.groups()
        rows.append(
            {
                "recipe": recipe,
                "current": current.lstrip(":"),
                "preferred": preferred.lstrip(":") if preferred else None,
                "latest": latest.lstrip(":") if latest else None,
            }
        )
    return rows


def parse_devtool_upgrade_status(stdout: str) -> dict[str, dict[str, str]]:
    """Parse `devtool check-upgrade-status` tabular lines."""
    upgrades: dict[str, dict[str, str]] = {}
    for raw in stdout.splitlines():
        line = raw.strip()
        if not line or line.startswith(("INFO:", "NOTE:", "WARNING:")):
            continue
        parts = line.split()
        if len(parts) >= 3 and parts[0].isidentifier() or ("-" in parts[0] and len(parts) >= 3):
            rec = parts[0]
            cur = parts[1]
            ups = parts[2]
            if cur in {"UNKNOWN", "N/A"}:
                continue
            upgrades[rec] = {"current": cur, "upstream": ups}
    return upgrades


def build_version_matrix(
    recipes: list[dict[str, Any]],
    local_conf_vars: dict[str, str],
    bbappends_by_recipe: dict[str, list[str]] | None = None,
    upgrade_map: dict[str, dict[str, str]] | None = None,
    virtual_providers: dict[str, list[str]] | None = None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Build resolved component version matrix and detect PREFERRED_VERSION/PROVIDER issues."""
    entries: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    appends_map = bbappends_by_recipe or {}
    upgrades = upgrade_map or {}

    recipe_map = {str(r.get("pn") or r.get("recipe")): r for r in recipes}

    # Check PREFERRED_VERSION_* validity
    for var_key, pinned_val in local_conf_vars.items():
        if not var_key.startswith("PREFERRED_VERSION_"):
            continue
        target_rec = var_key[len("PREFERRED_VERSION_") :]
        rec_info = recipe_map.get(target_rec)
        if rec_info and pinned_val not in {str(rec_info.get("pv")), "%"}:
            actual = str(rec_info.get("pv"))
            issues.append(
                {
                    "id": f"fix-prefver-{target_rec}",
                    "severity": "blocker",
                    "category": "version",
                    "title": tr_en(
                        f"PREFERRED_VERSION çakışması: {target_rec}",
                        f"PREFERRED_VERSION conflict: {target_rec}",
                    ),
                    "summary": tr_en(
                        f'local.conf içinde PREFERRED_VERSION_{target_rec} = "{pinned_val}" '
                        f"ayarlı ancak katmanlarda mevcut sürüm {actual}.",
                        f'local.conf sets PREFERRED_VERSION_{target_rec} = "{pinned_val}", '
                        f"but available layer version is {actual}.",
                    ),
                    "detail": tr_en(
                        "Mevcut olmayan sürüm sabitlemesi BitBake sağlayıcı seçiminin çökmesine yol açar.",
                        "Pinning a non-existent recipe version causes BitBake provider resolution to fail.",
                    ),
                    "recipe": target_rec,
                    "layer": rec_info.get("layer"),
                    "dependency_chain": [
                        f"PREFERRED_VERSION_{target_rec}={pinned_val}",
                        tr_en(f"mevcut={actual}", f"available={actual}"),
                    ],
                    "auto_fix": {
                        "id": f"fix-prefver-{target_rec}",
                        "label": f"PREFERRED_VERSION_{target_rec} -> {actual}",
                        "description": tr_en(
                            f"local.conf içindeki PREFERRED_VERSION_{target_rec} değerini {actual} yapar.",
                            f"Sets PREFERRED_VERSION_{target_rec} to {actual} in local.conf.",
                        ),
                        "kind": "local_conf_set",
                        "target_file": "conf/local.conf",
                        "changes": {var_key: actual},
                    },
                }
            )

    # Check virtual/* multi-provider ambiguity
    for vtarget, candidates in (virtual_providers or {}).items():
        if len(candidates) <= 1:
            continue
        pref_key = f"PREFERRED_PROVIDER_{vtarget}"
        if pref_key not in local_conf_vars:
            recommended = candidates[0]
            issues.append(
                {
                    "id": f"warn-prefprov-{vtarget}",
                    "severity": "warning",
                    "category": "version",
                    "title": tr_en(
                        f"Çoklu sağlayıcı belirsizliği: {vtarget}",
                        f"Multi-provider ambiguity: {vtarget}",
                    ),
                    "summary": tr_en(
                        f"{vtarget} için {len(candidates)} sağlayıcı ({', '.join(candidates)}) mevcut "
                        f"ancak {pref_key} tanımlı değil.",
                        f"{len(candidates)} providers ({', '.join(candidates)}) exist for {vtarget}, "
                        f"but {pref_key} is unset.",
                    ),
                    "detail": tr_en(
                        "Açık PREFERRED_PROVIDER tanımlamak beklenmedik çekirdek/sürücü seçimini önler.",
                        "Defining PREFERRED_PROVIDER explicitly prevents unpredictable kernel/driver selection.",
                    ),
                    "recipe": recommended,
                    "layer": None,
                    "dependency_chain": [vtarget, *candidates],
                    "auto_fix": {
                        "id": f"warn-prefprov-{vtarget}",
                        "label": tr_en(
                            f'{pref_key} = "{recommended}" Ekle',
                            f'Add {pref_key} = "{recommended}"',
                        ),
                        "description": tr_en(
                            f'local.conf dosyasına {pref_key} = "{recommended}" satırını ekler.',
                            f'Adds {pref_key} = "{recommended}" to local.conf.',
                        ),
                        "kind": "local_conf_set",
                        "target_file": "conf/local.conf",
                        "changes": {pref_key: recommended},
                    },
                }
            )

    for rec in recipes:
        pn = str(rec.get("pn") or rec.get("recipe") or "")
        pv = str(rec.get("pv") or rec.get("resolved_version") or "unknown")
        layer = str(rec.get("layer") or "openembedded-core")
        prio = int(rec.get("priority") or 5)
        app_list = appends_map.get(pn, list(rec.get("bbappends") or []))
        providers = list(rec.get("providers") or [])
        pref_prov = local_conf_vars.get(f"PREFERRED_PROVIDER_{pn}")
        pref_ver = local_conf_vars.get(f"PREFERRED_VERSION_{pn}")
        conflict = None
        if pref_ver and pref_ver not in {pv, "%"}:
            conflict = tr_en(
                f"Sabitlenen {pref_ver} mevcut değil (mevcut: {pv})",
                f"Pinned {pref_ver} is unavailable (available: {pv})",
            )

        up = upgrades.get(pn) or {}
        upstream_ver = up.get("upstream") or rec.get("upstream_version")
        sec_note = None
        for (sec_pkg, ver_prefix), msg in KNOWN_SECURITY_ADVISORIES.items():
            if pn == sec_pkg and pv.startswith(ver_prefix):
                en_msg = KNOWN_SECURITY_ADVISORIES_EN.get((sec_pkg, ver_prefix), msg)
                sec_note = tr_en(msg, en_msg)
                break

        if sec_note:
            up_status = "security-risk"
        elif upstream_ver and upstream_ver != pv:
            up_status = "outdated"
        elif upstream_ver:
            up_status = "up-to-date"
        else:
            up_status = str(rec.get("upgrade_status") or "unknown")

        entries.append(
            {
                "recipe": pn,
                "resolved_version": pv,
                "layer": layer,
                "priority": prio,
                "bbappends": app_list,
                "providers": providers,
                "preferred_provider": pref_prov,
                "preferred_version": pref_ver,
                "preferred_conflict": conflict,
                "upstream_version": upstream_ver,
                "upgrade_status": up_status,
                "security_note": sec_note,
            }
        )

    return entries, issues
