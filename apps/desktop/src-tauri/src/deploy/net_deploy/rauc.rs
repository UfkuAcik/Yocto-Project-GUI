use crate::deploy::{DeployEventSink, DeployLogEvent, DeployProgressEvent, FlashOutcome};
use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RaucSlotInfo {
    pub slot_name: String,
    pub class: String,
    pub device: String,
    pub state: String,
    pub bootname: String,
    pub boot_status: String,
    pub bundle_version: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RaucStatus {
    pub compatible: String,
    pub variant: String,
    pub booted: String,
    pub slots: Vec<RaucSlotInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RaucInstallRequest {
    pub job_id: String,
    pub host: String,
    pub ssh_user: String,
    pub ssh_key_ref: String,
    pub bundle_path: String,
    pub reboot_after: bool,
    pub mock_mode: bool,
    pub confirmed: bool,
}

pub fn parse_rauc_status_json(raw: &str) -> Result<RaucStatus, String> {
    let val: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        crate::tf!(
            "RAUC JSON ayrıştırılamadı: {e}",
            "Failed to parse RAUC JSON: {e}"
        )
    })?;
    let compatible = val["compatible"].as_str().unwrap_or("unknown").to_string();
    let variant = val["variant"].as_str().unwrap_or("default").to_string();
    let booted = val["booted"].as_str().unwrap_or("A").to_string();

    let mut slots = Vec::new();
    if let Some(arr) = val["slots"].as_array() {
        for item in arr {
            if let Some(obj) = item.as_object() {
                for (slot_name, meta) in obj {
                    let state = meta["state"].as_str().unwrap_or("inactive").to_string();
                    let active = state == "booted";
                    slots.push(RaucSlotInfo {
                        slot_name: slot_name.clone(),
                        class: meta["class"].as_str().unwrap_or("rootfs").to_string(),
                        device: meta["device"].as_str().unwrap_or("").to_string(),
                        state,
                        bootname: meta["bootname"].as_str().unwrap_or("").to_string(),
                        boot_status: meta["boot_status"].as_str().unwrap_or("good").to_string(),
                        bundle_version: meta["bundle"]["version"]
                            .as_str()
                            .unwrap_or("—")
                            .to_string(),
                        active,
                    });
                }
            }
        }
    }
    Ok(RaucStatus {
        compatible,
        variant,
        booted,
        slots,
    })
}

pub fn query_rauc_status(
    host: &str,
    user: &str,
    key_ref: &str,
    mock: bool,
) -> Result<RaucStatus, String> {
    if mock || host.trim().is_empty() {
        let mock_json = r#"{
            "compatible": "imx8mp-lpddr4-evk",
            "variant": "prod",
            "booted": "A",
            "slots": [
                {"rootfs.0": {"class": "rootfs", "device": "/dev/mmcblk2p2", "state": "booted", "bootname": "A", "boot_status": "good", "bundle": {"version": "2026.11.0"}}},
                {"rootfs.1": {"class": "rootfs", "device": "/dev/mmcblk2p3", "state": "inactive", "bootname": "B", "boot_status": "good", "bundle": {"version": "2026.10.2"}}}
            ]
        }"#;
        return parse_rauc_status_json(mock_json);
    }

    let clean_host = crate::providers::validate_ssh_token(host, "host")?;
    let clean_user = crate::providers::validate_ssh_token(user, "ssh_user")?;
    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"]);
    if !key_ref.trim().is_empty() && !key_ref.starts_with("keyring://") {
        let clean_key = crate::providers::validate_cli_path_arg(key_ref, "ssh_key_ref")?;
        cmd.args(["-i", clean_key]);
    }
    cmd.arg("--")
        .arg(format!("{clean_user}@{clean_host}"))
        .arg("rauc status --output-format=json");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let out = cmd.output().map_err(|e| {
        crate::tf!(
            "RAUC SSH sorgusu çalıştırılamadı: {e}",
            "Failed to run RAUC SSH query: {e}"
        )
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(crate::tf!(
            "rauc status hatası: {stderr}",
            "rauc status error: {stderr}"
        ));
    }
    parse_rauc_status_json(&String::from_utf8_lossy(&out.stdout))
}

pub fn install_rauc_bundle(
    req: &RaucInstallRequest,
    sink: Arc<dyn DeployEventSink>,
) -> Result<FlashOutcome, String> {
    if !req.confirmed {
        return Err(
            tr_en(
                "RAUC A/B slot güncellemesi için açık onay gereklidir.",
                "Explicit confirmation is required for a RAUC A/B slot update.",
            )
            .into(),
        );
    }
    if req.bundle_path.trim().is_empty() {
        return Err(
            tr_en(
                ".raucb paket yolu boş olamaz.",
                ".raucb bundle path cannot be empty.",
            )
            .into(),
        );
    }

    if req.mock_mode {
        let steps = [
            (
                20.0,
                tr_en(
                    "rauc install: bundle imzası CMS/X.509 ile doğrulandı",
                    "rauc install: bundle signature verified via CMS/X.509",
                ),
            ),
            (
                55.0,
                tr_en(
                    "Pasif slot rootfs.1 (/dev/mmcblk2p3) güncelleniyor",
                    "Updating inactive slot rootfs.1 (/dev/mmcblk2p3)",
                ),
            ),
            (
                85.0,
                tr_en(
                    "Bootloader slot önceliği B olarak işaretlendi (try-once)",
                    "Marked bootloader slot priority B as next active (try-once)",
                ),
            ),
            (
                100.0,
                tr_en("RAUC bundle kurulumu tamamlandı", "RAUC bundle installation completed"),
            ),
        ];
        for (pct, msg) in steps {
            sink.emit_log(DeployLogEvent {
                job_id: req.job_id.clone(),
                stream: "stdout".into(),
                line: format!("[mock rauc @ {}] {msg}", req.host),
                ts_ms: 0,
            });
            sink.emit_progress(DeployProgressEvent {
                job_id: req.job_id.clone(),
                phase: "rauc-install".into(),
                percent: pct,
                bytes_written: (pct as u64) * 512_000,
                total_bytes: 51_200_000,
                speed_mb_s: 28.0,
                message: msg.into(),
            });
            std::thread::sleep(Duration::from_millis(50));
        }
        let bpath = &req.bundle_path;
        return Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: String::new(),
            bytes_written: 51_200_000,
            summary: crate::tf!(
                "Mock RAUC ({bpath}) pasif slota başarıyla yüklendi.",
                "Mock RAUC ({bpath}) successfully installed to inactive slot."
            ),
        });
    }

    let clean_host = crate::providers::validate_ssh_token(&req.host, "host")?;
    let clean_user = crate::providers::validate_ssh_token(&req.ssh_user, "ssh_user")?;
    let clean_bundle = crate::providers::validate_cli_path_arg(&req.bundle_path, "bundle_path")?;

    let mut scp = Command::new("scp");
    scp.args(["-o", "BatchMode=yes"]);
    if !req.ssh_key_ref.trim().is_empty() && !req.ssh_key_ref.starts_with("keyring://") {
        let clean_key = crate::providers::validate_cli_path_arg(&req.ssh_key_ref, "ssh_key_ref")?;
        scp.args(["-i", clean_key]);
    }
    let remote_tmp = "/tmp/yocto-studio-update.raucb";
    scp.arg("--")
        .arg(clean_bundle)
        .arg(format!("{clean_user}@{clean_host}:{remote_tmp}"));
    #[cfg(windows)]
    scp.creation_flags(CREATE_NO_WINDOW);
    let scp_out = scp
        .output()
        .map_err(|e| crate::tf!("scp hatası: {e}", "scp error: {e}"))?;
    if !scp_out.status.success() {
        let stderr = String::from_utf8_lossy(&scp_out.stderr).trim().to_string();
        return Err(crate::tf!(
            "RAUC paketi cihaza aktarılamadı: {stderr}",
            "Failed to transfer RAUC bundle to target: {stderr}"
        ));
    }

    let mut ssh = Command::new("ssh");
    ssh.args(["-o", "BatchMode=yes"]);
    if !req.ssh_key_ref.trim().is_empty() && !req.ssh_key_ref.starts_with("keyring://") {
        let clean_key = crate::providers::validate_cli_path_arg(&req.ssh_key_ref, "ssh_key_ref")?;
        ssh.args(["-i", clean_key]);
    }
    let remote_cmd = if req.reboot_after {
        format!("rauc install {remote_tmp} && rm -f {remote_tmp} && systemctl reboot")
    } else {
        format!("rauc install {remote_tmp} && rm -f {remote_tmp}")
    };
    ssh.arg("--")
        .arg(format!("{clean_user}@{clean_host}"))
        .arg(&remote_cmd);
    #[cfg(windows)]
    ssh.creation_flags(CREATE_NO_WINDOW);
    let out = ssh
        .output()
        .map_err(|e| crate::tf!("rauc install hatası: {e}", "rauc install error: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    for line in stdout.lines() {
        sink.emit_log(DeployLogEvent {
            job_id: req.job_id.clone(),
            stream: "stdout".into(),
            line: line.to_string(),
            ts_ms: 0,
        });
    }
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(crate::tf!(
            "rauc install başarısız: {stderr}",
            "rauc install failed: {stderr}"
        ));
    }

    Ok(FlashOutcome {
        job_id: req.job_id.clone(),
        ok: true,
        sha256: String::new(),
        bytes_written: 0,
        summary: tr_en(
            "RAUC bundle kurulumu başarıyla tamamlandı.",
            "RAUC bundle installation completed successfully.",
        )
        .into(),
    })
}
