"""Pre-build dry-run (`bitbake -p/-n`), DISTRO_FEATURES, INCOMPATIBLE_LICENSE, and bloat analyzer."""

from __future__ import annotations

import fnmatch
import re
from typing import Any

from bridge.i18n import tr_en

_ERROR_LINE_RE = re.compile(r"^ERROR:\s*(.+)$", re.MULTILINE)

FEATURE_RULES: dict[str, dict[str, list[str]]] = {
    "core-image-weston": {"requires": ["wayland"], "conflicts": []},
    "xserver-xorg": {"requires": ["x11"], "conflicts": []},
    "mesa": {"requires": ["opengl"], "conflicts": []},
    "qtbase": {"requires": ["opengl"], "conflicts": []},
    "pulseaudio": {"requires": [], "conflicts": ["pipewire-exclusively"]},
}

HEAVY_BLOAT_PACKAGES: dict[str, dict[str, Any]] = {
    "xserver-xorg": {
        "category": "X11 Grafik Yığını",
        "category_en": "X11 Graphics Stack",
        "rootfs_mb": 48.0,
        "build_min": 14.0,
        "fix_key": "DISTRO_FEATURES:remove",
        "fix_val": "x11",
        "reason": "Headless / Wayland hedefinde gereksiz X11 pencere sunucusu bağımlılığı.",
        "reason_en": "Unnecessary X11 display server dependency on headless / Wayland targets.",
    },
    "llvm": {
        "category": "Ağır Derleyici Altyapısı",
        "category_en": "Heavy Compiler Infrastructure",
        "rootfs_mb": 95.0,
        "build_min": 28.0,
        "fix_key": "PACKAGECONFIG:remove:pn-mesa",
        "fix_val": "gallium-llvm",
        "reason": "Hedef imaja LLVM kütüphanelerini çekerek derleme süresini belirgin şekilde uzatır.",
        "reason_en": "Pulls target LLVM libraries, significantly increasing C++ compile time.",
    },
    "webkitgtk": {
        "category": "Web Tarayıcı Motoru",
        "category_en": "Web Browser Engine",
        "rootfs_mb": 110.0,
        "build_min": 42.0,
        "fix_key": "IMAGE_INSTALL:remove",
        "fix_val": "webkitgtk",
        "reason": "Tam tarayıcı motoru C++ derleme belleğini ve imaj boyutunu aşırı artırır.",
        "reason_en": "Full browser engine dramatically inflates C++ link RAM and rootfs size.",
    },
    "qtwebengine": {
        "category": "Chromium / QtWebEngine",
        "category_en": "Chromium / QtWebEngine",
        "rootfs_mb": 165.0,
        "build_min": 65.0,
        "fix_key": "IMAGE_INSTALL:remove",
        "fix_val": "qtwebengine",
        "reason": "Chromium tabanlı QtWebEngine derlemesi >=32 GiB RAM gerektirir.",
        "reason_en": "Chromium-based QtWebEngine compilation typically requires >=32 GiB RAM.",
    },
    "perl": {
        "category": "Betik Çalışma Zamanı",
        "category_en": "Scripting Runtime",
        "rootfs_mb": 22.0,
        "build_min": 5.0,
        "fix_key": "IMAGE_INSTALL:remove",
        "fix_val": "perl",
        "reason": "Küçük gömülü imajlar için gereksiz hedef perl yorumlayıcısı.",
        "reason_en": "Target Perl interpreter is typically unnecessary for minimal embedded images.",
    },
    "python3-full": {
        "category": "Tam Python Paketi",
        "category_en": "Full Python Bundle",
        "rootfs_mb": 34.0,
        "build_min": 6.0,
        "fix_key": "IMAGE_INSTALL:remove",
        "fix_val": "python3-full",
        "reason": "Minimal hedeflerde yalnızca gereken python3 modüllerini eklemek daha ekonomiktir.",
        "reason_en": "Installing only required python3 modules is much smaller on minimal targets.",
    },
}


def parse_dryrun_errors(output: str) -> list[dict[str, Any]]:
    """Extract parse, missing-provider, and circular-dependency diagnostics from `bitbake -p/-n`."""
    issues: list[dict[str, Any]] = []
    for idx, msg in enumerate(_ERROR_LINE_RE.findall(output), start=1):
        clean = msg.strip()
        if "Nothing PROVIDES" in clean or "Nothing RPROVIDES" in clean or "ParseError" in clean:
            issues.append(
                {
                    "id": f"dryrun-err-{idx}",
                    "severity": "blocker",
                    "category": "distro",
                    "title": tr_en(
                        "BitBake Parse / Bağımlılık Hatası",
                        "BitBake Parse / Dependency Error",
                    ),
                    "summary": clean,
                    "detail": tr_en(
                        "Derleme başlamadan `bitbake -p/-n` aşamasında "
                        "çözülemeyen tarif/sağlayıcı hatası bulundu.",
                        "Unresolved recipe or provider error detected during `bitbake -p/-n` pre-flight check.",
                    ),
                    "recipe": None,
                    "layer": None,
                    "dependency_chain": [clean],
                    "auto_fix": None,
                }
            )
    return issues


def _license_matches_policy(pkg_license: str, policy_tokens: list[str]) -> str | None:
    parts = [p.strip() for p in re.split(r"[&|()]+", pkg_license) if p.strip()]
    for rule in policy_tokens:
        for lic in parts:
            if fnmatch.fnmatch(lic, rule) or lic.startswith(rule.rstrip("*")):
                return rule
    return None


def analyze_features_licenses_and_bloat(
    target: str,
    distro_features: list[str],
    machine_features: list[str],
    incompatible_licenses: list[str],
    packages: list[dict[str, Any]],
    dep_chains: dict[str, list[str]] | None = None,
    resolved_fixes: set[str] | None = None,
) -> dict[str, Any]:
    """Audit DISTRO/MACHINE features, INCOMPATIBLE_LICENSE chains, and heavy bloat dependencies."""
    resolved = resolved_fixes or set()
    chains = dep_chains or {}
    issues: list[dict[str, Any]] = []
    bloat_items: list[dict[str, Any]] = []
    license_violations: list[dict[str, Any]] = []

    df_set = {f.strip().lower() for f in distro_features if f.strip()}
    mf_set = {f.strip().lower() for f in machine_features if f.strip()}
    is_headless = "minimal" in target or ("x11" not in df_set and "wayland" not in df_set)

    # 1. Conflicting DISTRO_FEATURES
    if "sysvinit" in df_set and "systemd" in df_set:
        fix_id = "fix-init-conflict"
        if fix_id not in resolved:
            issues.append(
                {
                    "id": fix_id,
                    "severity": "blocker",
                    "category": "distro",
                    "title": tr_en(
                        "Başlatma Sistemi Çakışması (systemd vs sysvinit)",
                        "Init Manager Conflict (systemd vs sysvinit)",
                    ),
                    "summary": tr_en(
                        "DISTRO_FEATURES içinde aynı anda hem systemd hem sysvinit bulunuyor.",
                        "DISTRO_FEATURES contains both systemd and sysvinit simultaneously.",
                    ),
                    "detail": tr_en(
                        'INIT_MANAGER = "systemd" ile sysvinit kaldırılmalıdır.',
                        'Remove sysvinit when using INIT_MANAGER = "systemd".',
                    ),
                    "recipe": None,
                    "layer": None,
                    "dependency_chain": ["DISTRO_FEATURES", "systemd <-> sysvinit"],
                    "auto_fix": {
                        "id": fix_id,
                        "label": tr_en(
                            "sysvinit Çıkar ve systemd Kullan",
                            "Remove sysvinit and Use systemd",
                        ),
                        "description": tr_en(
                            'local.conf içinde DISTRO_FEATURES:remove = "sysvinit" ayarlar.',
                            'Sets DISTRO_FEATURES:remove = "sysvinit" in local.conf.',
                        ),
                        "kind": "local_conf_set",
                        "target_file": "conf/local.conf",
                        "changes": {"DISTRO_FEATURES:remove": "sysvinit", "INIT_MANAGER": "systemd"},
                    },
                }
            )

    if ("opengl" in df_set or "vulkan" in df_set) and mf_set and "gpu" not in mf_set and "opengl" not in mf_set:
        issues.append(
            {
                "id": "warn-gpu-mismatch",
                "severity": "warning",
                "category": "distro",
                "title": tr_en(
                    "Donanım Özellik Uyumsuzluğu (GPU / OpenGL)",
                    "Hardware Feature Mismatch (GPU / OpenGL)",
                ),
                "summary": tr_en(
                    "DISTRO_FEATURES GPU gerektiriyor ancak MACHINE_FEATURES içinde gpu/opengl yok.",
                    "DISTRO_FEATURES requests GPU acceleration, but MACHINE_FEATURES lacks gpu/opengl.",
                ),
                "detail": tr_en(
                    "Yazılımsal LLVMpipe render devreye girebilir ve imaj boyutu büyüyebilir.",
                    "Software LLVMpipe rendering may be pulled in, inflating build time and image size.",
                ),
                "recipe": "mesa",
                "layer": None,
                "dependency_chain": ["DISTRO_FEATURES:opengl", "MACHINE_FEATURES (no gpu)"],
                "auto_fix": None,
            }
        )

    # 2. License Shield (INCOMPATIBLE_LICENSE)
    for pkg in packages:
        name = str(pkg.get("name") or "")
        ver = str(pkg.get("version") or "1.0")
        lic = str(pkg.get("license") or "")
        rule = _license_matches_policy(lic, incompatible_licenses)
        if not rule:
            continue
        fix_id = f"fix-license-{name}"
        if fix_id in resolved:
            continue
        chain = chains.get(name) or [target, "packagegroup-core-boot", name]
        auto_fix = {
            "id": fix_id,
            "label": tr_en(
                f"{name} Paketini Kaldır / BusyBox ile Değiştir",
                f"Remove {name} / Switch to BusyBox",
            ),
            "description": tr_en(
                f'local.conf içine IMAGE_INSTALL:remove = "{name}" ekler.',
                f'Adds IMAGE_INSTALL:remove = "{name}" to local.conf.',
            ),
            "kind": "local_conf_append",
            "target_file": "conf/local.conf",
            "changes": {"IMAGE_INSTALL:remove": name},
        }
        license_violations.append(
            {
                "package": name,
                "version": ver,
                "license": lic,
                "policy_rule": rule,
                "chain": chain,
                "auto_fix": auto_fix,
            }
        )
        issues.append(
            {
                "id": fix_id,
                "severity": "warning",
                "category": "license",
                "title": tr_en(
                    f"Lisans Politikası İhlali: {name} ({lic})",
                    f"License Policy Violation: {name} ({lic})",
                ),
                "summary": tr_en(
                    f"Tanımlanan '{rule}' kısıtı {name} ({ver}) tarafından ihlal ediliyor "
                    f"(Zincir: {' -> '.join(chain)}).",
                    f"Configured '{rule}' restriction triggered by {name} ({ver}) "
                    f"(Chain: {' -> '.join(chain)}).",
                ),
                "detail": tr_en(
                    "Ticari ürün dağıtımından önce GPLv3/AGPLv3 paketin alternatifiyle değiştirilmesi önerilir.",
                    "Replace GPLv3/AGPLv3 packages with compliant alternatives before commercial distribution.",
                ),
                "recipe": name,
                "layer": None,
                "dependency_chain": chain,
                "auto_fix": auto_fix,
            }
        )

    # 3. Bloat Detector
    pkg_names = {str(p.get("name") or ""): p for p in packages}
    for heavy_name, meta in HEAVY_BLOAT_PACKAGES.items():
        if heavy_name not in pkg_names:
            continue
        if heavy_name == "xserver-xorg" and "x11" in df_set and not is_headless:
            continue
        fix_id = f"fix-bloat-{heavy_name}"
        if fix_id in resolved:
            continue
        chain = chains.get(heavy_name) or [target, "DISTRO_FEATURES", heavy_name]
        cat_label = tr_en(meta["category"], meta["category_en"])
        reason_label = tr_en(meta["reason"], meta["reason_en"])
        auto_fix = {
            "id": fix_id,
            "label": tr_en(
                f"{heavy_name} Şişkinliğini Temizle",
                f"Clean {heavy_name} Bloat",
            ),
            "description": tr_en(
                f'local.conf içinde {meta["fix_key"]} = "{meta["fix_val"]}" uygular.',
                f'Applies {meta["fix_key"]} = "{meta["fix_val"]}" in local.conf.',
            ),
            "kind": "packageconfig_remove",
            "target_file": "conf/local.conf",
            "changes": {meta["fix_key"]: meta["fix_val"]},
        }
        bloat_items.append(
            {
                "package": heavy_name,
                "category": cat_label,
                "estimated_rootfs_mb": meta["rootfs_mb"],
                "estimated_build_min": meta["build_min"],
                "chain": chain,
                "reason": reason_label,
                "auto_fix": auto_fix,
            }
        )
        issues.append(
            {
                "id": fix_id,
                "severity": "warning",
                "category": "bloat",
                "title": tr_en(
                    f"Gereksiz Ağır Bağımlılık (Bloat): {heavy_name}",
                    f"Unnecessary Heavy Dependency (Bloat): {heavy_name}",
                ),
                "summary": tr_en(
                    f"+{meta['rootfs_mb']:.0f} MiB rootfs ve +{meta['build_min']:.0f} dk derleme maliyeti. "
                    f"Giriş zinciri: {' -> '.join(chain)}",
                    f"+{meta['rootfs_mb']:.0f} MiB rootfs and +{meta['build_min']:.0f} min build cost. "
                    f"Inclusion chain: {' -> '.join(chain)}",
                ),
                "detail": reason_label,
                "recipe": heavy_name,
                "layer": None,
                "dependency_chain": chain,
                "auto_fix": auto_fix,
            }
        )

    return {
        "issues": issues,
        "bloat_items": bloat_items,
        "license_violations": license_violations,
    }
