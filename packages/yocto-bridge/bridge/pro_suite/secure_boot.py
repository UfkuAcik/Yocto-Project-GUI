"""Secure Boot (U-Boot FIT signing) & dm-verity Yocto `.inc` configuration generator."""

from __future__ import annotations

from typing import Any

from bridge.i18n import tr_en


def generate_secure_boot_inc(
    enable_fit_sign: bool = True,
    key_dir: str = "${TOPDIR}/keys/dev-fit",
    key_name: str = "dev-fit-key",
    key_bits: int = 2048,
    enable_dm_verity: bool = True,
    verity_image: str = "core-image-minimal",
    verity_data_dev: str = "/dev/mmcblk2p2",
) -> dict[str, Any]:
    """Generate standard Yocto `secure-boot.inc` and dev RSA key commands."""
    bits = 4096 if int(key_bits) >= 4096 else 2048
    lines = [
        "# Yocto Studio Secure Boot & Rootfs Integrity Configuration",
        tr_en(
            "# ÜRETİM UYARISI: Bu anahtarlar yalnızca geliştirme içindir; üretimde HSM/KMS kullanın.",
            "# PRODUCTION WARNING: These keys are for development only; use HSM/KMS in production.",
        ),
        "",
    ]

    if enable_fit_sign:
        lines.extend(
            [
                "# 1. U-Boot Verified Boot (FIT Image Signing)",
                'KERNEL_CLASSES += "kernel-fitimage"',
                'KERNEL_IMAGETYPES = "fitImage"',
                'UBOOT_SIGN_ENABLE = "1"',
                f'UBOOT_SIGN_KEYDIR = "{key_dir}"',
                f'UBOOT_SIGN_KEYNAME = "{key_name}"',
                'UBOOT_MKIMAGE_DTCOPTS = "-I dts -O dtb -p 2000"',
                f'FIT_SIGN_NUMBITS = "{bits}"',
                "",
            ]
        )

    if enable_dm_verity:
        lines.extend(
            [
                "# 2. Read-Only Rootfs Integrity (dm-verity)",
                'IMAGE_CLASSES += "dm-verity-img"',
                f'DM_VERITY_IMAGE = "{verity_image}"',
                'DM_VERITY_IMAGE_TYPE = "ext4"',
                f'DM_VERITY_DATA_DEV = "{verity_data_dev}"',
                'IMAGE_FEATURES:append = " read-only-rootfs"',
                "",
            ]
        )

    inc_content = "\n".join(lines)
    keygen_commands = [
        f"mkdir -p {key_dir}",
        f"openssl genpkey -algorithm RSA -out {key_dir}/{key_name}.key -pkeyopt rsa_keygen_bits:{bits}",
        (
            f"openssl req -batch -new -x509 -key {key_dir}/{key_name}.key "
            f"-out {key_dir}/{key_name}.crt -days 3650 -subj '/CN=YoctoStudio-DEV-ONLY/'"
        ),
    ]

    return {
        "inc_filename": "conf/secure-boot.inc",
        "inc_content": inc_content,
        "local_conf_require": 'require conf/secure-boot.inc',
        "keygen_commands": keygen_commands,
        "production_warning": tr_en(
            "GÜVENLİK UYARISI: Oluşturulan yerel RSA geliştirme anahtarlarını asla üretime "
            "almayın! Seri üretimde imzalama anahtarlarını donanım güvenlik modülünde (HSM / PKCS#11) tutun.",
            "SECURITY WARNING: Never ship generated local RSA dev keys to production! "
            "Store signing keys inside an HSM / PKCS#11 module for mass production.",
        ),
    }
