use crate::deploy::{
    DeployEventSink, DeployLogEvent, DeployProgressEvent, FlashOutcome, FlashRequest, TargetFlasher,
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

pub struct Stm32ProgFlasher;

impl TargetFlasher for Stm32ProgFlasher {
    fn kind(&self) -> &'static str {
        "stm32_prog"
    }

    fn validate_request(&self, req: &FlashRequest) -> Result<(), String> {
        let tsv = req
            .tsv_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&req.image_path);
        if tsv.trim().is_empty() {
            return Err(tr_en(
                "STM32_Programmer_CLI için `.tsv` FlashLayout dosyası gereklidir.",
                "A `.tsv` FlashLayout file is required for STM32_Programmer_CLI.",
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
        let bin = req
            .resolved_tool_bin
            .as_deref()
            .unwrap_or("STM32_Programmer_CLI");
        let tsv = req
            .tsv_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&req.image_path);

        if req.mock_mode {
            for (step, msg) in [
                (25.0, "Phase 0x01 FSBL (tf-a-stm32mp157.stm32)"),
                (55.0, "Phase 0x03 SSBL (fip-stm32mp157.bin)"),
                (85.0, "Phase 0x04 bootfs + rootfs (.ext4)"),
                (100.0, "Flashing service completed successfully"),
            ] {
                if cancel.load(Ordering::Relaxed) {
                    return Err(tr_en(
                        "STM32_Programmer_CLI işlemi iptal edildi.",
                        "STM32_Programmer_CLI operation was cancelled.",
                    )
                    .into());
                }
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line: format!("[mock STM32_Programmer_CLI -w {tsv}] {msg}"),
                    ts_ms: 0,
                });
                sink.emit_progress(DeployProgressEvent {
                    job_id: req.job_id.clone(),
                    phase: "stm32-tsv".into(),
                    percent: step,
                    bytes_written: (step as u64) * 1_000_000,
                    total_bytes: 100_000_000,
                    speed_mb_s: 19.5,
                    message: msg.into(),
                });
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            return Ok(FlashOutcome {
                job_id: req.job_id.clone(),
                ok: true,
                sha256: req.confirmed_sha256.clone().unwrap_or_default(),
                bytes_written: 100_000_000,
                summary: crate::tf!(
                    "Mock STM32 FlashLayout ({tsv}) başarıyla yüklendi.",
                    "Mock STM32 FlashLayout ({tsv}) flashed successfully."
                ),
            });
        }

        let mut cmd = Command::new(bin);
        cmd.args(["-c", "port=usb1", "-w", tsv.trim()])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| {
            crate::tf!(
                "STM32_Programmer_CLI başlatılamadı ({bin}): {e}",
                "Failed to spawn STM32_Programmer_CLI ({bin}): {e}"
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
                "STM32_Programmer_CLI başarısız oldu.",
                "STM32_Programmer_CLI failed.",
            )
            .into());
        }
        Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: req.confirmed_sha256.clone().unwrap_or_default(),
            bytes_written: 0,
            summary: crate::tf!(
                "STM32_Programmer_CLI ({tsv}) tamamlandı.",
                "STM32_Programmer_CLI ({tsv}) completed."
            ),
        })
    }
}
