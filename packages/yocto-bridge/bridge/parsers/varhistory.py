"""Parser for authentic `bitbake -e` variable expansion and origin history blocks."""

from __future__ import annotations

import re
from typing import Any

_OP_MAP = {
    "set": "=",
    "set?": "?=",
    "set??": "??=",
    "append": "+=",
    "prepend": "=+",
    ":append": ":append",
    ":prepend": ":prepend",
    ":remove": ":remove",
    "postdot": ".=",
    "predot": "=.",
}

_HIST_LINE_RE = re.compile(
    r"^#\s+(set\?\?|set\?|set|:append|:prepend|:remove|append|prepend|remove|postdot|predot)\s+"
    r"(.+?):(\d+)\s*$"
)


def parse_bitbake_env_variable(env_output: str, var_name: str) -> dict[str, Any]:
    """Parse `bitbake -e` output for a specific variable's origin history & final value."""
    lines = env_output.splitlines()
    marker = f"# ${var_name} ["
    history: list[dict[str, Any]] = []
    unexpanded = ""
    final_value = ""
    doc = f"BitBake variable '{var_name}'"

    i = 0
    total = len(lines)
    found_block = False
    while i < total:
        line = lines[i]
        if line.startswith(marker):
            found_block = True
            i += 1
            while i < total:
                cur = lines[i]
                if cur.startswith(f"{var_name}="):
                    raw = cur.split("=", 1)[1].strip()
                    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
                        raw = raw[1:-1]
                    final_value = raw
                    break
                if cur.startswith("# pre-expansion value:"):
                    if i + 1 < total and lines[i + 1].startswith("#   "):
                        raw_pre = lines[i + 1][4:].strip()
                        if len(raw_pre) >= 2 and raw_pre[0] == '"' and raw_pre[-1] == '"':
                            raw_pre = raw_pre[1:-1]
                        unexpanded = raw_pre
                        i += 2
                        continue
                m = _HIST_LINE_RE.match(cur)
                if m:
                    raw_op, filepath, line_no = m.groups()
                    op = _OP_MAP.get(raw_op, "=")
                    val = ""
                    if i + 1 < total and lines[i + 1].startswith("#     "):
                        val = lines[i + 1][6:].strip()
                        if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
                            val = val[1:-1]
                        i += 1
                    history.append(
                        {
                            "file": filepath,
                            "line": int(line_no),
                            "operator": op,
                            "value": val,
                            "overridden": False,
                        }
                    )
                i += 1
            break
        i += 1

    if not found_block:
        # Fallback: scan direct VAR="..." line
        prefix = f"{var_name}="
        for line in lines:
            if line.startswith(prefix):
                val = line.split("=", 1)[1].strip()
                if len(val) >= 2 and val[0] == '"' and val[-1] == '"':
                    val = val[1:-1]
                final_value = val
                unexpanded = val
                break

    # Mark overridden weak defaults if followed by a stronger set/override
    for idx in range(len(history) - 1):
        if history[idx]["operator"] in ("??=", "?="):
            later_sets = any(
                h["operator"] in ("=", ":=", "?=", "??=") for h in history[idx + 1 :]
            )
            if later_sets:
                history[idx]["overridden"] = True

    if not unexpanded:
        unexpanded = final_value

    return {
        "name": var_name,
        "final_value": final_value or "<unset>",
        "unexpanded_value": unexpanded or "<unset>",
        "doc": doc,
        "history": history,
    }
