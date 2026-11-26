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

/// Rockchip RK3588 / RK3568 / RK3399 USB Maskrom flasher via `rkdeveloptool`.
pub struct RockchipRkdevFlasher;

pub fn validate_lba_offset(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok("0".to_string());
    }
    if let Some(hex_digits) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        if !hex_digits.is_empty() && hex_digits.chars().all(|c| c.is_ascii_hexdigit()) {
            return Ok(trimmed.to_string());
        }
    } else if trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Ok(trimmed.to_string());
    }
    Err(crate::tf!(
        "Geçersiz Rockchip LBA ofseti '{raw}': yalnızca sayısal veya 0x... hex değer kabul edilir.",
        "Invalid Rockchip LBA offset '{raw}': only decimal or 0x... hex values are allowed."
    ))
}

pub fn detect_rockchip_devices(rk_bin: &str, include_mock: bool) -> Vec<UsbDetectedDevice> {
    let mut devices = Vec::new();
    let mut cmd = Command::new(rk_bin);
    cmd.arg("ld");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(out) = cmd.output() {
        let text = String::from_utf8_lossy(&out.stdout);
        for (idx, line) in text.lines().enumerate() {
            if line.contains("DevNo=") && !line.contains("not found") {
                devices.push(UsbDetectedDevice {
                    id: format!("rk-usb-{idx}"),
                    kind: "rockchip_rkdev".into(),
                    name: "Rockchip USB Maskrom / Loader".into(),
                    device_path: format!("rkdev://{idx}"),
                    size_bytes: 0,
                    size_human: "eMMC/SPI".into(),
                    bus_type: "USB Maskrom".into(),
                    is_system_disk: false,
                    removable: true,
                    details: line.trim().to_string(),
                });
            }
        }
    }

    if include_mock {
        devices.push(UsbDetectedDevice {
            id: "mock-rk3588-maskrom".into(),
            kind: "rockchip_rkdev".into(),
            name: tr_en(
                "Rockchip RK3588 Maskrom USB [2207:350b] (Simülasyon)",
                "Rockchip RK3588 Maskrom USB [2207:350b] (Simulation)",
            )
            .into(),
            device_path: "rkdev://2207:350b".into(),
            size_bytes: 64 * 1024 * 1024 * 1024,
            size_human: "64 GB eMMC".into(),
            bus_type: "USB Maskrom".into(),
            is_system_disk: false,
            removable: true,
            details: "DevNo=1 Vid=0x2207 Pid=0x350b LocationID=104 Maskrom".into(),
        });
    }
    devices
}

impl TargetFlasher for RockchipRkdevFlasher {
    fn kind(&self) -> &'static str {
        "rockchip_rkdev"
    }

    fn validate_request(&self, req: &FlashRequest) -> Result<(), String> {
        if req.image_path.trim().is_empty() {
            return Err(tr_en(
                "Rockchip rkdeveloptool için imaj dosyası (.wic / .img) gereklidir.",
                "An image file (.wic / .img) is required for Rockchip rkdeveloptool.",
            )
            .into());
        }
        let lba = req.rk_lba_offset.as_deref().unwrap_or("0");
        validate_lba_offset(lba)?;
        Ok(())
    }

    fn execute(
        &self,
        req: &FlashRequest,
        cancel: Arc<AtomicBool>,
        sink: Arc<dyn DeployEventSink>,
    ) -> Result<FlashOutcome, String> {
        self.validate_request(req)?;
        let bin = req.resolved_tool_bin.as_deref().unwrap_or("rkdeveloptool");
        let loader = req
            .rk_loader_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("rk3588_spl_loader_v1.15.113.bin")
            .trim();
        let lba = validate_lba_offset(req.rk_lba_offset.as_deref().unwrap_or("0"))?;
        let img = req.image_path.trim();

        if req.mock_mode {
            for (pct, cmd_desc) in [
                (25.0, format!("{bin} db {loader}")),
                (85.0, format!("{bin} wl {lba} {img}")),
                (
                    100.0,
                    if req.reboot_after {
                        crate::tf!(
                            "{bin} rd (Cihaz yeniden başlatılıyor)",
                            "{bin} rd (Rebooting device)"
                        )
                    } else {
                        tr_en(
                            "Yazma tamamlandı (Write LBA OK)",
                            "Write completed (Write LBA OK)",
                        )
                        .to_string()
                    },
                ),
            ] {
                if cancel.load(Ordering::Relaxed) {
                    return Err(tr_en(
                        "Rockchip rkdeveloptool işlemi iptal edildi.",
                        "Rockchip rkdeveloptool operation was cancelled.",
                    )
                    .into());
                }
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line: format!("[mock] {cmd_desc}"),
                    ts_ms: 0,
                });
                sink.emit_progress(DeployProgressEvent {
                    job_id: req.job_id.clone(),
                    phase: "rockchip-rkdev".into(),
                    percent: pct,
                    bytes_written: (pct as u64) * 2_100_000,
                    total_bytes: 210_000_000,
                    speed_mb_s: 42.1,
                    message: cmd_desc,
                });
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            return Ok(FlashOutcome {
                job_id: req.job_id.clone(),
                ok: true,
                sha256: req.confirmed_sha256.clone().unwrap_or_default(),
                bytes_written: 210_000_000,
                summary: crate::tf!(
                    "Mock Rockchip rkdeveloptool (LBA {lba}) başarıyla yazıldı.",
                    "Mock Rockchip rkdeveloptool (LBA {lba}) flashed successfully."
                ),
            });
        }

        let steps: Vec<Vec<String>> = {
            let mut s = vec![
                vec!["db".into(), loader.into()],
                vec!["wl".into(), lba.clone(), img.into()],
            ];
            if req.reboot_after {
                s.push(vec!["rd".into()]);
            }
            s
        };

        for (idx, args) in steps.iter().enumerate() {
            if cancel.load(Ordering::Relaxed) {
                return Err(tr_en(
                    "Rockchip rkdeveloptool işlemi iptal edildi.",
                    "Rockchip rkdeveloptool operation was cancelled.",
                )
                .into());
            }
            let mut cmd = Command::new(bin);
            cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            let mut child = cmd.spawn().map_err(|e| {
                crate::tf!(
                    "rkdeveloptool başlatılamadı ({bin}): {e}",
                    "Failed to spawn rkdeveloptool ({bin}): {e}"
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
                    "rkdeveloptool alt komutu başarısız: {args:?}",
                    "rkdeveloptool subcommand failed: {args:?}"
                ));
            }
            let pct = (((idx + 1) as f32) / (steps.len() as f32)) * 100.0;
            sink.emit_progress(DeployProgressEvent {
                job_id: req.job_id.clone(),
                phase: "rockchip-rkdev".into(),
                percent: pct,
                bytes_written: 0,
                total_bytes: 0,
                speed_mb_s: 0.0,
                message: format!("rkdeveloptool {} OK", args[0]),
            });
        }

        Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: req.confirmed_sha256.clone().unwrap_or_default(),
            bytes_written: 0,
            summary: crate::tf!(
                "Rockchip rkdeveloptool ({img} @ LBA {lba}) tamamlandı.",
                "Rockchip rkdeveloptool ({img} @ LBA {lba}) completed."
            ),
        })
    }
}
