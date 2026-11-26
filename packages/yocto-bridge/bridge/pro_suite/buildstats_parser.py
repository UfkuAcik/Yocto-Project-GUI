"""Parser for BitBake `tmp/buildstats/` task timing bottlenecks & critical path timeline."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

_START_RE = re.compile(r"^Started:\s*([\d.]+)", re.MULTILINE)
_END_RE = re.compile(r"^Ended:\s*([\d.]+)", re.MULTILINE)
_CPU_RE = re.compile(r"^CPU usage:\s*([\d.]+)%", re.MULTILINE)


def analyze_buildstats_records(records: list[dict[str, Any]]) -> dict[str, Any]:
    """Compute top-20 slowest tasks, normalized timeline offsets, and CPU efficiency."""
    if not records:
        return {
            "total_duration_sec": 0.0,
            "avg_cpu_percent": 0.0,
            "task_count": 0,
            "top_tasks": [],
        }

    min_start = min(float(r.get("started_ts") or 0.0) for r in records)
    max_end = max(float(r.get("ended_ts") or 0.0) for r in records)
    total_wall = max(0.1, max_end - min_start)

    normalized: list[dict[str, Any]] = []
    for rec in records:
        st = float(rec.get("started_ts") or min_start)
        en = float(rec.get("ended_ts") or st)
        dur = max(0.01, float(rec.get("duration_sec") or (en - st)))
        normalized.append(
            {
                "recipe": str(rec.get("recipe") or ""),
                "task": str(rec.get("task") or "do_compile"),
                "duration_sec": round(dur, 2),
                "start_offset_sec": round(max(0.0, st - min_start), 2),
                "cpu_percent": round(float(rec.get("cpu_percent") or 0.0), 1),
            }
        )

    top_tasks = sorted(normalized, key=lambda t: t["duration_sec"], reverse=True)[:20]
    avg_cpu = round(sum(t["cpu_percent"] for t in top_tasks) / max(1, len(top_tasks)), 1)

    return {
        "total_duration_sec": round(total_wall, 1),
        "avg_cpu_percent": avg_cpu,
        "task_count": len(records),
        "top_tasks": top_tasks,
    }


def parse_buildstats_dir(buildstats_dir: Path) -> dict[str, Any]:
    """Read raw task stat files from a `tmp/buildstats/<timestamp>/` directory."""
    records: list[dict[str, Any]] = []
    if buildstats_dir.exists():
        for task_file in buildstats_dir.rglob("do_*"):
            if not task_file.is_file():
                continue
            text = task_file.read_text(encoding="utf-8", errors="replace")
            st_m = _START_RE.search(text)
            en_m = _END_RE.search(text)
            if not st_m or not en_m:
                continue
            st_ts = float(st_m.group(1))
            en_ts = float(en_m.group(1))
            cpu_m = _CPU_RE.search(text)
            records.append(
                {
                    "recipe": task_file.parent.name,
                    "task": task_file.name,
                    "started_ts": st_ts,
                    "ended_ts": en_ts,
                    "duration_sec": max(0.01, en_ts - st_ts),
                    "cpu_percent": float(cpu_m.group(1)) if cpu_m else 0.0,
                }
            )
    return analyze_buildstats_records(records)
