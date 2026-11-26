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

/// MediaTek Genio / MT83xx USB BROM/Preloader flasher via `sp-flash-tool`.
pub struct MediaTekSpFlasher;

pub fn detect_mediatek_devices(include_mock: bool) -> Vec<UsbDetectedDevice> {
    if !include_mock {
        return Vec::new();
    }
    vec![UsbDetectedDevice {
        id: "mock-mtk-genio-700".into(),
        kind: "mediatek_sp".into(),
        name: tr_en(
            "MediaTek Genio 700 EVK BROM/Preloader (Simülasyon)",
            "MediaTek Genio 700 EVK BROM/Preloader (Simulation)",
        )
        .into(),
        device_path: "0e8d:2000".into(),
        size_bytes: 32 * 1024 * 1024 * 1024,
        size_human: "32 GB UFS/eMMC".into(),
        bus_type: "USB BROM".into(),
        is_system_disk: false,
        removable: true,
        details: tr_en(
            "VID:PID 0e8d:2000 · sp-flash-tool / genio-flash uyumlu",
            "VID:PID 0e8d:2000 · sp-flash-tool / genio-flash compatible",
        )
        .into(),
    }]
}

impl TargetFlasher for MediaTekSpFlasher {
    fn kind(&self) -> &'static str {
        "mediatek_sp"
    }

    fn validate_request(&self, req: &FlashRequest) -> Result<(), String> {
        let scatter = req
            .mtk_scatter_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&req.image_path);
        if scatter.trim().is_empty() {
            return Err(tr_en(
                "MediaTek sp-flash-tool için scatter dosyası (`MT*_Android_scatter.txt`) gereklidir.",
                "A scatter file (`MT*_Android_scatter.txt`) is required for MediaTek sp-flash-tool.",
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
        let bin = req.resolved_tool_bin.as_deref().unwrap_or("sp-flash-tool");
        let scatter = req
            .mtk_scatter_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(&req.image_path)
            .trim();
        let da = req
            .mtk_da_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("MTK_AllInOne_DA.bin")
            .trim();

        if req.mock_mode {
            for (pct, msg) in [
                (
                    20.0,
                    crate::tf!(
                        "BROM el sıkışması ve Download Agent yükleme ({da})",
                        "BROM handshake and Download Agent upload ({da})"
                    ),
                ),
                (
                    50.0,
                    tr_en(
                        "preloader_genio700.bin + lk.img yazılıyor",
                        "Writing preloader_genio700.bin + lk.img",
                    )
                    .to_string(),
                ),
                (
                    82.0,
                    crate::tf!(
                        "rootfs bölümü flashlanıyor ({scatter})",
                        "Flashing rootfs partition ({scatter})"
                    ),
                ),
                (100.0, "Download Succeeded (DA checksum verified)".to_string()),
            ] {
                if cancel.load(Ordering::Relaxed) {
                    return Err(tr_en(
                        "MediaTek sp-flash-tool işlemi iptal edildi.",
                        "MediaTek sp-flash-tool operation was cancelled.",
                    )
                    .into());
                }
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line: format!("[mock {bin} -d {da} -s {scatter} -c download] {msg}"),
                    ts_ms: 0,
                });
                sink.emit_progress(DeployProgressEvent {
                    job_id: req.job_id.clone(),
                    phase: "mediatek-sp".into(),
                    percent: pct,
                    bytes_written: (pct as u64) * 1_600_000,
                    total_bytes: 160_000_000,
                    speed_mb_s: 34.8,
                    message: msg,
                });
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            return Ok(FlashOutcome {
                job_id: req.job_id.clone(),
                ok: true,
                sha256: req.confirmed_sha256.clone().unwrap_or_default(),
                bytes_written: 160_000_000,
                summary: crate::tf!(
                    "Mock MediaTek sp-flash-tool ({scatter}) başarıyla tamamlandı.",
                    "Mock MediaTek sp-flash-tool ({scatter}) completed successfully."
                ),
            });
        }

        let mut cmd = Command::new(bin);
        cmd.args(["-d", da, "-s", scatter, "-c", "download"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| {
            crate::tf!(
                "sp-flash-tool başlatılamadı ({bin}): {e}",
                "Failed to spawn sp-flash-tool ({bin}): {e}"
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
                "MediaTek sp-flash-tool başarısız oldu.",
                "MediaTek sp-flash-tool failed.",
            )
            .into());
        }
        Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: req.confirmed_sha256.clone().unwrap_or_default(),
            bytes_written: 0,
            summary: crate::tf!(
                "MediaTek sp-flash-tool ({scatter}) tamamlandı.",
                "MediaTek sp-flash-tool ({scatter}) completed."
            ),
        })
    }
}
