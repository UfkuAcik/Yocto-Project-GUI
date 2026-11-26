"""Pre-Flight Inspector & Image Advisor modules for Yocto Studio (Module 9)."""

from __future__ import annotations

from typing import Any

from bridge.parsers.local_conf import parse_conf
from bridge.preflight.dryrun_analyzer import (
    analyze_features_licenses_and_bloat,
    parse_dryrun_errors,
)
from bridge.preflight.layer_audit import (
    audit_layers,
    detect_bbappend_version_drift,
    parse_layer_conf,
    parse_yocto_check_layer_output,
)
from bridge.preflight.optimizer import detect_host_resources, generate_optimization_plan
from bridge.preflight.sstate_probe import (
    estimate_setscene_hit_rate,
    probe_sstate_and_hashserve,
    probe_tcp_endpoint,
)
from bridge.preflight.version_matrix import (
    build_version_matrix,
    parse_bitbake_s_output,
    parse_devtool_upgrade_status,
)


def compute_readiness_score(issues: list[dict[str, Any]]) -> tuple[int, int, int, int, bool]:
    """Compute 0-100 readiness score and counts for blockers, warnings, and optimizations."""
    blockers = sum(1 for i in issues if i.get("severity") == "blocker" and not i.get("resolved"))
    warnings = sum(1 for i in issues if i.get("severity") == "warning" and not i.get("resolved"))
    optimizations = sum(
        1 for i in issues if i.get("severity") == "optimization" and not i.get("resolved")
    )
    score = max(0, min(100, 100 - blockers * 25 - warnings * 10 - optimizations * 5))
    return score, blockers, warnings, optimizations, blockers == 0


def apply_local_conf_fix(local_conf_text: str, fix: dict[str, Any]) -> tuple[str, str]:
    """Apply a Pre-Flight Auto-Fix to local.conf while preserving comments and formatting."""
    before = parse_conf(local_conf_text)
    after = parse_conf(local_conf_text)
    kind = str(fix.get("kind") or "")
    op = str(fix.get("operator") or ("+=" if kind == "local_conf_append" else "?="))
    changes: dict[str, str] = dict(fix.get("changes") or {})

    if kind == "local_conf_remove":
        for key in changes:
            after.remove_variable(key)
    else:
        for key, val in changes.items():
            if key == "INHERIT":
                after.set_variable(key, str(val), "+=")
            elif key.endswith(":remove"):
                existing = after.get_variables().get(key)
                if existing and str(val) not in existing.split():
                    after.set_variable(key, f"{existing} {val}".strip(), "=")
                elif not existing:
                    after.set_variable(key, str(val), "=")
            else:
                after.set_variable(key, str(val), op)

    return after.render(), before.unified_diff(after, "conf/local.conf")


__all__ = [
    "analyze_features_licenses_and_bloat",
    "apply_local_conf_fix",
    "audit_layers",
    "build_version_matrix",
    "compute_readiness_score",
    "detect_bbappend_version_drift",
    "detect_host_resources",
    "estimate_setscene_hit_rate",
    "generate_optimization_plan",
    "parse_bitbake_s_output",
    "parse_devtool_upgrade_status",
    "parse_dryrun_errors",
    "parse_layer_conf",
    "parse_yocto_check_layer_output",
    "probe_sstate_and_hashserve",
    "probe_tcp_endpoint",
]
