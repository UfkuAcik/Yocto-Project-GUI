use crate::deploy::{
    DeployEventSink, DeployLogEvent, DeployProgressEvent, FlashOutcome, FlashRequest, TargetFlasher,
};
use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DfuAltSetting {
    pub alt_index: u32,
    pub name: String,
    pub vid_pid: String,
    pub serial: String,
    pub interface: String,
}

pub fn parse_dfu_list(output: &str) -> Vec<DfuAltSetting> {
    let mut results = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with("Found DFU:") {
            continue;
        }
        let vid_pid = trimmed
            .split('[')
            .nth(1)
            .and_then(|s| s.split(']').next())
            .unwrap_or("0483:df11")
            .to_string();

        let alt_index = trimmed
            .split("alt=")
            .nth(1)
            .and_then(|s| s.split(',').next())
            .and_then(|n| n.trim().parse::<u32>().ok())
            .unwrap_or(0);

        let name = trimmed
            .split("name=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap_or("@unknown")
            .to_string();

        let serial = trimmed
            .split("serial=\"")
            .nth(1)
            .and_then(|s| s.split('"').next())
            .unwrap_or("")
            .to_string();

        results.push(DfuAltSetting {
            alt_index,
            name,
            vid_pid,
            serial,
            interface: format!("alt={alt_index}"),
        });
    }
    results
}

pub fn list_dfu_altsettings(bin: &str, mock: bool) -> Vec<DfuAltSetting> {
    let mut cmd = Command::new(bin);
    cmd.arg("-l");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            let parsed = parse_dfu_list(&String::from_utf8_lossy(&out.stdout));
            if !parsed.is_empty() {
                return parsed;
            }
        }
    }
    if mock {
        return vec![
            DfuAltSetting {
                alt_index: 0,
                name: "@FSBL /0x00/1*004Ke".into(),
                vid_pid: "0483:df11".into(),
                serial: "0029003B3438".into(),
                interface: "alt=0".into(),
            },
            DfuAltSetting {
                alt_index: 1,
                name: "@SSBL /0x00/1*002Me".into(),
                vid_pid: "0483:df11".into(),
                serial: "0029003B3438".into(),
                interface: "alt=1".into(),
            },
            DfuAltSetting {
                alt_index: 2,
                name: "@rootfs /0x00/1*256Me".into(),
                vid_pid: "0483:df11".into(),
                serial: "0029003B3438".into(),
                interface: "alt=2".into(),
            },
        ];
    }
    Vec::new()
}

pub struct DfuFlasher;

impl TargetFlasher for DfuFlasher {
    fn kind(&self) -> &'static str {
        "dfu"
    }

    fn validate_request(&self, req: &FlashRequest) -> Result<(), String> {
        if req.image_path.trim().is_empty() {
            return Err(tr_en(
                "DFU yüklemesi için imaj dosyası gereklidir.",
                "An image file is required for DFU flashing.",
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
        let bin = req.resolved_tool_bin.as_deref().unwrap_or("dfu-util");
        let vid_pid = req.vid_pid.as_deref().unwrap_or("0483:df11");
        let alt = req.altsetting.as_deref().unwrap_or("0");

        if req.mock_mode {
            for pct in [25.0, 50.0, 75.0, 100.0] {
                if cancel.load(Ordering::Relaxed) {
                    return Err(
                        tr_en("DFU yüklemesi iptal edildi.", "DFU upload was cancelled.").into(),
                    );
                }
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line: format!("[mock dfu-util -d {vid_pid} -a {alt}] Download [{pct:>3.0}%]"),
                    ts_ms: 0,
                });
                sink.emit_progress(DeployProgressEvent {
                    job_id: req.job_id.clone(),
                    phase: "dfu-download".into(),
                    percent: pct,
                    bytes_written: (pct as u64) * 512 * 1024,
                    total_bytes: 100 * 512 * 1024,
                    speed_mb_s: 12.6,
                    message: crate::tf!(
                        "USB DFU alt={alt} (%{pct:.0})",
                        "USB DFU alt={alt} ({pct:.0}%)"
                    ),
                });
                std::thread::sleep(std::time::Duration::from_millis(45));
            }
            return Ok(FlashOutcome {
                job_id: req.job_id.clone(),
                ok: true,
                sha256: req.confirmed_sha256.clone().unwrap_or_default(),
                bytes_written: 50 * 1024 * 1024,
                summary: crate::tf!(
                    "Mock USB DFU (alt={alt}, VID:PID={vid_pid}) tamamlandı.",
                    "Mock USB DFU (alt={alt}, VID:PID={vid_pid}) completed."
                ),
            });
        }

        let mut cmd = Command::new(bin);
        cmd.args(["-d", vid_pid, "-a", alt, "-D", req.image_path.trim()])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd.spawn().map_err(|e| {
            crate::tf!(
                "dfu-util başlatılamadı ({bin}): {e}",
                "Failed to spawn dfu-util ({bin}): {e}"
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
                "dfu-util sıfır dışı çıkış kodu ile sonlandı.",
                "dfu-util exited with a non-zero status code.",
            )
            .into());
        }
        Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: req.confirmed_sha256.clone().unwrap_or_default(),
            bytes_written: 0,
            summary: crate::tf!(
                "dfu-util ile alt={alt} ({vid_pid}) başarıyla yüklendi.",
                "Successfully flashed alt={alt} ({vid_pid}) via dfu-util."
            ),
        })
    }
}
