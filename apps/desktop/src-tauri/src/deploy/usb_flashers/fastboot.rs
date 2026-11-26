use crate::deploy::{
    DeployEventSink, DeployLogEvent, DeployProgressEvent, FlashOutcome, FlashRequest, TargetFlasher,
    UsbDetectedDevice,
};
use crate::i18n::tr_en;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn detect_fastboot_devices(bin: &str, mock: bool) -> Vec<UsbDetectedDevice> {
    let mut devices = Vec::new();
    let mut cmd = Command::new(bin);
    cmd.arg("devices");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Ok(out) = cmd.output() {
        if out.status.success() {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                let parts: Vec<&str> = line.split_whitespace().collect();
                if parts.len() >= 2 && parts[1].eq_ignore_ascii_case("fastboot") {
                    let serial = parts[0];
                    devices.push(UsbDetectedDevice {
                        id: format!("fb-{serial}"),
                        kind: "fastboot".into(),
                        name: crate::tf!(
                            "Fastboot Cihazı ({serial})",
                            "Fastboot Device ({serial})"
                        ),
                        device_path: serial.to_string(),
                        size_bytes: 0,
                        size_human: "eMMC/UFS".into(),
                        bus_type: "USB Fastboot".into(),
                        is_system_disk: false,
                        removable: true,
                        details: tr_en("fastboot flash hazır", "fastboot flash ready").into(),
                    });
                }
            }
        }
    }

    if devices.is_empty() && mock {
        devices.push(UsbDetectedDevice {
            id: "mock-fb-01".into(),
            kind: "fastboot".into(),
            name: tr_en(
                "NXP i.MX8MP U-Boot Fastboot (Simülasyon)",
                "NXP i.MX8MP U-Boot Fastboot (Simulation)",
            )
            .into(),
            device_path: "IMX8MP-FB-001".into(),
            size_bytes: 0,
            size_human: "16 GB eMMC".into(),
            bus_type: "USB Fastboot (Mock)".into(),
            is_system_disk: false,
            removable: true,
            details: "mock fastboot gadget".into(),
        });
    }
    devices
}

pub struct FastbootFlasher;

impl TargetFlasher for FastbootFlasher {
    fn kind(&self) -> &'static str {
        "fastboot"
    }

    fn validate_request(&self, req: &FlashRequest) -> Result<(), String> {
        if req.partition_map.is_empty() && req.image_path.trim().is_empty() {
            return Err(tr_en(
                "Fastboot için en az bir partition->dosya eşleşmesi veya imaj yolu gereklidir.",
                "At least one partition->file mapping or image path is required for Fastboot.",
            )
            .to_string());
        }
        Ok(())
    }

    fn execute(
        &self,
        req: &FlashRequest,
        cancel: Arc<AtomicBool>,
        sink: Arc<dyn DeployEventSink>,
    ) -> Result<FlashOutcome, String> {
        self.validate_request(req)?;
        let bin = req.resolved_tool_bin.as_deref().unwrap_or("fastboot");
        let mappings = if req.partition_map.is_empty() {
            vec![crate::deploy::PartitionMapping {
                partition: "rootfs".into(),
                file_path: req.image_path.clone(),
            }]
        } else {
            req.partition_map.clone()
        };

        let total_steps = mappings.len().max(1);
        if req.mock_mode {
            for (idx, m) in mappings.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    return Err(tr_en(
                        "Fastboot işlemi iptal edildi.",
                        "Fastboot operation was cancelled.",
                    )
                    .into());
                }
                let pct = (((idx + 1) as f32) / (total_steps as f32)) * 90.0;
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line: format!("[mock fastboot] Sending '{}' -> OKAY | Writing '{}' -> OKAY", m.file_path, m.partition),
                    ts_ms: 0,
                });
                let part = &m.partition;
                let fpath = &m.file_path;
                sink.emit_progress(DeployProgressEvent {
                    job_id: req.job_id.clone(),
                    phase: format!("fastboot flash {part}"),
                    percent: pct,
                    bytes_written: (idx as u64 + 1) * 1024 * 1024,
                    total_bytes: (total_steps as u64) * 1024 * 1024,
                    speed_mb_s: 42.0,
                    message: crate::tf!("Yazıldı: {part} ({fpath})", "Written: {part} ({fpath})"),
                });
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            if req.reboot_after {
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line: "[mock fastboot] Rebooting... OKAY".into(),
                    ts_ms: 0,
                });
            }
            return Ok(FlashOutcome {
                job_id: req.job_id.clone(),
                ok: true,
                sha256: req.confirmed_sha256.clone().unwrap_or_default(),
                bytes_written: (total_steps as u64) * 1024 * 1024,
                summary: crate::tf!(
                    "Mock Fastboot ile {total_steps} bölüm başarıyla flashlandı.",
                    "Successfully flashed {total_steps} partition(s) with Mock Fastboot."
                ),
            });
        }

        for (idx, m) in mappings.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(tr_en(
                    "Fastboot işlemi iptal edildi.",
                    "Fastboot operation was cancelled.",
                )
                .into());
            }
            let mut cmd = Command::new(bin);
            if !req.target_device.trim().is_empty() && !req.target_device.starts_with("mock://") {
                cmd.args(["-s", req.target_device.trim()]);
            }
            cmd.args(["flash", m.partition.trim(), m.file_path.trim()])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);

            let mut child = cmd.spawn().map_err(|e| {
                crate::tf!(
                    "fastboot çalıştırılamadı ({bin}): {e}",
                    "Failed to spawn fastboot ({bin}): {e}"
                )
            })?;
            if let Some(stderr) = child.stderr.take() {
                for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                    sink.emit_log(DeployLogEvent {
                        job_id: req.job_id.clone(),
                        stream: "stderr".into(),
                        line,
                        ts_ms: 0,
                    });
                }
            }
            let part = &m.partition;
            let status = child.wait().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(crate::tf!(
                    "fastboot flash {part} başarısız oldu.",
                    "fastboot flash {part} failed."
                ));
            }
            let pct = (((idx + 1) as f32) / (total_steps as f32)) * 95.0;
            sink.emit_progress(DeployProgressEvent {
                job_id: req.job_id.clone(),
                phase: format!("fastboot flash {part}"),
                percent: pct,
                bytes_written: 0,
                total_bytes: 0,
                speed_mb_s: 0.0,
                message: crate::tf!("Tamamlandı: {part}", "Completed: {part}"),
            });
        }

        if req.reboot_after {
            let mut rcmd = Command::new(bin);
            if !req.target_device.trim().is_empty() {
                rcmd.args(["-s", req.target_device.trim()]);
            }
            rcmd.arg("reboot");
            #[cfg(windows)]
            rcmd.creation_flags(CREATE_NO_WINDOW);
            let _ = rcmd.status();
        }

        Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: req.confirmed_sha256.clone().unwrap_or_default(),
            bytes_written: 0,
            summary: crate::tf!(
                "Fastboot ile {total_steps} bölüm başarıyla yüklendi.",
                "Successfully flashed {total_steps} partition(s) with Fastboot."
            ),
        })
    }
}
