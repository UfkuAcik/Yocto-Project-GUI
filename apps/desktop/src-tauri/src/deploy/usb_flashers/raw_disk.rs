use crate::deploy::{
    DeployEventSink, DeployLogEvent, DeployProgressEvent, FlashOutcome, FlashRequest, TargetFlasher,
    UsbDetectedDevice,
};
use crate::flash::{list_removable_drives, RemovableDriveInfo};
use crate::i18n::tr_en;
use bzip2_rs::DecoderReader as BzDecoder;
use flate2::read::GzDecoder;
use ruzstd::StreamingDecoder as ZstdDecoder;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Instant;

pub fn list_safe_removable_drives(include_mock: bool) -> Vec<UsbDetectedDevice> {
    list_removable_drives(include_mock)
        .into_iter()
        .filter(|d| !d.is_system_disk && d.removable)
        .map(|d| UsbDetectedDevice {
            id: d.id,
            kind: "raw_disk".to_string(),
            name: d.name,
            device_path: d.device_path,
            size_bytes: d.size_bytes,
            size_human: d.size_human,
            bus_type: d.bus_type,
            is_system_disk: false,
            removable: true,
            details: if d.mount_points.is_empty() {
                tr_en(
                    "Çıkarılabilir SD / USB / UMS",
                    "Removable SD / USB / UMS",
                )
                .to_string()
            } else {
                let mnts = d.mount_points.join(", ");
                crate::tf!("Bağlı: {mnts}", "Mounted: {mnts}")
            },
        })
        .collect()
}

pub fn assert_safe_raw_target(
    device_path: &str,
    all_drives: &[RemovableDriveInfo],
) -> Result<(), String> {
    let trimmed = device_path.trim();
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
            "Güvenlik Kilidi (Zero-Brick): Sistem diski ({trimmed}) listelenmez ve yazılamaz.",
            "Safety Lock (Zero-Brick): System disk ({trimmed}) is hidden and cannot be overwritten."
        ));
    }

    if let Some(matched) = all_drives
        .iter()
        .find(|d| d.device_path.eq_ignore_ascii_case(trimmed))
    {
        if matched.is_system_disk || !matched.removable {
            let name = &matched.name;
            let dev_path = &matched.device_path;
            return Err(crate::tf!(
                "Güvenlik Kilidi (Zero-Brick): '{name}' ({dev_path}) sistem veya sabit disk olarak işaretlendiği için reddedildi.",
                "Safety Lock (Zero-Brick): '{name}' ({dev_path}) was rejected because it is flagged as a system or fixed disk."
            ));
        }
        return Ok(());
    }

    if trimmed.starts_with("mock://") {
        return Ok(());
    }

    Err(crate::tf!(
        "Güvenlik Kilidi: '{trimmed}' güvenli çıkarılabilir aygıt listesinde doğrulanamadı.",
        "Safety Lock: '{trimmed}' could not be verified in the safe removable devices list."
    ))
}

pub fn open_decompressed_reader(path: &Path) -> Result<Box<dyn Read>, String> {
    let path_disp = path.display();
    let file = File::open(path).map_err(|e| {
        crate::tf!(
            "İmaj dosyası açılamadı ({path_disp}): {e}",
            "Failed to open image file ({path_disp}): {e}"
        )
    })?;
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.ends_with(".bz2") {
        Ok(Box::new(BzDecoder::new(file)))
    } else if name.ends_with(".gz") {
        Ok(Box::new(GzDecoder::new(file)))
    } else if name.ends_with(".zst") {
        let dec = ZstdDecoder::new(file).map_err(|e| {
            crate::tf!(
                "zstd akışı başlatılamadı: {e}",
                "Failed to initialize zstd stream: {e}"
            )
        })?;
        Ok(Box::new(dec))
    } else {
        Ok(Box::new(file))
    }
}

pub struct RawDiskFlasher;

impl TargetFlasher for RawDiskFlasher {
    fn kind(&self) -> &'static str {
        "raw_disk"
    }

    fn validate_request(&self, req: &FlashRequest) -> Result<(), String> {
        if req.image_path.trim().is_empty() {
            return Err(
                tr_en(
                    "Yazdırılacak imaj yolu boş olamaz.",
                    "Image path to flash cannot be empty.",
                )
                .to_string(),
            );
        }
        let all_drives = list_removable_drives(true);
        assert_safe_raw_target(&req.target_device, &all_drives)
    }

    fn execute(
        &self,
        req: &FlashRequest,
        cancel: Arc<AtomicBool>,
        sink: Arc<dyn DeployEventSink>,
    ) -> Result<FlashOutcome, String> {
        self.validate_request(req)?;

        if req.mock_mode || req.target_device.starts_with("mock://") {
            let total = 148 * 1024 * 1024u64;
            let img = &req.image_path;
            let dev = &req.target_device;
            for step in 1..=5 {
                if cancel.load(Ordering::Relaxed) {
                    return Err(tr_en(
                        "Flash işlemi kullanıcı tarafından iptal edildi.",
                        "Flash operation was cancelled by user.",
                    )
                    .to_string());
                }
                let pct = (step as f32) * 20.0;
                let written = (total * step as u64) / 5;
                let written_mb = (written as f64) / (1024.0 * 1024.0);
                sink.emit_progress(DeployProgressEvent {
                    job_id: req.job_id.clone(),
                    phase: if step < 5 {
                        "raw-stream-write".into()
                    } else if req.verify_after_write {
                        "sha256-verify".into()
                    } else {
                        "sync-flush".into()
                    },
                    percent: pct,
                    bytes_written: written,
                    total_bytes: total,
                    speed_mb_s: 38.4,
                    message: crate::tf!(
                        "Mock UMS/SD yazımı: {img} -> {dev} (%{pct:.0})",
                        "Mock UMS/SD write: {img} -> {dev} ({pct:.0}%)"
                    ),
                });
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line: crate::tf!(
                        "[raw_disk] Blok akışı %{pct:.0} ({written_mb:.1} MB / 148.0 MB) [38.4 MB/s]",
                        "[raw_disk] Block stream {pct:.0}% ({written_mb:.1} MB / 148.0 MB) [38.4 MB/s]"
                    ),
                    ts_ms: 0,
                });
                std::thread::sleep(std::time::Duration::from_millis(60));
            }
            let digest = req
                .confirmed_sha256
                .clone()
                .unwrap_or_else(|| "mock-sha256-verified-0000".to_string());
            return Ok(FlashOutcome {
                job_id: req.job_id.clone(),
                ok: true,
                sha256: digest,
                bytes_written: total,
                summary: crate::tf!(
                    "Mock raw disk yazımı tamamlandı: {dev}",
                    "Mock raw disk write completed: {dev}"
                ),
            });
        }

        let src_path = Path::new(&req.image_path);
        let compressed_len = fs::metadata(src_path).map(|m| m.len()).unwrap_or(0).max(1);
        let mut reader = open_decompressed_reader(src_path)?;
        let dev = &req.target_device;
        let mut writer = OpenOptions::new().write(true).open(dev).map_err(|e| {
            crate::tf!(
                "Hedef aygıt yazılamadı ({dev}): {e}",
                "Failed to open target device for writing ({dev}): {e}"
            )
        })?;

        let start = Instant::now();
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1024 * 1024];
        let mut bytes_written: u64 = 0;

        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(tr_en(
                    "Flash işlemi kullanıcı tarafından iptal edildi.",
                    "Flash operation was cancelled by user.",
                )
                .to_string());
            }
            let n = match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    return Err(crate::tf!(
                        "İmaj açma/okuma hatası: {e}",
                        "Image decompress/read error: {e}"
                    ))
                }
            };
            writer.write_all(&buf[..n]).map_err(|e| {
                crate::tf!(
                    "Hedef aygıta yazma hatası: {e}",
                    "Target device write error: {e}"
                )
            })?;
            hasher.update(&buf[..n]);
            bytes_written += n as u64;

            let secs = start.elapsed().as_secs_f64().max(0.05);
            let mb_s = (bytes_written as f64 / (1024.0 * 1024.0)) / secs;
            let written_mb = bytes_written as f64 / 1_048_576.0;
            let est_pct = ((bytes_written as f32 / compressed_len as f32) * 90.0).min(95.0);
            sink.emit_progress(DeployProgressEvent {
                job_id: req.job_id.clone(),
                phase: "raw-stream-write".into(),
                percent: est_pct,
                bytes_written,
                total_bytes: compressed_len,
                speed_mb_s: mb_s,
                message: crate::tf!(
                    "Yazılıyor: {written_mb:.1} MB ({mb_s:.1} MB/s)",
                    "Writing: {written_mb:.1} MB ({mb_s:.1} MB/s)"
                ),
            });
        }

        writer.flush().map_err(|e| {
            crate::tf!("Disk flush hatası: {e}", "Disk flush error: {e}")
        })?;
        let digest = hex::encode(hasher.finalize());
        let short_digest = &digest[..12.min(digest.len())];
        sink.emit_progress(DeployProgressEvent {
            job_id: req.job_id.clone(),
            phase: "completed".into(),
            percent: 100.0,
            bytes_written,
            total_bytes: bytes_written,
            speed_mb_s: 0.0,
            message: crate::tf!(
                "Tamamlandı ({bytes_written} bayt, SHA-256: {short_digest})",
                "Completed ({bytes_written} bytes, SHA-256: {short_digest})"
            ),
        });

        Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: digest,
            bytes_written,
            summary: crate::tf!(
                "{dev} aygıtına {bytes_written} bayt güvenle yazıldı.",
                "Safely wrote {bytes_written} bytes to {dev}."
            ),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::write::GzEncoder;
    use flate2::Compression;

    #[test]
    fn excludes_os_disks_from_selectable_list() {
        let safe = list_safe_removable_drives(true);
        assert!(!safe.is_empty());
        for d in &safe {
            assert!(!d.is_system_disk);
            assert!(d.removable);
            assert!(!d.device_path.to_ascii_uppercase().contains("PHYSICALDRIVE0"));
            assert_ne!(d.device_path, "/dev/sda");
            assert_ne!(d.device_path, "C:\\");
        }
    }

    #[test]
    fn rejects_system_disks_in_raw_flasher() {
        let drives = vec![RemovableDriveInfo {
            id: "sys0".into(),
            name: "OS SSD".into(),
            device_path: "\\\\.\\PHYSICALDRIVE0".into(),
            size_bytes: 512_000_000_000,
            size_human: "476.8 GB".into(),
            bus_type: "NVME".into(),
            is_system_disk: true,
            removable: false,
            mount_points: vec!["C:\\".into()],
        }];
        assert!(assert_safe_raw_target("\\\\.\\PHYSICALDRIVE0", &drives).is_err());
        assert!(assert_safe_raw_target("C:\\", &drives).is_err());
        assert!(assert_safe_raw_target("/dev/sda", &drives).is_err());
        assert!(assert_safe_raw_target("/dev/nvme0n1", &drives).is_err());
    }

    #[test]
    fn decompresses_gzip_stream_correctly() {
        let dir = std::env::temp_dir().join(format!("yocto_gz_{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let gz_path = dir.join("test.wic.gz");
        {
            let f = File::create(&gz_path).unwrap();
            let mut enc = GzEncoder::new(f, Compression::fast());
            enc.write_all(b"YOCTO-WIC-GZ-STREAM-OK").unwrap();
            enc.finish().unwrap();
        }
        let mut reader = open_decompressed_reader(&gz_path).unwrap();
        let mut out = Vec::new();
        reader.read_to_end(&mut out).unwrap();
        assert_eq!(out, b"YOCTO-WIC-GZ-STREAM-OK");
        let _ = fs::remove_dir_all(&dir);
    }
}
