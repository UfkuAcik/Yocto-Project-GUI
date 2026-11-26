use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct UbootMacro {
    pub id: String,
    pub label: String,
    pub command: String,
    pub description: String,
    pub category: String,
}

pub fn default_uboot_macros() -> Vec<UbootMacro> {
    vec![
        UbootMacro {
            id: "ums-mmc0".into(),
            label: tr_en("UMS Modu (eMMC/SD)", "UMS Mode (eMMC/SD)").into(),
            command: "ums 0 mmc 0".into(),
            description: tr_en(
                "Hedef MMC aygıtını USB Mass Storage (UMS) diski olarak PC'ye açar.",
                "Exposes the target MMC device to the host PC as a USB Mass Storage (UMS) disk.",
            )
            .into(),
            category: "usb".into(),
        },
        UbootMacro {
            id: "fastboot-0".into(),
            label: tr_en("Fastboot Modu", "Fastboot Mode").into(),
            command: "fastboot 0".into(),
            description: tr_en(
                "U-Boot fastboot USB gadget modunu başlatır.",
                "Starts U-Boot fastboot USB gadget mode.",
            )
            .into(),
            category: "usb".into(),
        },
        UbootMacro {
            id: "tftpboot-net".into(),
            label: "TFTP Boot".into(),
            command: "dhcp; tftpboot ${loadaddr} Image && tftpboot ${fdt_addr_r} devicetree.dtb && booti ${loadaddr} - ${fdt_addr_r}".into(),
            description: tr_en(
                "TFTP sunucudan çekirdek ve DTB indirip başlatır.",
                "Downloads kernel and DTB from the TFTP server and boots.",
            )
            .into(),
            category: "network".into(),
        },
        UbootMacro {
            id: "printenv".into(),
            label: "printenv".into(),
            command: "printenv".into(),
            description: tr_en(
                "Tüm U-Boot ortam değişkenlerini yazdırır.",
                "Prints all U-Boot environment variables.",
            )
            .into(),
            category: "diag".into(),
        },
        UbootMacro {
            id: "mmc-list".into(),
            label: "mmc list".into(),
            command: "mmc list".into(),
            description: tr_en(
                "Algılanan MMC/SD denetleyicilerini listeler.",
                "Lists detected MMC/SD controllers.",
            )
            .into(),
            category: "diag".into(),
        },
        UbootMacro {
            id: "reset".into(),
            label: "Reset".into(),
            command: "reset".into(),
            description: tr_en("Kartı yeniden başlatır.", "Reboots the board.").into(),
            category: "power".into(),
        },
    ]
}

pub fn detect_autoboot_prompt(chunk: &str) -> bool {
    let lower = chunk.to_ascii_lowercase();
    lower.contains("hit any key to stop autoboot")
        || lower.contains("press space to abort autoboot")
        || lower.contains("stop autoboot")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_uboot_autoboot_prompts() {
        assert!(detect_autoboot_prompt("Hit any key to stop autoboot:  3"));
        assert!(detect_autoboot_prompt("Press SPACE to abort autoboot in 2s"));
        assert!(!detect_autoboot_prompt("Starting kernel ..."));
    }
}
