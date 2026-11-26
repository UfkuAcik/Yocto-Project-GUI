"""Pure-stdlib two-way Siemens kas YAML parser & serializer."""

from __future__ import annotations

from typing import Any

from bridge.i18n import tr_en


def _strip_yaml_quotes(val: str) -> str:
    s = val.strip()
    if len(s) >= 2 and ((s[0] == '"' and s[-1] == '"') or (s[0] == "'" and s[-1] == "'")):
        return s[1:-1]
    return s


def _parse_inline_list(raw: str) -> list[str]:
    inner = raw.strip()[1:-1].strip()
    if not inner:
        return []
    return [_strip_yaml_quotes(item.strip()) for item in inner.split(",") if item.strip()]


def _tokenize_yaml_lines(text: str) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        indent = len(raw_line) - len(raw_line.lstrip(" "))
        out.append((indent, raw_line.strip()))
    return out


def _parse_block(
    tokens: list[tuple[int, str]], idx: int, base_indent: int
) -> tuple[Any, int]:
    if idx >= len(tokens):
        return {}, idx

    # List block at base_indent
    if tokens[idx][1].startswith("- "):
        items: list[Any] = []
        while idx < len(tokens) and tokens[idx][0] == base_indent and tokens[idx][1].startswith("- "):
            item_val = tokens[idx][1][2:].strip()
            items.append(_strip_yaml_quotes(item_val))
            idx += 1
        return items, idx

    mapping: dict[str, Any] = {}
    while idx < len(tokens):
        indent, content = tokens[idx]
        if indent < base_indent:
            break
        if indent > base_indent:
            # Unexpected indentation; skip gracefully
            idx += 1
            continue
        if content.startswith("- "):
            break
        if ":" not in content:
            idx += 1
            continue

        key_raw, rest = content.split(":", 1)
        key = _strip_yaml_quotes(key_raw.strip())
        val_raw = rest.strip()
        idx += 1

        if val_raw in ("|", "|-", ">", ">-"):
            block_lines: list[str] = []
            block_indent: int | None = None
            while idx < len(tokens) and tokens[idx][0] > indent:
                if block_indent is None:
                    block_indent = tokens[idx][0]
                pad = max(0, tokens[idx][0] - block_indent)
                block_lines.append((" " * pad) + tokens[idx][1])
                idx += 1
            joiner = "\n" if val_raw.startswith("|") else " "
            mapping[key] = joiner.join(block_lines)
        elif val_raw == "":
            if idx < len(tokens) and tokens[idx][0] > indent:
                nested, idx = _parse_block(tokens, idx, tokens[idx][0])
                mapping[key] = nested
            else:
                mapping[key] = {}
        elif val_raw.startswith("[") and val_raw.endswith("]"):
            mapping[key] = _parse_inline_list(val_raw)
        else:
            unquoted = _strip_yaml_quotes(val_raw)
            if unquoted.isdigit():
                mapping[key] = int(unquoted)
            elif unquoted.lower() in ("true", "false"):
                mapping[key] = unquoted.lower() == "true"
            elif unquoted in ("null", "~"):
                mapping[key] = None
            else:
                mapping[key] = unquoted

    return mapping, idx


def parse_kas_yaml(text: str) -> tuple[dict[str, Any], list[str]]:
    """Parse a Siemens kas configuration YAML into normalized KasConfig dict + warnings."""
    warnings: list[str] = []
    tokens = _tokenize_yaml_lines(text)
    parsed, _ = _parse_block(tokens, 0, tokens[0][0] if tokens else 0)
    if not isinstance(parsed, dict):
        parsed = {}
        warnings.append(
            tr_en(
                "Kök YAML nesnesi sözlük (mapping) değil.",
                "Root YAML value is not a mapping.",
            )
        )

    header_raw = parsed.get("header")
    if not isinstance(header_raw, dict):
        header_raw = {"version": 14}
        warnings.append(
            tr_en(
                "'header.version' alanı eksik; varsayılan 14 uygulandı.",
                "'header.version' is missing; defaulted to 14.",
            )
        )

    version = header_raw.get("version", 14)
    if not isinstance(version, int) or version < 10:
        warnings.append(
            tr_en(
                f"Önerilen minimum kas header.version >= 14 (mevcut: {version}).",
                f"Recommended minimum kas header.version is >= 14 (current: {version}).",
            )
        )

    target_raw = parsed.get("target", ["core-image-minimal"])
    if isinstance(target_raw, str):
        targets = [target_raw]
    elif isinstance(target_raw, list):
        targets = [str(t) for t in target_raw]
    else:
        targets = ["core-image-minimal"]

    repos_raw = parsed.get("repos")
    if not isinstance(repos_raw, dict) or not repos_raw:
        warnings.append(
            tr_en(
                "'repos' altında en az bir katman deposu tanımlanmalıdır.",
                "At least one layer repository must be defined under 'repos'.",
            )
        )
        repos: dict[str, Any] = {}
    else:
        repos = {}
        for rname, rval in repos_raw.items():
            if isinstance(rval, dict):
                repos[str(rname)] = rval
            else:
                repos[str(rname)] = {}

    local_conf_header = parsed.get("local_conf_header")
    if not isinstance(local_conf_header, dict):
        local_conf_header = {}

    bblayers_conf_header = parsed.get("bblayers_conf_header")
    if not isinstance(bblayers_conf_header, dict):
        bblayers_conf_header = {}

    env = parsed.get("env")
    if not isinstance(env, dict):
        env = {}

    normalized = {
        "header": {
            "version": int(version) if isinstance(version, int) else 14,
            "includes": header_raw.get("includes", [])
            if isinstance(header_raw.get("includes"), list)
            else [],
        },
        "machine": str(parsed.get("machine", "qemuarm64")),
        "distro": str(parsed.get("distro", "poky")),
        "target": targets,
        "repos": repos,
        "local_conf_header": {str(k): str(v) for k, v in local_conf_header.items()},
        "bblayers_conf_header": {str(k): str(v) for k, v in bblayers_conf_header.items()},
        "env": {str(k): str(v) for k, v in env.items()},
    }
    return normalized, warnings


def _quote_yaml_scalar(val: str) -> str:
    if any(ch in val for ch in (":", "#", "{", "}", "[", "]", '"')) or val == "":
        escaped = val.replace('"', '\\"')
        return f'"{escaped}"'
    return val


def serialize_kas_yaml(config: dict[str, Any]) -> str:
    """Serialize a normalized KasConfig dict into clean deterministic Siemens kas YAML."""
    lines: list[str] = []
    header = config.get("header") or {"version": 14}
    lines.append("header:")
    lines.append(f"  version: {int(header.get('version', 14))}")
    includes = header.get("includes") or []
    if includes:
        lines.append("  includes:")
        for inc in includes:
            lines.append(f"    - {_quote_yaml_scalar(str(inc))}")

    lines.append("")
    lines.append(f"machine: {_quote_yaml_scalar(str(config.get('machine', 'qemuarm64')))}")
    lines.append(f"distro: {_quote_yaml_scalar(str(config.get('distro', 'poky')))}")

    targets = config.get("target") or ["core-image-minimal"]
    if isinstance(targets, str):
        targets = [targets]
    if len(targets) == 1:
        lines.append(f"target: {_quote_yaml_scalar(str(targets[0]))}")
    else:
        lines.append("target:")
        for t in targets:
            lines.append(f"  - {_quote_yaml_scalar(str(t))}")

    repos = config.get("repos") or {}
    if repos:
        lines.append("")
        lines.append("repos:")
        for rname, rdata in repos.items():
            lines.append(f"  {rname}:")
            if isinstance(rdata, dict):
                for field in ("url", "path", "branch", "commit", "refspec"):
                    if rdata.get(field):
                        lines.append(f"    {field}: {_quote_yaml_scalar(str(rdata[field]))}")
                layers = rdata.get("layers")
                if isinstance(layers, dict) and layers:
                    lines.append("    layers:")
                    for lname, lstate in layers.items():
                        val_str = "excluded" if str(lstate) == "excluded" else str(lstate)
                        lines.append(f"      {lname}: {_quote_yaml_scalar(val_str)}")

    for header_key in ("local_conf_header", "bblayers_conf_header"):
        section = config.get(header_key) or {}
        if section:
            lines.append("")
            lines.append(f"{header_key}:")
            for k, v in section.items():
                text_val = str(v)
                if "\n" in text_val:
                    lines.append(f"  {k}: |")
                    for sub in text_val.splitlines():
                        lines.append(f"    {sub}")
                else:
                    lines.append(f"  {k}: {_quote_yaml_scalar(text_val)}")

    env = config.get("env") or {}
    if env:
        lines.append("")
        lines.append("env:")
        for k, v in env.items():
            lines.append(f"  {k}: {_quote_yaml_scalar(str(v))}")

    return "\n".join(lines) + "\n"
