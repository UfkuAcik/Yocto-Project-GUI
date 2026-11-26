"""Host resource profiler & BitBake optimization advisor (threads, OOM safety, PSI, rm_work)."""

from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

from bridge.i18n import tr_en
from bridge.parsers.local_conf import parse_conf


def detect_host_resources(override: dict[str, Any] | None = None) -> dict[str, Any]:
    """Inspect host/container CPU, RAM, free disk space, and Linux PSI kernel support."""
    if override:
        return {
            "cpu_cores": int(override.get("cpu_cores") or os.cpu_count() or 8),
            "ram_total_gb": float(override.get("ram_total_gb") or 32.0),
            "ram_available_gb": float(override.get("ram_available_gb") or 24.0),
            "disk_free_gb": float(override.get("disk_free_gb") or 160.0),
            "psi_supported": bool(override.get("psi_supported", True)),
            "provider": str(override.get("provider") or "wsl2"),
        }

    cpu_cores = os.cpu_count() or 4
    ram_total_gb = 16.0
    ram_avail_gb = 10.0
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        text = meminfo.read_text(encoding="utf-8", errors="replace")
        for line in text.splitlines():
            if line.startswith("MemTotal:"):
                kb = int(line.split()[1])
                ram_total_gb = round(kb / (1024 * 1024), 1)
            elif line.startswith("MemAvailable:"):
                kb = int(line.split()[1])
                ram_avail_gb = round(kb / (1024 * 1024), 1)

    usage = shutil.disk_usage(".")
    disk_free_gb = round(usage.free / (1024 * 1024 * 1024), 1)
    psi_supported = Path("/proc/pressure/cpu").exists() and Path("/proc/pressure/memory").exists()

    return {
        "cpu_cores": cpu_cores,
        "ram_total_gb": ram_total_gb,
        "ram_available_gb": ram_avail_gb,
        "disk_free_gb": disk_free_gb,
        "psi_supported": psi_supported,
        "provider": "linux" if meminfo.exists() else "mock",
    }


def generate_optimization_plan(
    local_conf_text: str,
    host: dict[str, Any],
    resolved_fixes: set[str] | None = None,
) -> dict[str, Any]:
    """Compute OOM-safe threads, PSI pressure limits, `rm_work`, and package-class recommendations."""
    resolved = resolved_fixes or set()
    doc = parse_conf(local_conf_text)
    vars_map = doc.get_variables()

    cpu_cores = max(1, int(host.get("cpu_cores") or 4))
    ram_total_gb = float(host.get("ram_total_gb") or 16.0)
    disk_free_gb = float(host.get("disk_free_gb") or 120.0)
    psi_supported = bool(host.get("psi_supported", False))

    # Yocto OOM rule of thumb: ~2.0 GiB RAM per heavy C++ compiler job
    safe_jobs = max(2, min(cpu_cores, int(max(4.0, ram_total_gb) // 2)))
    recommended_bb = str(safe_jobs)
    recommended_make = f"-j {safe_jobs}"

    recommendations: list[dict[str, Any]] = []
    preview_doc = parse_conf(local_conf_text)

    cur_bb = vars_map.get("BB_NUMBER_THREADS", "")
    cur_make = vars_map.get("PARALLEL_MAKE", "")

    if (cur_bb != recommended_bb or cur_make != recommended_make) and "opt-threads" not in resolved:
        changes = {"BB_NUMBER_THREADS": recommended_bb, "PARALLEL_MAKE": recommended_make}
        d_tmp = parse_conf(local_conf_text)
        for k, v in changes.items():
            d_tmp.set_variable(k, v, "?=")
            preview_doc.set_variable(k, v, "?=")
        def_lbl = tr_en("varsayılan", "default")
        recommendations.append(
            {
                "id": "opt-threads",
                "title": tr_en(
                    f"OOM Korumalı Paralel Derleme ({recommended_bb} görev / {recommended_make})",
                    f"OOM-Protected Parallel Build ({recommended_bb} tasks / {recommended_make})",
                ),
                "impact": tr_en(
                    f"{cpu_cores} çekirdek ve {ram_total_gb:.0f} GiB RAM için dengeli bellek/hız ayarı.",
                    f"Balanced memory and CPU concurrency for {cpu_cores} cores and {ram_total_gb:.0f} GiB RAM.",
                ),
                "current_value": f"BB={cur_bb or def_lbl}, MAKE={cur_make or def_lbl}",
                "recommended_value": f"BB={recommended_bb}, MAKE={recommended_make}",
                "applied": False,
                "auto_fix": {
                    "id": "opt-threads",
                    "label": tr_en(
                        "Optimal Thread & Make Değerlerini Uygula",
                        "Apply Optimal Thread & Make Values",
                    ),
                    "description": tr_en(
                        "local.conf içinde BB_NUMBER_THREADS ve PARALLEL_MAKE günceller.",
                        "Updates BB_NUMBER_THREADS and PARALLEL_MAKE in local.conf.",
                    ),
                    "kind": "local_conf_set",
                    "target_file": "conf/local.conf",
                    "changes": changes,
                    "operator": "?=",
                    "preview_diff": doc.unified_diff(d_tmp),
                },
            }
        )

    if psi_supported and "BB_PRESSURE_MAX_CPU" not in vars_map and "opt-psi" not in resolved:
        psi_changes = {
            "BB_PRESSURE_MAX_CPU": "10000",
            "BB_PRESSURE_MAX_MEMORY": "10000",
            "BB_PRESSURE_MAX_IO": "10000",
        }
        d_tmp = parse_conf(local_conf_text)
        for k, v in psi_changes.items():
            d_tmp.set_variable(k, v, "?=")
            preview_doc.set_variable(k, v, "?=")
        recommendations.append(
            {
                "id": "opt-psi",
                "title": tr_en(
                    "Linux PSI Çekirdek Baskı Sınırlaması (BB_PRESSURE_MAX_*)",
                    "Linux PSI Kernel Pressure Throttling (BB_PRESSURE_MAX_*)",
                ),
                "impact": tr_en(
                    "Çekirdek /proc/pressure desteği algılandı: RAM/IO tıkanmasında "
                    "görev spawn hızını otomatik frenler.",
                    "Kernel /proc/pressure support detected: automatically throttles task "
                    "spawning under RAM/I/O contention.",
                ),
                "current_value": tr_en("Tanımlı değil", "Not configured"),
                "recommended_value": "CPU/MEM/IO = 10000",
                "applied": False,
                "auto_fix": {
                    "id": "opt-psi",
                    "label": tr_en("PSI Baskı Limitlerini Ekle", "Add PSI Pressure Limits"),
                    "description": tr_en(
                        "BB_PRESSURE_MAX_CPU, MEMORY ve IO limitlerini local.conf'a ekler.",
                        "Adds BB_PRESSURE_MAX_CPU, MEMORY, and IO limits to local.conf.",
                    ),
                    "kind": "local_conf_set",
                    "target_file": "conf/local.conf",
                    "changes": psi_changes,
                    "operator": "?=",
                    "preview_diff": doc.unified_diff(d_tmp),
                },
            }
        )

    inherit_val = vars_map.get("INHERIT", "")
    if disk_free_gb < 180.0 and "rm_work" not in inherit_val and "opt-rm-work" not in resolved:
        rm_changes = {
            "INHERIT": "rm_work",
            "RM_WORK_EXCLUDE": "linux-yocto my-sensor-daemon",
        }
        d_tmp = parse_conf(local_conf_text)
        d_tmp.set_variable("INHERIT", "rm_work", "+=")
        d_tmp.set_variable("RM_WORK_EXCLUDE", rm_changes["RM_WORK_EXCLUDE"], "?=")
        preview_doc.set_variable("INHERIT", "rm_work", "+=")
        preview_doc.set_variable("RM_WORK_EXCLUDE", rm_changes["RM_WORK_EXCLUDE"], "?=")
        recommendations.append(
            {
                "id": "opt-rm-work",
                "title": tr_en(
                    f"Disk Tasarrufu: rm_work Etkinleştir ({disk_free_gb:.1f} GiB Boş Alan)",
                    f"Disk Savings: Enable rm_work ({disk_free_gb:.1f} GiB Free)",
                ),
                "impact": tr_en(
                    "Derleme sonrası geçici tmp/work klasörlerini temizleyerek ~%60 disk tasarrufu sağlar.",
                    "Cleans temporary tmp/work build trees after packaging, saving ~60% disk space.",
                ),
                "current_value": tr_en("rm_work kapalı", "rm_work disabled"),
                "recommended_value": 'INHERIT += "rm_work"',
                "applied": False,
                "auto_fix": {
                    "id": "opt-rm-work",
                    "label": tr_en(
                        "rm_work (+ RM_WORK_EXCLUDE) Ekle",
                        "Add rm_work (+ RM_WORK_EXCLUDE)",
                    ),
                    "description": tr_en(
                        "Disk alanını korurken linux-yocto ve özel tarif çalışma ağaçlarını hariç tutar.",
                        "Preserves disk space while excluding linux-yocto and custom recipe work trees.",
                    ),
                    "kind": "local_conf_append",
                    "target_file": "conf/local.conf",
                    "changes": rm_changes,
                    "operator": "+=",
                    "preview_diff": doc.unified_diff(d_tmp),
                },
            }
        )

    pkg_cls = vars_map.get("PACKAGE_CLASSES", "")
    if "package_ipk" not in pkg_cls and "opt-pkg-ipk" not in resolved:
        d_tmp = parse_conf(local_conf_text)
        d_tmp.set_variable("PACKAGE_CLASSES", "package_ipk", "?=")
        preview_doc.set_variable("PACKAGE_CLASSES", "package_ipk", "?=")
        recommendations.append(
            {
                "id": "opt-pkg-ipk",
                "title": tr_en(
                    "Hızlı Paketleme: package_ipk Kullan",
                    "Faster Packaging: Use package_ipk",
                ),
                "impact": tr_en(
                    "package_rpm yerine package_ipk rootfs oluşturma ve do_package_write süresini kısaltır.",
                    "Using package_ipk instead of package_rpm speeds up do_package_write and rootfs assembly.",
                ),
                "current_value": pkg_cls or "package_rpm",
                "recommended_value": "package_ipk",
                "applied": False,
                "auto_fix": {
                    "id": "opt-pkg-ipk",
                    "label": tr_en(
                        'PACKAGE_CLASSES = "package_ipk" Yap',
                        'Set PACKAGE_CLASSES = "package_ipk"',
                    ),
                    "description": tr_en(
                        "local.conf içinde PACKAGE_CLASSES değerini package_ipk olarak ayarlar.",
                        'Sets PACKAGE_CLASSES = "package_ipk" in local.conf.',
                    ),
                    "kind": "local_conf_set",
                    "target_file": "conf/local.conf",
                    "changes": {"PACKAGE_CLASSES": "package_ipk"},
                    "operator": "?=",
                    "preview_diff": doc.unified_diff(d_tmp),
                },
            }
        )

    return {
        "host": {
            "cpu_cores": cpu_cores,
            "ram_total_gb": ram_total_gb,
            "ram_available_gb": float(host.get("ram_available_gb") or ram_total_gb * 0.75),
            "disk_free_gb": disk_free_gb,
            "psi_supported": psi_supported,
            "provider": str(host.get("provider") or "wsl2"),
        },
        "recommendations": recommendations,
        "combined_diff": doc.unified_diff(preview_doc),
    }
