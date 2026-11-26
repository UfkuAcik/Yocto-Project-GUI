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

pub fn detect_uuu_devices(bin: &str, mock: bool) -> Vec<UsbDetectedDevice> {
    let mut devices = Vec::new();
    let mut cmd = Command::new(bin);
    cmd.arg("-lsusb");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    if let Ok(out) = cmd.output() {
        if out.status.success() {
            for (idx, line) in String::from_utf8_lossy(&out.stdout).lines().enumerate() {
                let t = line.trim();
                if t.is_empty() || t.starts_with("uuu ") || t.starts_with("Connected") {
                    continue;
                }
                devices.push(UsbDetectedDevice {
                    id: format!("uuu-{idx}"),
                    kind: "nxp_uuu".into(),
                    name: format!("NXP SDP/Fastboot ({t})"),
                    device_path: t.to_string(),
                    size_bytes: 0,
                    size_human: "SDP/eMMC".into(),
                    bus_type: "USB NXP uuu".into(),
                    is_system_disk: false,
                    removable: true,
                    details: t.to_string(),
                });
            }
        }
    }

    if devices.is_empty() && mock {
        devices.push(UsbDetectedDevice {
            id: "mock-uuu-01".into(),
            kind: "nxp_uuu".into(),
            name: tr_en(
                "NXP i.MX8MP SDP [1fc9:0146] (Simülasyon)",
                "NXP i.MX8MP SDP [1fc9:0146] (Simulation)",
            )
            .into(),
            device_path: "usb:1:14-1fc9:0146".into(),
            size_bytes: 0,
            size_human: "32 GB eMMC".into(),
            bus_type: "USB SDP (Mock uuu)".into(),
            is_system_disk: false,
            removable: true,
            details: "MX8MP SDP Serial Download Protocol".into(),
        });
    }
    devices
}

pub struct NxpUuuFlasher;

impl TargetFlasher for NxpUuuFlasher {
    fn kind(&self) -> &'static str {
        "nxp_uuu"
    }

    fn validate_request(&self, req: &FlashRequest) -> Result<(), String> {
        let has_script = req
            .uuu_script_path
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty());
        if !has_script && req.image_path.trim().is_empty() {
            return Err(tr_en(
                "NXP uuu için `.uuu` betiği veya bootloader + `.wic` imajı gereklidir.",
                "A `.uuu` script or bootloader + `.wic` image is required for NXP uuu.",
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
        let bin = req.resolved_tool_bin.as_deref().unwrap_or("uuu");
        let mode = req.uuu_mode.as_deref().unwrap_or("emmc_all");

        let args: Vec<String> = if let Some(script) = req
            .uuu_script_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            vec![script.trim().to_string()]
        } else {
            let boot = req
                .bootloader_path
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or("imx-boot");
            vec![
                "-b".into(),
                mode.to_string(),
                boot.to_string(),
                req.image_path.clone(),
            ]
        };

        if req.mock_mode {
            let stages = [
                ("SDPS: boot -f imx-boot", 25.0),
                ("FB: ucmd setenv fastboot_dev mmc", 50.0),
                (&format!("FB: flash -raw2sparse all {}", req.image_path), 85.0),
                ("FB: done", 100.0),
            ];
            for (line, pct) in stages {
                if cancel.load(Ordering::Relaxed) {
                    return Err(tr_en(
                        "uuu işlemi iptal edildi.",
                        "uuu operation was cancelled.",
                    )
                    .into());
                }
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line: format!("[mock uuu] {line}"),
                    ts_ms: 0,
                });
                sink.emit_progress(DeployProgressEvent {
                    job_id: req.job_id.clone(),
                    phase: "nxp-uuu".into(),
                    percent: pct,
                    bytes_written: (pct as u64) * 1_500_000,
                    total_bytes: 150_000_000,
                    speed_mb_s: 34.2,
                    message: line.to_string(),
                });
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let joined_args = args.join(" ");
            return Ok(FlashOutcome {
                job_id: req.job_id.clone(),
                ok: true,
                sha256: req.confirmed_sha256.clone().unwrap_or_default(),
                bytes_written: 150_000_000,
                summary: crate::tf!(
                    "Mock NXP uuu ({joined_args}) başarıyla tamamlandı.",
                    "Mock NXP uuu ({joined_args}) completed successfully."
                ),
            });
        }

        let mut cmd = Command::new(bin);
        cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| {
            crate::tf!(
                "uuu başlatılamadı ({bin}): {e}",
                "Failed to spawn uuu ({bin}): {e}"
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
            return Err(tr_en(
                "NXP uuu sıfır dışı çıkış kodu döndürdü.",
                "NXP uuu returned a non-zero exit code.",
            )
            .into());
        }
        Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: req.confirmed_sha256.clone().unwrap_or_default(),
            bytes_written: 0,
            summary: crate::tf!(
                "NXP uuu başarıyla tamamlandı ({bin}).",
                "NXP uuu completed successfully ({bin})."
            ),
        })
    }
}
