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

/// TI Sitara (AM62x / AM64x / AM335x) multi-stage USB DFU Boot Flasher via `dfu-util`.
pub struct TiDfuBootFlasher;

pub fn detect_ti_dfu_devices(dfu_bin: &str, include_mock: bool) -> Vec<UsbDetectedDevice> {
    let mut devices = Vec::new();
    let mut cmd = Command::new(dfu_bin);
    cmd.arg("-l");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(out) = cmd.output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for (idx, line) in text.lines().enumerate() {
            if line.contains("0451:") || line.to_ascii_lowercase().contains("sitara") {
                devices.push(UsbDetectedDevice {
                    id: format!("ti-dfu-{idx}"),
                    kind: "ti_dfu_boot".into(),
                    name: "TI Sitara AM62x/AM64x USB DFU".into(),
                    device_path: "0451:6165".into(),
                    size_bytes: 0,
                    size_human: "ROM DFU".into(),
                    bus_type: "USB".into(),
                    is_system_disk: false,
                    removable: true,
                    details: line.trim().to_string(),
                });
            }
        }
    }

    if include_mock {
        devices.push(UsbDetectedDevice {
            id: "mock-ti-am62x-dfu".into(),
            kind: "ti_dfu_boot".into(),
            name: tr_en(
                "TI AM625-SK Sitara ROM DFU (Simülasyon)",
                "TI AM625-SK Sitara ROM DFU (Simulation)",
            )
            .into(),
            device_path: "0451:6165".into(),
            size_bytes: 16 * 1024 * 1024 * 1024,
            size_human: "16 GB eMMC".into(),
            bus_type: "USB DFU".into(),
            is_system_disk: false,
            removable: true,
            details: "VID:PID 0451:6165 · alt=bootloader, tispl.bin, u-boot.img".into(),
        });
    }
    devices
}

fn resolve_ti_stages(req: &FlashRequest) -> Vec<(&'static str, String)> {
    let mut stages = Vec::new();
    if let Some(ref tiboot3) = req.ti_tiboot3_path {
        if !tiboot3.trim().is_empty() {
            stages.push(("bootloader", tiboot3.trim().to_string()));
        }
    }
    if let Some(ref tispl) = req.ti_tispl_path {
        if !tispl.trim().is_empty() {
            stages.push(("tispl.bin", tispl.trim().to_string()));
        }
    }
    if let Some(ref uboot) = req.bootloader_path {
        if !uboot.trim().is_empty() {
            stages.push(("u-boot.img", uboot.trim().to_string()));
        }
    }
    if !req.image_path.trim().is_empty() && !req.image_path.ends_with(".bin") {
        stages.push(("rootfs", req.image_path.trim().to_string()));
    }
    stages
}

impl TargetFlasher for TiDfuBootFlasher {
    fn kind(&self) -> &'static str {
        "ti_dfu_boot"
    }

    fn validate_request(&self, req: &FlashRequest) -> Result<(), String> {
        let stages = resolve_ti_stages(req);
        if stages.is_empty() {
            return Err(tr_en(
                "TI dfu-boot için en az tiboot3.bin veya hedef imaj yolu gereklidir.",
                "At least tiboot3.bin or a target image path is required for TI dfu-boot.",
            )
            .into());
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
        let bin = req.resolved_tool_bin.as_deref().unwrap_or("dfu-util");
        let vid_pid = req.vid_pid.as_deref().unwrap_or("0451:6165");
        let stages = resolve_ti_stages(req);
        let total = stages.len().max(1);

        if req.mock_mode {
            for (idx, (alt, file)) in stages.iter().enumerate() {
                if cancel.load(Ordering::Relaxed) {
                    return Err(tr_en(
                        "TI dfu-boot işlemi iptal edildi.",
                        "TI dfu-boot operation was cancelled.",
                    )
                    .into());
                }
                let pct = (((idx + 1) as f32) / (total as f32)) * 100.0;
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line: format!("[mock {bin} -d {vid_pid} -R -a {alt} -D {file}] DFU Stage OK"),
                    ts_ms: 0,
                });
                sink.emit_progress(DeployProgressEvent {
                    job_id: req.job_id.clone(),
                    phase: "ti-dfu-boot".into(),
                    percent: pct,
                    bytes_written: ((idx + 1) as u64) * 32_000_000,
                    total_bytes: (total as u64) * 32_000_000,
                    speed_mb_s: 14.2,
                    message: crate::tf!(
                        "TI Sitara DFU alt={alt} ({file}) yüklendi",
                        "Uploaded TI Sitara DFU alt={alt} ({file})"
                    ),
                });
                std::thread::sleep(std::time::Duration::from_millis(35));
            }
            return Ok(FlashOutcome {
                job_id: req.job_id.clone(),
                ok: true,
                sha256: req.confirmed_sha256.clone().unwrap_or_default(),
                bytes_written: (total as u64) * 32_000_000,
                summary: crate::tf!(
                    "Mock TI Sitara DFU ({total} aşama) başarıyla tamamlandı.",
                    "Mock TI Sitara DFU ({total} stage(s)) completed successfully."
                ),
            });
        }

        for (idx, (alt, file)) in stages.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(tr_en(
                    "TI dfu-boot işlemi iptal edildi.",
                    "TI dfu-boot operation was cancelled.",
                )
                .into());
            }
            let mut cmd = Command::new(bin);
            cmd.args(["-d", vid_pid, "-R", "-a", alt, "-D", file])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let mut child = cmd.spawn().map_err(|e| {
                crate::tf!(
                    "TI dfu-util başlatılamadı ({bin}): {e}",
                    "Failed to spawn TI dfu-util ({bin}): {e}"
                )
            })?;
            if let Some(stdout) = child.stdout.take() {
                for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                    sink.emit_log(DeployLogEvent {
                        job_id: req.job_id.clone(),
                        stream: "stdout".into(),
                        line,
                        ts_ms: 0,
                    });
                }
            }
            let status = child.wait().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(crate::tf!(
                    "TI DFU aşaması başarısız (alt={alt}).",
                    "TI DFU stage failed (alt={alt})."
                ));
            }
            let pct = (((idx + 1) as f32) / (total as f32)) * 100.0;
            sink.emit_progress(DeployProgressEvent {
                job_id: req.job_id.clone(),
                phase: "ti-dfu-boot".into(),
                percent: pct,
                bytes_written: 0,
                total_bytes: 0,
                speed_mb_s: 0.0,
                message: crate::tf!("alt={alt} tamamlandı", "alt={alt} completed"),
            });
        }

        Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: req.confirmed_sha256.clone().unwrap_or_default(),
            bytes_written: 0,
            summary: crate::tf!(
                "TI Sitara dfu-boot ({total} aşama) tamamlandı.",
                "TI Sitara dfu-boot ({total} stage(s)) completed."
            ),
        })
    }
}
