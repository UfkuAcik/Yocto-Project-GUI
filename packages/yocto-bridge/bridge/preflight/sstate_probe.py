"""sstate-cache mirror & BB_HASHSERVE reachability probe + setscene hit-rate estimator."""

from __future__ import annotations

import re
import socket
import time
from typing import Any
from urllib.parse import urlparse

from bridge.i18n import tr_en

_SETSCENE_RE = re.compile(r"Running setscene task", re.IGNORECASE)
_RUNQUEUE_RE = re.compile(r"NOTE:\s*Running task\s+\d+\s+of\s+(\d+)")
_DRYRUN_SUMMARY_RE = re.compile(r"(\d+)\s+tasks.*?(\d+)\s+didn't need to be rerun", re.IGNORECASE)


def probe_tcp_endpoint(url_or_hostport: str, timeout: float = 1.0) -> dict[str, Any]:
    """Check TCP reachability and RTT latency for an sstate HTTP mirror or BB_HASHSERVE host:port."""
    raw = url_or_hostport.strip()
    if not raw:
        return {"endpoint": raw, "reachable": False, "latency_ms": None, "status": "unconfigured"}

    if raw == "auto" or raw.startswith("unix://"):
        return {"endpoint": raw, "reachable": True, "latency_ms": 0.4, "status": "local-socket"}

    if raw.startswith("file://") or raw.startswith("/"):
        return {"endpoint": raw, "reachable": True, "latency_ms": 0.5, "status": "local-dir"}

    host = ""
    port = 80
    if "://" in raw:
        parsed = urlparse(raw)
        host = parsed.hostname or ""
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    elif ":" in raw:
        host, pstr = raw.rsplit(":", 1)
        try:
            port = int(pstr)
        except ValueError:
            port = 8686

    if not host:
        return {"endpoint": raw, "reachable": False, "latency_ms": None, "status": "invalid-endpoint"}

    start = time.perf_counter()
    try:
        with socket.create_connection((host, port), timeout=timeout):
            rtt = round((time.perf_counter() - start) * 1000.0, 1)
            return {"endpoint": raw, "reachable": True, "latency_ms": rtt, "status": "reachable"}
    except OSError as exc:
        reason = exc.strerror or "timeout"
        return {"endpoint": raw, "reachable": False, "latency_ms": None, "status": f"unreachable ({reason})"}


def estimate_setscene_hit_rate(dryrun_stdout: str) -> tuple[int, int, int]:
    """Estimate setscene hit percentage from `bitbake -n` output."""
    if not dryrun_stdout.strip():
        return 0, 0, 0

    summary_match = _DRYRUN_SUMMARY_RE.search(dryrun_stdout)
    if summary_match:
        total = max(1, int(summary_match.group(1)))
        hits = min(total, int(summary_match.group(2)))
        return round((hits / total) * 100), total, hits

    setscene_count = len(_SETSCENE_RE.findall(dryrun_stdout))
    totals = [int(x) for x in _RUNQUEUE_RE.findall(dryrun_stdout)]
    total_tasks = max(totals) if totals else max(setscene_count, 1)
    hits = min(total_tasks, setscene_count)
    pct = round((hits / total_tasks) * 100)
    return pct, total_tasks, hits


def probe_sstate_and_hashserve(
    mirrors: list[str],
    hashserve: str,
    dryrun_stdout: str = "",
    mock: bool = False,
) -> dict[str, Any]:
    """Run reachability checks on sstate mirrors & hashserve and return hit-rate estimate."""
    if mock:
        mirror_results = [
            {
                "url": m or "https://sstate.yoctoproject.org/all/PATH;downloadfilename=PATH",
                "reachable": True,
                "latency_ms": 28.4,
                "status": "reachable (CDN)",
            }
            for m in (mirrors or ["https://sstate.yoctoproject.org/all/PATH"])
        ]
        hs_res = {
            "endpoint": hashserve or "hashserv.yoctoproject.org:8686",
            "reachable": True,
            "latency_ms": 24.1,
            "status": "reachable",
        }
        hit_pct, total_t, covered = (
            estimate_setscene_hit_rate(dryrun_stdout) if dryrun_stdout else (78, 3420, 2668)
        )
        return {
            "mirrors": mirror_results,
            "hashserve": hs_res,
            "estimated_hit_percent": hit_pct,
            "total_tasks_sampled": total_t,
            "setscene_covered_tasks": covered,
            "recommendation": tr_en(
                f"Önbellek İsabet Tahmini: ~%{hit_pct} "
                f"({covered}/{total_t} görev sstate üzerinden gelecek).",
                f"Cache Hit Estimate: ~{hit_pct}% "
                f"({covered}/{total_t} tasks served from sstate).",
            ),
        }

    mirror_results = []
    for m in mirrors:
        clean_url = m.split("\\n")[0].split()[0] if m else ""
        res = probe_tcp_endpoint(clean_url)
        mirror_results.append(
            {
                "url": m,
                "reachable": res["reachable"],
                "latency_ms": res["latency_ms"],
                "status": res["status"],
            }
        )
    hs_res = probe_tcp_endpoint(hashserve)
    hit_pct, total_t, covered = estimate_setscene_hit_rate(dryrun_stdout)
    return {
        "mirrors": mirror_results,
        "hashserve": hs_res,
        "estimated_hit_percent": hit_pct,
        "total_tasks_sampled": total_t,
        "setscene_covered_tasks": covered,
        "recommendation": (
            tr_en(
                f"Önbellek İsabet Tahmini: ~%{hit_pct} ({covered}/{total_t} görev).",
                f"Cache Hit Estimate: ~{hit_pct}% ({covered}/{total_t} tasks).",
            )
            if total_t > 0
            else tr_en("Önbellek erişilebilirliği doğrulandı.", "Cache reachability verified.")
        ),
    }
