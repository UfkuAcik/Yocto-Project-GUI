use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemovableDriveInfo {
    pub id: String,
    pub name: String,
    pub device_path: String,
    pub size_bytes: u64,
    pub size_human: String,
    pub bus_type: String,
    pub is_system_disk: bool,
    pub removable: bool,
    pub mount_points: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FlashPlan {
    pub image_path: String,
    pub image_filename: String,
    pub target_device: String,
    pub method: String,
    pub command: String,
    pub warnings: Vec<String>,
    pub requires_elevation: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CopyArtifactResult {
    pub ok: bool,
    pub source_path: String,
    pub dest_path: String,
    pub bytes_copied: u64,
}

pub fn format_bytes(bytes: u64) -> String {
    const GIB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MIB: f64 = 1024.0 * 1024.0;
    if bytes as f64 >= GIB {
        format!("{:.1} GB", bytes as f64 / GIB)
    } else {
        format!("{:.1} MB", bytes as f64 / MIB)
    }
}

#[cfg(windows)]
fn probe_os_drives() -> Vec<RemovableDriveInfo> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = "Get-CimInstance Win32_DiskDrive | Select-Object DeviceID,Model,InterfaceType,MediaType,Size,Index | ConvertTo-Json -Compress";
    let output = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let Ok(out) = output else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }

    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if raw.is_empty() {
        return Vec::new();
    }

    let parsed: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(val) => val,
        Err(_) => return Vec::new(),
    };

    let items = match parsed {
        serde_json::Value::Array(arr) => arr,
        obj @ serde_json::Value::Object(_) => vec![obj],
        _ => Vec::new(),
    };

    let mut drives = Vec::new();
    for item in items {
        let device_id = item
            .get("DeviceID")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if device_id.is_empty() {
            continue;
        }
        let model = item
            .get("Model")
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown Disk")
            .trim()
            .to_string();
        let iface = item
            .get("InterfaceType")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN")
            .to_uppercase();
        let media = item
            .get("MediaType")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_lowercase();
        let index = item.get("Index").and_then(|v| v.as_u64()).unwrap_or(0);
        let size_bytes = item.get("Size").and_then(|v| v.as_u64()).unwrap_or(0);

        let is_usb_or_removable =
            iface == "USB" || media.contains("removable") || media.contains("external");
        let is_system_disk = index == 0
            || device_id.to_ascii_uppercase().contains("PHYSICALDRIVE0")
            || !is_usb_or_removable;

        drives.push(RemovableDriveInfo {
            id: format!("win-disk-{index}"),
            name: model,
            device_path: device_id,
            size_bytes,
            size_human: format_bytes(size_bytes),
            bus_type: if iface.is_empty() { "STORAGE".to_string() } else { iface },
            is_system_disk,
            removable: is_usb_or_removable && !is_system_disk,
            mount_points: if index == 0 {
                vec!["C:\\".to_string()]
            } else {
                Vec::new()
            },
        });
    }
    drives
}

#[cfg(not(windows))]
fn probe_os_drives() -> Vec<RemovableDriveInfo> {
    use std::process::Command;

    let output = Command::new("lsblk")
        .args(["-J", "-b", "-o", "NAME,MODEL,SIZE,RM,TRAN,MOUNTPOINT"])
        .output();
    let Ok(out) = output else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }

    let Ok(json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) else {
        return Vec::new();
    };
    let Some(devs) = json.get("blockdevices").and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    let mut drives = Vec::new();
    for dev in devs {
        let name = dev.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() || name.starts_with("loop") {
            continue;
        }
        let rm = match dev.get("rm") {
            Some(serde_json::Value::Bool(b)) => *b,
            Some(serde_json::Value::Number(n)) => n.as_u64() == Some(1),
            Some(serde_json::Value::String(s)) => s == "1" || s.eq_ignore_ascii_case("true"),
            _ => false,
        };
        let tran = dev
            .get("tran")
            .and_then(|v| v.as_str())
            .unwrap_or("sata")
            .to_uppercase();
        let size_bytes = dev
            .get("size")
            .and_then(|v| v.as_u64())
            .or_else(|| dev.get("size").and_then(|v| v.as_str()).and_then(|s| s.parse().ok()))
            .unwrap_or(0);
        let model = dev
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or(name)
            .trim()
            .to_string();

        let mut mounts = Vec::new();
        if let Some(mp) = dev.get("mountpoint").and_then(|v| v.as_str()) {
            mounts.push(mp.to_string());
        }
        if let Some(children) = dev.get("children").and_then(|v| v.as_array()) {
            for ch in children {
                if let Some(mp) = ch.get("mountpoint").and_then(|v| v.as_str()) {
                    mounts.push(mp.to_string());
                }
            }
        }
        let is_primary_sys_dev = matches!(name, "sda" | "nvme0n1" | "vda");
        let has_system_mount =
            is_primary_sys_dev || mounts.iter().any(|m| m == "/" || m == "/boot" || m == "/home");
        let removable = (rm || tran == "USB" || tran == "MMC") && !has_system_mount;

        drives.push(RemovableDriveInfo {
            id: format!("linux-{name}"),
            name: if model.is_empty() {
                name.to_string()
            } else {
                model
            },
            device_path: format!("/dev/{name}"),
            size_bytes,
            size_human: format_bytes(size_bytes),
            bus_type: tran,
            is_system_disk: has_system_mount || !removable,
            removable,
            mount_points: mounts,
        });
    }
    drives
}

pub fn list_removable_drives(include_mock_if_empty: bool) -> Vec<RemovableDriveInfo> {
    let mut drives = probe_os_drives();
    let has_removable = drives.iter().any(|d| d.removable && !d.is_system_disk);
    if !has_removable && include_mock_if_empty {
        drives.push(RemovableDriveInfo {
            id: "mock-sd-01".to_string(),
            name: tr_en(
                "SanDisk Industrial microSD 32GB (Simülasyon)",
                "SanDisk Industrial microSD 32GB (Simulation)",
            )
            .to_string(),
            device_path: "mock://sd-card-industrial-32g".to_string(),
            size_bytes: 31_914_983_424,
            size_human: "29.7 GB".to_string(),
            bus_type: "USB (Mock)".to_string(),
            is_system_disk: false,
            removable: true,
            mount_points: Vec::new(),
        });
    }
    drives
}

pub fn validate_flash_target(
    target_device: &str,
    known_drives: &[RemovableDriveInfo],
) -> Result<(), String> {
    let trimmed = target_device.trim();
    if trimmed.is_empty() {
        return Err(
            tr_en(
                "Hedef blok aygıtı boş olamaz.",
                "Target block device cannot be empty.",
            )
            .to_string(),
        );
    }

    let upper = trimmed.to_ascii_uppercase();
    if upper == "C:"
        || upper == "C:\\"
        || upper.contains("PHYSICALDRIVE0")
        || trimmed == "/dev/sda"
        || trimmed == "/dev/nvme0n1"
        || trimmed == "/dev/vda"
    {
        return Err(crate::tf!(
            "Güvenlik Kilidi: Sistem diski ({trimmed}) üzerine doğrudan imaj yazımı kalıcı olarak engellenmiştir.",
            "Safety Lock: Direct image flashing onto the system disk ({trimmed}) is permanently blocked."
        ));
    }

    if let Some(matched) = known_drives.iter().find(|d| d.device_path.eq_ignore_ascii_case(trimmed)) {
        if matched.is_system_disk || !matched.removable {
            let name = &matched.name;
            let dev_path = &matched.device_path;
            return Err(crate::tf!(
                "Güvenlik Kilidi: '{name}' ({dev_path}) çıkarılabilir bir SD/USB medya olarak doğrulanamadı.",
                "Safety Lock: '{name}' ({dev_path}) could not be verified as removable SD/USB media."
            ));
        }
        return Ok(());
    }

    if trimmed.starts_with("mock://") {
        return Ok(());
    }

    Err(crate::tf!(
        "Güvenlik Kilidi: '{trimmed}' doğrulanan çıkarılabilir sürücüler listesinde bulunamadı.",
        "Safety Lock: '{trimmed}' was not found in the verified removable drives list."
    ))
}

pub fn build_flash_plan(
    image_path: &str,
    target_device: &str,
    known_drives: &[RemovableDriveInfo],
) -> Result<FlashPlan, String> {
    let trimmed_img = image_path.trim();
    if trimmed_img.is_empty() {
        return Err(
            tr_en(
                "Yazdırılacak WIC imaj yolu boş olamaz.",
                "WIC image path to flash cannot be empty.",
            )
            .to_string(),
        );
    }

    validate_flash_target(target_device, known_drives)?;

    let filename = Path::new(trimmed_img)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(trimmed_img)
        .to_string();

    let is_mock = target_device.starts_with("mock://");
    let use_bmap = trimmed_img.ends_with(".wic.bz2")
        || trimmed_img.ends_with(".wic.gz")
        || trimmed_img.ends_with(".wic.xz")
        || trimmed_img.ends_with(".wic");

    let (method, command) = if cfg!(windows) {
        if is_mock {
            (
                "dry-run-usbimager".to_string(),
                crate::tf!(
                    "bmaptool copy \"{trimmed_img}\" {target_device}  # Önizleme / Kuru Çalıştırma",
                    "bmaptool copy \"{trimmed_img}\" {target_device}  # Preview / Dry Run"
                ),
            )
        } else {
            (
                "usbimager-raw-write".to_string(),
                crate::tf!(
                    "usbimager.exe -w \"{trimmed_img}\" \"{target_device}\"  # veya bmaptool (WSL2 USB-IP)",
                    "usbimager.exe -w \"{trimmed_img}\" \"{target_device}\"  # or bmaptool (WSL2 USB-IP)"
                ),
            )
        }
    } else if use_bmap {
        (
            "bmaptool".to_string(),
            format!("sudo bmaptool copy \"{trimmed_img}\" \"{target_device}\""),
        )
    } else {
        (
            "dd".to_string(),
            format!("sudo dd if=\"{trimmed_img}\" of=\"{target_device}\" bs=4M status=progress conv=fsync"),
        )
    };

    let mut warnings = vec![
        crate::tf!(
            "Hedef aygıttaki ({target_device}) tüm bölümler silinecektir.",
            "All partitions on target device ({target_device}) will be erased."
        ),
        tr_en(
            "Yalnızca çıkarılabilir USB/SD sürücülere izin verilir; sistem diskleri kilitlidir.",
            "Only removable USB/SD drives are permitted; system disks are locked.",
        )
        .to_string(),
    ];
    if !trimmed_img.contains(".wic") && !trimmed_img.ends_with(".img") {
        warnings.push(
            tr_en(
                "Seçilen dosya standart bir .wic/.img disk imajı uzantısı taşımıyor.",
                "The selected file does not carry a standard .wic/.img disk image extension.",
            )
            .to_string(),
        );
    }

    Ok(FlashPlan {
        image_path: trimmed_img.to_string(),
        image_filename: filename,
        target_device: target_device.trim().to_string(),
        method,
        command,
        warnings,
        requires_elevation: !is_mock,
    })
}

pub fn default_host_export_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(profile) = std::env::var("USERPROFILE") {
            return PathBuf::from(profile).join("Downloads").join("yocto-artifacts");
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join("Downloads").join("yocto-artifacts");
        }
    }
    std::env::temp_dir().join("yocto-artifacts")
}

pub fn copy_artifact_to_host(
    source_path: &str,
    dest_dir: Option<&str>,
) -> Result<CopyArtifactResult, String> {
    let src = Path::new(source_path.trim());
    if !src.exists() || !src.is_file() {
        let src_disp = src.display();
        return Err(crate::tf!(
            "Kaynak çıktı dosyası host dosya sisteminde bulunamadı: {src_disp}",
            "Source artifact file was not found on the host filesystem: {src_disp}"
        ));
    }

    let target_dir = match dest_dir {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d.trim()),
        _ => default_host_export_dir(),
    };
    fs::create_dir_all(&target_dir).map_err(|e| {
        let dir_disp = target_dir.display();
        crate::tf!(
            "Hedef klasör oluşturulamadı ({dir_disp}): {e}",
            "Failed to create destination folder ({dir_disp}): {e}"
        )
    })?;

    let file_name = src.file_name().ok_or_else(|| {
        tr_en("Geçersiz kaynak dosya adı", "Invalid source filename").to_string()
    })?;
    let dest = target_dir.join(file_name);
    let bytes_copied = fs::copy(src, &dest).map_err(|e| {
        let dest_disp = dest.display();
        crate::tf!(
            "Dosya kopyalanamadı ({dest_disp}): {e}",
            "Failed to copy file ({dest_disp}): {e}"
        )
    })?;

    Ok(CopyArtifactResult {
        ok: true,
        source_path: src.to_string_lossy().to_string(),
        dest_path: dest.to_string_lossy().to_string(),
        bytes_copied,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_drives() -> Vec<RemovableDriveInfo> {
        vec![
            RemovableDriveInfo {
                id: "win-disk-0".to_string(),
                name: "NVMe System SSD".to_string(),
                device_path: "\\\\.\\PHYSICALDRIVE0".to_string(),
                size_bytes: 512_000_000_000,
                size_human: "476.8 GB".to_string(),
                bus_type: "NVME".to_string(),
                is_system_disk: true,
                removable: false,
                mount_points: vec!["C:\\".to_string()],
            },
            RemovableDriveInfo {
                id: "win-disk-2".to_string(),
                name: "SanDisk USB SD Reader".to_string(),
                device_path: "\\\\.\\PHYSICALDRIVE2".to_string(),
                size_bytes: 32_000_000_000,
                size_human: "29.8 GB".to_string(),
                bus_type: "USB".to_string(),
                is_system_disk: false,
                removable: true,
                mount_points: vec!["E:\\".to_string()],
            },
        ]
    }

    #[test]
    fn rejects_system_disk_and_c_drive() {
        let drives = sample_drives();
        assert!(build_flash_plan("image.wic.bz2", "\\\\.\\PHYSICALDRIVE0", &drives).is_err());
        assert!(build_flash_plan("image.wic.bz2", "C:\\", &drives).is_err());
        assert!(build_flash_plan("image.wic.bz2", "/dev/sda", &drives).is_err());
    }

    #[test]
    fn allows_verified_removable_drive_and_builds_plan() {
        let drives = sample_drives();
        let plan = build_flash_plan(
            "/home/yocto/deploy/core-image-minimal-imx8mp.rootfs.wic.bz2",
            "\\\\.\\PHYSICALDRIVE2",
            &drives,
        )
        .expect("removable USB drive should produce flash plan");
        assert!(plan.command.contains("PHYSICALDRIVE2"));
        assert!(!plan.warnings.is_empty());
    }

    #[test]
    fn copies_local_artifact_to_host_dir() {
        let tmp = std::env::temp_dir().join(format!("yocto_flash_test_{}", std::process::id()));
        let src_dir = tmp.join("src");
        let dst_dir = tmp.join("dst");
        fs::create_dir_all(&src_dir).unwrap();
        let src_file = src_dir.join("test-image.wic");
        fs::write(&src_file, b"YOCTO-WIC-BYTES").unwrap();

        let res = copy_artifact_to_host(
            src_file.to_str().unwrap(),
            Some(dst_dir.to_str().unwrap()),
        )
        .expect("copy should succeed");
        assert!(res.ok);
        assert_eq!(res.bytes_copied, 15);
        assert_eq!(fs::read(dst_dir.join("test-image.wic")).unwrap(), b"YOCTO-WIC-BYTES");
        let _ = fs::remove_dir_all(&tmp);
    }
}
