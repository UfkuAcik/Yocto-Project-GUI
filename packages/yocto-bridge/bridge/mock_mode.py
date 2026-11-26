"""Full-featured Yocto 6.0 Wrynose & 5.0 Scarthgap mock engine for UI/CI verification."""

from __future__ import annotations

import asyncio
import os
import platform
import random
import shutil
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from bridge import __version__
from bridge.enterprise import (
    apply_autorev_pins,
    apply_migration_fixes,
    build_archiver_config,
    build_gdbserver_launch_plan,
    build_mcdepends_expression,
    build_offline_mirror_plan,
    build_remote_sstate_analytics,
    export_sources_tarball,
    generate_multiconfig_conf,
    generate_vscode_debug_configs,
    lookup_path_in_index,
    parse_diffsigs_output,
    parse_installed_package_sizes,
    parse_live_telemetry_output,
    parse_multiconfig_text,
    scan_autorev_in_files,
    scan_migration_files,
    sync_bbmulticonfig_in_local_conf,
)
from bridge.event_monitor import EventMonitor
from bridge.i18n import is_en, tr_en
from bridge.parsers.buildhistory import parse_buildhistory_diff
from bridge.parsers.dot_dag import (
    explain_why_included,
    parse_task_depends_dot,
    slice_graph_for_ui,
)
from bridge.parsers.kas_yaml import parse_kas_yaml, serialize_kas_yaml
from bridge.parsers.local_conf import parse_conf
from bridge.parsers.spdx_cve import export_license_matrix, parse_cve_report, parse_spdx3_jsonld
from bridge.parsers.wks_parser import parse_wks, serialize_wks
from bridge.preflight import (
    analyze_features_licenses_and_bloat,
    apply_local_conf_fix,
    audit_layers,
    build_version_matrix,
    compute_readiness_score,
    detect_host_resources,
    generate_optimization_plan,
    parse_yocto_check_layer_output,
    probe_sstate_and_hashserve,
)
from bridge.pro_suite import (
    analyze_buildstats_records,
    build_hardware_smoke_report,
    build_openvex_document,
    diff_kernel_config,
    export_cra_compliance_bundle,
    generate_cicd_pipeline,
    generate_kernel_bbappend_fragment,
    generate_secure_boot_inc,
    parse_dts_tree,
    parse_ptest_output,
    update_dts_node_status,
    validate_dts_syntax,
)
from bridge.protocol import RpcError, RpcErrorCode, validate_linux_workspace_path
from bridge.tools.layer_index import LayerIndexClient
from bridge.tools.recipe_templates import (
    generate_bbappend_content,
    generate_recipe_content,
    recipe_summary_dict,
)
from bridge.tools.yocto_tools import check_layer_compatibility

INITIAL_LOCAL_CONF = """# Yocto Studio Managed Configuration — Comments Preserved
# Bu dosya yorum koruyucu AST/satır düzenleyicisi tarafından yönetilir.

# Hedef Donanım (Machine Selection)
MACHINE ??= "imx8mp-lpddr4-evk"

# Dağıtım Politikası (Distro)
DISTRO ?= "poky"

# Paket Yöneticisi & Başlatma Sistemi
PACKAGE_CLASSES ?= "package_rpm"
INIT_MANAGER = "systemd"

# Paralel Derleme Kaynakları
BB_NUMBER_THREADS ?= "8"
PARALLEL_MAKE ?= "-j 8"

# Paylaşımlı Önbellekler (WSL2 ext4 / Shared Cache)
DL_DIR ?= "/home/yocto/yocto-cache/downloads"
SSTATE_DIR ?= "/home/yocto/yocto-cache/sstate-cache"

# Derleyici Araç Zinciri (GCC / Clang)
PREFERRED_TOOLCHAIN_TARGET ?= "gcc"

# Ek İmaj Özellikleri ve Paketler
EXTRA_IMAGE_FEATURES ?= "allow-empty-password allow-root-login debug-tweaks"
IMAGE_INSTALL:append = " openssh-sftp-server htop my-sensor-daemon"
"""

SAMPLE_RECIPES: dict[str, dict[str, Any]] = {
    "core-image-minimal": {
        "summary": {
            "pn": "core-image-minimal",
            "pv": "1.0",
            "layer": "openembedded-core",
            "file_path": "meta/recipes-core/images/core-image-minimal.bb",
            "summary": "A small image just capable of allowing a device to boot.",
            "license": "MIT",
            "has_bbappend": False,
        },
        "content": (
            'SUMMARY = "A small image just capable of allowing a device to boot."\n\n'
            'IMAGE_INSTALL = "packagegroup-core-boot ${CORE_IMAGE_EXTRA_INSTALL}"\n\n'
            'IMAGE_LINGUAS = " "\n\n'
            'LICENSE = "MIT"\n\n'
            "inherit core-image\n\n"
            "IMAGE_ROOTFS_SIZE ?= \"8192\"\n"
            'IMAGE_ROOTFS_EXTRA_SPACE:append = "${@bb.utils.contains('
            "'DISTRO_FEATURES', 'systemd', ' + 4096', '', d)}\"\n"
        ),
    },
    "linux-yocto": {
        "summary": {
            "pn": "linux-yocto",
            "pv": "6.12.19+git",
            "layer": "openembedded-core",
            "file_path": "meta/recipes-kernel/linux/linux-yocto_6.12.bb",
            "summary": "Yocto Linux Kernel (LTS 6.12)",
            "license": "GPL-2.0-only",
            "has_bbappend": True,
        },
        "content": (
            "KBRANCH ?= \"v6.12/standard/base\"\n"
            "require recipes-kernel/linux/linux-yocto.inc\n\n"
            'LINUX_VERSION ?= "6.12.19"\n'
            'PV = "${LINUX_VERSION}+git"\n\n'
            'COMPATIBLE_MACHINE = "(qemuarm|qemuarm64|qemux86|qemux86-64|imx8mp-lpddr4-evk)"\n'
            'KERNEL_FEATURES:append = " features/netfilter/netfilter.scc"\n'
        ),
    },
    "systemd": {
        "summary": {
            "pn": "systemd",
            "pv": "257.4",
            "layer": "openembedded-core",
            "file_path": "meta/recipes-core/systemd/systemd_257.bb",
            "summary": "A System and Service Manager",
            "license": "GPL-2.0-only & LGPL-2.1-or-later",
            "has_bbappend": False,
        },
        "content": (
            'SUMMARY = "A System and Service Manager"\n'
            'LICENSE = "GPL-2.0-only & LGPL-2.1-or-later"\n\n'
            "inherit meson pkgconfig useradd systemd gettext\n\n"
            'PACKAGECONFIG ??= " \\\n'
            '    ${@bb.utils.filter(\'DISTRO_FEATURES\', \'acl audit pam selinux\', d)} \\\n'
            '    backlight hostnamed journald localed logind networkd resolved timedated \\\n'
            '"\n'
        ),
    },
    "my-sensor-daemon": {
        "summary": {
            "pn": "my-sensor-daemon",
            "pv": "1.2.0",
            "layer": "meta-custom-iot",
            "file_path": "meta-custom-iot/recipes-apps/my-sensor-daemon/my-sensor-daemon_1.2.0.bb",
            "summary": "Industrial MQTT telemetry & CAN-bus sensor daemon",
            "license": "Apache-2.0",
            "has_bbappend": True,
        },
        "content": (
            'SUMMARY = "Industrial MQTT telemetry & CAN-bus sensor daemon"\n'
            'LICENSE = "Apache-2.0"\n'
            'LIC_FILES_CHKSUM = "file://LICENSE;md5=86d3f3a95c324c9479bd8986968f4327"\n\n'
            'DEPENDS = "mosquitto libgpiod nlohmann-json"\n'
            'SRC_URI = "git://github.com/example/my-sensor-daemon.git;protocol=https;branch=main \\\n'
            '           file://sensor-daemon.service \\\n'
            '"\n'
            'SRCREV = "a4c9f8e12b3d4c556677889900aabbccddeeff11"\n\n'
            "inherit cmake systemd\n\n"
            'SYSTEMD_SERVICE:${PN} = "sensor-daemon.service"\n'
        ),
    },
    "busybox": {
        "summary": {
            "pn": "busybox",
            "pv": "1.37.0",
            "layer": "openembedded-core",
            "file_path": "meta-custom-iot/recipes-core/busybox/busybox_%.bbappend",
            "summary": "Tiny versions of many common UNIX utilities (.bbappend)",
            "license": "GPL-2.0-only",
            "has_bbappend": True,
        },
        "content": (
            'FILESEXTRAPATHS:prepend := "${THISDIR}/${PN}:"\n\n'
            'SRC_URI += "file://enable-syslog-network.cfg"\n'
        ),
    },
}

BUILD_TASK_SCRIPT: list[tuple[str, str, bool]] = [
    ("quilt-native", "do_populate_sysroot_setscene", True),
    ("glibc", "do_populate_sysroot_setscene", True),
    ("gcc-cross-aarch64", "do_populate_sysroot_setscene", True),
    ("openssl", "do_populate_sysroot_setscene", True),
    ("zlib", "do_populate_sysroot_setscene", True),
    ("systemd", "do_populate_sysroot_setscene", True),
    ("mosquitto", "do_fetch", False),
    ("libgpiod", "do_populate_sysroot_setscene", True),
    ("busybox", "do_configure", False),
    ("busybox", "do_compile", False),
    ("busybox", "do_install", False),
    ("mosquitto", "do_configure", False),
    ("mosquitto", "do_compile", False),
    ("mosquitto", "do_install", False),
    ("u-boot-imx", "do_fetch", False),
    ("u-boot-imx", "do_compile", False),
    ("u-boot-imx", "do_deploy", False),
    ("linux-yocto", "do_kernel_configme", False),
    ("linux-yocto", "do_compile", False),
    ("linux-yocto", "do_compile_kernelmodules", False),
    ("linux-yocto", "do_deploy", False),
    ("my-sensor-daemon", "do_fetch", False),
    ("my-sensor-daemon", "do_configure", False),
    ("my-sensor-daemon", "do_compile", False),
    ("my-sensor-daemon", "do_install", False),
    ("my-sensor-daemon", "do_package_write_rpm", False),
    ("core-image-minimal", "do_rootfs", False),
    ("core-image-minimal", "do_image_ext4", False),
    ("core-image-minimal", "do_image_wic", False),
    ("core-image-minimal", "do_create_spdx", False),
    ("core-image-minimal", "do_sbom_cve_check", False),
    ("core-image-minimal", "do_build", False),
]


def _update_conf_preserve_comments(
    content: str,
    updates: dict[str, str],
    operators: dict[str, str] | None = None,
    remove_keys: list[str] | None = None,
) -> str:
    """Update BitBake .conf variables in place using lossless AST parser."""
    doc = parse_conf(content)
    ops = operators or {}
    for key, val in updates.items():
        doc.set_variable(key, val, operator=ops.get(key))
    for rk in remove_keys or []:
        doc.remove_variable(rk)
    return doc.render()


def _extract_conf_vars(content: str) -> dict[str, str]:
    return parse_conf(content).get_variables()


@dataclass
class MockBuildState:
    build_id: str | None = None
    target: str | None = None
    machine: str = "imx8mp-lpddr4-evk"
    distro: str = "poky"
    status: str = "idle"
    total_tasks: int = 0
    completed_tasks: int = 0
    sstate_hits: int = 0
    sstate_misses: int = 0
    started_at: float = 0.0
    elapsed_ms: float = 0.0
    active_tasks: dict[int, dict[str, Any]] = field(default_factory=dict)
    failed_task: dict[str, Any] | None = None
    task_logs: dict[str, tuple[str, str, str, str]] = field(default_factory=dict)


class MockYoctoEngine:
    """In-memory deterministic + realistic mock engine for all 7 Yocto Studio modules."""

    def __init__(self, monitor: EventMonitor) -> None:
        self._monitor = monitor
        self._start_time = time.time()
        self._projects: list[dict[str, Any]] = [
            {
                "id": "proj-wrynose-imx8mp",
                "name": "poky-wrynose-imx8mp",
                "yocto_version": "6.0.4",
                "yocto_codename": "wrynose",
                "setup_tool": "bitbake-setup",
                "workspace_path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp",
                "build_dir": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/build",
                "dl_dir": "/home/yocto/yocto-cache/downloads",
                "sstate_dir": "/home/yocto/yocto-cache/sstate-cache",
                "machine": "imx8mp-lpddr4-evk",
                "distro": "poky",
                "provider": "mock",
                "hashserve": "auto",
            },
            {
                "id": "proj-scarthgap-qemu",
                "name": "edge-gateway-scarthgap",
                "yocto_version": "5.0.21",
                "yocto_codename": "scarthgap",
                "setup_tool": "oe-init-build-env",
                "workspace_path": "/home/yocto/yocto-studio/edge-gateway-scarthgap",
                "build_dir": "/home/yocto/yocto-studio/edge-gateway-scarthgap/build",
                "dl_dir": "/home/yocto/yocto-cache/downloads",
                "sstate_dir": "/home/yocto/yocto-cache/sstate-cache",
                "machine": "qemuarm64",
                "distro": "poky-altcfg",
                "provider": "mock",
                "hashserve": "wss://hashserv.yoctoproject.org:8687",
            },
        ]
        self._active_project_id = "proj-wrynose-imx8mp"

        self._layers: list[dict[str, Any]] = [
            {
                "name": "meta",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/openembedded-core/meta",
                "priority": 5,
                "branch": "wrynose",
                "compat": ["wrynose"],
                "compatible_with_active": True,
                "warning": None,
                "appends_count": 0,
            },
            {
                "name": "meta-yocto-bsp",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-yocto/meta-yocto-bsp",
                "priority": 5,
                "branch": "wrynose",
                "compat": ["wrynose"],
                "compatible_with_active": True,
                "warning": None,
                "appends_count": 1,
            },
            {
                "name": "meta-oe",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-openembedded/meta-oe",
                "priority": 6,
                "branch": "wrynose",
                "compat": ["wrynose"],
                "compatible_with_active": True,
                "warning": None,
                "appends_count": 4,
            },
            {
                "name": "meta-freescale",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-freescale",
                "priority": 8,
                "branch": "wrynose",
                "compat": ["wrynose", "scarthgap"],
                "compatible_with_active": True,
                "warning": None,
                "appends_count": 7,
            },
            {
                "name": "meta-custom-iot",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-custom-iot",
                "priority": 10,
                "branch": "main",
                "compat": ["wrynose", "scarthgap"],
                "compatible_with_active": True,
                "warning": None,
                "appends_count": 2,
            },
            {
                "name": "meta-legacy-wifi",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-legacy-wifi",
                "priority": 7,
                "branch": "kirkstone",
                "compat": ["kirkstone"],
                "compatible_with_active": False,
                "warning": "LAYERSERIES_COMPAT='kirkstone' aktif 'wrynose' serisiyle uyumsuz.",
                "appends_count": 1,
            },
        ]

        self._layer_index: list[dict[str, Any]] = [
            {
                "name": "meta-clang",
                "summary": "C/C++ Clang/LLVM cross toolchain layer for OpenEmbedded",
                "vcs_url": "https://github.com/kraj/meta-clang.git",
                "branch": "wrynose",
                "compat": ["wrynose", "scarthgap"],
                "layer_type": "toolchain",
                "installed": False,
            },
            {
                "name": "meta-security",
                "summary": "Security tools, hardening, TPM2, IMA/EVM and audit layers",
                "vcs_url": "https://git.yoctoproject.org/meta-security",
                "branch": "wrynose",
                "compat": ["wrynose"],
                "layer_type": "security",
                "installed": False,
            },
            {
                "name": "meta-virtualization",
                "summary": "Containers, Docker, Podman, Xen, and KVM recipes",
                "vcs_url": "https://git.yoctoproject.org/meta-virtualization",
                "branch": "wrynose",
                "compat": ["wrynose", "scarthgap"],
                "layer_type": "software",
                "installed": False,
            },
            {
                "name": "meta-qt6",
                "summary": "Qt 6 embedded Wayland/EGLFS HMI framework",
                "vcs_url": "https://code.qt.io/yocto/meta-qt6.git",
                "branch": "6.8",
                "compat": ["wrynose", "scarthgap"],
                "layer_type": "software",
                "installed": False,
            },
            {
                "name": "meta-raspberrypi",
                "summary": "BSP layer for Raspberry Pi 3/4/5 boards",
                "vcs_url": "https://git.yoctoproject.org/meta-raspberrypi",
                "branch": "wrynose",
                "compat": ["wrynose", "scarthgap"],
                "layer_type": "bsp",
                "installed": False,
            },
        ]

        self._local_conf = INITIAL_LOCAL_CONF
        self._fragments: list[dict[str, Any]] = [
            {
                "id": "core/yocto/root-login-with-empty-password",
                "name": "root-login-with-empty-password",
                "description": "Geliştirme aşamasında şifresiz root seri/SSH oturumuna izin verir.",
                "category": "security",
                "enabled": True,
            },
            {
                "id": "core/yocto/sstate-mirror-cdn",
                "name": "sstate-mirror-cdn",
                "description": "Resmi Yocto Project CDN sstate-cache yansısını ve hashserv'i açar.",
                "category": "build",
                "enabled": True,
            },
            {
                "id": "distro/poky-altcfg",
                "name": "poky-altcfg (systemd + Wayland)",
                "description": "SysVinit yerine systemd ve modern Wayland/PipeWire yığınını seçer.",
                "category": "distro",
                "enabled": False,
            },
            {
                "id": "toolchain/clang-target",
                "name": "clang-target",
                "description": "Hedef paketler için PREFERRED_TOOLCHAIN_TARGET = 'clang' etkinleştirir.",
                "category": "toolchain",
                "enabled": False,
            },
        ]

        self._recipes = {
            k: {"summary": dict(v["summary"]), "content": str(v["content"])}
            for k, v in SAMPLE_RECIPES.items()
        }

        self._build = MockBuildState()
        self._build_task: asyncio.Task[None] | None = None
        self._cancel_requested = False
        self._pty_sessions: dict[str, dict[str, Any]] = {}
        self._qemu_sessions: dict[str, dict[str, Any]] = {}
        self._resolved_preflight_fixes: set[str] = set()
        self._preflight_appends: list[dict[str, Any]] = [
            {
                "recipe": "my-sensor-daemon",
                "layer": "meta-legacy-wifi",
                "append_file": (
                    "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/"
                    "meta-legacy-wifi/recipes-apps/my-sensor-daemon_1.1.4.bbappend"
                ),
            }
        ]
        self._preflight_packages: list[dict[str, Any]] = [
            {"name": "linux-yocto", "version": "6.12.19", "license": "GPL-2.0-only"},
            {"name": "u-boot-imx", "version": "2025.04", "license": "GPL-2.0-or-later"},
            {"name": "glibc", "version": "2.41", "license": "LGPL-2.1-or-later"},
            {"name": "systemd", "version": "257.4", "license": "LGPL-2.1-or-later"},
            {"name": "openssl", "version": "3.0.14", "license": "Apache-2.0"},
            {"name": "mosquitto", "version": "2.0.20", "license": "EPL-2.0"},
            {"name": "bash", "version": "5.2.37", "license": "GPL-3.0-or-later"},
            {"name": "xserver-xorg", "version": "21.1.14", "license": "MIT"},
            {"name": "python3", "version": "3.13.2", "license": "PSF-2.0"},
            {"name": "qtbase", "version": "6.8.2", "license": "LGPL-3.0-only"},
            {"name": "gstreamer1.0", "version": "1.24.11", "license": "LGPL-2.1-or-later"},
            {"name": "mesa", "version": "25.0.1", "license": "MIT"},
        ]
        self._kernel_cfg_before = (
            "CONFIG_CAN=y\n"
            "# CONFIG_CAN_FLEXCAN is not set\n"
            "CONFIG_USB_GADGET=y\n"
            "CONFIG_DM_VERITY=m\n"
            "CONFIG_NETFILTER_XTABLES=m\n"
        )
        self._kernel_cfg_after = (
            "CONFIG_CAN=y\n"
            "CONFIG_CAN_FLEXCAN=y\n"
            "CONFIG_USB_GADGET=y\n"
            "CONFIG_DM_VERITY=y\n"
            "CONFIG_NETFILTER_XTABLES=m\n"
            "CONFIG_WIREGUARD=m\n"
        )
        self._kernel_bbappend = 'FILESEXTRAPATHS:prepend := "${THISDIR}/files:"\n'
        self._dts_files: dict[str, dict[str, str]] = {
            "meta-freescale/recipes-kernel/linux/files/imx8mp-lpddr4-evk.dts": {
                "name": "imx8mp-lpddr4-evk.dts",
                "layer": "meta-freescale",
                "content": (
                    "/dts-v1/;\n"
                    "/ {\n"
                    '    model = "NXP i.MX8MP LPDDR4 EVK board";\n'
                    '    compatible = "fsl,imx8mp-evk", "fsl,imx8mp";\n'
                    "    i2c3: i2c@30a40000 {\n"
                    '        compatible = "fsl,imx8mp-i2c", "fsl,imx21-i2c";\n'
                    "        reg = <0x30a40000 0x10000>;\n"
                    '        pinctrl-0 = <&pinctrl_i2c3>;\n'
                    '        status = "okay";\n'
                    "        pmic@25 {\n"
                    '            compatible = "nxp,pca9450c";\n'
                    "            reg = <0x25>;\n"
                    '            status = "okay";\n'
                    "        };\n"
                    "    };\n"
                    "    flexcan1: can@308c0000 {\n"
                    '        compatible = "fsl,imx8mp-flexcan";\n'
                    "        reg = <0x308c0000 0x10000>;\n"
                    '        pinctrl-0 = <&pinctrl_flexcan1>;\n'
                    '        status = "disabled";\n'
                    "    };\n"
                    "    fec: ethernet@30be0000 {\n"
                    '        compatible = "fsl,imx8mp-fec";\n'
                    "        reg = <0x30be0000 0x10000>;\n"
                    '        pinctrl-0 = <&pinctrl_fec>;\n'
                    '        status = "okay";\n'
                    "    };\n"
                    "};\n"
                ),
            }
        }
        self._vex_entries: list[dict[str, Any]] = [
            {
                "cve_id": "CVE-2025-41203",
                "package": "mosquitto",
                "version": "2.0.20",
                "severity": "HIGH",
                "cvss": 7.5,
                "status": "under_investigation",
                "justification": None,
                "impact_statement": "MQTT broker TLS ACL analizi sürüyor.",
                "updated_at": "2026-11-25T10:00:00+00:00",
            },
            {
                "cve_id": "CVE-2025-29911",
                "package": "openssl",
                "version": "3.5.0",
                "severity": "MEDIUM",
                "cvss": 5.3,
                "status": "fixed",
                "justification": None,
                "impact_statement": "OE-Core tarifi içinde backport yama uygulandı.",
                "updated_at": "2026-11-25T09:40:00+00:00",
            },
            {
                "cve_id": "CVE-2024-56321",
                "package": "busybox",
                "version": "1.37.0",
                "severity": "LOW",
                "cvss": 3.3,
                "status": "not_affected",
                "justification": "vulnerable_code_not_in_execute_path",
                "impact_statement": "httpd applet defconfig içinde kapalıdır.",
                "updated_at": "2026-11-24T18:20:00+00:00",
            },
            {
                "cve_id": "CVE-2025-33018",
                "package": "curl",
                "version": "8.12.1",
                "severity": "HIGH",
                "cvss": 7.4,
                "status": "not_affected",
                "justification": "component_not_present",
                "impact_statement": "NTLM kimlik doğrulama desteği derleme dışı bırakılmıştır.",
                "updated_at": "2026-11-24T15:10:00+00:00",
            },
            {
                "cve_id": "CVE-2025-11804",
                "package": "linux-yocto",
                "version": "6.12.19",
                "severity": "MEDIUM",
                "cvss": 6.1,
                "status": "affected",
                "justification": None,
                "impact_statement": "6.12.22 yama seti planlandı.",
                "updated_at": "2026-11-25T08:05:00+00:00",
            },
        ]
        self._wks_files: dict[str, dict[str, str]] = {
            "meta-freescale/wic/imx-imx-boot-bootpart.wks": {
                "name": "imx-imx-boot-bootpart.wks",
                "layer": "meta-freescale",
                "description": "NXP i.MX8MP GPT çift bölüm (U-Boot SPL + FAT32 boot + ext4 rootfs)",
                "content": (
                    "# short-description: Create SD card image with boot and rootfs partitions\n"
                    "# long-description: NXP i.MX8MP EVK production kickstart layout\n"
                    "part u-boot --source rawcopy --sourceparams=\"file=imx-boot\" "
                    "--ondisk mmcblk2 --no-table --align 32\n"
                    "part /boot --source bootimg-partition --ondisk mmcblk2 --fstype=vfat "
                    "--label boot --active --align 4096 --size 128M\n"
                    "part / --source rootfs --ondisk mmcblk2 --fstype=ext4 "
                    "--label rootfs --align 4096 --size 2048M\n"
                    "part /data --ondisk mmcblk2 --fstype=ext4 --label data --align 4096 --size 512M\n"
                    "bootloader --ptable gpt --timeout=3 --append=\"console=ttymxc1,115200 rootwait rw\"\n"
                ),
            },
            "meta/scripts/lib/wic/canned-wks/qemux86-directdisk.wks": {
                "name": "qemux86-directdisk.wks",
                "layer": "openembedded-core",
                "description": "QEMU x86_64 EFI + ext4 kök dosya sistemi düzeni",
                "content": (
                    "# short-description: Create Qemu disk image with EFI and rootfs\n"
                    "part /boot --source bootimg-efi --sourceparams=\"loader=grub-efi\" "
                    "--ondisk sda --label msdos --active --align 1024 --size 64M\n"
                    "part / --source rootfs --ondisk sda --fstype=ext4 --label platform --align 1024 --size 1536M\n"
                    "bootloader --ptable gpt --timeout=0 --append=\"rootwait console=ttyS0,115200\"\n"
                ),
            },
        }
        self._sdks: list[dict[str, Any]] = [
            {
                "name": "poky-glibc-x86_64-core-image-minimal-armv8a-imx8mp-lpddr4-evk-toolchain-6.0.sh",
                "kind": "standard-sdk",
                "machine": "imx8mp-lpddr4-evk",
                "filename": "poky-glibc-x86_64-core-image-minimal-armv8a-imx8mp-lpddr4-evk-toolchain-6.0.sh",
                "path": (
                    "/home/yocto/yocto-studio/poky-wrynose-imx8mp/build/tmp/deploy/sdk/"
                    "poky-glibc-x86_64-core-image-minimal-armv8a-imx8mp-lpddr4-evk-toolchain-6.0.sh"
                ),
                "size_bytes": 492_830_720,
                "built_at": "2026-11-25 08:42:10",
                "sysroot_arch": "aarch64-poky-linux",
            }
        ]
        self._telemetry_task: asyncio.Task[None] | None = None
        self._layer_index_client = LayerIndexClient()
        self._devtool_entries: list[dict[str, Any]] = [
            {
                "recipe": "my-sensor-daemon",
                "srctree": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/build/workspace/sources/my-sensor-daemon",
                "bbappend": (
                    "/home/yocto/yocto-studio/poky-wrynose-imx8mp/"
                    "build/workspace/appends/my-sensor-daemon_1.2.0.bbappend"
                ),
                "status": "modified",
            }
        ]
        self._setup_layers: list[dict[str, Any]] = [
            {
                "layer": "openembedded-core",
                "branch": "wrynose",
                "current_rev": "a18c44d",
                "remote_rev": "a18c44d",
                "status": "up-to-date",
                "local_changes": [],
                "diff": "",
            },
            {
                "layer": "bitbake",
                "branch": "2.12",
                "current_rev": "891f02b",
                "remote_rev": "9d41e77",
                "status": "behind",
                "local_changes": [],
                "diff": (
                    "commit 9d41e77\n"
                    "Author: Richard Purdie <richard.purdie@linuxfoundation.org>\n"
                    "    tinfoil: improve config_data varhistory serialization\n"
                ),
            },
            {
                "layer": "meta-custom-iot",
                "branch": "main",
                "current_rev": "f22a190",
                "remote_rev": "f22a190",
                "status": "dirty",
                "local_changes": ["M recipes-apps/my-sensor-daemon/my-sensor-daemon_1.2.0.bb"],
                "diff": (
                    "--- a/recipes-apps/my-sensor-daemon/my-sensor-daemon_1.2.0.bb\n"
                    "+++ b/recipes-apps/my-sensor-daemon/my-sensor-daemon_1.2.0.bb\n"
                    "@@ -4 +4 @@\n"
                    '-DEPENDS = "mosquitto libgpiod"\n'
                    '+DEPENDS = "mosquitto libgpiod nlohmann-json"\n'
                ),
            },
        ]

        # Modül 11: Multiconfig, Air-Gapped, RootFS Treemap, Migration Linter & Multi-Git mock state
        self._multiconfigs: dict[str, dict[str, Any]] = {}
        mc_samples = [
            (
                "cortex-a53-linux",
                "imx8mp-lpddr4-evk",
                "${TOPDIR}/tmp-a53-linux",
                "poky",
                "Ana Cortex-A53 Linux rootfs & uygulama hedefi",
            ),
            (
                "cortex-m7-rtos",
                "imx8mp-m7-freertos",
                "${TOPDIR}/tmp-m7-rtos",
                "baremetal",
                "Cortex-M7 gerçek zamanlı CAN/ADC yardımcı çekirdek firmware'i",
            ),
            (
                "initramfs",
                "imx8mp-lpddr4-evk",
                "${TOPDIR}/tmp-initramfs",
                "poky-tiny",
                "OTA kurtarma & dm-verity erken açılış initramfs",
            ),
        ]
        for mc_name, mc_mach, mc_tmp, mc_dist, mc_desc in mc_samples:
            raw_mc = generate_multiconfig_conf(mc_name, mc_mach, mc_tmp, mc_dist, mc_desc)
            self._multiconfigs[mc_name] = parse_multiconfig_text(
                mc_name, raw_mc, f"conf/multiconfig/{mc_name}.conf"
            )
        self._mcdepends: list[dict[str, str]] = [
            build_mcdepends_expression(
                "cortex-a53-linux", "cortex-m7-rtos", "zephyr-sensor-fw", "do_deploy"
            ),
            build_mcdepends_expression(
                "cortex-a53-linux", "initramfs", "core-image-minimal-initramfs", "do_image_complete"
            ),
        ]
        self._bbmulticonfig_enabled: list[str] = ["cortex-a53-linux", "cortex-m7-rtos", "initramfs"]

        self._autorev_files: dict[str, str] = {
            "meta-custom-iot/recipes-apps/my-sensor-daemon/my-sensor-daemon_git.bb": (
                'SUMMARY = "Industrial IoT Sensor Daemon"\n'
                'LICENSE = "MIT"\n'
                'SRC_URI = "git://github.com/example/my-sensor-daemon.git;protocol=https;branch=main"\n'
                'SRCREV = "${AUTOREV}"\n'
                'PV = "1.2+git${SRCPV}"\n'
            ),
            "meta-custom-iot/recipes-connectivity/can-gateway/can-gateway_git.bb": (
                'SUMMARY = "FlexCAN MQTT Bridge"\n'
                'LICENSE = "GPL-2.0-only"\n'
                'SRC_URI = "git://github.com/example/can-gateway.git;protocol=https;branch=main"\n'
                'SRCREV = "${AUTOREV}"\n'
            ),
            "meta-custom-iot/recipes-ai/edge-ml-runtime/edge-ml-runtime_git.bb": (
                'SUMMARY = "TFLite Edge Inference Service"\n'
                'LICENSE = "Apache-2.0"\n'
                'SRC_URI = "git://github.com/example/edge-ml-runtime.git;protocol=https;branch=main"\n'
                'SRCREV_runtime = "${AUTOREV}"\n'
            ),
        }

        mock_pkgs = [
            ("89420", "linux-imx"),
            ("64210", "qtbase"),
            ("42850", "mesa-megadriver"),
            ("38400", "opencv"),
            ("31200", "gstreamer1.0-plugins-bad"),
            ("24600", "python3-core"),
            ("19840", "systemd"),
            ("18420", "glibc-binary-localedata-en-us"),
            ("16900", "imx-gpu-viv"),
            ("14320", "firmware-imx-sdma"),
            ("12850", "llvm-libllvm"),
            ("11200", "glibc"),
            ("9840", "libstdc++6"),
            ("8420", "openssl-bin"),
            ("7910", "libcrypto3"),
            ("6450", "perl-module-core"),
            ("5820", "udev"),
            ("5210", "bluez5"),
            ("4890", "networkmanager"),
            ("4420", "openssh-sshd"),
            ("4110", "my-sensor-daemon"),
            ("3850", "can-gateway"),
            ("3640", "wpa-supplicant"),
            ("3280", "mosquitto"),
            ("2940", "sqlite3"),
            ("2650", "curl"),
            ("2410", "busybox"),
            ("2180", "libssl3"),
            ("1950", "dbus-1"),
            ("1820", "util-linux"),
            ("1690", "e2fsprogs"),
            ("1540", "kmod"),
            ("1420", "iptables"),
            ("1310", "iproute2"),
            ("1180", "bash"),
            ("1040", "zlib1g"),
            ("920", "libgpiod3"),
            ("840", "libyaml-0-2"),
            ("760", "tzdata"),
            ("680", "ca-certificates"),
            ("590", "libnl-3-200"),
            ("480", "libusb-1.0-0"),
            ("410", "systemd-analyze"),
            ("320", "dropbear"),
            ("240", "base-files"),
        ]
        self._rootfs_sizes_text = "\n".join(f"{kb}\tKiB\t{name}" for kb, name in mock_pkgs)
        self._pkgdata_index: list[dict[str, Any]] = [
            {
                "file_path": "/usr/lib/libcrypto.so.3",
                "package": "libcrypto3",
                "recipe": "openssl",
                "recipe_file": "meta/recipes-connectivity/openssl/openssl_3.5.0.bb",
                "layer": "openembedded-core",
                "version": "3.5.0",
                "size_bytes": 8100000,
            },
            {
                "file_path": "/etc/systemd/system/my-sensor-daemon.service",
                "package": "my-sensor-daemon",
                "recipe": "my-sensor-daemon",
                "recipe_file": "meta-custom-iot/recipes-apps/my-sensor-daemon/my-sensor-daemon_1.2.0.bb",
                "layer": "meta-custom-iot",
                "version": "1.2.0",
                "size_bytes": 4208640,
            },
            {
                "file_path": "/lib/libc.so.6",
                "package": "glibc",
                "recipe": "glibc",
                "recipe_file": "meta/recipes-core/glibc/glibc_2.41.bb",
                "layer": "openembedded-core",
                "version": "2.41",
                "size_bytes": 11468800,
            },
            {
                "file_path": "/usr/bin/busybox",
                "package": "busybox",
                "recipe": "busybox",
                "recipe_file": "meta/recipes-core/busybox/busybox_1.37.0.bb",
                "layer": "openembedded-core",
                "version": "1.37.0",
                "size_bytes": 2467840,
            },
            {
                "file_path": "/usr/bin/mosquitto",
                "package": "mosquitto",
                "recipe": "mosquitto",
                "recipe_file": "meta-oe/recipes-connectivity/mosquitto/mosquitto_2.0.20.bb",
                "layer": "meta-oe",
                "version": "2.0.20",
                "size_bytes": 3358720,
            },
        ]

        # 6 distinct Scarthgap -> Wrynose migration findings in mock custom layer
        self._migration_files: dict[str, str] = {
            "meta-custom-iot/conf/layer.conf": (
                'BBPATH .= ":${LAYERDIR}"\n'
                'LAYERSERIES_COMPAT_meta-custom-iot = "kirkstone scarthgap"\n'
            ),
            "meta-custom-iot/recipes-apps/my-sensor-daemon/my-sensor-daemon_1.2.0.bb": (
                'SUMMARY = "Sensor Daemon"\n'
                'SRC_URI = "file://sensor.conf file://0001-init.patch"\n'
                'S = "${WORKDIR}/git"\n'
                'B = "${WORKDIR}/build"\n'
                'DEPENDS_append = " zlib"\n'
            ),
            "meta-custom-iot/recipes-core/images/iot-edge-image.bb": (
                'inherit core-image\n'
                'INHERIT += "cve-check"\n'
                'EXTRA_IMAGE_FEATURES += "debug-tweaks ssh-server-openssh"\n'
            ),
            "meta-custom-iot/conf/distro/custom-iot.conf": (
                'DISTRO = "custom-iot"\n'
                'BB_ENV_EXTRAWHITE = "MACHINE DISTRO DL_DIR"\n'
            ),
        }

        self._layer_git_repos: list[dict[str, Any]] = [
            {
                "layer_name": "openembedded-core",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/openembedded-core",
                "branch": "wrynose",
                "commit_sha": "a18c44d91f",
                "commit_message": "openssl: upgrade 3.4.1 -> 3.5.0",
                "dirty_count": 0,
                "staged_count": 0,
                "untracked_count": 0,
                "ahead": 0,
                "behind": 2,
                "upstream": "origin/wrynose",
                "changed_files": [],
                "mock_diff": "",
            },
            {
                "layer_name": "meta-openembedded",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-openembedded",
                "branch": "wrynose",
                "commit_sha": "7c91e04ab2",
                "commit_message": "mosquitto: enable systemd notify socket",
                "dirty_count": 0,
                "staged_count": 0,
                "untracked_count": 0,
                "ahead": 0,
                "behind": 0,
                "upstream": "origin/wrynose",
                "changed_files": [],
                "mock_diff": "",
            },
            {
                "layer_name": "meta-freescale",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-freescale",
                "branch": "wrynose",
                "commit_sha": "4f2d801cc3",
                "commit_message": "imx8mp-lpddr4-evk: bump linux-imx to 6.12.19",
                "dirty_count": 1,
                "staged_count": 0,
                "untracked_count": 0,
                "ahead": 1,
                "behind": 0,
                "upstream": "origin/wrynose",
                "changed_files": [{"status": "M", "path": "conf/machine/imx8mp-lpddr4-evk.conf"}],
                "mock_diff": (
                    "--- a/conf/machine/imx8mp-lpddr4-evk.conf\n"
                    "+++ b/conf/machine/imx8mp-lpddr4-evk.conf\n"
                    "@@ -12 +12 @@\n"
                    '-KERNEL_DEVICETREE += "freescale/imx8mp-evk-can.dtb"\n'
                    '+KERNEL_DEVICETREE:append = " freescale/imx8mp-evk-flexcan1.dtb"\n'
                ),
            },
            {
                "layer_name": "meta-security",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-security",
                "branch": "wrynose",
                "commit_sha": "9e013bc721",
                "commit_message": "dm-verity: align veritysetup params with systemd 257",
                "dirty_count": 0,
                "staged_count": 0,
                "untracked_count": 0,
                "ahead": 0,
                "behind": 1,
                "upstream": "origin/wrynose",
                "changed_files": [],
                "mock_diff": "",
            },
            {
                "layer_name": "meta-rauc",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-rauc",
                "branch": "wrynose",
                "commit_sha": "3b771a0e92",
                "commit_message": "rauc: update adaptive update documentation",
                "dirty_count": 0,
                "staged_count": 0,
                "untracked_count": 0,
                "ahead": 0,
                "behind": 0,
                "upstream": "origin/wrynose",
                "changed_files": [],
                "mock_diff": "",
            },
            {
                "layer_name": "meta-custom-iot",
                "path": "/home/yocto/yocto-studio/poky-wrynose-imx8mp/layers/meta-custom-iot",
                "branch": "main",
                "commit_sha": "f22a190d4a",
                "commit_message": "sensor-daemon: add FlexCAN telemetry packet parser",
                "dirty_count": 2,
                "staged_count": 1,
                "untracked_count": 1,
                "ahead": 2,
                "behind": 0,
                "upstream": "origin/main",
                "changed_files": [
                    {"status": "M", "path": "recipes-apps/my-sensor-daemon/my-sensor-daemon_1.2.0.bb"},
                    {"status": "M", "path": "conf/layer.conf"},
                    {"status": "??", "path": "recipes-kernel/linux/files/can-wakeup.cfg"},
                ],
                "mock_diff": (
                    "--- a/recipes-apps/my-sensor-daemon/my-sensor-daemon_1.2.0.bb\n"
                    "+++ b/recipes-apps/my-sensor-daemon/my-sensor-daemon_1.2.0.bb\n"
                    "@@ -4 +4 @@\n"
                    '-DEPENDS = "mosquitto libgpiod"\n'
                    '+DEPENDS = "mosquitto libgpiod nlohmann-json"\n'
                ),
            },
        ]

    def start_background_tasks(self) -> None:
        if self._telemetry_task is None or self._telemetry_task.done():
            self._telemetry_task = asyncio.create_task(self._telemetry_loop())

    async def stop_background_tasks(self) -> None:
        if self._build_task and not self._build_task.done():
            self._cancel_requested = True
            self._build_task.cancel()
            await asyncio.gather(self._build_task, return_exceptions=True)
        if self._telemetry_task and not self._telemetry_task.done():
            self._telemetry_task.cancel()
            await asyncio.gather(self._telemetry_task, return_exceptions=True)

    def get_health_info(self) -> dict[str, Any]:
        return {
            "status": "ok",
            "mode": "mock",
            "version": __version__,
            "yocto_version": "6.0.4 (Wrynose)",
            "pid": os.getpid(),
            "uptime_sec": round(time.time() - self._start_time, 2),
        }

    def _active_project(self) -> dict[str, Any]:
        for proj in self._projects:
            if proj["id"] == self._active_project_id:
                return proj
        return self._projects[0]

    def _localized_layers(self) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for lyr in self._layers:
            item = dict(lyr)
            warn = item.get("warning")
            if isinstance(warn, str) and warn:
                if "LAYERSERIES_COMPAT='kirkstone'" in warn:
                    item["warning"] = tr_en(
                        warn,
                        "LAYERSERIES_COMPAT='kirkstone' is incompatible with active 'wrynose' series.",
                    )
                elif warn.startswith("Uyumluluk kontrolü önerilir"):
                    compat = item.get("compat", [])
                    item["warning"] = tr_en(
                        warn,
                        f"Compatibility check recommended ({compat}).",
                    )
            out.append(item)
        return out

    def _localized_fragments(self) -> list[dict[str, Any]]:
        en_map = {
            "core/yocto/root-login-with-empty-password": (
                "Allows passwordless root serial/SSH sessions during development."
            ),
            "core/yocto/sstate-mirror-cdn": (
                "Enables the official Yocto Project CDN sstate-cache mirror and hashserv."
            ),
            "distro/poky-altcfg": (
                "Selects systemd and the modern Wayland/PipeWire stack instead of SysVinit."
            ),
            "toolchain/clang-target": (
                "Enables PREFERRED_TOOLCHAIN_TARGET = 'clang' for target recipes."
            ),
        }
        out: list[dict[str, Any]] = []
        for frag in self._fragments:
            item = dict(frag)
            if item["id"] in en_map:
                item["description"] = tr_en(str(item["description"]), en_map[item["id"]])
            out.append(item)
        return out

    def _localized_vex_entries(self) -> list[dict[str, Any]]:
        en_map = {
            "CVE-2025-41203": "MQTT broker TLS ACL analysis in progress.",
            "CVE-2025-29911": "Backport patch applied inside the OE-Core recipe.",
            "CVE-2024-56321": "httpd applet is disabled in defconfig.",
            "CVE-2025-33018": "NTLM authentication support is compiled out.",
            "CVE-2025-11804": "6.12.22 patch set scheduled.",
        }
        out: list[dict[str, Any]] = []
        for entry in self._vex_entries:
            item = dict(entry)
            cid = str(item.get("cve_id") or "")
            if cid in en_map and item.get("impact_statement"):
                item["impact_statement"] = tr_en(str(item["impact_statement"]), en_map[cid])
            out.append(item)
        return out

    def _localized_multiconfigs(self) -> list[dict[str, Any]]:
        en_map = {
            "cortex-a53-linux": "Primary Cortex-A53 Linux rootfs & application target",
            "cortex-m7-rtos": "Cortex-M7 real-time CAN/ADC companion core firmware",
            "initramfs": "OTA recovery & dm-verity early-boot initramfs",
        }
        out: list[dict[str, Any]] = []
        for cfg in self._multiconfigs.values():
            item = dict(cfg)
            if is_en():
                name = str(item.get("name") or "")
                desc_en = en_map.get(name, str(item.get("description", "")))
                item["description"] = desc_en
                item["raw_content"] = generate_multiconfig_conf(
                    name,
                    str(item.get("machine") or ""),
                    str(item.get("tmpdir") or ""),
                    str(item.get("distro") or ""),
                    desc_en,
                    item.get("extra_vars") or {},
                )
            out.append(item)
        return out

    async def _telemetry_loop(self) -> None:
        try:
            while True:
                running = self._build.status == "running"
                cpu = random.uniform(68.0, 94.0) if running else random.uniform(2.5, 9.0)
                ram = random.uniform(18.4, 27.6) if running else random.uniform(1.2, 2.1)
                disk_r = random.uniform(180.0, 460.0) if running else random.uniform(0.5, 4.0)
                disk_w = random.uniform(95.0, 290.0) if running else random.uniform(0.2, 2.5)
                await self._monitor.emit(
                    "telemetry.sample",
                    {
                        "cpu_percent": round(cpu, 1),
                        "ram_used_gb": round(ram, 2),
                        "ram_total_gb": 32.0,
                        "disk_read_mb_s": round(disk_r, 1),
                        "disk_write_mb_s": round(disk_w, 1),
                        "ts": time.time(),
                    },
                )
                await asyncio.sleep(1.0)
        except asyncio.CancelledError:
            return

    async def dispatch(self, method: str, params: dict[str, Any]) -> Any:
        handlers: dict[str, Any] = {
            "bridge.ping": self._rpc_ping,
            "bridge.info": self._rpc_info,
            "env.doctor": self._rpc_env_doctor,
            "env.validate_path": self._rpc_validate_path,
            "workspace.list": self._rpc_workspace_list,
            "workspace.get": self._rpc_workspace_get,
            "workspace.select": self._rpc_workspace_select,
            "workspace.create": self._rpc_workspace_create,
            "workspace.import": self._rpc_workspace_import,
            "workspace.setup_status": self._rpc_workspace_setup_status,
            "workspace.setup_update": self._rpc_workspace_setup_update,
            "workspace.update_caches": self._rpc_workspace_update_caches,
            "kas.parse": self._rpc_kas_parse,
            "kas.serialize": self._rpc_kas_serialize,
            "kas.run": self._rpc_kas_run,
            "layers.list": self._rpc_layers_list,
            "layers.search_index": self._rpc_layers_search,
            "layers.add": self._rpc_layers_add,
            "layers.remove": self._rpc_layers_remove,
            "layers.show_appends": self._rpc_layers_appends,
            "layers.show_overlayed": self._rpc_layers_overlayed,
            "layers.create_layer": self._rpc_layers_create,
            "layers.check_compat": self._rpc_layers_check_compat,
            "layers.fetch_from_index": self._rpc_layers_fetch_from_index,
            "config.get_local_conf": self._rpc_config_get,
            "config.preview_diff": self._rpc_config_preview_diff,
            "config.apply_changes": self._rpc_config_apply,
            "config.list_fragments": self._rpc_fragments_list,
            "config.toggle_fragment": self._rpc_fragments_toggle,
            "config.create_fragment": self._rpc_fragments_create,
            "config.inspect_variable": self._rpc_inspect_variable,
            "recipes.list": self._rpc_recipes_list,
            "recipes.get": self._rpc_recipes_get,
            "recipes.save": self._rpc_recipes_save,
            "recipes.create_bbappend": self._rpc_recipes_create_bbappend,
            "devtool.status": self._rpc_devtool_status,
            "devtool.add": self._rpc_devtool_add,
            "devtool.modify": self._rpc_devtool_modify,
            "devtool.build": self._rpc_devtool_build,
            "devtool.deploy_target": self._rpc_devtool_deploy_target,
            "devtool.upgrade": self._rpc_devtool_upgrade,
            "devtool.finish": self._rpc_devtool_finish,
            "devtool.reset": self._rpc_devtool_reset,
            "recipetool.create": self._rpc_recipetool_create,
            "build.start": self._rpc_build_start,
            "build.cancel": self._rpc_build_cancel,
            "build.status": self._rpc_build_status,
            "build.get_task_log": self._rpc_build_task_log,
            "build.run_task_action": self._rpc_build_task_action,
            "dag.generate": self._rpc_dag_generate,
            "dag.explain_why": self._rpc_dag_explain_why,
            "artifacts.list_images": self._rpc_artifacts_images,
            "artifacts.get_sbom": self._rpc_artifacts_sbom,
            "artifacts.get_cves": self._rpc_artifacts_cves,
            "artifacts.export_licenses": self._rpc_artifacts_export_licenses,
            "artifacts.copy_to_host": self._rpc_artifacts_copy_to_host,
            "artifacts.get_buildhistory_diff": self._rpc_artifacts_buildhistory,
            "wic.list_wks": self._rpc_wic_list_wks,
            "wic.parse_wks": self._rpc_wic_parse_wks,
            "wic.serialize_wks": self._rpc_wic_serialize_wks,
            "wic.create_image": self._rpc_wic_create_image,
            "qemu.launch": self._rpc_qemu_launch,
            "qemu.stop": self._rpc_qemu_stop,
            "sdk.list": self._rpc_sdk_list,
            "sdk.build": self._rpc_sdk_build,
            "preflight.runAudit": self._rpc_preflight_run_audit,
            "preflight.getVersionMatrix": self._rpc_preflight_version_matrix,
            "preflight.checkUpgrades": self._rpc_preflight_check_upgrades,
            "preflight.probeSstate": self._rpc_preflight_probe_sstate,
            "preflight.getOptimizationPlan": self._rpc_preflight_optimization_plan,
            "preflight.applyFix": self._rpc_preflight_apply_fix,
            "pro.kernel.diffConfig": self._rpc_pro_kernel_diff,
            "pro.kernel.saveFragment": self._rpc_pro_kernel_save_fragment,
            "pro.dt.listFiles": self._rpc_pro_dt_list,
            "pro.dt.parseTree": self._rpc_pro_dt_parse,
            "pro.dt.updateNodeStatus": self._rpc_pro_dt_update_status,
            "pro.qa.runSuite": self._rpc_pro_qa_run_suite,
            "pro.qa.runHardwareSmoke": self._rpc_pro_qa_hardware_smoke,
            "pro.cra.listVex": self._rpc_pro_cra_list_vex,
            "pro.cra.updateVex": self._rpc_pro_cra_update_vex,
            "pro.cra.exportBundle": self._rpc_pro_cra_export_bundle,
            "pro.secboot.generateConfig": self._rpc_pro_secboot_generate,
            "pro.buildstats.analyze": self._rpc_pro_buildstats_analyze,
            "pro.cicd.generate": self._rpc_pro_cicd_generate,
            "enterprise.multiconfig.list": self._rpc_enterprise_mc_list,
            "enterprise.multiconfig.save": self._rpc_enterprise_mc_save,
            "enterprise.multiconfig.delete": self._rpc_enterprise_mc_delete,
            "enterprise.offline.scanAutorev": self._rpc_enterprise_scan_autorev,
            "enterprise.offline.pinAutorev": self._rpc_enterprise_pin_autorev,
            "enterprise.offline.prepareMirror": self._rpc_enterprise_prepare_mirror,
            "enterprise.offline.configureArchiver": self._rpc_enterprise_configure_archiver,
            "enterprise.rootfs.getTreemap": self._rpc_enterprise_rootfs_treemap,
            "enterprise.rootfs.findPath": self._rpc_enterprise_rootfs_find_path,
            "enterprise.rootfs.diffSigs": self._rpc_enterprise_rootfs_diffsigs,
            "enterprise.debug.exportIdeConfig": self._rpc_enterprise_debug_export_ide,
            "enterprise.debug.startGdbserver": self._rpc_enterprise_debug_start_gdbserver,
            "enterprise.debug.getLiveTelemetry": self._rpc_enterprise_debug_telemetry,
            "enterprise.migration.scan": self._rpc_enterprise_migration_scan,
            "enterprise.migration.applyAll": self._rpc_enterprise_migration_apply_all,
            "enterprise.git.statusAll": self._rpc_enterprise_git_status_all,
            "enterprise.git.runAction": self._rpc_enterprise_git_run_action,
            "enterprise.sstate.getRunnerAnalytics": self._rpc_enterprise_sstate_analytics,
            "pty.open": self._rpc_pty_open,
            "pty.write": self._rpc_pty_write,
            "pty.resize": self._rpc_pty_resize,
            "pty.close": self._rpc_pty_close,
        }
        handler = handlers.get(method)
        if handler is None:
            raise RpcError(RpcErrorCode.METHOD_NOT_FOUND, f"Method not found: {method}")
        return await handler(params)

    async def _rpc_ping(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"pong": True, "ts": time.time()}

    async def _rpc_info(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "version": __version__,
            "mode": "mock",
            "yocto_series": "6.0.4 Wrynose / 5.0.21 Scarthgap",
            "python_version": platform.python_version(),
            "pid": os.getpid(),
            "uptime_sec": round(time.time() - self._start_time, 2),
            "active_clients": 1,
            "active_project_id": self._active_project_id,
        }

    async def _rpc_env_doctor(self, params: dict[str, Any]) -> dict[str, Any]:
        provider = str(params.get("provider", "mock"))
        return {
            "provider": provider,
            "checks": [
                {
                    "id": "mock-engine",
                    "label": tr_en(
                        "yocto-bridge Mock Simülasyon Motoru",
                        "yocto-bridge Mock Simulation Engine",
                    ),
                    "status": "ok",
                    "detail": tr_en(
                        f"Python {platform.python_version()} pure-stdlib JSON-RPC/WebSocket aktif.",
                        f"Python {platform.python_version()} pure-stdlib JSON-RPC/WebSocket active.",
                    ),
                    "fix_command": None,
                },
                {
                    "id": "ext4-guard",
                    "label": tr_en(
                        "NTFS (/mnt/c) Koruma Kuralı",
                        "NTFS (/mnt/c) Protection Rule",
                    ),
                    "status": "ok",
                    "detail": tr_en(
                        "Aktif proje /home/yocto/yocto-studio (ext4) üzerinde doğrulanmış.",
                        "Active project verified on /home/yocto/yocto-studio (ext4).",
                    ),
                    "fix_command": None,
                },
                {
                    "id": "host-tools",
                    "label": tr_en(
                        "Yocto 6.0 Host Paketleri (gawk, chrpath, zstd, lz4)",
                        "Yocto 6.0 Host Packages (gawk, chrpath, zstd, lz4)",
                    ),
                    "status": "ok",
                    "detail": tr_en(
                        "Simülasyon modunda tüm BitBake/devtool/kas arayüzleri hazır.",
                        "All BitBake/devtool/kas interfaces are ready in simulation mode.",
                    ),
                    "fix_command": None,
                },
            ],
        }

    async def _rpc_validate_path(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path", ""))
        provider = str(params.get("provider", "wsl2"))
        return validate_linux_workspace_path(path, provider)

    async def _rpc_workspace_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "projects": self._projects,
            "active_project_id": self._active_project_id,
        }

    async def _rpc_workspace_get(self, params: dict[str, Any]) -> dict[str, Any]:
        pid = params.get("project_id") or self._active_project_id
        for proj in self._projects:
            if proj["id"] == pid:
                return proj
        raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unknown project_id: {pid}")

    async def _rpc_workspace_select(self, params: dict[str, Any]) -> dict[str, Any]:
        pid = str(params.get("project_id", ""))
        for proj in self._projects:
            if proj["id"] == pid:
                self._active_project_id = pid
                await self._monitor.emit_command(
                    str(uuid.uuid4())[:8],
                    f"source {proj['workspace_path']}/oe-init-build-env {proj['build_dir']}",
                    proj["workspace_path"],
                    proj["provider"],
                    "ok",
                )
                return proj
        raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unknown project_id: {pid}")

    async def _rpc_workspace_create(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        path = str(params.get("workspace_path", "")).strip()
        provider = str(params.get("provider", "wsl2"))
        validation = validate_linux_workspace_path(path, provider)
        if not validation["valid"]:
            raise RpcError(
                validation["error_code"] or RpcErrorCode.NTFS_PATH_FORBIDDEN,
                validation["reason"],
                validation,
            )
        if not name:
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("Proje adı boş olamaz.", "Project name cannot be empty."),
            )

        codename = str(params.get("yocto_codename", "wrynose"))
        version = "6.0.4" if codename == "wrynose" else "5.0.21"
        setup_tool = str(params.get("setup_tool", "bitbake-setup"))
        proj = {
            "id": f"proj-{uuid.uuid4().hex[:8]}",
            "name": name,
            "yocto_version": version,
            "yocto_codename": codename,
            "setup_tool": setup_tool,
            "workspace_path": validation["normalized_path"],
            "build_dir": f"{validation['normalized_path']}/build",
            "dl_dir": "/home/yocto/yocto-cache/downloads",
            "sstate_dir": "/home/yocto/yocto-cache/sstate-cache",
            "machine": str(params.get("machine", "imx8mp-lpddr4-evk")),
            "distro": str(params.get("distro", "poky")),
            "provider": provider,
            "hashserve": "auto",
        }
        self._projects.append(proj)
        self._active_project_id = proj["id"]
        cmd = (
            f"bitbake-setup init --non-interactive {proj['workspace_path']}"
            if setup_tool == "bitbake-setup"
            else f"{setup_tool} {proj['build_dir']}"
        )
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8], cmd, proj["workspace_path"], provider, "ok"
        )
        return proj

    async def _rpc_workspace_import(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        path = str(params.get("workspace_path", "")).strip()
        provider = str(params.get("provider", "wsl2"))
        validation = validate_linux_workspace_path(path, provider)
        if not validation["valid"]:
            raise RpcError(
                validation["error_code"] or RpcErrorCode.NTFS_PATH_FORBIDDEN,
                validation["reason"],
                validation,
            )
        if not name:
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("Proje adı boş olamaz.", "Project name cannot be empty."),
            )

        setup_tool = str(params.get("setup_tool", "oe-init-build-env"))
        build_dir = str(params.get("build_dir") or f"{validation['normalized_path']}/build")
        proj = {
            "id": f"proj-{uuid.uuid4().hex[:8]}",
            "name": name,
            "yocto_version": "5.0.21" if setup_tool == "oe-init-build-env" else "6.0.4",
            "yocto_codename": "scarthgap" if setup_tool == "oe-init-build-env" else "wrynose",
            "setup_tool": setup_tool,
            "workspace_path": validation["normalized_path"],
            "build_dir": build_dir,
            "dl_dir": "/home/yocto/yocto-cache/downloads",
            "sstate_dir": "/home/yocto/yocto-cache/sstate-cache",
            "machine": "qemuarm64",
            "distro": "poky",
            "provider": provider,
            "hashserve": "auto",
        }
        self._projects.append(proj)
        self._active_project_id = proj["id"]
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"source {proj['workspace_path']}/oe-init-build-env {build_dir}",
            proj["workspace_path"],
            provider,
            "ok",
        )
        return proj

    async def _rpc_workspace_setup_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        up_to_date = all(item["status"] == "up-to-date" for item in self._setup_layers)
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            "bitbake-setup status",
            proj["workspace_path"],
            proj["provider"],
            "ok",
        )
        return {
            "tool": proj["setup_tool"],
            "up_to_date": up_to_date,
            "layers": self._setup_layers,
        }

    async def _rpc_workspace_setup_update(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        preserve_local = bool(params.get("preserve_local", True))
        updated: list[str] = []
        preserved: list[str] = []
        diffs: list[str] = []

        for item in self._setup_layers:
            if item["status"] == "behind":
                if item["diff"]:
                    diffs.append(f"[{item['layer']}]\n{item['diff']}")
                item["current_rev"] = item["remote_rev"]
                item["status"] = "up-to-date"
                item["diff"] = ""
                updated.append(item["layer"])
            elif item["status"] == "dirty":
                if preserve_local:
                    preserved.append(item["layer"])
                else:
                    item["local_changes"] = []
                    item["status"] = "up-to-date"
                    item["diff"] = ""
                    updated.append(item["layer"])

        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            "bitbake-setup update --no-overwrite-local" if preserve_local else "bitbake-setup update",
            proj["workspace_path"],
            proj["provider"],
            "ok",
        )
        return {
            "updated_layers": updated,
            "preserved_dirty": preserved,
            "summary": tr_en(
                f"{len(updated)} katman güncellendi, {len(preserved)} yerel değişiklikli katman korundu.",
                f"Updated {len(updated)} layer(s), preserved {len(preserved)} layer(s) with local changes.",
            ),
            "diff": "\n".join(diffs) or tr_en("(Tüm katmanlar güncel)", "(All layers up-to-date)"),
        }

    async def _rpc_workspace_update_caches(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        dl_dir = str(params.get("dl_dir", proj["dl_dir"])).strip()
        sstate_dir = str(params.get("sstate_dir", proj["sstate_dir"])).strip()
        for p in (dl_dir, sstate_dir):
            val = validate_linux_workspace_path(p, proj["provider"])
            if not val["valid"]:
                raise RpcError(val["error_code"] or RpcErrorCode.NTFS_PATH_FORBIDDEN, val["reason"], val)
        proj["dl_dir"] = dl_dir
        proj["sstate_dir"] = sstate_dir
        if "hashserve" in params:
            proj["hashserve"] = params["hashserve"]
        self._local_conf = _update_conf_preserve_comments(
            self._local_conf,
            {"DL_DIR": dl_dir, "SSTATE_DIR": sstate_dir},
        )
        return proj

    async def _rpc_kas_parse(self, params: dict[str, Any]) -> dict[str, Any]:
        cfg, warnings = parse_kas_yaml(str(params.get("yaml_text", "")))
        return {"config": cfg, "warnings": warnings}

    async def _rpc_kas_serialize(self, params: dict[str, Any]) -> dict[str, Any]:
        cfg = params.get("config")
        if not isinstance(cfg, dict):
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("config nesnesi gerekli.", "config object is required."),
            )
        return {"yaml_text": serialize_kas_yaml(cfg)}

    async def _rpc_kas_run(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        action = str(params.get("action", "checkout"))
        if action not in ("lock", "checkout", "build"):
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en(f"Geçersiz kas aksiyonu: {action}", f"Invalid kas action: {action}"),
            )
        yaml_text = str(params.get("yaml_text", ""))
        filename = str(params.get("filename") or "kas-project.yml")
        cfg, _ = parse_kas_yaml(yaml_text)
        cmd = f"kas {action} {filename}"
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8], cmd, proj["workspace_path"], proj["provider"], "ok"
        )
        lock_yaml = None
        if action == "lock":
            locked_cfg = dict(cfg)
            locked_repos = {}
            for rname, rdata in (cfg.get("repos") or {}).items():
                entry = dict(rdata)
                entry["commit"] = "16a03ed6c2db2fa1d7edac4f288a74958a00eb9f"
                locked_repos[rname] = entry
            locked_cfg["repos"] = locked_repos
            lock_yaml = serialize_kas_yaml(locked_cfg)
        return {
            "ok": True,
            "action": action,
            "command": cmd,
            "output": (
                f"[kas] Running '{cmd}' (machine={cfg['machine']}, distro={cfg['distro']}, "
                f"repos={list((cfg.get('repos') or {}).keys())})\n"
                f"[kas] {action} completed cleanly."
            ),
            "lock_yaml": lock_yaml,
        }

    async def _rpc_layers_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"layers": self._localized_layers()}

    async def _rpc_layers_search(self, params: dict[str, Any]) -> dict[str, Any]:
        query = str(params.get("query", "")).strip()
        branch = str(params.get("branch", "wrynose")).strip() or "wrynose"
        kind = str(params.get("kind", "layer")).strip() or "layer"
        live = bool(params.get("live", True))
        limit = int(params.get("limit", 25))
        installed_names = {layer["name"] for layer in self._layers}

        branches = ["wrynose", "scarthgap", "blacksail", "master"]
        if live:
            branches, _ = await self._layer_index_client.get_branches()
            live_results, source = await self._layer_index_client.search(
                query=query, branch=branch, kind=kind, limit=limit
            )
            if source in ("live", "cache") and live_results:
                for item in live_results:
                    item["installed"] = item["name"] in installed_names
                return {
                    "source": source,
                    "branch": branch,
                    "branches": branches,
                    "results": live_results,
                }

        q_lower = query.lower()
        results = []
        for entry in self._layer_index:
            item = dict(entry)
            item["installed"] = entry["name"] in installed_names
            item["kind"] = "layer"
            if not q_lower or q_lower in entry["name"].lower() or q_lower in entry["summary"].lower():
                results.append(item)
        return {
            "source": "mock",
            "branch": branch,
            "branches": branches,
            "results": results,
        }

    async def _rpc_layers_add(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        if not name:
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("Katman adı gerekli.", "Layer name is required."),
            )
        if any(layer["name"] == name for layer in self._layers):
            return {"layers": self._localized_layers()}

        proj = self._active_project()
        idx_entry = next((x for x in self._layer_index if x["name"] == name), None)
        compat = idx_entry["compat"] if idx_entry else [proj["yocto_codename"]]
        is_compat = proj["yocto_codename"] in compat
        self._layers.append(
            {
                "name": name,
                "path": f"{proj['workspace_path']}/layers/{name}",
                "priority": 7,
                "branch": idx_entry["branch"] if idx_entry else proj["yocto_codename"],
                "compat": compat,
                "compatible_with_active": is_compat,
                "warning": None if is_compat else f"Uyumluluk kontrolü önerilir ({compat}).",
                "appends_count": 1,
            }
        )
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"bitbake-layers add-layer {proj['workspace_path']}/layers/{name}",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        return {"layers": self._localized_layers()}

    async def _rpc_layers_remove(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        if name == "meta":
            raise RpcError(
                RpcErrorCode.BITBAKE_ERROR,
                tr_en("Çekirdek 'meta' katmanı kaldırılamaz.", "Core 'meta' layer cannot be removed."),
            )
        self._layers = [layer for layer in self._layers if layer["name"] != name]
        proj = self._active_project()
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"bitbake-layers remove-layer {name}",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        return {"layers": self._localized_layers()}

    async def _rpc_layers_appends(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "appends": [
                {
                    "recipe": "busybox_1.37.0.bb",
                    "layer": "meta-custom-iot",
                    "append_file": "meta-custom-iot/recipes-core/busybox/busybox_%.bbappend",
                },
                {
                    "recipe": "linux-yocto_6.12.bb",
                    "layer": "meta-freescale",
                    "append_file": "meta-freescale/recipes-kernel/linux/linux-yocto_%.bbappend",
                },
                {
                    "recipe": "systemd_257.bb",
                    "layer": "meta-oe",
                    "append_file": "meta-oe/recipes-core/systemd/systemd_%.bbappend",
                },
            ]
        }

    async def _rpc_layers_overlayed(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "overlayed": [
                {
                    "recipe": "mosquitto_2.0.20.bb",
                    "active_layer": "meta-custom-iot",
                    "active_priority": 10,
                    "shadowed_layer": "meta-oe",
                    "shadowed_priority": 6,
                }
            ]
        }

    async def _rpc_layers_create(self, params: dict[str, Any]) -> dict[str, Any]:
        raw_name = str(params.get("name", "")).strip()
        if not raw_name:
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("Katman adı gerekli.", "Layer name is required."),
            )
        clean_name = raw_name if raw_name.startswith("meta-") else f"meta-{raw_name}"
        proj = self._active_project()
        priority = int(params.get("priority", 9))
        compat = [str(c) for c in (params.get("compat") or [proj["yocto_codename"]])]
        layer_path = f"{proj['workspace_path']}/layers/{clean_name}"

        if not any(layer["name"] == clean_name for layer in self._layers):
            self._layers.append(
                {
                    "name": clean_name,
                    "path": layer_path,
                    "priority": priority,
                    "branch": proj["yocto_codename"],
                    "compat": compat,
                    "compatible_with_active": proj["yocto_codename"] in compat,
                    "warning": None,
                    "appends_count": 0,
                }
            )
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"bitbake-layers create-layer --priority {priority} {layer_path}",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        layers = self._localized_layers()
        created_layer = next(x for x in layers if x["name"] == clean_name)
        return {
            "layer": created_layer,
            "files_created": [
                f"{layer_path}/conf/layer.conf",
                f"{layer_path}/README",
                f"{layer_path}/COPYING.MIT",
                f"{layer_path}/recipes-example/example/example_0.1.bb",
            ],
            "layers": layers,
        }

    async def _rpc_layers_check_compat(self, _params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        return check_layer_compatibility(self._localized_layers(), proj["yocto_codename"])

    async def _rpc_layers_fetch_from_index(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "")).strip()
        branch = str(params.get("branch", "wrynose")).strip()
        if not name:
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("Katman adı gerekli.", "Layer name is required."),
            )
        proj = self._active_project()
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"bitbake-layers layerindex-fetch --branch {branch} {name}",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        res = await self._rpc_layers_add({"name": name})
        layer = next((x for x in res["layers"] if x["name"] == name), res["layers"][-1])
        return {"layer": layer, "layers": res["layers"]}

    async def _rpc_config_get(self, _params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        doc = parse_conf(self._local_conf)
        return {
            "path": f"{proj['build_dir']}/conf/local.conf",
            "content": self._local_conf,
            "variables": doc.get_variables(),
            "comments_count": doc.comments_count,
            "directives": doc.directives,
            "multiline_keys": doc.multiline_keys,
        }

    async def _rpc_config_preview_diff(self, params: dict[str, Any]) -> dict[str, Any]:
        updates = params.get("updates")
        if not isinstance(updates, dict):
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("updates sözlüğü gerekli.", "updates dict is required."),
            )
        str_updates = {str(k): str(v) for k, v in updates.items()}
        ops = {str(k): str(v) for k, v in (params.get("operators") or {}).items()}
        remove_keys = [str(k) for k in (params.get("remove_keys") or [])]
        doc = parse_conf(self._local_conf)
        new_content = _update_conf_preserve_comments(
            self._local_conf, str_updates, operators=ops, remove_keys=remove_keys
        )
        diff = doc.unified_diff(parse_conf(new_content))
        return {"diff": diff, "new_content": new_content}

    async def _rpc_config_apply(self, params: dict[str, Any]) -> dict[str, Any]:
        updates = params.get("updates")
        if not isinstance(updates, dict):
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("updates sözlüğü gerekli.", "updates dict is required."),
            )
        str_updates = {str(k): str(v) for k, v in updates.items()}
        ops = {str(k): str(v) for k, v in (params.get("operators") or {}).items()}
        remove_keys = [str(k) for k in (params.get("remove_keys") or [])]
        self._local_conf = _update_conf_preserve_comments(
            self._local_conf, str_updates, operators=ops, remove_keys=remove_keys
        )
        doc = parse_conf(self._local_conf)
        vars_map = doc.get_variables()
        proj = self._active_project()
        if "MACHINE" in vars_map:
            proj["machine"] = vars_map["MACHINE"]
        if "DISTRO" in vars_map:
            proj["distro"] = vars_map["DISTRO"]
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            "yocto-bridge apply local.conf (AST comment-preserving)",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        return {
            "path": f"{proj['build_dir']}/conf/local.conf",
            "content": self._local_conf,
            "variables": vars_map,
            "comments_count": doc.comments_count,
            "directives": doc.directives,
            "multiline_keys": doc.multiline_keys,
        }

    async def _rpc_fragments_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"fragments": self._localized_fragments()}

    async def _rpc_fragments_toggle(self, params: dict[str, Any]) -> dict[str, Any]:
        frag_id = str(params.get("id", ""))
        enabled = bool(params.get("enabled", False))
        proj = self._active_project()
        found = False
        for frag in self._fragments:
            if frag["id"] == frag_id:
                frag["enabled"] = enabled
                found = True
        if not found:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unknown fragment: {frag_id}")
        action = "enable-fragment" if enabled else "disable-fragment"
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"bitbake-config-build {action} {frag_id}",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        return {"fragments": self._localized_fragments()}

    async def _rpc_fragments_create(self, params: dict[str, Any]) -> dict[str, Any]:
        frag_id = str(params.get("id", "")).strip()
        name = str(params.get("name", "")).strip()
        desc = str(params.get("description", "")).strip()
        category = str(params.get("category", "build")).strip()
        if not frag_id or not name:
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("Fragment kimliği ve adı gerekli.", "Fragment ID and name are required."),
            )
        if any(f["id"] == frag_id for f in self._fragments):
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en(f"Fragment zaten mevcut: {frag_id}", f"Fragment already exists: {frag_id}"),
            )
        self._fragments.append(
            {
                "id": frag_id,
                "name": name,
                "description": desc or name,
                "category": category,
                "enabled": True,
            }
        )
        proj = self._active_project()
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"bitbake-config-build enable-fragment {frag_id}",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        return {"fragments": self._localized_fragments()}

    async def _rpc_inspect_variable(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "MACHINE")).strip() or "MACHINE"
        vars_map = _extract_conf_vars(self._local_conf)
        proj = self._active_project()

        presets: dict[str, dict[str, Any]] = {
            "MACHINE": {
                "final_value": vars_map.get("MACHINE", proj["machine"]),
                "unexpanded_value": vars_map.get("MACHINE", proj["machine"]),
                "doc": "Target machine / BSP board definition.",
                "history": [
                    {
                        "file": "meta/conf/bitbake.conf",
                        "line": 102,
                        "operator": "??=",
                        "value": "qemux86-64",
                        "overridden": True,
                    },
                    {
                        "file": "conf/local.conf",
                        "line": 5,
                        "operator": "??=",
                        "value": vars_map.get("MACHINE", proj["machine"]),
                        "overridden": False,
                    },
                ],
            },
            "IMAGE_INSTALL": {
                "final_value": (
                    "packagegroup-core-boot run-postinsts "
                    + vars_map.get("IMAGE_INSTALL:append", "openssh-sftp-server htop")
                ).strip(),
                "unexpanded_value": (
                    "packagegroup-core-boot ${CORE_IMAGE_EXTRA_INSTALL}"
                ),
                "doc": "List of packages to install into the target rootfs image.",
                "history": [
                    {
                        "file": "meta/recipes-core/images/core-image-minimal.bb",
                        "line": 3,
                        "operator": "=",
                        "value": "packagegroup-core-boot ${CORE_IMAGE_EXTRA_INSTALL}",
                        "overridden": False,
                    },
                    {
                        "file": "conf/local.conf",
                        "line": 25,
                        "operator": ":append",
                        "value": " " + vars_map.get("IMAGE_INSTALL:append", "openssh-sftp-server"),
                        "overridden": False,
                    },
                ],
            },
            "PARALLEL_MAKE": {
                "final_value": vars_map.get("PARALLEL_MAKE", "-j 8"),
                "unexpanded_value": vars_map.get("PARALLEL_MAKE", "-j 8"),
                "doc": "Extra options passed to make/ninja during do_compile.",
                "history": [
                    {
                        "file": "meta/conf/bitbake.conf",
                        "line": 544,
                        "operator": "?=",
                        "value": "-j ${@oe.utils.cpu_count()}",
                        "overridden": True,
                    },
                    {
                        "file": "conf/local.conf",
                        "line": 14,
                        "operator": "?=",
                        "value": vars_map.get("PARALLEL_MAKE", "-j 8"),
                        "overridden": False,
                    },
                ],
            },
        }
        if name in presets:
            return {"name": name, **presets[name]}

        val = vars_map.get(name, "<unset>")
        return {
            "name": name,
            "final_value": val,
            "unexpanded_value": val,
            "doc": f"BitBake variable '{name}' inspected via tinfoil mock adapter.",
            "history": [
                {
                    "file": "conf/local.conf",
                    "line": 1,
                    "operator": "?=",
                    "value": val,
                    "overridden": False,
                }
            ],
        }

    async def _rpc_recipes_list(self, params: dict[str, Any]) -> dict[str, Any]:
        query = str(params.get("query", "")).strip().lower()
        items = [
            r["summary"]
            for r in self._recipes.values()
            if not query
            or query in r["summary"]["pn"].lower()
            or query in r["summary"]["summary"].lower()
        ]
        return {"recipes": items}

    async def _rpc_recipes_get(self, params: dict[str, Any]) -> dict[str, Any]:
        pn = str(params.get("pn", "")).strip()
        if pn not in self._recipes:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Recipe not found: {pn}")
        return self._recipes[pn]

    async def _rpc_recipes_save(self, params: dict[str, Any]) -> dict[str, Any]:
        pn = str(params.get("pn", "")).strip()
        content = str(params.get("content", ""))
        if pn not in self._recipes:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Recipe not found: {pn}")
        self._recipes[pn]["content"] = content
        return {"ok": True, "file_path": self._recipes[pn]["summary"]["file_path"]}

    async def _rpc_recipes_create_bbappend(self, params: dict[str, Any]) -> dict[str, Any]:
        pn = str(params.get("pn", "")).strip()
        layer = str(params.get("layer", "meta-custom-iot")).strip()
        template = str(params.get("template", "files")).strip()
        if pn not in self._recipes:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Recipe not found: {pn}")
        base_content = self._recipes[pn]["content"]
        bbappend_key = f"{pn}.bbappend"
        file_path = f"{layer}/recipes-custom/{pn}/{pn}_%.bbappend"
        content = generate_bbappend_content(pn, template)
        self._recipes[pn]["summary"]["has_bbappend"] = True
        self._recipes[bbappend_key] = {
            "summary": recipe_summary_dict(
                bbappend_key,
                self._recipes[pn]["summary"]["pv"],
                layer,
                file_path,
                f".bbappend override for {pn}",
                self._recipes[pn]["summary"]["license"],
                has_bbappend=True,
            ),
            "content": content,
        }
        return {
            "pn": bbappend_key,
            "file_path": file_path,
            "content": content,
            "base_content": base_content,
        }

    async def _rpc_devtool_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"entries": self._devtool_entries}

    async def _rpc_devtool_add(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        src_uri = str(params.get("src_uri", "")).strip()
        if not rec or not src_uri:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, "recipe ve src_uri gerekli.")
        proj = self._active_project()
        entry = {
            "recipe": rec,
            "srctree": f"{proj['build_dir']}/workspace/sources/{rec}",
            "bbappend": f"{proj['build_dir']}/workspace/appends/{rec}_git.bbappend",
            "status": "added",
        }
        self._devtool_entries = [e for e in self._devtool_entries if e["recipe"] != rec] + [entry]
        if rec not in self._recipes:
            content = generate_recipe_content(rec, "1.0.0+git", src_uri, "cmake")
            self._recipes[rec] = {
                "summary": recipe_summary_dict(
                    rec,
                    "1.0.0+git",
                    "workspace",
                    f"workspace/recipes/{rec}/{rec}_git.bb",
                    f"Added via devtool add ({src_uri})",
                    "MIT",
                ),
                "content": content,
            }
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8], f"devtool add {rec} {src_uri}", proj["build_dir"], proj["provider"], "ok"
        )
        return {
            "entry": entry,
            "entries": self._devtool_entries,
            "output": f"NOTE: Recipe {entry['srctree']} created in workspace.",
        }

    async def _rpc_devtool_modify(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        if not rec:
            raise RpcError(
                RpcErrorCode.INVALID_PARAMS,
                tr_en("recipe adı gerekli.", "recipe name is required."),
            )
        proj = self._active_project()
        entry = {
            "recipe": rec,
            "srctree": f"{proj['build_dir']}/workspace/sources/{rec}",
            "bbappend": f"{proj['build_dir']}/workspace/appends/{rec}_%.bbappend",
            "status": "modified",
        }
        self._devtool_entries = [e for e in self._devtool_entries if e["recipe"] != rec] + [entry]
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8], f"devtool modify {rec}", proj["build_dir"], proj["provider"], "ok"
        )
        return {
            "entry": entry,
            "entries": self._devtool_entries,
            "output": f"NOTE: Source tree extracted to {entry['srctree']}.",
        }

    async def _rpc_devtool_build(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        proj = self._active_project()
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8], f"devtool build {rec}", proj["build_dir"], proj["provider"], "ok"
        )
        return {
            "ok": True,
            "recipe": rec,
            "output": f"NOTE: Executing Tasks...\nNOTE: {rec} do_compile & do_install succeeded cleanly.",
        }

    async def _rpc_devtool_deploy_target(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        host = str(params.get("target_host", "192.168.1.50")).strip()
        user = str(params.get("target_user", "root")).strip() or "root"
        proj = self._active_project()
        cmd = f"devtool deploy-target {rec} {user}@{host}"
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8], cmd, proj["build_dir"], proj["provider"], "ok"
        )
        return {
            "ok": True,
            "command": cmd,
            "output": f"NOTE: Successfully deployed {rec} artifacts to {user}@{host} via SSH/SFTP.",
        }

    async def _rpc_devtool_upgrade(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        ver = str(params.get("new_version", "1.3.0")).strip()
        proj = self._active_project()
        entry = {
            "recipe": rec,
            "srctree": f"{proj['build_dir']}/workspace/sources/{rec}",
            "bbappend": f"{proj['build_dir']}/workspace/appends/{rec}_{ver}.bbappend",
            "status": "upgraded",
        }
        self._devtool_entries = [e for e in self._devtool_entries if e["recipe"] != rec] + [entry]
        if rec in self._recipes:
            self._recipes[rec]["summary"]["pv"] = ver
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"devtool upgrade -V {ver} {rec}",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        return {
            "entry": entry,
            "entries": self._devtool_entries,
            "output": f"NOTE: Upgraded {rec} to version {ver} in devtool workspace.",
        }

    async def _rpc_devtool_finish(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        layer_path = str(params.get("layer_path", "meta-custom-iot")).strip()
        proj = self._active_project()
        self._devtool_entries = [e for e in self._devtool_entries if e["recipe"] != rec]
        patch_file = f"{layer_path}/recipes-apps/{rec}/0001-yocto-studio-changes.patch"
        bbappend_file = f"{layer_path}/recipes-apps/{rec}/{rec}_%.bbappend"
        patch_diff = (
            "--- a/src/main.cpp\n"
            "+++ b/src/main.cpp\n"
            "@@ -18,3 +18,4 @@\n"
            "     init_mqtt_client();\n"
            "+    enable_watchdog_heartbeat(5000);\n"
        )
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"devtool finish {rec} {layer_path}",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        return {
            "ok": True,
            "patch_file": patch_file,
            "bbappend_file": bbappend_file,
            "patch_diff": patch_diff,
            "entries": self._devtool_entries,
        }

    async def _rpc_devtool_reset(self, params: dict[str, Any]) -> dict[str, Any]:
        rec = str(params.get("recipe", "")).strip()
        proj = self._active_project()
        self._devtool_entries = [e for e in self._devtool_entries if e["recipe"] != rec]
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8], f"devtool reset {rec}", proj["build_dir"], proj["provider"], "ok"
        )
        return {"ok": True, "entries": self._devtool_entries}

    async def _rpc_recipetool_create(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name", "custom-app")).strip()
        version = str(params.get("version", "1.0.0")).strip() or "1.0.0"
        src_uri = str(params.get("src_uri", "git://github.com/example/app.git;branch=main")).strip()
        bs = str(params.get("build_system", "cmake")).strip()
        lic = str(params.get("license", "MIT")).strip() or "MIT"
        summary = str(params.get("summary", "")).strip()
        content = generate_recipe_content(name, version, src_uri, bs, lic, summary)
        file_path = f"meta-custom-iot/recipes-apps/{name}/{name}_{version}.bb"
        rec_summary = recipe_summary_dict(
            name, version, "meta-custom-iot", file_path, summary or f"{name} ({bs})", lic, False
        )
        self._recipes[name] = {"summary": rec_summary, "content": content}
        proj = self._active_project()
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"recipetool create -o {file_path} {src_uri}",
            proj["build_dir"],
            proj["provider"],
            "ok",
        )
        return {
            "pn": name,
            "file_path": file_path,
            "content": content,
            "recipe": rec_summary,
        }

    async def _rpc_build_start(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._build.status == "running" and self._build_task and not self._build_task.done():
            raise RpcError(
                RpcErrorCode.BUILD_ALREADY_RUNNING,
                tr_en(
                    "Halihazırda çalışan bir BitBake derlemesi var.",
                    "A BitBake build is already running.",
                ),
            )

        proj = self._active_project()
        target = str(params.get("target") or "core-image-minimal")
        machine = str(params.get("machine") or proj["machine"])
        distro = str(params.get("distro") or proj["distro"])
        simulate_failure = bool(params.get("simulate_failure", False))
        tick_ms = max(5, min(2000, int(params.get("tick_ms", 90))))

        build_id = f"bld-{uuid.uuid4().hex[:8]}"
        self._cancel_requested = False
        self._build = MockBuildState(
            build_id=build_id,
            target=target,
            machine=machine,
            distro=distro,
            status="running",
            total_tasks=len(BUILD_TASK_SCRIPT),
            completed_tasks=0,
            sstate_hits=0,
            sstate_misses=0,
            started_at=time.time(),
            elapsed_ms=0.0,
            active_tasks={},
            failed_task=None,
            task_logs={},
        )

        await self._monitor.emit_command(
            str(uuid.uuid4())[:8],
            f"bitbake {target}",
            proj["build_dir"],
            proj["provider"],
            "running",
        )
        self._build_task = asyncio.create_task(
            self._run_mock_build(build_id, target, machine, distro, simulate_failure, tick_ms)
        )
        return {"build_id": build_id, "status": "running", "target": target}

    async def _run_mock_build(
        self,
        build_id: str,
        target: str,
        machine: str,
        distro: str,
        simulate_failure: bool,
        tick_ms: int,
    ) -> None:
        proj = self._active_project()
        await self._monitor.emit(
            "build.started",
            {
                "build_id": build_id,
                "target": target,
                "machine": machine,
                "distro": distro,
                "total_tasks": len(BUILD_TASK_SCRIPT),
                "ts": time.time(),
            },
        )
        await self._monitor.emit_log(
            build_id,
            "NOTE",
            f"Loading cache: 100% | Target={target} MACHINE={machine} DISTRO={distro}",
        )
        await self._monitor.emit_log(
            build_id,
            "NOTE",
            f"Initialising tasks: {len(BUILD_TASK_SCRIPT)} tasks (tinfoil + XML-RPC stream)",
        )

        queue: list[tuple[str, str, bool]] = list(BUILD_TASK_SCRIPT)
        max_workers = 4
        fail_triggered = False

        async def worker(slot: int) -> None:
            nonlocal fail_triggered
            while queue and not self._cancel_requested and not fail_triggered:
                recipe, task, is_sstate = queue.pop(0)
                task_id = f"{recipe}:{task}"
                t_start = time.time()

                self._build.active_tasks[slot] = {
                    "task_id": task_id,
                    "recipe": recipe,
                    "task": task,
                    "worker_slot": slot,
                    "progress": 0,
                    "status": "running",
                    "started_at": t_start,
                }

                await self._monitor.emit(
                    "build.task_started",
                    {
                        "build_id": build_id,
                        "task_id": task_id,
                        "recipe": recipe,
                        "task": task,
                        "worker_slot": slot,
                        "from_sstate": is_sstate,
                        "ts": t_start,
                    },
                )

                if is_sstate:
                    await asyncio.sleep(tick_ms / 1000.0)
                    if self._cancel_requested:
                        return
                    self._build.sstate_hits += 1
                    self._build.completed_tasks += 1
                    dur = round((time.time() - t_start) * 1000.0, 1)
                    self._build.active_tasks.pop(slot, None)
                    await self._monitor.emit_log(
                        build_id,
                        "NOTE",
                        f"Running setscene task ({recipe}:{task}) — sstate cache HIT",
                        recipe,
                        task,
                    )
                    await self._monitor.emit(
                        "build.task_succeeded",
                        {
                            "build_id": build_id,
                            "task_id": task_id,
                            "recipe": recipe,
                            "task": task,
                            "worker_slot": slot,
                            "from_sstate": True,
                            "duration_ms": dur,
                            "completed_tasks": self._build.completed_tasks,
                            "total_tasks": self._build.total_tasks,
                            "sstate_hits": self._build.sstate_hits,
                            "sstate_misses": self._build.sstate_misses,
                            "ts": time.time(),
                        },
                    )
                    continue

                steps = 4
                for step in range(1, steps + 1):
                    if self._cancel_requested or fail_triggered:
                        self._build.active_tasks.pop(slot, None)
                        return
                    await asyncio.sleep(tick_ms / 1000.0)
                    pct = int((step / steps) * 100)
                    if slot in self._build.active_tasks:
                        self._build.active_tasks[slot]["progress"] = pct
                    await self._monitor.emit(
                        "build.task_progress",
                        {
                            "build_id": build_id,
                            "task_id": task_id,
                            "recipe": recipe,
                            "task": task,
                            "worker_slot": slot,
                            "progress": pct,
                            "ts": time.time(),
                        },
                    )
                    if (
                        simulate_failure
                        and recipe == "my-sensor-daemon"
                        and task == "do_compile"
                        and step == 3
                    ):
                        fail_triggered = True
                        log_path = (
                            f"{proj['build_dir']}/tmp/work/armv8a-poky-linux/"
                            "my-sensor-daemon/1.2.0/temp/log.do_compile"
                        )
                        run_path = (
                            f"{proj['build_dir']}/tmp/work/armv8a-poky-linux/"
                            "my-sensor-daemon/1.2.0/temp/run.do_compile"
                        )
                        log_content = (
                            "DEBUG: Executing shell function do_compile\n"
                            "NOTE: make -j 8\n"
                            "[ 62%] Building CXX object CMakeFiles/sensor-daemon.dir/src/mqtt_client.cpp.o\n"
                            "src/mqtt_client.cpp:142:18: error: 'mosquitto_lib_version' "
                            "was not declared in this scope\n"
                            "  142 |     int rc = mosquitto_lib_version(&major, &minor, &rev);\n"
                            "      |              ^~~~~~~~~~~~~~~~~~~~~\n"
                            "src/mqtt_client.cpp:142:18: note: suggested alternative: 'mosquitto_connect_v5'\n"
                            "ninja: build stopped: subcommand failed.\n"
                            "ERROR: Task (my-sensor-daemon:do_compile) failed with exit code '1'\n"
                        )
                        run_content = (
                            "#!/bin/bash\n"
                            "set -e\n"
                            "do_compile() {\n"
                            "    cmake_runcmake_build --target all\n"
                            "}\n"
                            "do_compile\n"
                        )
                        self._build.task_logs[task_id] = (
                            log_path,
                            run_path,
                            log_content,
                            run_content,
                        )
                        err_summary = (
                            "src/mqtt_client.cpp:142:18: error: 'mosquitto_lib_version' "
                            "was not declared in this scope"
                        )
                        self._build.failed_task = {
                            "recipe": recipe,
                            "task": task,
                            "exit_code": 1,
                            "error_summary": err_summary,
                            "log_path": log_path,
                            "run_path": run_path,
                        }
                        self._build.active_tasks.pop(slot, None)
                        await self._monitor.emit_log(
                            build_id, "ERROR", err_summary, recipe, task
                        )
                        await self._monitor.emit(
                            "build.task_failed",
                            {
                                "build_id": build_id,
                                "task_id": task_id,
                                "recipe": recipe,
                                "task": task,
                                "worker_slot": slot,
                                "exit_code": 1,
                                "error_summary": err_summary,
                                "log_path": log_path,
                                "run_path": run_path,
                                "ts": time.time(),
                            },
                        )
                        return

                self._build.sstate_misses += 1
                self._build.completed_tasks += 1
                dur = round((time.time() - t_start) * 1000.0, 1)
                self._build.active_tasks.pop(slot, None)
                await self._monitor.emit_log(
                    build_id,
                    "NOTE",
                    f"Recipe {recipe}:{task} succeeded in {dur:.0f} ms",
                    recipe,
                    task,
                )
                await self._monitor.emit(
                    "build.task_succeeded",
                    {
                        "build_id": build_id,
                        "task_id": task_id,
                        "recipe": recipe,
                        "task": task,
                        "worker_slot": slot,
                        "from_sstate": False,
                        "duration_ms": dur,
                        "completed_tasks": self._build.completed_tasks,
                        "total_tasks": self._build.total_tasks,
                        "sstate_hits": self._build.sstate_hits,
                        "sstate_misses": self._build.sstate_misses,
                        "ts": time.time(),
                    },
                )

        try:
            workers = [asyncio.create_task(worker(slot)) for slot in range(max_workers)]
            await asyncio.gather(*workers)
        except asyncio.CancelledError:
            self._cancel_requested = True

        self._build.active_tasks.clear()
        self._build.elapsed_ms = round((time.time() - self._build.started_at) * 1000.0, 1)

        if self._cancel_requested:
            final_status = "cancelled"
        elif fail_triggered:
            final_status = "failed"
        else:
            final_status = "succeeded"

        self._build.status = final_status
        await self._monitor.emit_log(
            build_id,
            "ERROR" if final_status == "failed" else "NOTE",
            f"Build {build_id} finished with status={final_status} "
            f"({self._build.completed_tasks}/{self._build.total_tasks} tasks)",
        )
        await self._monitor.emit(
            "build.completed",
            {
                "build_id": build_id,
                "target": target,
                "status": final_status,
                "completed_tasks": self._build.completed_tasks,
                "total_tasks": self._build.total_tasks,
                "sstate_hits": self._build.sstate_hits,
                "sstate_misses": self._build.sstate_misses,
                "duration_ms": self._build.elapsed_ms,
                "ts": time.time(),
            },
        )

    async def _rpc_build_cancel(self, params: dict[str, Any]) -> dict[str, Any]:
        if self._build.status != "running" or self._build_task is None:
            return {
                "ok": True,
                "build_id": self._build.build_id,
                "status": self._build.status,
            }

        self._cancel_requested = True
        if self._build.build_id:
            await self._monitor.emit_log(
                self._build.build_id,
                "WARNING",
                "Sending SIGINT to BitBake server — waiting for active tasks to exit cleanly...",
            )
        if bool(params.get("force", False)) and not self._build_task.done():
            self._build_task.cancel()
        await asyncio.gather(self._build_task, return_exceptions=True)
        return {
            "ok": True,
            "build_id": self._build.build_id,
            "status": self._build.status,
        }

    async def _rpc_build_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        elapsed = (
            round((time.time() - self._build.started_at) * 1000.0, 1)
            if self._build.status == "running" and self._build.started_at > 0
            else self._build.elapsed_ms
        )
        return {
            "build_id": self._build.build_id,
            "target": self._build.target,
            "machine": self._build.machine,
            "distro": self._build.distro,
            "status": self._build.status,
            "total_tasks": self._build.total_tasks,
            "completed_tasks": self._build.completed_tasks,
            "sstate_hits": self._build.sstate_hits,
            "sstate_misses": self._build.sstate_misses,
            "elapsed_ms": elapsed,
            "active_tasks": list(self._build.active_tasks.values()),
            "failed_task": self._build.failed_task,
        }

    async def _rpc_build_task_log(self, params: dict[str, Any]) -> dict[str, Any]:
        recipe = str(params.get("recipe", "")).strip()
        task = str(params.get("task", "")).strip()
        key = f"{recipe}:{task}"
        if key in self._build.task_logs:
            log_path, run_path, log_content, run_content = self._build.task_logs[key]
            return {
                "recipe": recipe,
                "task": task,
                "log_path": log_path,
                "run_path": run_path,
                "log_content": log_content,
                "run_content": run_content,
            }
        return {
            "recipe": recipe,
            "task": task,
            "log_path": f"/home/yocto/build/tmp/work/.../{recipe}/temp/log.{task}",
            "run_path": f"/home/yocto/build/tmp/work/.../{recipe}/temp/run.{task}",
            "log_content": f"DEBUG: Executing shell function {task}\nNOTE: Completed successfully.\n",
            "run_content": f"#!/bin/bash\nset -e\n{task}() {{\n  :\n}}\n{task}\n",
        }

    async def _rpc_build_task_action(self, params: dict[str, Any]) -> dict[str, Any]:
        recipe = str(params.get("recipe", "virtual/kernel")).strip() or "virtual/kernel"
        action = str(params.get("action", "compile")).strip()
        proj = self._active_project()
        cmd = f"bitbake {recipe} -c {action}"
        await self._monitor.emit_command(
            str(uuid.uuid4())[:8], cmd, proj["build_dir"], proj["provider"], "ok"
        )
        pty_id: str | None = None
        if action in ("menuconfig", "devshell", "diffconfig"):
            opened = await self._rpc_pty_open({"kind": action, "recipe": recipe})
            pty_id = opened["session_id"]
        return {
            "ok": True,
            "command": cmd,
            "output": tr_en(f"NOTE: {cmd} tamamlandı.", f"NOTE: {cmd} completed."),
            "pty_session_id": pty_id,
        }

    def _build_mock_dot_source(self, target: str) -> str:
        return "\n".join(
            [
                "digraph depends {",
                f'"{target}.do_build" -> "{target}.do_rootfs"',
                f'"{target}.do_build" -> "linux-yocto.do_deploy"',
                f'"{target}.do_build" -> "u-boot-imx.do_deploy"',
                f'"{target}.do_rootfs" -> "systemd.do_package_write_rpm"',
                f'"{target}.do_rootfs" -> "busybox.do_package_write_rpm"',
                f'"{target}.do_rootfs" -> "my-sensor-daemon.do_package_write_rpm"',
                '"linux-yocto.do_deploy" -> "gcc-cross-aarch64.do_populate_sysroot"',
                '"u-boot-imx.do_deploy" -> "gcc-cross-aarch64.do_populate_sysroot"',
                '"systemd.do_package_write_rpm" -> "glibc.do_populate_sysroot"',
                '"busybox.do_package_write_rpm" -> "glibc.do_populate_sysroot"',
                '"my-sensor-daemon.do_package_write_rpm" -> "mosquitto.do_populate_sysroot"',
                '"my-sensor-daemon.do_package_write_rpm" -> "libgpiod.do_populate_sysroot"',
                '"mosquitto.do_populate_sysroot" -> "openssl.do_populate_sysroot"',
                '"libgpiod.do_populate_sysroot" -> "glibc.do_populate_sysroot"',
                '"openssl.do_populate_sysroot" -> "glibc.do_populate_sysroot"',
                '"glibc.do_populate_sysroot" -> "gcc-cross-aarch64.do_populate_sysroot"',
                "}",
            ]
        )

    async def _rpc_dag_generate(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        raw_dot = params.get("raw_dot")
        dot_src = str(raw_dot) if raw_dot else self._build_mock_dot_source(target)
        graph = parse_task_depends_dot(dot_src)
        return slice_graph_for_ui(
            graph,
            target=target,
            query=str(params.get("query", "")),
            kind=str(params.get("kind", "")),
            focus_recipe=str(params.get("focus_recipe", "")),
            max_nodes=int(params.get("max_nodes", 120)),
        )

    async def _rpc_dag_explain_why(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        package = str(params.get("package") or "openssl")
        graph = parse_task_depends_dot(self._build_mock_dot_source(target))
        return explain_why_included(graph, target, package)

    async def _rpc_artifacts_images(self, _params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        deploy_dir = f"{proj['build_dir']}/tmp/deploy/images/{proj['machine']}"
        return {
            "machine": proj["machine"],
            "deploy_dir": deploy_dir,
            "images": [
                {
                    "filename": f"core-image-minimal-{proj['machine']}.rootfs.wic.bz2",
                    "path": f"{deploy_dir}/core-image-minimal-{proj['machine']}.rootfs.wic.bz2",
                    "kind": "wic",
                    "size_bytes": 148_392_448,
                    "modified_at": "2026-11-25 09:12:04",
                    "sha256_short": "8f2a9c1b",
                },
                {
                    "filename": "Image-6.12.19-yocto-standard",
                    "path": f"{deploy_dir}/Image-6.12.19-yocto-standard",
                    "kind": "kernel",
                    "size_bytes": 34_816_000,
                    "modified_at": "2026-11-25 09:08:51",
                    "sha256_short": "3e71d044",
                },
                {
                    "filename": f"{proj['machine']}.dtb",
                    "path": f"{deploy_dir}/{proj['machine']}.dtb",
                    "kind": "dtb",
                    "size_bytes": 92_416,
                    "modified_at": "2026-11-25 09:08:52",
                    "sha256_short": "a11b5590",
                },
                {
                    "filename": f"u-boot-{proj['machine']}.bin",
                    "path": f"{deploy_dir}/u-boot-{proj['machine']}.bin",
                    "kind": "bootloader",
                    "size_bytes": 1_245_184,
                    "modified_at": "2026-11-25 09:06:10",
                    "sha256_short": "d4429e02",
                },
                {
                    "filename": f"core-image-minimal-{proj['machine']}.spdx.json",
                    "path": f"{deploy_dir}/core-image-minimal-{proj['machine']}.spdx.json",
                    "kind": "spdx",
                    "size_bytes": 4_912_300,
                    "modified_at": "2026-11-25 09:12:09",
                    "sha256_short": "c910f318",
                },
            ],
        }

    async def _rpc_artifacts_sbom(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "format": "SPDX 3.0 JSON-LD",
            "packages": [
                {
                    "name": "linux-yocto",
                    "version": "6.12.19",
                    "purl": "pkg:yocto/openembedded-core/linux-yocto@6.12.19",
                    "license": "GPL-2.0-only",
                    "supplier": "Yocto Project",
                    "gplv3_flag": False,
                },
                {
                    "name": "systemd",
                    "version": "257.4",
                    "purl": "pkg:yocto/openembedded-core/systemd@257.4",
                    "license": "GPL-2.0-only & LGPL-2.1-or-later",
                    "supplier": "OpenEmbedded",
                    "gplv3_flag": False,
                },
                {
                    "name": "bash",
                    "version": "5.2.37",
                    "purl": "pkg:yocto/openembedded-core/bash@5.2.37",
                    "license": "GPL-3.0-or-later",
                    "supplier": "GNU",
                    "gplv3_flag": True,
                },
                {
                    "name": "openssl",
                    "version": "3.5.0",
                    "purl": "pkg:yocto/openembedded-core/openssl@3.5.0",
                    "license": "Apache-2.0",
                    "supplier": "OpenSSL",
                    "gplv3_flag": False,
                },
                {
                    "name": "my-sensor-daemon",
                    "version": "1.2.0",
                    "purl": "pkg:yocto/meta-custom-iot/my-sensor-daemon@1.2.0",
                    "license": "Apache-2.0",
                    "supplier": "Internal Engineering",
                    "gplv3_flag": False,
                },
            ],
        }

    async def _rpc_artifacts_cves(self, params: dict[str, Any]) -> dict[str, Any]:
        fmt = str(params.get("format", "sbom-cve-check"))
        if fmt == "cve-check":
            scarthgap_sample = {
                "version": "1",
                "package": [
                    {
                        "name": "mosquitto",
                        "version": "2.0.20",
                        "issue": [
                            {
                                "id": "CVE-2025-41203",
                                "status": "Unpatched",
                                "scorev3": "7.5",
                                "vector": "NETWORK",
                                "summary": "MQTT v5 packet property parser heap out-of-bounds read.",
                            }
                        ],
                    },
                    {
                        "name": "openssl",
                        "version": "3.2.4",
                        "issue": [
                            {
                                "id": "CVE-2025-29911",
                                "status": "Patched",
                                "scorev3": "5.3",
                                "vector": "NETWORK",
                                "summary": "X.509 policy verification timing side-channel.",
                            }
                        ],
                    },
                ],
            }
            return parse_cve_report(scarthgap_sample)

        wrynose_sample = {
            "tool": "sbom-cve-check (Yocto 6.0 Wrynose)",
            "findings": [
                {
                    "cve_id": "CVE-2025-41203",
                    "package": "mosquitto",
                    "version": "2.0.20",
                    "severity": "HIGH",
                    "cvss": 7.5,
                    "status": "Unpatched",
                    "vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H",
                    "summary": "MQTT v5 packet property parser heap out-of-bounds read.",
                },
                {
                    "cve_id": "CVE-2025-29911",
                    "package": "openssl",
                    "version": "3.5.0",
                    "severity": "MEDIUM",
                    "cvss": 5.3,
                    "status": "Patched",
                    "vector": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N",
                    "summary": "X.509 policy verification timing side-channel (patched in OE-Core).",
                },
                {
                    "cve_id": "CVE-2024-56321",
                    "package": "busybox",
                    "version": "1.37.0",
                    "severity": "LOW",
                    "cvss": 3.3,
                    "status": "Ignored",
                    "vector": "CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N",
                    "summary": "httpd applet CGI query handling (applet disabled in defconfig).",
                },
            ],
        }
        return parse_cve_report(wrynose_sample)

    async def _rpc_artifacts_export_licenses(self, params: dict[str, Any]) -> dict[str, Any]:
        fmt = str(params.get("format", "csv")).lower()
        sbom = await self._rpc_artifacts_sbom({})
        spdx_sample = {
            "@context": "https://spdx.org/rdf/3.0.1/spdx-context.jsonld",
            "@graph": [
                {
                    "type": "software_Package",
                    "spdxId": f"spdx:{pkg['name']}",
                    "name": pkg["name"],
                    "software_packageVersion": pkg["version"],
                    "software_concludedLicense": pkg["license"],
                    "software_packageUrl": pkg["purl"],
                }
                for pkg in sbom["packages"]
            ],
        }
        parsed_pkgs = parse_spdx3_jsonld(spdx_sample)
        content = export_license_matrix(parsed_pkgs, fmt)
        ext = "md" if fmt == "markdown" else ("json" if fmt == "json" else "csv")
        return {
            "format": fmt,
            "filename": f"yocto-licenses-matrix.{ext}",
            "content": content,
            "package_count": len(parsed_pkgs),
        }

    async def _rpc_artifacts_copy_to_host(self, params: dict[str, Any]) -> dict[str, Any]:
        source_path = str(params.get("source_path", "")).strip()
        dest_dir = str(params.get("dest_dir") or "~/Downloads/yocto-artifacts").strip()
        if not source_path:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, "source_path is required")
        filename = Path(source_path).name
        dest_path = str(Path(dest_dir) / filename)
        if Path(source_path).exists() and Path(source_path).is_file():
            Path(dest_dir).mkdir(parents=True, exist_ok=True)
            shutil.copy2(source_path, dest_path)
            copied = Path(dest_path).stat().st_size
        else:
            copied = 148_392_448
        return {
            "ok": True,
            "source_path": source_path,
            "dest_path": dest_path,
            "bytes_copied": copied,
            "command": f"cp \"{source_path}\" \"{dest_path}\"",
        }

    async def _rpc_artifacts_buildhistory(self, params: dict[str, Any]) -> dict[str, Any]:
        from_b = str(params.get("from_build") or "#14 (2026-11-24)")
        to_b = str(params.get("to_build") or "#15 (2026-11-25)")
        diff_text = params.get("diff_text")
        if isinstance(diff_text, str) and diff_text.strip():
            return parse_buildhistory_diff(diff_text, from_build=from_b, to_build=to_b)

        sample_diff = (
            "images/imx8mp_lpddr4_evk/glibc/core-image-minimal: IMAGESIZE: 132370 -> 134210\n"
            "M my-sensor-daemon: 1.1.4 -> 1.2.0 (+420 KB)\n"
            "M linux-yocto: 6.12.17 -> 6.12.19 (+1120 KB)\n"
            "+ htop (3.4.0)\n"
        )
        parsed = parse_buildhistory_diff(sample_diff, from_build=from_b, to_build=to_b)
        for entry in parsed["entries"]:
            if entry["package"] == "htop":
                entry["size_delta_kb"] = 300
        return parsed

    async def _rpc_wic_list_wks(self, _params: dict[str, Any]) -> dict[str, Any]:
        en_map = {
            "meta-freescale/wic/imx-imx-boot-bootpart.wks": (
                "NXP i.MX8MP GPT dual partition (U-Boot SPL + FAT32 boot + ext4 rootfs)"
            ),
            "meta/scripts/lib/wic/canned-wks/qemux86-directdisk.wks": (
                "QEMU x86_64 EFI + ext4 rootfs layout"
            ),
        }
        return {
            "files": [
                {
                    "name": v["name"],
                    "path": path,
                    "layer": v["layer"],
                    "description": (
                        tr_en(v["description"], en_map[path])
                        if path in en_map
                        else (
                            tr_en(v["description"], "User-edited .wks partition layout")
                            if v["description"] == "Kullanıcı tarafından düzenlenmiş .wks bölümü"
                            else v["description"]
                        )
                    ),
                }
                for path, v in self._wks_files.items()
            ]
        }

    async def _rpc_wic_parse_wks(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or next(iter(self._wks_files)))
        raw = params.get("content")
        if isinstance(raw, str) and raw.strip():
            return parse_wks(raw, path=path)
        if path in self._wks_files:
            return parse_wks(self._wks_files[path]["content"], path=path)
        if Path(path).exists():
            return parse_wks(Path(path).read_text(encoding="utf-8"), path=path)
        raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unknown WKS file: {path}")

    async def _rpc_wic_serialize_wks(self, params: dict[str, Any]) -> dict[str, Any]:
        wks = params.get("wks") or {}
        raw_text = serialize_wks(wks)
        save_path = str(params.get("save_path") or "").strip()
        saved = False
        if save_path:
            if save_path in self._wks_files:
                self._wks_files[save_path]["content"] = raw_text
            else:
                self._wks_files[save_path] = {
                    "name": Path(save_path).name,
                    "layer": "meta-custom-iot",
                    "description": tr_en(
                        "Kullanıcı tarafından düzenlenmiş .wks bölümü",
                        "User-edited .wks partition layout",
                    ),
                    "content": raw_text,
                }
            saved = True
        return {"raw_text": raw_text, "saved": saved, "path": save_path or None}

    async def _rpc_wic_create_image(self, params: dict[str, Any]) -> dict[str, Any]:
        wks_path = str(params.get("wks_path") or "meta-freescale/wic/imx-imx-boot-bootpart.wks")
        image_name = str(params.get("image_name") or "core-image-minimal")
        proj = self._active_project()
        if params.get("wks_content"):
            _ = parse_wks(str(params["wks_content"]), path=wks_path)
        outdir = str(params.get("outdir") or f"{proj['build_dir']}/tmp/deploy/images/{proj['machine']}")
        out_img = f"{outdir}/{image_name}-{proj['machine']}.wic.bz2"
        cmd = f"wic create {wks_path} -e {image_name} -o {outdir}"
        await self._monitor.emit_command(uuid.uuid4().hex[:8], cmd, proj["build_dir"], "mock", "ok")
        log = (
            f"INFO: Creating image(s) from kickstart file {wks_path}\n"
            f"INFO: Building partition table (GPT) for {proj['machine']}...\n"
            "INFO: Copying bootimg-partition (/boot, 128M vfat)...\n"
            "INFO: Populating rootfs (/, 2048M ext4)...\n"
            f"INFO: Created WIC image: {out_img} (149.1 MB compressed)\n"
        )
        return {
            "ok": True,
            "command": cmd,
            "output_image": out_img,
            "size_bytes": 156_340_224,
            "log": log,
        }

    async def _rpc_qemu_launch(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        machine = str(params.get("machine") or proj["machine"])
        image = str(params.get("image") or "core-image-minimal")
        mode = str(params.get("mode") or "nographic")
        memory_mb = int(params.get("memory_mb") or 1024)
        extra_args = str(params.get("extra_args") or "").strip()

        qparams = f'-m {memory_mb} {extra_args}'.strip()
        mode_flag = "nographic" if mode == "nographic" else ("slirp" if mode == "slirp" else "vnc=0.0.0.0:1")
        cmd = f"runqemu {machine} {image} {mode_flag} qemuparams=\"{qparams}\""
        pty_res = await self._rpc_pty_open({"kind": "runqemu", "recipe": f"{machine}:{image}"})
        session_id = f"qemu-{uuid.uuid4().hex[:8]}"
        ssh_forward = "ssh -p 2222 root@127.0.0.1" if mode in {"slirp", "nographic"} else None
        self._qemu_sessions[session_id] = {
            "machine": machine,
            "image": image,
            "mode": mode,
            "pty_session_id": pty_res["session_id"],
            "status": "running",
        }
        await self._monitor.emit_command(session_id, cmd, proj["build_dir"], "mock", "running")
        return {
            "ok": True,
            "session_id": session_id,
            "pty_session_id": pty_res["session_id"],
            "command": cmd,
            "mode": mode,
            "ssh_forward": ssh_forward,
            "status": "running",
        }

    async def _rpc_qemu_stop(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id") or "")
        sess = self._qemu_sessions.pop(session_id, None)
        if sess and sess.get("pty_session_id") in self._pty_sessions:
            await self._rpc_pty_close({"session_id": sess["pty_session_id"]})
        return {"ok": True, "session_id": session_id}

    async def _rpc_sdk_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {"sdks": list(self._sdks)}

    async def _rpc_sdk_build(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        target = str(params.get("target") or "core-image-minimal")
        kind = str(params.get("kind") or "standard-sdk")
        task = "populate_sdk_ext" if kind == "esdk" else "populate_sdk"
        cmd = f"bitbake {target} -c {task}"
        ext_tag = "ext-sdk" if kind == "esdk" else "toolchain"
        filename = f"poky-glibc-x86_64-{target}-armv8a-{proj['machine']}-{ext_tag}-6.0.sh"
        path = f"{proj['build_dir']}/tmp/deploy/sdk/{filename}"
        new_sdk = {
            "name": filename,
            "kind": "esdk" if kind == "esdk" else "standard-sdk",
            "machine": proj["machine"],
            "filename": filename,
            "path": path,
            "size_bytes": 1_284_505_600 if kind == "esdk" else 492_830_720,
            "built_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "sysroot_arch": "aarch64-poky-linux",
        }
        self._sdks = [s for s in self._sdks if s["filename"] != filename]
        self._sdks.insert(0, new_sdk)
        await self._monitor.emit_command(uuid.uuid4().hex[:8], cmd, proj["build_dir"], "mock", "ok")
        log = (
            f"NOTE: Executing {cmd}\n"
            f"NOTE: Tasks Summary: Attempted 3842 tasks of which 3810 didn't need to be rerun and all succeeded.\n"
            f"SDK installer generated at: {path}\n"
            f"Usage: sh {path} -d ~/yocto-sdk/{proj['machine']}\n"
        )
        return {"ok": True, "command": cmd, "sdk": new_sdk, "log": log}

    def _render_menuconfig(self, recipe: str, cursor: int, flags: dict[str, str]) -> str:
        items = [
            ("CONFIG_CAN_FLEXCAN", "NXP FlexCAN CAN-bus controller driver"),
            ("CONFIG_NETFILTER_XTABLES", "Netfilter Xtables packet filtering support"),
            ("CONFIG_BLK_DEV_NVME", "NVM Express block device"),
            ("CONFIG_DRM_IMX8MP", "Freescale i.MX8MP DRM/LCDIF display"),
            ("CONFIG_SECURITY_APPARMOR", "AppArmor security module"),
        ]
        lines = [
            "\x1b[2J\x1b[H",
            f"\x1b[1;36m=== Yocto Studio Linux Kernel / BusyBox menuconfig ({recipe}) ===\x1b[0m",
            tr_en(
                "Gezinme: [j/k veya Ok]  Değiştir: [Space/y/n/m]  Kaydet & Çık: [q]",
                "Navigate: [j/k or Arrows]  Toggle: [Space/y/n/m]  Save & Exit: [q]",
            ),
            "-" * 74,
        ]
        for idx, (cfg, desc) in enumerate(items):
            mark = "\x1b[1;33m>\x1b[0m" if idx == cursor else " "
            val = flags.get(cfg, "y")
            lines.append(f" {mark} [{val}] {cfg:<26} ({desc})")
        lines.append("-" * 74)
        return "\r\n".join(lines) + "\r\n"

    async def _rpc_pty_open(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = f"pty-{uuid.uuid4().hex[:8]}"
        proj = self._active_project()
        kind = str(params.get("kind", "shell"))
        recipe = str(params.get("recipe", "virtual/kernel"))
        prompt = f"yocto@{proj['yocto_codename']}:{proj['build_dir']}$ "
        title = f"{kind}:{recipe}" if kind != "shell" else f"sh:{proj['name']}"
        flags = {
            "CONFIG_CAN_FLEXCAN": "y",
            "CONFIG_NETFILTER_XTABLES": "m",
            "CONFIG_BLK_DEV_NVME": "y",
            "CONFIG_DRM_IMX8MP": "y",
            "CONFIG_SECURITY_APPARMOR": "n",
        }
        self._pty_sessions[session_id] = {
            "cwd": proj["build_dir"],
            "prompt": prompt,
            "kind": kind,
            "recipe": recipe,
            "line_buf": "",
            "cursor": 0,
            "flags": flags,
        }

        if kind == "menuconfig":
            banner = self._render_menuconfig(recipe, 0, flags)
        elif kind == "diffconfig":
            saved_msg = tr_en("Fragment kaydedildi", "Fragment saved")
            banner = (
                f"\r\n\x1b[1;36m[bitbake {recipe} -c diffconfig]\x1b[0m\r\n"
                "\x1b[32m+CONFIG_CAN_FLEXCAN=y\x1b[0m\r\n"
                "\x1b[32m+CONFIG_NETFILTER_XTABLES=m\x1b[0m\r\n"
                f"{saved_msg}: {proj['build_dir']}/tmp/work/.../{recipe}/fragment.cfg\r\n"
                f"{prompt}"
            )
        elif kind == "devshell":
            src_dir = f"{proj['build_dir']}/workspace/sources/{recipe}"
            self._pty_sessions[session_id]["cwd"] = src_dir
            prompt = f"[devshell {recipe}]:{src_dir}$ "
            self._pty_sessions[session_id]["prompt"] = prompt
            banner = (
                f"\r\n\x1b[1;36m[BitBake devshell — {recipe}]\x1b[0m\r\n"
                f"CC=aarch64-poky-linux-gcc | S={src_dir}\r\n"
                f"{prompt}"
            )
        elif kind == "runqemu":
            prompt = f"root@{proj['machine']}:~# "
            self._pty_sessions[session_id]["prompt"] = prompt
            cmd_lbl = tr_en("Komutlar", "Commands")
            banner = (
                f"\r\n\x1b[1;32m[QEMU Serial Console — {recipe}]\x1b[0m\r\n"
                "[    0.000000] Booting Linux on physical CPU 0x0000000000 [0x410fd034]\r\n"
                "[    0.412890] Linux version 6.12.19-yocto-standard (oe-user@oe-host)\r\n"
                "[    1.843210] systemd[1]: Reached target Multi-User System.\r\n"
                f"Poky (Yocto Project Reference Distro) {proj['yocto_version']} ({proj['yocto_codename']}) "
                f"{proj['machine']} ttyAMA0\r\n"
                f"SSH Forward: ssh -p 2222 root@127.0.0.1 | {cmd_lbl}: uname -a, ip addr, df -h, poweroff\r\n"
                f"{prompt}"
            )
        else:
            conn_lbl = tr_en("Bağlı", "Connected")
            cmd_lbl = tr_en("Komutlar", "Commands")
            banner = (
                f"\r\n\x1b[1;36m[Yocto Studio Mock PTY]\x1b[0m {conn_lbl}: {proj['name']} "
                f"(Yocto {proj['yocto_version']} {proj['yocto_codename']})\r\n"
                f"{cmd_lbl}: help, bitbake --version, bitbake-layers show-layers, "
                "devtool status, pwd, uname -a, clear\r\n"
                f"{prompt}"
            )
        await self._monitor.emit("pty.output", {"session_id": session_id, "data": banner})
        return {"session_id": session_id, "kind": kind, "title": title, "prompt": prompt}

    async def _rpc_pty_write(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id", ""))
        data = str(params.get("data", ""))
        sess = self._pty_sessions.get(session_id)
        if not sess:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unknown PTY session: {session_id}")

        if sess.get("kind") == "menuconfig":
            keys = [
                "CONFIG_CAN_FLEXCAN",
                "CONFIG_NETFILTER_XTABLES",
                "CONFIG_BLK_DEV_NVME",
                "CONFIG_DRM_IMX8MP",
                "CONFIG_SECURITY_APPARMOR",
            ]
            cur = int(sess.get("cursor", 0))
            if data in ("j", "\x1b[B"):
                cur = (cur + 1) % len(keys)
            elif data in ("k", "\x1b[A"):
                cur = (cur - 1) % len(keys)
            elif data in (" ", "y", "n", "m"):
                cycle = {"y": "m", "m": "n", "n": "y"}
                sess["flags"][keys[cur]] = cycle.get(sess["flags"][keys[cur]], "y") if data == " " else data
            elif data in ("q", "Q"):
                saved_cfg = tr_en(".config kaydedildi", ".config saved")
                await self._monitor.emit(
                    "pty.output",
                    {
                        "session_id": session_id,
                        "data": f"\r\n\x1b[32m{saved_cfg} ({sess['recipe']}).\x1b[0m\r\n{sess['prompt']}",
                    },
                )
                sess["kind"] = "shell"
                return {"ok": True}
            sess["cursor"] = cur
            await self._monitor.emit(
                "pty.output",
                {"session_id": session_id, "data": self._render_menuconfig(sess["recipe"], cur, sess["flags"])},
            )
            return {"ok": True}

        # Support both raw xterm keystrokes (char-by-char with \r) and line-buffered RPC writes
        if "\r" not in data and "\n" not in data:
            if data == "\x7f":  # Backspace
                buf = str(sess.get("line_buf", ""))
                if buf:
                    sess["line_buf"] = buf[:-1]
                    await self._monitor.emit("pty.output", {"session_id": session_id, "data": "\b \b"})
                return {"ok": True}
            sess["line_buf"] = str(sess.get("line_buf", "")) + data
            await self._monitor.emit("pty.output", {"session_id": session_id, "data": data})
            return {"ok": True}

        combined = str(sess.get("line_buf", "")) + data
        sess["line_buf"] = ""
        cmd = combined.strip()
        prompt = sess["prompt"]
        if not cmd:
            out = f"\r\n{prompt}"
        elif cmd == "help":
            hdr = tr_en("Mock BitBake Shell Komutları:", "Mock BitBake Shell Commands:")
            out = (
                f"\r\n{hdr}\r\n"
                "  bitbake --version\r\n"
                "  bitbake-layers show-layers\r\n"
                "  devtool status\r\n"
                "  pwd / uname -a / clear\r\n"
                f"{prompt}"
            )
        elif cmd == "bitbake --version":
            out = f"\r\nBitBake Build Tool Core version 2.12.0 (Yocto Mock)\r\n{prompt}"
        elif cmd == "bitbake-layers show-layers":
            lines = ["\r\nlayer                 path                                      priority"]
            lines.append("=" * 78)
            for lyr in self._layers:
                lines.append(f"{lyr['name']:<22}{lyr['path']:<42}{lyr['priority']}")
            out = "\r\n".join(lines) + f"\r\n{prompt}"
        elif cmd == "devtool status":
            lines = ["\r\nNOTE: Starting bitbake server..."]
            for e in self._devtool_entries:
                lines.append(f"{e['recipe']}: {e['srctree']}")
            out = "\r\n".join(lines) + f"\r\n{prompt}"
        elif cmd == "pwd":
            out = f"\r\n{sess['cwd']}\r\n{prompt}"
        elif cmd == "uname -a":
            out = (
                "\r\nLinux yocto-wsl2 6.6.36.6-microsoft-standard-WSL2 #1 SMP x86_64 GNU/Linux\r\n"
                f"{prompt}"
            )
        elif cmd == "clear":
            out = f"\x1b[2J\x1b[H{prompt}"
        else:
            ran_lbl = tr_en("çalıştırıldı", "executed")
            out = f"\r\n[mock-sh] {ran_lbl}: {cmd}\r\n{prompt}"

        await self._monitor.emit("pty.output", {"session_id": session_id, "data": out})
        return {"ok": True}

    async def _rpc_pty_resize(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id", ""))
        if session_id not in self._pty_sessions:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unknown PTY session: {session_id}")
        return {"ok": True}

    async def _rpc_pty_close(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id", ""))
        self._pty_sessions.pop(session_id, None)
        await self._monitor.emit("pty.exit", {"session_id": session_id, "exit_code": 0})
        return {"ok": True}

    def _preflight_recipe_rows(self) -> list[dict[str, Any]]:
        return [
            {
                "pn": p["name"],
                "pv": p["version"],
                "layer": "meta-freescale"
                if "imx" in p["name"]
                else ("meta-openembedded" if p["name"] in {"mosquitto", "qtbase"} else "openembedded-core"),
                "priority": 8 if "imx" in p["name"] else 5,
                "bbappends": [
                    a["append_file"]
                    for a in self._preflight_appends
                    if a["recipe"] == p["name"]
                ],
                "providers": ["linux-yocto", "linux-imx"] if p["name"] == "linux-yocto" else [],
            }
            for p in self._preflight_packages
        ]

    async def _rpc_preflight_run_audit(self, params: dict[str, Any]) -> dict[str, Any]:
        t0 = time.perf_counter()
        proj = self._active_project()
        target = str(params.get("target") or "core-image-minimal")
        incompat_raw = params.get("incompatible_licenses")
        incompatible_licenses = (
            [str(x) for x in incompat_raw if str(x).strip()]
            if isinstance(incompat_raw, list)
            else ["GPL-3.0*"]
        )

        conf_doc = parse_conf(self._local_conf)
        vars_map = conf_doc.get_variables()

        layer_checks, layer_issues = audit_layers(
            layers=self._localized_layers(),
            active_series=proj["yocto_codename"],
            active_recipe_versions={"my-sensor-daemon": "1.2.0"},
            explicit_appends=self._preflight_appends,
        )

        _, ver_issues = build_version_matrix(
            self._preflight_recipe_rows(),
            vars_map,
            virtual_providers={"virtual/kernel": ["linux-yocto", "linux-imx"]},
        )

        distro_features = ["systemd", "wifi", "bluetooth"]
        if "sysvinit" in vars_map.get("DISTRO_FEATURES", ""):
            distro_features.append("sysvinit")
        machine_features = ["alsa", "usbhost", "usbgadget", "wifi", "bluetooth", "gpu"]

        dry_res = analyze_features_licenses_and_bloat(
            target=target,
            distro_features=distro_features,
            machine_features=machine_features,
            incompatible_licenses=incompatible_licenses,
            packages=self._preflight_packages,
            dep_chains={
                "bash": [target, "packagegroup-core-full-cmdline", "bash"],
                "xserver-xorg": [target, "DISTRO_FEATURES:x11", "packagegroup-core-x11", "xserver-xorg"],
            },
            resolved_fixes=self._resolved_preflight_fixes,
        )

        host = detect_host_resources(params.get("host_resources"))
        opt_plan = generate_optimization_plan(
            self._local_conf, host, resolved_fixes=self._resolved_preflight_fixes
        )
        opt_issues = [
            {
                "id": rec["id"],
                "severity": "optimization",
                "category": "performance",
                "title": rec["title"],
                "summary": tr_en(
                    f"Mevcut: {rec['current_value']} -> Önerilen: {rec['recommended_value']}",
                    f"Current: {rec['current_value']} -> Recommended: {rec['recommended_value']}",
                ),
                "detail": rec["impact"],
                "recipe": None,
                "layer": None,
                "dependency_chain": ["conf/local.conf"],
                "auto_fix": rec.get("auto_fix"),
            }
            for rec in opt_plan["recommendations"]
        ]

        all_issues = [
            iss
            for iss in [*layer_issues, *ver_issues, *dry_res["issues"], *opt_issues]
            if iss["id"] not in self._resolved_preflight_fixes
        ]
        score, blockers, warnings, opts, ready = compute_readiness_score(all_issues)

        check_layer_summary = None
        if params.get("check_layer"):
            chk_lyr = str(params["check_layer"])
            fake_out = (
                f"INFO: Detected layers:\n"
                f"INFO: {chk_lyr}: test_signatures ... PASS\n"
                f"INFO: {chk_lyr}: test_bsp_defines_machines ... PASS\n"
                f"INFO: {chk_lyr}: test_world ... PASS\n"
            )
            check_layer_summary = parse_yocto_check_layer_output(chk_lyr, fake_out, 0)

        return {
            "score": score,
            "target": target,
            "machine": proj["machine"],
            "yocto_series": f"{proj['yocto_version']} ({proj['yocto_codename']})",
            "duration_ms": max(18, round((time.perf_counter() - t0) * 1000.0)),
            "blockers": blockers,
            "warnings": warnings,
            "optimizations": opts,
            "ready_to_build": ready,
            "issues": all_issues,
            "layer_checks": layer_checks,
            "bloat_items": dry_res["bloat_items"],
            "license_violations": dry_res["license_violations"],
            "check_layer_summary": check_layer_summary,
        }

    async def _rpc_preflight_version_matrix(self, params: dict[str, Any]) -> dict[str, Any]:
        target = str(params.get("target") or "core-image-minimal")
        query = str(params.get("query") or "").strip().lower()
        vars_map = parse_conf(self._local_conf).get_variables()
        entries, conflicts = build_version_matrix(
            self._preflight_recipe_rows(),
            vars_map,
            virtual_providers={"virtual/kernel": ["linux-yocto", "linux-imx"]},
        )
        if query:
            entries = [
                e
                for e in entries
                if query in e["recipe"].lower() or query in e["layer"].lower()
            ]
        return {"target": target, "entries": entries, "conflicts": conflicts}

    async def _rpc_preflight_check_upgrades(self, _params: dict[str, Any]) -> dict[str, Any]:
        vars_map = parse_conf(self._local_conf).get_variables()
        upgrades = {
            "openssl": {"current": "3.0.14", "upstream": "3.5.0"},
            "mosquitto": {"current": "2.0.20", "upstream": "2.0.21"},
            "linux-yocto": {"current": "6.12.19", "upstream": "6.12.22"},
            "systemd": {"current": "257.4", "upstream": "257.4"},
        }
        entries, _ = build_version_matrix(
            self._preflight_recipe_rows(), vars_map, upgrade_map=upgrades
        )
        outdated_count = sum(
            1 for e in entries if e["upgrade_status"] in {"outdated", "security-risk"}
        )
        return {
            "checked_count": len(entries),
            "outdated_count": outdated_count,
            "entries": entries,
        }

    async def _rpc_preflight_probe_sstate(self, _params: dict[str, Any]) -> dict[str, Any]:
        vars_map = parse_conf(self._local_conf).get_variables()
        mirrors = [vars_map["SSTATE_MIRRORS"]] if "SSTATE_MIRRORS" in vars_map else []
        hs = self._active_project().get("hashserve") or "auto"
        return probe_sstate_and_hashserve(mirrors, str(hs), mock=True)

    async def _rpc_preflight_optimization_plan(self, params: dict[str, Any]) -> dict[str, Any]:
        host = detect_host_resources(params.get("host_resources"))
        return generate_optimization_plan(
            self._local_conf, host, resolved_fixes=self._resolved_preflight_fixes
        )

    async def _rpc_preflight_apply_fix(self, params: dict[str, Any]) -> dict[str, Any]:
        fix = dict(params.get("fix") or {})
        dry_run = bool(params.get("dry_run", False))
        fix_id = str(fix.get("id") or "")
        kind = str(fix.get("kind") or "")
        proj = self._active_project()

        diff = str(fix.get("preview_diff") or "")
        msg = str(fix.get("description") or tr_en("Pre-Flight düzeltmesi", "Pre-Flight fix"))

        if kind in {"local_conf_set", "local_conf_append", "local_conf_remove", "packageconfig_remove"}:
            new_conf, computed_diff = apply_local_conf_fix(self._local_conf, fix)
            diff = computed_diff or diff
            if not dry_run:
                self._local_conf = new_conf
                self._resolved_preflight_fixes.add(fix_id)
        elif kind == "layer_compat_update":
            lyr_name = str(fix.get("layer_name") or "")
            series = proj["yocto_codename"]
            diff = (
                f"--- a/{lyr_name}/conf/layer.conf\n"
                f"+++ b/{lyr_name}/conf/layer.conf\n"
                f"-LAYERSERIES_COMPAT = \"kirkstone\"\n"
                f"+LAYERSERIES_COMPAT = \"kirkstone {series}\"\n"
            )
            if not dry_run:
                for lyr in self._layers:
                    if lyr["name"] == lyr_name:
                        if series not in lyr["compat"]:
                            lyr["compat"].append(series)
                        lyr["compatible_with_active"] = True
                        lyr["warning"] = None
                self._resolved_preflight_fixes.add(fix_id)
        elif kind == "bbappend_wildcard":
            rec = next(iter((fix.get("changes") or {}).keys()), "my-sensor-daemon")
            renamed_note = tr_en(
                "Dosya yeniden adlandırıldı (sürüm bağımsız wildcard)",
                "File renamed (version-independent wildcard)",
            )
            diff = (
                f"--- a/{rec}_1.1.4.bbappend\n"
                f"+++ b/{rec}_%.bbappend\n"
                f"@@ {renamed_note} @@\n"
            )
            if not dry_run:
                for app in self._preflight_appends:
                    if app["recipe"] == rec:
                        app["append_file"] = app["append_file"].replace("_1.1.4.bbappend", "_%.bbappend")
                self._resolved_preflight_fixes.add(fix_id)
        elif kind == "layer_add":
            lyr_name = str(fix.get("layer_name") or "meta-networking")
            diff = f"--- a/conf/bblayers.conf\n+++ b/conf/bblayers.conf\n+  /layers/{lyr_name} \\\n"
            if not dry_run:
                if not any(lyr["name"] == lyr_name for lyr in self._layers):
                    self._layers.append(
                        {
                            "name": lyr_name,
                            "path": f"/layers/{lyr_name}",
                            "priority": 6,
                            "branch": proj["yocto_codename"],
                            "compat": [proj["yocto_codename"]],
                            "compatible_with_active": True,
                            "warning": None,
                            "appends_count": 0,
                        }
                    )
                self._resolved_preflight_fixes.add(fix_id)

        report = await self._rpc_preflight_run_audit(params)
        preview_prefix = tr_en("Önizleme hazır", "Preview ready")
        return {
            "applied": not dry_run,
            "fix_id": fix_id,
            "diff": diff,
            "message": msg if not dry_run else f"{preview_prefix}: {msg}",
            "updated_score": report["score"],
            "updated_report": report,
        }

    async def _rpc_pro_kernel_diff(self, params: dict[str, Any]) -> dict[str, Any]:
        search = str(params.get("search") or "")
        return diff_kernel_config(self._kernel_cfg_before, self._kernel_cfg_after, search)

    async def _rpc_pro_kernel_save_fragment(self, params: dict[str, Any]) -> dict[str, Any]:
        frag_name = str(params.get("fragment_name") or "custom-features.cfg")
        frag_content = str(params.get("fragment_content") or "")
        updated, diff = generate_kernel_bbappend_fragment(
            frag_name, frag_content, self._kernel_bbappend
        )
        self._kernel_bbappend = updated
        clean_name = frag_name if frag_name.endswith(".cfg") else f"{frag_name}.cfg"
        return {
            "ok": True,
            "fragment_path": f"recipes-kernel/linux/files/{clean_name}",
            "bbappend_diff": diff,
            "bbappend_content": updated,
        }

    async def _rpc_pro_dt_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "files": [
                {"name": v["name"], "path": p, "layer": v["layer"]}
                for p, v in self._dts_files.items()
            ]
        }

    async def _rpc_pro_dt_parse(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or next(iter(self._dts_files)))
        raw = str(params.get("content") or self._dts_files.get(path, {}).get("content", ""))
        valid, errors = validate_dts_syntax(raw)
        tree = parse_dts_tree(raw)
        return {"path": path, "raw_text": raw, "valid": valid, "errors": errors, "tree": tree}

    async def _rpc_pro_dt_update_status(self, params: dict[str, Any]) -> dict[str, Any]:
        path = str(params.get("path") or next(iter(self._dts_files)))
        node_path = str(params.get("node_path") or "")
        new_status = str(params.get("new_status") or "okay")
        if path not in self._dts_files:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unknown DTS path: {path}")
        cur_text = self._dts_files[path]["content"]
        new_text, diff = update_dts_node_status(cur_text, node_path, new_status)
        valid, errors = validate_dts_syntax(new_text)
        self._dts_files[path]["content"] = new_text
        return {
            "ok": True,
            "valid": valid,
            "errors": errors,
            "diff": diff,
            "raw_text": new_text,
            "tree": parse_dts_tree(new_text),
        }

    async def _rpc_pro_qa_run_suite(self, params: dict[str, Any]) -> dict[str, Any]:
        suite = str(params.get("suite") or "testimage")
        sample = (
            "PASS: ping.PingTest.test_ping\n"
            "PASS: ssh.SSHTest.test_ssh\n"
            "PASS: systemd.SystemdBasicTests.test_systemd_basic\n"
            "PASS: can_loopback.ptest\n"
            "SKIP: xorg.XorgTest.test_xorg_running\n"
            if suite == "testimage"
            else "PASS: openssl-evp-sha256\nPASS: mosquitto-broker-tls\nPASS: my-sensor-daemon-ipc\n"
        )
        return parse_ptest_output(sample, suite_name=suite)

    async def _rpc_pro_qa_hardware_smoke(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        machine = str(params.get("machine") or proj["machine"])
        host = str(params.get("target_host") or "192.168.10.50")
        uart_log = (
            "[0.000] U-Boot SPL 2025.04\n"
            "[0.840] Booting Linux on physical CPU 0x0\n"
            "[1.120] Linux version 6.12.19-yocto-standard\n"
            "[2.280] systemd[1]: Reached target Local File Systems.\n"
            "[4.190] systemd[1]: Reached target Multi-User System.\n"
        )
        analyze_out = "Startup finished in 1.440s (kernel) + 1.910s (userspace) = 3.350s"
        blame_out = (
            "680ms NetworkManager-wait-online.service\n"
            "410ms systemd-udev-trigger.service\n"
            "290ms my-sensor-daemon.service\n"
            "180ms sshd.service\n"
        )
        checks = [
            {
                "name": "dmesg -l err,crit",
                "status": "PASS",
                "output": tr_en("0 kritik çekirdek hatası", "0 critical kernel errors"),
            },
            {"name": "ip -br a (Ethernet)", "status": "PASS", "output": f"eth0 UP {host}/24 (1000Mb/s)"},
            {"name": "lsblk / eMMC", "status": "PASS", "output": "/dev/mmcblk2 29.7G ext4 rw"},
            {
                "name": "i2cdetect -y 2",
                "status": "PASS",
                "output": tr_en("PMIC @ 0x25 algılandı (UU)", "PMIC @ 0x25 detected (UU)"),
            },
            {"name": "can0 / flexcan", "status": "PASS", "output": "500000 bps UP"},
        ]
        return build_hardware_smoke_report(
            target_host=host,
            machine=machine,
            uart_log=uart_log,
            analyze_out=analyze_out,
            blame_out=blame_out,
            dmesg_errors=[],
            checks=checks,
        )

    async def _rpc_pro_cra_list_vex(self, _params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        purl = f"pkg:yocto/{proj['distro']}/{proj['machine']}@{proj['yocto_version']}"
        entries = self._localized_vex_entries()
        return {
            "product_purl": purl,
            "entries": entries,
            "openvex_doc": build_openvex_document(entries, purl),
        }

    async def _rpc_pro_cra_update_vex(self, params: dict[str, Any]) -> dict[str, Any]:
        cve_id = str(params.get("cve_id") or "")
        status = str(params.get("status") or "under_investigation")
        just = params.get("justification")
        impact = params.get("impact_statement")
        proj = self._active_project()
        purl = f"pkg:yocto/{proj['distro']}/{proj['machine']}@{proj['yocto_version']}"
        updated_entry = None
        for e in self._vex_entries:
            if e["cve_id"] == cve_id:
                e["status"] = status
                e["justification"] = just
                e["impact_statement"] = impact
                e["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
                updated_entry = e
                break
        if updated_entry is None:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unknown CVE in VEX store: {cve_id}")
        entries = self._localized_vex_entries()
        loc_updated = next((x for x in entries if x["cve_id"] == cve_id), updated_entry)
        return {
            "entry": loc_updated,
            "entries": entries,
            "openvex_doc": build_openvex_document(entries, purl),
        }

    async def _rpc_pro_cra_export_bundle(self, params: dict[str, Any]) -> dict[str, Any]:
        import tempfile

        proj = self._active_project()
        out_dir = Path(str(params.get("output_dir") or Path(tempfile.gettempdir()) / "yocto-cra-bundles"))
        bname = str(params.get("bundle_name") or f"cra-compliance-{proj['machine']}.zip")
        purl = f"pkg:yocto/{proj['distro']}/{proj['machine']}@{proj['yocto_version']}"
        sbom = await self._rpc_artifacts_sbom({})
        lic = await self._rpc_artifacts_export_licenses({"format": "csv"})
        vex_doc = build_openvex_document(self._vex_entries, purl)
        return export_cra_compliance_bundle(out_dir, bname, sbom, vex_doc, lic["content"])

    async def _rpc_pro_secboot_generate(self, params: dict[str, Any]) -> dict[str, Any]:
        return generate_secure_boot_inc(
            enable_fit_sign=bool(params.get("enable_fit_sign", True)),
            key_dir=str(params.get("key_dir") or "${TOPDIR}/keys/dev-fit"),
            key_name=str(params.get("key_name") or "dev-fit-key"),
            key_bits=int(params.get("key_bits") or 2048),
            enable_dm_verity=bool(params.get("enable_dm_verity", True)),
            verity_image=str(params.get("verity_image") or "core-image-minimal"),
            verity_data_dev=str(params.get("verity_data_dev") or "/dev/mmcblk2p2"),
        )

    async def _rpc_pro_buildstats_analyze(self, _params: dict[str, Any]) -> dict[str, Any]:
        sample_tasks = [
            ("linux-yocto", "do_compile", 0.0, 245.4, 88.2),
            ("gcc-cross-aarch64", "do_compile", 10.0, 198.2, 91.5),
            ("glibc", "do_compile", 45.0, 112.6, 84.0),
            ("openssl", "do_compile", 120.0, 68.3, 76.5),
            ("systemd", "do_compile", 180.0, 62.1, 79.0),
            ("binutils-cross", "do_compile", 15.0, 54.8, 82.1),
            ("python3-native", "do_compile", 90.0, 48.0, 74.0),
            ("perl-native", "do_compile", 95.0, 39.2, 71.0),
            ("cmake-native", "do_compile", 55.0, 34.5, 80.0),
            ("core-image-minimal", "do_rootfs", 310.0, 29.4, 42.3),
            ("core-image-minimal", "do_image_wic", 340.0, 24.1, 38.0),
            ("my-sensor-daemon", "do_compile", 250.0, 18.7, 65.4),
        ]
        records = [
            {
                "recipe": r,
                "task": t,
                "started_ts": 1000.0 + st,
                "ended_ts": 1000.0 + st + dur,
                "duration_sec": dur,
                "cpu_percent": cpu,
            }
            for r, t, st, dur, cpu in sample_tasks
        ]
        return analyze_buildstats_records(records)

    async def _rpc_pro_cicd_generate(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        return generate_cicd_pipeline(
            platform=str(params.get("platform") or "gitlab"),
            setup_tool=str(params.get("setup_tool") or proj["setup_tool"]),
            machine=str(params.get("machine") or proj["machine"]),
            target=str(params.get("target") or "core-image-minimal"),
            kas_file=str(params.get("kas_file") or "kas-project.yml"),
            enable_preflight_gate=bool(params.get("enable_preflight_gate", True)),
            enable_cve_gate=bool(params.get("enable_cve_gate", True)),
            sstate_cache_dir=str(params.get("sstate_cache_dir") or proj["sstate_dir"]),
            dl_dir=str(params.get("dl_dir") or proj["dl_dir"]),
        )

    # ─── Modül 11: Enterprise & Completeness Pack RPCs ─────────────────────

    async def _rpc_enterprise_mc_list(self, _params: dict[str, Any]) -> dict[str, Any]:
        snippet = f'BBMULTICONFIG = "{" ".join(self._bbmulticonfig_enabled)}"'
        return {
            "bbmulticonfig_enabled": list(self._bbmulticonfig_enabled),
            "configs": self._localized_multiconfigs(),
            "dependencies": list(self._mcdepends),
            "local_conf_snippet": snippet,
        }

    async def _rpc_enterprise_mc_save(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "").strip()
        machine = str(params.get("machine") or "imx8mp-lpddr4-evk")
        tmpdir = str(params.get("tmpdir") or f"${{TOPDIR}}/tmp-{name}")
        distro = str(params.get("distro") or "")
        desc = str(params.get("description") or "")
        extra_vars = params.get("extra_vars") or {}
        try:
            raw = generate_multiconfig_conf(name, machine, tmpdir, distro, desc, extra_vars)
            entry = parse_multiconfig_text(name, raw, f"conf/multiconfig/{name}.conf")
        except ValueError as exc:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, str(exc)) from exc

        self._multiconfigs[name] = entry
        if name not in self._bbmulticonfig_enabled:
            self._bbmulticonfig_enabled.append(name)

        add_dep = params.get("add_dependency")
        if isinstance(add_dep, dict) and add_dep.get("recipe"):
            dep = build_mcdepends_expression(
                str(add_dep.get("from_config") or name),
                str(add_dep.get("to_config") or "cortex-m7-rtos"),
                str(add_dep.get("recipe") or ""),
                str(add_dep.get("task") or "do_deploy"),
            )
            if not any(d["expression"] == dep["expression"] for d in self._mcdepends):
                self._mcdepends.append(dep)

        new_conf, diff = sync_bbmulticonfig_in_local_conf(
            self._local_conf, self._bbmulticonfig_enabled, self._mcdepends
        )
        self._local_conf = new_conf
        configs = self._localized_multiconfigs()
        loc_entry = next((c for c in configs if c["name"] == name), entry)
        return {
            "config": loc_entry,
            "bbmulticonfig_enabled": list(self._bbmulticonfig_enabled),
            "configs": configs,
            "dependencies": list(self._mcdepends),
            "local_conf_diff": diff,
        }

    async def _rpc_enterprise_mc_delete(self, params: dict[str, Any]) -> dict[str, Any]:
        name = str(params.get("name") or "").strip()
        removed = self._multiconfigs.pop(name, None) is not None
        self._bbmulticonfig_enabled = [n for n in self._bbmulticonfig_enabled if n != name]
        self._mcdepends = [
            d for d in self._mcdepends if d["from_config"] != name and d["to_config"] != name
        ]
        new_conf, _ = sync_bbmulticonfig_in_local_conf(
            self._local_conf, self._bbmulticonfig_enabled, self._mcdepends
        )
        self._local_conf = new_conf
        return {
            "ok": removed,
            "bbmulticonfig_enabled": list(self._bbmulticonfig_enabled),
            "configs": self._localized_multiconfigs(),
        }

    async def _rpc_enterprise_scan_autorev(self, params: dict[str, Any]) -> dict[str, Any]:
        layer_filter = str(params.get("layer_filter") or "")
        return scan_autorev_in_files(self._autorev_files, layer_filter=layer_filter)

    async def _rpc_enterprise_pin_autorev(self, params: dict[str, Any]) -> dict[str, Any]:
        finding_ids = [str(x) for x in (params.get("finding_ids") or [])]
        updated, diff, pinned = apply_autorev_pins(
            self._autorev_files, finding_ids=finding_ids if finding_ids else None
        )
        self._autorev_files = updated
        remaining = scan_autorev_in_files(self._autorev_files)["findings"]
        return {
            "pinned_count": pinned,
            "combined_diff": diff,
            "remaining_findings": remaining,
        }

    async def _rpc_enterprise_prepare_mirror(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        target = str(params.get("target") or "core-image-minimal")
        dl_dir = str(params.get("dl_dir") or proj["dl_dir"])
        mirror_dir = str(params.get("mirror_dir") or "/home/yocto/airgap-mirror/downloads")
        no_net = bool(params.get("enable_no_network", True))
        apply_cfg = bool(params.get("apply_config", False))
        plan = build_offline_mirror_plan(
            target, dl_dir, mirror_dir, self._local_conf, enable_no_network=no_net
        )
        if apply_cfg:
            self._local_conf = _update_conf_preserve_comments(
                self._local_conf,
                plan["local_conf_updates"],
                operators={"INHERIT": "+="},
            )
        return plan

    async def _rpc_enterprise_configure_archiver(self, params: dict[str, Any]) -> dict[str, Any]:
        import tempfile

        mode = "patched" if str(params.get("mode") or "original") == "patched" else "original"
        gpl_only = bool(params.get("gpl_only", True))
        apply_cfg = bool(params.get("apply_config", False))
        export_bundle = bool(params.get("export_bundle", True))
        updates, new_conf, diff = build_archiver_config(
            self._local_conf, mode=mode, gpl_only=gpl_only
        )
        if apply_cfg:
            self._local_conf = new_conf

        out_path = Path(tempfile.gettempdir()) / "yocto-studio-archives" / "yocto-gpl-sources.tar.gz"
        if export_bundle:
            tar_info = export_sources_tarball(None, out_path, gpl_only=gpl_only)
        else:
            tar_info = {
                "archive_path": str(out_path),
                "size_bytes": 0,
                "package_count": 0,
                "sha256": "",
            }
        return {
            "ok": True,
            "mode": mode,
            "gpl_only": gpl_only,
            "local_conf_updates": updates,
            "local_conf_diff": diff,
            **tar_info,
        }

    async def _rpc_enterprise_rootfs_treemap(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        image = str(params.get("image") or "core-image-minimal")
        return parse_installed_package_sizes(
            self._rootfs_sizes_text,
            image=image,
            machine=proj["machine"],
            recipe_map={"libcrypto3": "openssl", "libssl3": "openssl", "openssl-bin": "openssl"},
            file_map={
                "libcrypto3": ["/usr/lib/libcrypto.so.3"],
                "my-sensor-daemon": [
                    "/usr/bin/my-sensor-daemon",
                    "/etc/systemd/system/my-sensor-daemon.service",
                ],
                "glibc": ["/lib/libc.so.6", "/lib/libm.so.6"],
            },
        )

    async def _rpc_enterprise_rootfs_find_path(self, params: dict[str, Any]) -> dict[str, Any]:
        query = str(params.get("path") or "")
        matches = lookup_path_in_index(query, self._pkgdata_index)
        return {"query": query, "matches": matches}

    async def _rpc_enterprise_rootfs_diffsigs(self, params: dict[str, Any]) -> dict[str, Any]:
        recipe = str(params.get("recipe") or "my-sensor-daemon")
        task = str(params.get("task") or "do_compile")
        sample_raw = (
            f"NOTE: Task {recipe}.bb:{task} basehash changed from "
            "9a11e2b8c4d0f1a2 to 4c8f00d9e3b71a99\n"
            'Variable EXTRA_OECMAKE value changed:\n'
            '- "-DENABLE_TLS=OFF -DCAN_TIMEOUT_MS=250"\n'
            '+ "-DENABLE_TLS=ON -DCAN_TIMEOUT_MS=500"\n'
            "Checksum for file file://0002-fix-can-timeout.patch changed "
            "from e3b0c44298fc to 9182ab73cf01\n"
            f"Hash for dependent task openssl_3.5.0.bb:do_populate_sysroot changed\n"
        )
        return parse_diffsigs_output(sample_raw, recipe=recipe, task=task)

    async def _rpc_enterprise_debug_export_ide(self, params: dict[str, Any]) -> dict[str, Any]:
        recipe = str(params.get("recipe") or "my-sensor-daemon")
        return generate_vscode_debug_configs(
            recipe=recipe,
            binary_path=str(params.get("binary_path") or f"/usr/bin/{recipe}"),
            target_host=str(params.get("target_host") or "192.168.10.50"),
            gdb_port=int(params.get("gdb_port") or 2345),
            sysroot_path=str(
                params.get("sysroot_path")
                or "/opt/poky/6.0/sysroots/armv8a-poky-linux"
            ),
            gdb_path=str(params.get("gdb_path") or "aarch64-poky-linux-gdb"),
        )

    async def _rpc_enterprise_debug_start_gdbserver(self, params: dict[str, Any]) -> dict[str, Any]:
        target_host = str(params.get("target_host") or "192.168.10.50")
        return build_gdbserver_launch_plan(
            target_host=target_host,
            ssh_user=str(params.get("ssh_user") or "root"),
            ssh_port=int(params.get("ssh_port") or 22),
            remote_binary=str(params.get("remote_binary") or "/usr/bin/my-sensor-daemon"),
            gdb_port=int(params.get("gdb_port") or 2345),
            args=str(params.get("args") or ""),
        )

    async def _rpc_enterprise_debug_telemetry(self, params: dict[str, Any]) -> dict[str, Any]:
        target_host = str(params.get("target_host") or "192.168.10.50")
        unit = str(params.get("journal_unit") or "my-sensor-daemon")
        now = time.strftime("%H:%M:%S", time.localtime())
        cpu = round(random.uniform(18.0, 56.0), 1)
        load1 = round(cpu / 25.0, 2)
        ram_used = random.randint(680, 1180)
        temp_soc = random.randint(44500, 58200)
        temp_gpu = random.randint(41000, 53400)
        raw = (
            "=== TIME ===\n"
            f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\n"
            "=== UPTIME ===\n"
            "18432.5 71204.2\n"
            "=== LOAD ===\n"
            f"{load1} {round(load1 * 0.9, 2)} {round(load1 * 0.75, 2)} 2/148 1921\n"
            "=== MEM ===\n"
            "MemTotal:        4096000 kB\n"
            f"MemAvailable:    {(4000 - ram_used) * 1024} kB\n"
            "SwapTotal:        524288 kB\n"
            "SwapFree:         491520 kB\n"
            "=== DF ===\n"
            "/dev/mmcblk2p2 14680064 4120576 9820000 30% /\n"
            "=== THERMAL ===\n"
            f"thermal_zone0|cpu-thermal|{temp_soc}\n"
            f"thermal_zone1|gpu-thermal|{temp_gpu}\n"
            "=== SYSTEMD ===\n"
            "UNIT LOAD ACTIVE SUB DESCRIPTION\n"
            "can-gateway.service loaded failed failed FlexCAN MQTT Bridge Service\n"
            "=== JOURNAL ===\n"
            f"Nov 25 {now} imx8mp-evk {unit}[1482]: Telemetry frame #409 tx ok (124 bytes)\n"
            f"Nov 25 {now} imx8mp-evk systemd[1]: Started {unit}.service - Industrial Sensor Daemon.\n"
            f"Nov 25 {now} imx8mp-evk can-gateway[1509]: WARN flexcan0 bus-off retry 2/5\n"
            f"Nov 25 {now} imx8mp-evk kernel: fec 30be0000.ethernet eth0: Link is Up - 1Gbps/Full\n"
        )
        return parse_live_telemetry_output(raw, target_host)

    async def _rpc_enterprise_migration_scan(self, params: dict[str, Any]) -> dict[str, Any]:
        from_lts = str(params.get("from_lts") or "scarthgap")
        to_lts = str(params.get("to_lts") or "wrynose")
        layer = str(params.get("layer_name") or "meta-custom-iot")
        return scan_migration_files(
            self._migration_files, from_lts=from_lts, to_lts=to_lts, layer_name=layer
        )

    async def _rpc_enterprise_migration_apply_all(self, params: dict[str, Any]) -> dict[str, Any]:
        from_lts = str(params.get("from_lts") or "scarthgap")
        to_lts = str(params.get("to_lts") or "wrynose")
        layer = str(params.get("layer_name") or "meta-custom-iot")
        fids = params.get("finding_ids")
        updated, res = apply_migration_fixes(
            self._migration_files,
            from_lts=from_lts,
            to_lts=to_lts,
            layer_name=layer,
            finding_ids=[str(x) for x in fids] if fids is not None else None,
        )
        self._migration_files = updated
        return res

    async def _rpc_enterprise_git_status_all(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {
            "layers": [
                {k: v for k, v in repo.items() if k != "mock_diff"}
                for repo in self._layer_git_repos
            ]
        }

    async def _rpc_enterprise_git_run_action(self, params: dict[str, Any]) -> dict[str, Any]:
        layer_name = str(params.get("layer_name") or "")
        action = str(params.get("action") or "diff")
        message = str(params.get("message") or "").strip()
        target_repo = next(
            (r for r in self._layer_git_repos if r["layer_name"] == layer_name), None
        )
        if target_repo is None:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unknown layer repo: {layer_name}")

        output = ""
        diff = ""
        if action == "fetch":
            if target_repo["behind"] > 0:
                commits_lbl = tr_en("yeni commit mevcut", "new commit(s) available")
                output = (
                    f"{layer_name}: origin/{target_repo['branch']} fetched "
                    f"({target_repo['behind']} {commits_lbl})."
                )
            else:
                output = f"{layer_name}: up-to-date."
        elif action == "diff":
            diff = target_repo.get("mock_diff", "")
            output = (
                tr_en("Diff yüklendi.", "Diff loaded.")
                if diff
                else tr_en("Çalışma ağacı temiz (diff yok).", "Working tree clean (no diff).")
            )
        elif action == "stash":
            target_repo["dirty_count"] = 0
            target_repo["staged_count"] = 0
            target_repo["untracked_count"] = 0
            target_repo["changed_files"] = []
            target_repo["mock_diff"] = ""
            output = tr_en(
                f"{layer_name}: tüm yerel değişiklikler stash'e alındı.",
                f"{layer_name}: all local changes stashed.",
            )
        elif action == "stash_pop":
            output = tr_en(
                f"{layer_name}: stash pop uygulandı.",
                f"{layer_name}: stash pop applied.",
            )
        elif action == "commit":
            commit_msg = message or "chore(layer): commit changes via Yocto Studio"
            target_repo["dirty_count"] = 0
            target_repo["staged_count"] = 0
            target_repo["untracked_count"] = 0
            target_repo["changed_files"] = []
            target_repo["mock_diff"] = ""
            target_repo["ahead"] = int(target_repo["ahead"]) + 1
            target_repo["commit_message"] = commit_msg
            target_repo["commit_sha"] = uuid.uuid4().hex[:10]
            output = f"[{target_repo['branch']} {target_repo['commit_sha']}] {commit_msg}"
        else:
            raise RpcError(RpcErrorCode.INVALID_PARAMS, f"Unsupported git action: {action}")

        clean_status = {k: v for k, v in target_repo.items() if k != "mock_diff"}
        return {
            "ok": True,
            "layer_name": layer_name,
            "action": action,
            "output": output,
            "diff": diff,
            "updated_status": clean_status,
        }

    async def _rpc_enterprise_sstate_analytics(self, params: dict[str, Any]) -> dict[str, Any]:
        proj = self._active_project()
        return build_remote_sstate_analytics(
            mirror_url=str(params.get("mirror_url") or "https://sstate.yoctoproject.org/all/PATH"),
            hashserve_endpoint=str(params.get("hashserve_endpoint") or proj.get("hashserve") or "auto"),
            time_range=str(params.get("time_range") or "7d"),
            runner_logs=params.get("runner_logs"),
            mock=True,
        )
