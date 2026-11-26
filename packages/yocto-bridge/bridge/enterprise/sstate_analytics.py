"""Remote sstate-cache & Hash Equivalence analytics across CI runners."""

from __future__ import annotations

import re
import time
from typing import Any

from bridge.i18n import tr_en
from bridge.preflight.sstate_probe import probe_tcp_endpoint

SSTATE_SUMMARY_RE = re.compile(
    r"Sstate summary:\s*Wanted\s+(\d+)\s+Local\s+(\d+)\s+Mirrors\s+(\d+)\s+Missed\s+(\d+)\s+"
    r"Current\s+\d+\s+\((\d+)%\s+match",
    re.IGNORECASE,
)
HASHEQUIV_RE = re.compile(r"(?:unihash|hash\s+equivalence).*?reused[:=\s]+(\d+)", re.IGNORECASE)
SETSCENE_COUNT_RE = re.compile(r"Running setscene task", re.IGNORECASE)
NATIVELSB_RE = re.compile(r"NATIVELSBSTRING\s*=\s*[\"']?([^\s\"']+)", re.IGNORECASE)


def parse_runner_bitbake_log(
    runner_id: str,
    runner_name: str,
    log_text: str,
    arch: str = "x86_64",
    provider: str = "github-actions",
    branch: str = "main",
    nativelsbstring: str = "ubuntu-24.04",
) -> dict[str, Any]:
    """Parse BitBake Sstate summary + Hash Equivalence reuse lines from a CI runner log."""
    wanted = 0
    local_hits = 0
    mirror_hits = 0
    missed = 0
    hit_pct = 0.0

    m = SSTATE_SUMMARY_RE.search(log_text)
    if m:
        wanted = int(m.group(1))
        local_hits = int(m.group(2))
        mirror_hits = int(m.group(3))
        missed = int(m.group(4))
        total_hits = local_hits + mirror_hits
        hit_pct = round((total_hits / wanted) * 100.0, 1) if wanted > 0 else float(m.group(5))
    else:
        setscene = len(SETSCENE_COUNT_RE.findall(log_text))
        wanted = max(setscene, 1) if setscene else 0
        mirror_hits = setscene
        hit_pct = round((mirror_hits / wanted) * 100.0, 1) if wanted else 0.0

    hq_match = HASHEQUIV_RE.search(log_text)
    hashequiv_reused = int(hq_match.group(1)) if hq_match else max(0, mirror_hits // 10)

    lsb_match = NATIVELSB_RE.search(log_text)
    detected_lsb = lsb_match.group(1) if lsb_match else nativelsbstring

    status = "healthy" if hit_pct >= 75.0 else ("degraded" if hit_pct >= 45.0 else "cold")
    time_saved_min = round((local_hits + mirror_hits) * 0.045, 1)
    avg_duration_min = max(4.0, round(18.0 + missed * 0.09, 1))

    return {
        "runner_id": runner_id,
        "runner_name": runner_name,
        "arch": arch,
        "provider": provider,
        "branch": branch,
        "wanted_tasks": wanted,
        "local_hits": local_hits,
        "mirror_hits": mirror_hits,
        "missed": missed,
        "hit_rate_percent": hit_pct,
        "hashequiv_reused": hashequiv_reused,
        "avg_duration_min": avg_duration_min,
        "time_saved_min": time_saved_min,
        "nativelsbstring": detected_lsb,
        "status": status,
        "last_run_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }


def detect_runner_anomalies(
    runners: list[dict[str, Any]],
    hashserve_reachable: bool,
    cache_footprint_gb: float,
    cache_quota_gb: float,
) -> list[dict[str, str]]:
    """Detect cold CI runners, NATIVELSBSTRING skew, hashserve outages, and eviction pressure."""
    anomalies: list[dict[str, str]] = []
    lsb_values = {r["nativelsbstring"] for r in runners if r.get("nativelsbstring")}
    majority_lsb = max(lsb_values, key=lambda v: sum(1 for r in runners if r["nativelsbstring"] == v), default="")

    if not hashserve_reachable:
        anomalies.append(
            {
                "id": "anom-hashserve-down",
                "severity": "critical",
                "runner_id": "fleet",
                "title": tr_en("BB_HASHSERVE sunucusuna erişilemiyor", "BB_HASHSERVE server unreachable"),
                "detail": tr_en(
                    "Paylaşımlı Hash Equivalence sunucusu yanıt vermiyor; "
                    "outhash değişimlerinde yeniden derleme olur.",
                    "Shared Hash Equivalence server is not responding; "
                    "outhash changes will trigger downstream rebuilds.",
                ),
                "recommendation": tr_en(
                    "BB_HASHSERVE ağ bağlantısını ve 8686/WSS port erişimini doğrulayın.",
                    "Verify BB_HASHSERVE network connectivity and port 8686/WSS access.",
                ),
            }
        )

    for r in runners:
        if r["hit_rate_percent"] < 45.0:
            extra_reason = ""
            if len(lsb_values) > 1 and r["nativelsbstring"] != majority_lsb:
                extra_reason = tr_en(
                    f" Runner ana dağıtımı '{r['nativelsbstring']}', filo standardı '{majority_lsb}' "
                    "ile uyumsuz (NATIVELSBSTRING sapması).",
                    f" Runner host distro '{r['nativelsbstring']}' mismatches fleet standard "
                    f"'{majority_lsb}' (NATIVELSBSTRING skew).",
                )
            anomalies.append(
                {
                    "id": f"anom-cold-{r['runner_id']}",
                    "severity": "critical",
                    "runner_id": r["runner_id"],
                    "title": tr_en(
                        f"Soğuk sstate çalıştırıcısı: {r['runner_name']} (%{r['hit_rate_percent']})",
                        f"Cold sstate runner: {r['runner_name']} ({r['hit_rate_percent']}%)",
                    ),
                    "detail": tr_en(
                        f"{r['missed']} görev önbellekten bulunamadı ve sıfırdan derlendi.{extra_reason}",
                        f"{r['missed']} tasks missed the cache and compiled from scratch.{extra_reason}",
                    ),
                    "recommendation": tr_en(
                        f"Runner konteyner imajını '{majority_lsb or 'ubuntu-24.04'}' ile eşitleyin veya "
                        "SSTATE_MIRRORS ayarını doğrulayın.",
                        f"Align runner container image to '{majority_lsb or 'ubuntu-24.04'}' or "
                        "verify SSTATE_MIRRORS.",
                    ),
                }
            )
        elif r["hit_rate_percent"] < 75.0:
            anomalies.append(
                {
                    "id": f"anom-degraded-{r['runner_id']}",
                    "severity": "warning",
                    "runner_id": r["runner_id"],
                    "title": tr_en(
                        f"Düşen sstate isabet oranı: {r['runner_name']} (%{r['hit_rate_percent']})",
                        f"Degraded sstate hit rate: {r['runner_name']} ({r['hit_rate_percent']}%)",
                    ),
                    "detail": tr_en(
                        f"Son koşuda {r['missed']} görev kaçırıldı (ortalama {r['avg_duration_min']} dk).",
                        f"{r['missed']} tasks missed on last run (avg {r['avg_duration_min']} min).",
                    ),
                    "recommendation": tr_en(
                        "bitbake-diffsigs ile en sık değişen görev imzalarını inceleyin.",
                        "Inspect frequently changing task signatures with bitbake-diffsigs.",
                    ),
                }
            )

    if cache_quota_gb > 0 and (cache_footprint_gb / cache_quota_gb) >= 0.82:
        anomalies.append(
            {
                "id": "anom-eviction-risk",
                "severity": "warning",
                "runner_id": "mirror",
                "title": tr_en(
                    f"sstate-cache disk kotası doluyor ({cache_footprint_gb}/{cache_quota_gb} GB)",
                    f"sstate-cache disk quota nearing limit ({cache_footprint_gb}/{cache_quota_gb} GB)",
                ),
                "detail": tr_en(
                    "LRU tahliye politikası aktif paketlerin erken silinmesine yol açabilir.",
                    "LRU eviction policy may prune active packages prematurely.",
                ),
                "recommendation": tr_en(
                    "yocto-sstate-prune ile 30 günden eski kullanılmayan nesneleri temizleyin.",
                    "Clean up unused objects older than 30 days with yocto-sstate-prune.",
                ),
            }
        )
    return anomalies


def build_remote_sstate_analytics(
    mirror_url: str,
    hashserve_endpoint: str,
    time_range: str = "7d",
    runner_logs: list[dict[str, Any]] | None = None,
    mock: bool = False,
) -> dict[str, Any]:
    """Build fleet-wide sstate-cache & Hash Equivalence analytics report across CI runners."""
    clean_range = time_range if time_range in ("24h", "7d", "30d") else "7d"

    if mock and not runner_logs:
        mirror_status = {
            "url": mirror_url or "https://sstate.yoctoproject.org/all/PATH",
            "reachable": True,
            "latency_ms": 22.8,
            "status": "reachable (CDN + R2 Mirror)",
        }
        hashserve_status = {
            "endpoint": hashserve_endpoint or "wss://hashserv.yoctostudio.dev:8687",
            "reachable": True,
            "latency_ms": 18.4,
            "status": "reachable (unihash v2)",
        }
        runners = [
            {
                "runner_id": "gh-ubuntu24-x86-01",
                "runner_name": "gh-ubuntu24-x86_64-01",
                "arch": "x86_64 -> armv8a",
                "provider": "GitHub Actions",
                "branch": "main",
                "wanted_tasks": 3420,
                "local_hits": 412,
                "mirror_hits": 2845,
                "missed": 163,
                "hit_rate_percent": 95.2,
                "hashequiv_reused": 318,
                "avg_duration_min": 8.4,
                "time_saved_min": 146.6,
                "nativelsbstring": "ubuntu-24.04",
                "status": "healthy",
                "last_run_at": "2026-11-25T11:45:00Z",
            },
            {
                "runner_id": "gh-ubuntu24-x86-02",
                "runner_name": "gh-ubuntu24-x86_64-02",
                "arch": "x86_64 -> armv8a",
                "provider": "GitHub Actions",
                "branch": "release/v1.1",
                "wanted_tasks": 3420,
                "local_hits": 298,
                "mirror_hits": 2790,
                "missed": 332,
                "hit_rate_percent": 90.3,
                "hashequiv_reused": 274,
                "avg_duration_min": 11.2,
                "time_saved_min": 139.0,
                "nativelsbstring": "ubuntu-24.04",
                "status": "healthy",
                "last_run_at": "2026-11-25T11:20:00Z",
            },
            {
                "runner_id": "gitlab-arm64-01",
                "runner_name": "gitlab-arm64-builder",
                "arch": "aarch64 -> armv8a",
                "provider": "GitLab Runner",
                "branch": "main",
                "wanted_tasks": 3180,
                "local_hits": 520,
                "mirror_hits": 2110,
                "missed": 550,
                "hit_rate_percent": 82.7,
                "hashequiv_reused": 195,
                "avg_duration_min": 14.9,
                "time_saved_min": 118.4,
                "nativelsbstring": "ubuntu-24.04",
                "status": "healthy",
                "last_run_at": "2026-11-25T10:55:00Z",
            },
            {
                "runner_id": "corp-ssh-epyc-01",
                "runner_name": "corp-ssh-epyc-01",
                "arch": "x86_64 -> armv8a",
                "provider": "Self-Hosted SSH",
                "branch": "feat/can-fd",
                "wanted_tasks": 3420,
                "local_hits": 1410,
                "mirror_hits": 1680,
                "missed": 330,
                "hit_rate_percent": 90.4,
                "hashequiv_reused": 240,
                "avg_duration_min": 9.8,
                "time_saved_min": 139.1,
                "nativelsbstring": "ubuntu-24.04",
                "status": "healthy",
                "last_run_at": "2026-11-25T11:10:00Z",
            },
            {
                "runner_id": "gh-ubuntu22-legacy",
                "runner_name": "gh-ubuntu22-legacy",
                "arch": "x86_64 -> armv8a",
                "provider": "GitHub Actions",
                "branch": "main",
                "wanted_tasks": 3420,
                "local_hits": 44,
                "mirror_hits": 1186,
                "missed": 2190,
                "hit_rate_percent": 36.0,
                "hashequiv_reused": 42,
                "avg_duration_min": 64.5,
                "time_saved_min": 55.4,
                "nativelsbstring": "ubuntu-22.04",
                "status": "cold",
                "last_run_at": "2026-11-25T09:40:00Z",
            },
        ]
        hash_equiv_top = [
            {
                "recipe": "linux-imx",
                "out_hash_changes": 18,
                "equivalent_unihash_hits": 16,
                "skipped_downstream_tasks": 412,
                "saved_minutes": 94.5,
            },
            {
                "recipe": "qtbase",
                "out_hash_changes": 12,
                "equivalent_unihash_hits": 11,
                "skipped_downstream_tasks": 284,
                "saved_minutes": 76.2,
            },
            {
                "recipe": "glibc",
                "out_hash_changes": 9,
                "equivalent_unihash_hits": 9,
                "skipped_downstream_tasks": 620,
                "saved_minutes": 68.0,
            },
            {
                "recipe": "mesa-megadriver",
                "out_hash_changes": 14,
                "equivalent_unihash_hits": 10,
                "skipped_downstream_tasks": 148,
                "saved_minutes": 41.3,
            },
            {
                "recipe": "openssl",
                "out_hash_changes": 11,
                "equivalent_unihash_hits": 9,
                "skipped_downstream_tasks": 310,
                "saved_minutes": 38.7,
            },
        ]
        trend = [
            {"label": tr_en("G-6", "D-6"), "hit_rate_percent": 71.2, "hashequiv_rate_percent": 6.1, "runs_count": 14},
            {"label": tr_en("G-5", "D-5"), "hit_rate_percent": 74.8, "hashequiv_rate_percent": 7.4, "runs_count": 18},
            {"label": tr_en("G-4", "D-4"), "hit_rate_percent": 79.5, "hashequiv_rate_percent": 8.9, "runs_count": 21},
            {"label": tr_en("G-3", "D-3"), "hit_rate_percent": 82.1, "hashequiv_rate_percent": 9.8, "runs_count": 19},
            {"label": tr_en("G-2", "D-2"), "hit_rate_percent": 84.4, "hashequiv_rate_percent": 11.2, "runs_count": 23},
            {
                "label": tr_en("Dün", "Yesterday"),
                "hit_rate_percent": 81.0,
                "hashequiv_rate_percent": 10.6,
                "runs_count": 17,
            },
            {
                "label": tr_en("Bugün", "Today"),
                "hit_rate_percent": 86.4,
                "hashequiv_rate_percent": 12.4,
                "runs_count": 16,
            },
        ]
        if clean_range == "24h":
            trend = [
                {"label": "00:00", "hit_rate_percent": 82.0, "hashequiv_rate_percent": 9.8, "runs_count": 3},
                {"label": "06:00", "hit_rate_percent": 85.4, "hashequiv_rate_percent": 11.1, "runs_count": 4},
                {"label": "12:00", "hit_rate_percent": 88.2, "hashequiv_rate_percent": 12.9, "runs_count": 5},
                {"label": "18:00", "hit_rate_percent": 86.4, "hashequiv_rate_percent": 12.4, "runs_count": 4},
            ]
        elif clean_range == "30d":
            w_lbl = tr_en("Hafta", "Week")
            trend = [
                {"label": f"{w_lbl} 1", "hit_rate_percent": 64.5, "hashequiv_rate_percent": 4.8, "runs_count": 72},
                {"label": f"{w_lbl} 2", "hit_rate_percent": 73.2, "hashequiv_rate_percent": 7.9, "runs_count": 88},
                {"label": f"{w_lbl} 3", "hit_rate_percent": 80.1, "hashequiv_rate_percent": 10.2, "runs_count": 94},
                {"label": f"{w_lbl} 4", "hit_rate_percent": 86.4, "hashequiv_rate_percent": 12.4, "runs_count": 101},
            ]
        footprint_gb = 214.6
        quota_gb = 250.0
    else:
        mirror_probe = probe_tcp_endpoint(mirror_url or "")
        mirror_status = {
            "url": mirror_url or "unconfigured",
            "reachable": mirror_probe["reachable"],
            "latency_ms": mirror_probe["latency_ms"],
            "status": mirror_probe["status"],
        }
        hs_probe = probe_tcp_endpoint(hashserve_endpoint or "")
        hashserve_status = {
            "endpoint": hashserve_endpoint or "auto",
            "reachable": hs_probe["reachable"],
            "latency_ms": hs_probe["latency_ms"],
            "status": hs_probe["status"],
        }
        runners = [
            parse_runner_bitbake_log(
                runner_id=str(item.get("runner_id") or f"runner-{idx}"),
                runner_name=str(item.get("runner_name") or item.get("runner_id") or f"runner-{idx}"),
                log_text=str(item.get("log_text") or ""),
                arch=str(item.get("arch") or "x86_64"),
                provider=str(item.get("provider") or "ci-runner"),
                branch=str(item.get("branch") or "main"),
                nativelsbstring=str(item.get("nativelsbstring") or "ubuntu-24.04"),
            )
            for idx, item in enumerate(runner_logs or [], start=1)
        ]
        hash_equiv_top = []
        trend = [
            {
                "label": r["runner_name"],
                "hit_rate_percent": r["hit_rate_percent"],
                "hashequiv_rate_percent": round(
                    (r["hashequiv_reused"] / max(1, r["wanted_tasks"])) * 100.0, 1
                ),
                "runs_count": 1,
            }
            for r in runners
        ]
        footprint_gb = 0.0
        quota_gb = 250.0

    total_wanted = sum(r["wanted_tasks"] for r in runners)
    total_hits = sum(r["local_hits"] + r["mirror_hits"] for r in runners)
    total_hq = sum(r["hashequiv_reused"] for r in runners)
    fleet_hit = round((total_hits / total_wanted) * 100.0, 1) if total_wanted else 0.0
    hq_pct = round((total_hq / total_wanted) * 100.0, 1) if total_wanted else 0.0
    saved_hours = round(sum(r["time_saved_min"] for r in runners) / 60.0, 1)
    eviction_ratio = (footprint_gb / quota_gb) if quota_gb else 0.0
    eviction_risk = "high" if eviction_ratio >= 0.9 else ("medium" if eviction_ratio >= 0.8 else "low")
    anomalies = detect_runner_anomalies(
        runners,
        hashserve_reachable=hashserve_status["reachable"],
        cache_footprint_gb=footprint_gb,
        cache_quota_gb=quota_gb,
    )

    return {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "time_range": clean_range,
        "mirror_status": mirror_status,
        "hashserve_status": hashserve_status,
        "fleet_hit_rate_percent": fleet_hit,
        "hashequiv_dedup_percent": hq_pct,
        "total_time_saved_hours": saved_hours,
        "cache_footprint_gb": footprint_gb,
        "cache_quota_gb": quota_gb,
        "eviction_risk": eviction_risk,
        "runners": runners,
        "trend": trend,
        "hash_equiv_top_recipes": hash_equiv_top,
        "anomalies": anomalies,
    }
