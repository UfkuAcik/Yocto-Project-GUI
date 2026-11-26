pub mod net_deploy;
pub mod serial;
pub mod staging;
pub mod usb_flashers;

use crate::deploy::usb_flashers::{
    custom_cli::CustomCliFlasher, dfu::DfuFlasher, fastboot::FastbootFlasher,
    mediatek_sp::MediaTekSpFlasher, nxp_uuu::NxpUuuFlasher, raw_disk::RawDiskFlasher,
    rockchip_rkdev::RockchipRkdevFlasher, stm32_prog::Stm32ProgFlasher,
    ti_dfu_boot::TiDfuBootFlasher,
};
use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployProgressEvent {
    pub job_id: String,
    pub phase: String,
    pub percent: f32,
    pub bytes_written: u64,
    pub total_bytes: u64,
    pub speed_mb_s: f64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployLogEvent {
    pub job_id: String,
    pub stream: String,
    pub line: String,
    pub ts_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeployStatusEvent {
    pub job_id: String,
    pub status: String, // "running" | "succeeded" | "failed" | "cancelled"
    pub summary: String,
    pub sha256: Option<String>,
}

pub trait DeployEventSink: Send + Sync {
    fn emit_progress(&self, ev: DeployProgressEvent);
    fn emit_log(&self, ev: DeployLogEvent);
    fn emit_status(&self, ev: DeployStatusEvent);
}

pub struct TauriEventSink {
    app: AppHandle,
}

impl TauriEventSink {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

impl DeployEventSink for TauriEventSink {
    fn emit_progress(&self, ev: DeployProgressEvent) {
        let _ = self.app.emit("deploy://progress", ev);
    }
    fn emit_log(&self, ev: DeployLogEvent) {
        let _ = self.app.emit("deploy://log", ev);
    }
    fn emit_status(&self, ev: DeployStatusEvent) {
        let _ = self.app.emit("deploy://status", ev);
    }
}

#[derive(Default)]
pub struct MemoryEventSink {
    pub progress: Mutex<Vec<DeployProgressEvent>>,
    pub logs: Mutex<Vec<DeployLogEvent>>,
    pub statuses: Mutex<Vec<DeployStatusEvent>>,
}

impl DeployEventSink for MemoryEventSink {
    fn emit_progress(&self, ev: DeployProgressEvent) {
        self.progress.lock().unwrap().push(ev);
    }
    fn emit_log(&self, ev: DeployLogEvent) {
        self.logs.lock().unwrap().push(ev);
    }
    fn emit_status(&self, ev: DeployStatusEvent) {
        self.statuses.lock().unwrap().push(ev);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PartitionMapping {
    pub partition: String,
    pub file_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FlashRequest {
    pub job_id: String,
    pub flasher_kind: String,
    pub image_path: String,
    pub deploy_dir: String,
    pub machine: String,
    pub kernel_path: String,
    pub dtb_path: String,
    pub serial_port: String,
    pub target_device: String,
    #[serde(default)]
    pub partition_map: Vec<PartitionMapping>,
    pub altsetting: Option<String>,
    pub vid_pid: Option<String>,
    pub uuu_mode: Option<String>,
    pub uuu_script_path: Option<String>,
    pub bootloader_path: Option<String>,
    pub tsv_path: Option<String>,
    pub custom_template: Option<String>,
    #[serde(default)]
    pub ti_tiboot3_path: Option<String>,
    #[serde(default)]
    pub ti_tispl_path: Option<String>,
    #[serde(default)]
    pub mtk_scatter_path: Option<String>,
    #[serde(default)]
    pub mtk_da_path: Option<String>,
    #[serde(default)]
    pub rk_loader_path: Option<String>,
    #[serde(default)]
    pub rk_lba_offset: Option<String>,
    #[serde(default)]
    pub verify_after_write: bool,
    #[serde(default)]
    pub reboot_after: bool,
    #[serde(default)]
    pub mock_mode: bool,
    #[serde(default)]
    pub confirmed: bool,
    pub confirmed_sha256: Option<String>,
    #[serde(default)]
    pub resolved_tool_bin: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlashOutcome {
    pub job_id: String,
    pub ok: bool,
    pub sha256: String,
    pub bytes_written: u64,
    pub summary: String,
}

pub trait TargetFlasher: Send + Sync {
    fn kind(&self) -> &'static str;
    fn validate_request(&self, req: &FlashRequest) -> Result<(), String>;
    fn execute(
        &self,
        req: &FlashRequest,
        cancel: Arc<AtomicBool>,
        sink: Arc<dyn DeployEventSink>,
    ) -> Result<FlashOutcome, String>;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FlashToolStatus {
    pub tool_id: String,
    pub display_name: String,
    pub binary: String,
    pub found: bool,
    pub resolved_path: Option<String>,
    pub version: Option<String>,
    pub install_hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsbDetectedDevice {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub device_path: String,
    pub size_bytes: u64,
    pub size_human: String,
    pub bus_type: String,
    pub is_system_disk: bool,
    pub removable: bool,
    pub details: String,
}

pub struct DeployManager {
    staging_root: Mutex<PathBuf>,
    active_jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    tool_overrides: Mutex<HashMap<String, String>>,
}

impl DeployManager {
    pub fn new(staging_root: PathBuf) -> Self {
        Self {
            staging_root: Mutex::new(staging_root),
            active_jobs: Arc::new(Mutex::new(HashMap::new())),
            tool_overrides: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_staging_root(&self, root: PathBuf) {
        *self.staging_root.lock().expect("staging root mutex") = root;
    }

    pub fn staging_root(&self) -> PathBuf {
        self.staging_root.lock().expect("staging root mutex").clone()
    }

    pub fn set_tool_override(&self, tool_id: String, path: String) {
        let mut guard = self.tool_overrides.lock().expect("tool overrides mutex");
        if path.trim().is_empty() {
            guard.remove(&tool_id);
        } else {
            guard.insert(tool_id, path.trim().to_string());
        }
    }

    pub fn resolve_tool_binary(&self, tool_id: &str, default_bin: &str) -> String {
        let guard = self.tool_overrides.lock().expect("tool overrides mutex");
        guard
            .get(tool_id)
            .cloned()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default_bin.to_string())
    }

    pub fn check_tools_health(&self) -> Vec<FlashToolStatus> {
        let specs = [
            (
                "fastboot",
                "Android / U-Boot Fastboot",
                "fastboot",
                "--version",
                tr_en(
                    "Android SDK Platform-Tools veya OS paket yöneticisiyle kurun.",
                    "Install via Android SDK Platform-Tools or your OS package manager.",
                ),
            ),
            (
                "dfu-util",
                "USB DFU (dfu-util)",
                "dfu-util",
                "--version",
                tr_en(
                    "dfu-util.sourceforge.net adresinden kurun.",
                    "Install from dfu-util.sourceforge.net or your OS package manager.",
                ),
            ),
            (
                "uuu",
                "NXP i.MX Universal Update (uuu)",
                "uuu",
                "-v",
                tr_en(
                    "NXP mfgtools (uuu) ikili dosyasını PATH'e ekleyin veya yolunu seçin.",
                    "Add the NXP mfgtools (uuu) binary to PATH or select its executable path.",
                ),
            ),
            (
                "stm32_prog",
                "STM32CubeProgrammer CLI",
                "STM32_Programmer_CLI",
                "--version",
                tr_en(
                    "STM32CubeProgrammer CLI kurup yolunu gösterin.",
                    "Install STM32CubeProgrammer CLI and configure its path.",
                ),
            ),
            (
                "rpiboot",
                "Raspberry Pi USB Boot (rpiboot)",
                "rpiboot",
                "-h",
                tr_en(
                    "raspberrypi/usbboot aracını kurun.",
                    "Install the raspberrypi/usbboot tool.",
                ),
            ),
            (
                "sp-flash-tool",
                "MediaTek SP Flash Tool",
                "sp-flash-tool",
                "--version",
                tr_en(
                    "MediaTek SP Flash Tool / genio-flash kurun.",
                    "Install MediaTek SP Flash Tool / genio-flash.",
                ),
            ),
            (
                "rkdeveloptool",
                "Rockchip Maskrom (rkdeveloptool)",
                "rkdeveloptool",
                "-v",
                tr_en(
                    "Rockchip rkdeveloptool aracını PATH'e ekleyin.",
                    "Add the Rockchip rkdeveloptool binary to PATH.",
                ),
            ),
        ];

        specs
            .into_iter()
            .map(|(id, display, default_bin, ver_arg, hint)| {
                let bin = self.resolve_tool_binary(id, default_bin);
                let resolved_path = resolve_in_path(&bin);
                let mut found = resolved_path.is_some();
                let mut version = None;

                if found || PathBuf::from(&bin).exists() {
                    let mut cmd = Command::new(&bin);
                    cmd.arg(ver_arg);
                    #[cfg(windows)]
                    cmd.creation_flags(CREATE_NO_WINDOW);
                    if let Ok(out) = cmd.output() {
                        found = true;
                        let first_line = String::from_utf8_lossy(&out.stdout)
                            .lines()
                            .chain(String::from_utf8_lossy(&out.stderr).lines())
                            .next()
                            .map(|s| s.trim().to_string());
                        version = first_line;
                    }
                }

                FlashToolStatus {
                    tool_id: id.into(),
                    display_name: display.into(),
                    binary: bin,
                    found,
                    resolved_path,
                    version,
                    install_hint: hint.into(),
                }
            })
            .collect()
    }

    pub fn resolve_flasher(&self, kind: &str) -> Result<Box<dyn TargetFlasher>, String> {
        match kind {
            "raw_disk" => Ok(Box::new(RawDiskFlasher)),
            "fastboot" => Ok(Box::new(FastbootFlasher)),
            "dfu" => Ok(Box::new(DfuFlasher)),
            "nxp_uuu" => Ok(Box::new(NxpUuuFlasher)),
            "stm32_prog" => Ok(Box::new(Stm32ProgFlasher)),
            "ti_dfu_boot" => Ok(Box::new(TiDfuBootFlasher)),
            "mediatek_sp" => Ok(Box::new(MediaTekSpFlasher)),
            "rockchip_rkdev" => Ok(Box::new(RockchipRkdevFlasher)),
            "custom_cli" => Ok(Box::new(CustomCliFlasher)),
            other => Err(crate::tf!(
                "Bilinmeyen USB flasher profili: {other}",
                "Unknown USB flasher profile: {other}"
            )),
        }
    }

    pub fn start_flash_job(
        &self,
        mut req: FlashRequest,
        sink: Arc<dyn DeployEventSink>,
    ) -> Result<String, String> {
        if !req.confirmed {
            return Err(
                tr_en(
                    "Güvenlik Kuralı: Yıkıcı flash işlemi için açık kullanıcı onayı (confirmed=true) gereklidir.",
                    "Safety Rule: Explicit user confirmation (confirmed=true) is required for a destructive flash operation.",
                )
                .into(),
            );
        }
        if req.job_id.trim().is_empty() {
            req.job_id = format!("job-{}", &Uuid::new_v4().to_string()[..8]);
        }

        if req.resolved_tool_bin.is_none() {
            req.resolved_tool_bin = match req.flasher_kind.as_str() {
                "fastboot" => Some(self.resolve_tool_binary("fastboot", "fastboot")),
                "dfu" | "ti_dfu_boot" => Some(self.resolve_tool_binary("dfu-util", "dfu-util")),
                "nxp_uuu" => Some(self.resolve_tool_binary("uuu", "uuu")),
                "stm32_prog" => Some(self.resolve_tool_binary("stm32_prog", "STM32_Programmer_CLI")),
                "mediatek_sp" => Some(self.resolve_tool_binary("sp-flash-tool", "sp-flash-tool")),
                "rockchip_rkdev" => Some(self.resolve_tool_binary("rkdeveloptool", "rkdeveloptool")),
                _ => None,
            };
        }

        let flasher = self.resolve_flasher(&req.flasher_kind)?;
        flasher.validate_request(&req)?;

        let job_id = req.job_id.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        self.active_jobs
            .lock()
            .expect("active_jobs mutex")
            .insert(job_id.clone(), Arc::clone(&cancel));

        let jobs_ref = Arc::clone(&self.active_jobs);
        let jid_for_thread = job_id.clone();
        let fkind = flasher.kind();
        sink.emit_status(DeployStatusEvent {
            job_id: job_id.clone(),
            status: "running".into(),
            summary: crate::tf!("{fkind} başlatıldı...", "Started {fkind}..."),
            sha256: req.confirmed_sha256.clone(),
        });

        std::thread::spawn(move || {
            let res = flasher.execute(&req, Arc::clone(&cancel), Arc::clone(&sink));
            if let Ok(mut guard) = jobs_ref.lock() {
                guard.remove(&jid_for_thread);
            }
            match res {
                Ok(outcome) => {
                    sink.emit_status(DeployStatusEvent {
                        job_id: jid_for_thread,
                        status: "succeeded".into(),
                        summary: outcome.summary,
                        sha256: if outcome.sha256.is_empty() {
                            None
                        } else {
                            Some(outcome.sha256)
                        },
                    });
                }
                Err(err) => {
                    let cancelled = cancel.load(Ordering::Relaxed);
                    sink.emit_status(DeployStatusEvent {
                        job_id: jid_for_thread,
                        status: if cancelled { "cancelled" } else { "failed" }.into(),
                        summary: err,
                        sha256: None,
                    });
                }
            }
        });

        Ok(job_id)
    }

    pub fn cancel_job(&self, job_id: &str) -> bool {
        if let Some(flag) = self
            .active_jobs
            .lock()
            .expect("active_jobs mutex")
            .get(job_id)
        {
            flag.store(true, Ordering::Relaxed);
            return true;
        }
        false
    }

    pub fn cancel_all(&self) {
        if let Ok(guard) = self.active_jobs.lock() {
            for flag in guard.values() {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }
}

fn resolve_in_path(bin: &str) -> Option<String> {
    let p = PathBuf::from(bin);
    if p.exists() && p.is_file() {
        return Some(p.to_string_lossy().to_string());
    }
    #[cfg(windows)]
    let probe_cmd = "where";
    #[cfg(not(windows))]
    let probe_cmd = "which";

    let mut cmd = Command::new(probe_cmd);
    cmd.arg(bin);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    if let Ok(out) = cmd.output() {
        if out.status.success() {
            if let Some(first) = String::from_utf8_lossy(&out.stdout).lines().next() {
                let t = first.trim();
                if !t.is_empty() {
                    return Some(t.to_string());
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::net_deploy::{
        rauc::{install_rauc_bundle, query_rauc_status, RaucInstallRequest},
        swupdate::{deploy_swupdate, SwUpdateRequest},
        tftp_server::{generate_uboot_tftp_script, TftpServerManager},
    };
    use crate::deploy::serial::{manager::SerialManager, manager::SerialOpenConfig};
    use crate::deploy::staging::{stage_artifact, StagingRequest};

    #[test]
    fn e2e_mock_usb_flash_flow() {
        let stage_dir = std::env::temp_dir().join(format!("yocto_e2e_usb_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&stage_dir);

        let staged = stage_artifact(
            &stage_dir,
            &StagingRequest {
                source_kind: "mock".into(),
                source_path: "/home/yocto/deploy/core-image-minimal-imx8mp.wic.bz2".into(),
                project_id: "proj-wrynose".into(),
                machine: "imx8mp-lpddr4-evk".into(),
                wsl_distro: None,
                docker_container: None,
                ssh_host: None,
                ssh_user: None,
                ssh_port: None,
                ssh_key_path: None,
                expected_sha256: None,
                mock_mode: true,
            },
        )
        .unwrap();
        assert!(staged.verified);

        let mgr = DeployManager::new(stage_dir.clone());
        let sink = Arc::new(MemoryEventSink::default());

        // Must fail without confirmed=true
        let unconfirmed = mgr.start_flash_job(
            FlashRequest {
                flasher_kind: "raw_disk".into(),
                image_path: staged.local_path.clone(),
                target_device: "mock://sd-card-industrial-32g".into(),
                mock_mode: true,
                confirmed: false,
                ..Default::default()
            },
            sink.clone(),
        );
        assert!(unconfirmed.is_err());

        // Succeeds with confirmed=true on safe mock target
        let _job_id = mgr
            .start_flash_job(
                FlashRequest {
                    flasher_kind: "raw_disk".into(),
                    image_path: staged.local_path,
                    target_device: "mock://sd-card-industrial-32g".into(),
                    verify_after_write: true,
                    mock_mode: true,
                    confirmed: true,
                    confirmed_sha256: Some(staged.sha256),
                    ..Default::default()
                },
                sink.clone(),
            )
            .unwrap();

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            if sink
                .statuses
                .lock()
                .unwrap()
                .iter()
                .any(|s| s.status == "succeeded")
            {
                break;
            }
            if std::time::Instant::now() >= deadline {
                panic!("e2e_mock_usb_flash_flow timed out: {:?}", sink.statuses.lock().unwrap());
            }
            std::thread::sleep(std::time::Duration::from_millis(30));
        }
        let _ = std::fs::remove_dir_all(&stage_dir);
    }

    #[tokio::test]
    async fn e2e_mock_tftp_rauc_swupdate_flow() {
        let dir = std::env::temp_dir().join(format!("yocto_e2e_net_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("Image-6.12"), b"KERNEL-BYTES").unwrap();

        let tftp = TftpServerManager::new();
        let st = tftp
            .start(None, "127.0.0.1", 0, dir.to_str().unwrap())
            .await
            .unwrap();
        assert!(st.running);
        let script = generate_uboot_tftp_script("192.168.10.2", "192.168.10.50", "Image-6.12", "imx8mp.dtb");
        assert!(script.contains("tftpboot"));
        tftp.stop().await;

        let rauc_status = query_rauc_status("192.168.10.50", "root", "", true).unwrap();
        assert_eq!(rauc_status.slots.len(), 2);

        let sink = Arc::new(MemoryEventSink::default());
        let rauc_res = install_rauc_bundle(
            &RaucInstallRequest {
                job_id: "j-rauc".into(),
                host: "192.168.10.50".into(),
                ssh_user: "root".into(),
                ssh_key_ref: "".into(),
                bundle_path: "update.raucb".into(),
                reboot_after: false,
                mock_mode: true,
                confirmed: true,
            },
            sink.clone(),
        )
        .unwrap();
        assert!(rauc_res.ok);

        let swu_res = deploy_swupdate(
            &SwUpdateRequest {
                job_id: "j-swu".into(),
                target_url: "http://192.168.10.50:8080".into(),
                swu_path: "core-image-minimal.swu".into(),
                mock_mode: true,
                confirmed: true,
            },
            sink.clone(),
        )
        .unwrap();
        assert!(swu_res.ok);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn e2e_mock_uart_uboot_auto_interrupt_flow() {
        let serial = SerialManager::new();
        let cap = Arc::new(Mutex::new(String::new()));
        let cap_ref = Arc::clone(&cap);
        let sid = serial
            .open_port(
                None,
                SerialOpenConfig {
                    port_name: "mock://uart-imx8mp".into(),
                    baud_rate: 115_200,
                    data_bits: 8,
                    parity: "none".into(),
                    stop_bits: 1,
                    auto_interrupt_uboot: true,
                    interrupt_key: Some("\r".into()),
                },
                Some(Arc::new(move |s| cap_ref.lock().unwrap().push_str(&s))),
            )
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(250));
        serial.write(&sid, "fastboot 0\r").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(80));
        let txt = cap.lock().unwrap().clone();
        assert!(txt.contains("u-boot=>"));
        assert!(txt.contains("Fastboot gadget"));
        serial.close(&sid).unwrap();
    }

    #[test]
    fn e2e_mock_vendor_flashers_ti_mediatek_rockchip() {
        let mgr = DeployManager::new(std::env::temp_dir().join("yocto_vendor_flasher_test"));
        for (kind, extra_lba) in [
            ("ti_dfu_boot", None),
            ("mediatek_sp", None),
            ("rockchip_rkdev", Some("0x2000")),
        ] {
            let sink = Arc::new(MemoryEventSink::default());
            mgr.start_flash_job(
                FlashRequest {
                    job_id: format!("j-{kind}"),
                    flasher_kind: kind.into(),
                    image_path: "core-image-minimal.wic".into(),
                    bootloader_path: Some("u-boot.img".into()),
                    ti_tiboot3_path: Some("tiboot3.bin".into()),
                    ti_tispl_path: Some("tispl.bin".into()),
                    mtk_scatter_path: Some("MT8395_scatter.txt".into()),
                    mtk_da_path: Some("MTK_AllInOne_DA.bin".into()),
                    rk_loader_path: Some("rk3588_spl_loader.bin".into()),
                    rk_lba_offset: extra_lba.map(ToString::to_string),
                    mock_mode: true,
                    confirmed: true,
                    ..Default::default()
                },
                sink.clone(),
            )
            .unwrap();

            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                if sink
                    .statuses
                    .lock()
                    .unwrap()
                    .iter()
                    .any(|s| s.status == "succeeded")
                {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    panic!("Timed out waiting for {kind}");
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
        }

        // Reject invalid Rockchip LBA injection attempts
        let sink = Arc::new(MemoryEventSink::default());
        let bad = mgr.start_flash_job(
            FlashRequest {
                job_id: "j-bad-rk".into(),
                flasher_kind: "rockchip_rkdev".into(),
                image_path: "image.wic".into(),
                rk_lba_offset: Some("0x10; rm -rf /".into()),
                mock_mode: true,
                confirmed: true,
                ..Default::default()
            },
            sink,
        );
        assert!(bad.is_err());
    }
}
