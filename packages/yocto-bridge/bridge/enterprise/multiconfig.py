"""Multiconfig (BBMULTICONFIG) & heterogeneous SoC multi-target orchestrator."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from bridge.i18n import tr_en
from bridge.parsers.local_conf import parse_conf

MC_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")


def validate_multiconfig_name(name: str) -> str:
    clean = name.strip()
    if not clean or not MC_NAME_RE.match(clean):
        raise ValueError(f"Invalid multiconfig name: {name!r}")
    return clean


def parse_multiconfig_text(name: str, text: str, file_path: str = "") -> dict[str, Any]:
    """Parse a conf/multiconfig/<name>.conf file into structured fields."""
    doc = parse_conf(text)
    vars_map = doc.get_variables()
    machine = vars_map.get("MACHINE", "")
    tmpdir = vars_map.get("TMPDIR", f"${{TOPDIR}}/tmp-{name}")
    distro = vars_map.get("DISTRO", "")
    description = vars_map.get("DESCRIPTION", "")
    if not description:
        for line in text.splitlines():
            s = line.strip()
            if s.startswith("#"):
                description = s.lstrip("# ").strip()
                break

    known = {"MACHINE", "TMPDIR", "DISTRO", "DESCRIPTION"}
    extra_vars = {k: v for k, v in vars_map.items() if k not in known}
    return {
        "name": name,
        "file_path": file_path or f"conf/multiconfig/{name}.conf",
        "machine": machine,
        "tmpdir": tmpdir,
        "distro": distro,
        "description": description,
        "extra_vars": extra_vars,
        "raw_content": text,
    }


def generate_multiconfig_conf(
    name: str,
    machine: str,
    tmpdir: str,
    distro: str = "",
    description: str = "",
    extra_vars: dict[str, str] | None = None,
) -> str:
    """Generate a standard Yocto conf/multiconfig/<name>.conf document."""
    clean = validate_multiconfig_name(name)
    lines = [
        f"# Multiconfig: {description or clean}",
        tr_en("# Managed by Yocto Studio (Modül 11)", "# Managed by Yocto Studio (Module 11)"),
        f'MACHINE = "{machine.strip()}"',
        f'TMPDIR = "{tmpdir.strip() or f"${{TOPDIR}}/tmp-{clean}"}"',
    ]
    if distro.strip():
        lines.append(f'DISTRO = "{distro.strip()}"')
    for key, val in (extra_vars or {}).items():
        k = key.strip()
        if k and k not in {"MACHINE", "TMPDIR", "DISTRO", "DESCRIPTION"}:
            lines.append(f'{k} ?= "{val.strip()}"')
    return "\n".join(lines) + "\n"


def build_mcdepends_expression(
    from_config: str,
    to_config: str,
    recipe: str,
    task: str = "do_deploy",
) -> dict[str, str]:
    """Build a BitBake mc:<from>:<to>:<recipe>:<task> inter-multiconfig dependency."""
    src = validate_multiconfig_name(from_config)
    dst = validate_multiconfig_name(to_config)
    rec = recipe.strip()
    tsk = task.strip() or "do_deploy"
    if not rec:
        raise ValueError("Recipe name cannot be empty for mcdepends")
    expr = f"mc:{src}:{dst}:{rec}:{tsk}"
    return {
        "from_config": src,
        "to_config": dst,
        "recipe": rec,
        "task": tsk,
        "expression": expr,
    }


def sync_bbmulticonfig_in_local_conf(
    local_conf_text: str,
    enabled_names: list[str],
    mcdepends_list: list[dict[str, str]] | None = None,
) -> tuple[str, str]:
    """Update BBMULTICONFIG cleanly in local.conf while preserving comments."""
    orig_doc = parse_conf(local_conf_text)
    doc = parse_conf(local_conf_text)
    cleaned = [validate_multiconfig_name(n) for n in enabled_names if n.strip()]
    unique_names = list(dict.fromkeys(cleaned))
    if unique_names:
        doc.set_variable("BBMULTICONFIG", " ".join(unique_names), operator="=")
    else:
        doc.remove_variable("BBMULTICONFIG")

    if mcdepends_list:
        exprs = " ".join(d["expression"] for d in mcdepends_list if d.get("expression"))
        if exprs:
            doc.set_variable("do_image_complete[mcdepends]", exprs, operator="=")

    new_content = doc.render()
    diff = orig_doc.unified_diff(doc, filename="conf/local.conf")
    return new_content, diff


def list_workspace_multiconfigs(build_dir: Path, local_conf_text: str) -> dict[str, Any]:
    """Discover conf/multiconfig/*.conf files inside a Yocto build directory."""
    mc_dir = build_dir / "conf" / "multiconfig"
    configs: list[dict[str, Any]] = []
    if mc_dir.exists():
        for conf_file in sorted(mc_dir.glob("*.conf")):
            text = conf_file.read_text(encoding="utf-8", errors="replace")
            configs.append(parse_multiconfig_text(conf_file.stem, text, str(conf_file)))

    vars_map = parse_conf(local_conf_text).get_variables()
    enabled = [tok for tok in vars_map.get("BBMULTICONFIG", "").split() if tok]
    mcdepends_raw = vars_map.get("do_image_complete[mcdepends]", "")
    dependencies: list[dict[str, str]] = []
    for tok in mcdepends_raw.split():
        parts = tok.split(":")
        if len(parts) == 5 and parts[0] == "mc":
            dependencies.append(
                {
                    "from_config": parts[1],
                    "to_config": parts[2],
                    "recipe": parts[3],
                    "task": parts[4],
                    "expression": tok,
                }
            )
    snippet = f'BBMULTICONFIG = "{" ".join(enabled)}"' if enabled else 'BBMULTICONFIG = ""'
    return {
        "bbmulticonfig_enabled": enabled,
        "configs": configs,
        "dependencies": dependencies,
        "local_conf_snippet": snippet,
    }


def save_workspace_multiconfig(
    build_dir: Path,
    name: str,
    machine: str,
    tmpdir: str,
    distro: str = "",
    description: str = "",
    extra_vars: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Write conf/multiconfig/<name>.conf on disk and return parsed entry."""
    clean = validate_multiconfig_name(name)
    mc_dir = build_dir / "conf" / "multiconfig"
    mc_dir.mkdir(parents=True, exist_ok=True)
    target = mc_dir / f"{clean}.conf"
    raw = generate_multiconfig_conf(clean, machine, tmpdir, distro, description, extra_vars)
    target.write_text(raw, encoding="utf-8")
    return parse_multiconfig_text(clean, raw, str(target))


def delete_workspace_multiconfig(build_dir: Path, name: str) -> bool:
    clean = validate_multiconfig_name(name)
    target = build_dir / "conf" / "multiconfig" / f"{clean}.conf"
    if target.exists():
        target.unlink()
        return True
    return False
