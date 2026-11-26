use crate::deploy::{DeployEventSink, DeployLogEvent, DeployProgressEvent, FlashOutcome};
use crate::flash::format_bytes;
use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RemoteBlockDevice {
    pub name: String,
    pub path: String,
    pub size_bytes: u64,
    pub size_human: String,
    pub model: String,
    pub mountpoints: Vec<String>,
    pub is_active_root: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshRawFlashRequest {
    pub job_id: String,
    pub host: String,
    pub ssh_user: String,
    pub ssh_key_ref: String,
    pub image_path: String,
    pub target_device: String,
    pub use_bmaptool: bool,
    pub mock_mode: bool,
    pub confirmed: bool,
}

pub fn parse_lsblk_json(raw: &str) -> Result<Vec<RemoteBlockDevice>, String> {
    let val: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
        crate::tf!(
            "lsblk JSON ayrıştırılamadı: {e}",
            "Failed to parse lsblk JSON: {e}"
        )
    })?;
    let mut devices = Vec::new();
    let Some(arr) = val["blockdevices"].as_array() else {
        return Ok(devices);
    };

    for dev in arr {
        collect_dev(dev, &mut devices);
    }
    Ok(devices)
}

fn collect_dev(dev: &serde_json::Value, out: &mut Vec<RemoteBlockDevice>) {
    let name = dev["name"].as_str().unwrap_or("").to_string();
    if name.is_empty() || name.starts_with("loop") || name.starts_with("ram") {
        return;
    }
    let size_bytes = dev["size"]
        .as_u64()
        .or_else(|| dev["size"].as_str().and_then(|s| s.parse().ok()))
        .unwrap_or(0);
    let model = dev["model"].as_str().unwrap_or(&name).trim().to_string();

    let mut mounts = Vec::new();
    if let Some(m) = dev["mountpoint"].as_str() {
        mounts.push(m.to_string());
    }
    if let Some(arr) = dev["mountpoints"].as_array() {
        for m in arr {
            if let Some(s) = m.as_str() {
                mounts.push(s.to_string());
            }
        }
    }
    let is_active_root = mounts.iter().any(|m| m == "/" || m == "/boot" || m == "/usr");

    out.push(RemoteBlockDevice {
        path: format!("/dev/{name}"),
        name,
        size_bytes,
        size_human: format_bytes(size_bytes),
        model,
        mountpoints: mounts,
        is_active_root,
    });

    if let Some(children) = dev["children"].as_array() {
        for ch in children {
            collect_dev(ch, out);
        }
    }
}

pub fn list_remote_block_devices(
    host: &str,
    user: &str,
    key_ref: &str,
    mock: bool,
) -> Result<Vec<RemoteBlockDevice>, String> {
    if mock || host.trim().is_empty() {
        let sample = r#"{
            "blockdevices": [
                {
                    "name": "mmcblk2",
                    "size": 31914983424,
                    "model": "eMMC-32G",
                    "children": [
                        {"name": "mmcblk2p1", "size": 134217728, "mountpoint": "/boot"},
                        {"name": "mmcblk2p2", "size": 4294967296, "mountpoint": "/"},
                        {"name": "mmcblk2p3", "size": 4294967296, "mountpoint": null}
                    ]
                }
            ]
        }"#;
        return parse_lsblk_json(sample);
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
        .arg("lsblk -J -b -o NAME,SIZE,MODEL,MOUNTPOINT");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd
        .output()
        .map_err(|e| crate::tf!("SSH lsblk hatası: {e}", "SSH lsblk error: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(crate::tf!(
            "Uzak lsblk başarısız: {stderr}",
            "Remote lsblk failed: {stderr}"
        ));
    }
    parse_lsblk_json(&String::from_utf8_lossy(&out.stdout))
}

pub fn flash_remote_partition(
    req: &SshRawFlashRequest,
    sink: Arc<dyn DeployEventSink>,
) -> Result<FlashOutcome, String> {
    if !req.confirmed {
        return Err(
            tr_en(
                "SSH Raw bölüm yazımı için açık onay gereklidir.",
                "Explicit confirmation is required for SSH raw partition flashing.",
            )
            .into(),
        );
    }
    let clean_dev = crate::providers::validate_remote_block_device(&req.target_device)?;
    let devices = list_remote_block_devices(&req.host, &req.ssh_user, &req.ssh_key_ref, req.mock_mode)?;
    let Some(matched) = devices.iter().find(|d| d.path == clean_dev) else {
        return Err(crate::tf!(
            "Güvenlik Kilidi: Uzak aygıt ({clean_dev}) doğrulanmış lsblk cihaz listesinde bulunamadı.",
            "Safety Lock: Remote device ({clean_dev}) was not found in the verified lsblk device list."
        ));
    };
    if matched.is_active_root {
        let dev_path = &matched.path;
        return Err(crate::tf!(
            "Güvenlik Kilidi: Uzak aygıt ({dev_path}) aktif kök (/) veya /boot sistem bölümüdür; yazılamaz.",
            "Safety Lock: Remote device ({dev_path}) is an active root (/) or /boot system partition and cannot be overwritten."
        ));
    }

    if req.mock_mode {
        let target_dev = &req.target_device;
        let tool_name = if req.use_bmaptool { "bmaptool copy" } else { "dd conv=fsync" };
        for (pct, msg) in [
            (
                25.0,
                crate::tf!(
                    "SSH pipe açıldı -> {target_dev}",
                    "SSH pipe opened -> {target_dev}"
                ),
            ),
            (
                65.0,
                crate::tf!(
                    "{tool_name} akışı gönderiliyor",
                    "Streaming {tool_name}"
                ),
            ),
            (
                100.0,
                tr_en(
                    "Uzak bölüm SHA-256 doğrulandı",
                    "Remote partition SHA-256 verified",
                )
                .to_string(),
            ),
        ] {
            sink.emit_log(DeployLogEvent {
                job_id: req.job_id.clone(),
                stream: "stdout".into(),
                line: format!("[mock ssh_raw @ {}] {msg}", req.host),
                ts_ms: 0,
            });
            sink.emit_progress(DeployProgressEvent {
                job_id: req.job_id.clone(),
                phase: "ssh-raw-write".into(),
                percent: pct,
                bytes_written: (pct as u64) * 1_200_000,
                total_bytes: 120_000_000,
                speed_mb_s: 31.2,
                message: msg,
            });
            std::thread::sleep(Duration::from_millis(45));
        }
        return Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: String::new(),
            bytes_written: 120_000_000,
            summary: crate::tf!(
                "Mock SSH Raw ({target_dev}) tamamlandı.",
                "Mock SSH Raw ({target_dev}) completed."
            ),
        });
    }

    let mut file = File::open(Path::new(&req.image_path)).map_err(|e| {
        crate::tf!(
            "Yerel imaj açılamadı: {e}",
            "Failed to open local image: {e}"
        )
    })?;
    let mut payload = Vec::new();
    file.read_to_end(&mut payload).map_err(|e| e.to_string())?;

    let clean_host = crate::providers::validate_ssh_token(&req.host, "host")?;
    let clean_user = crate::providers::validate_ssh_token(&req.ssh_user, "ssh_user")?;
    let quoted_dev = crate::providers::shell_single_quote(clean_dev);
    let remote_cmd = if req.use_bmaptool {
        format!("cat > /tmp/yocto-part.img && bmaptool copy --nobmap /tmp/yocto-part.img {quoted_dev} && rm -f /tmp/yocto-part.img")
    } else {
        format!("dd of={quoted_dev} bs=4M conv=fsync status=none")
    };

    let mut cmd = Command::new("ssh");
    cmd.args(["-o", "BatchMode=yes"]);
    if !req.ssh_key_ref.trim().is_empty() && !req.ssh_key_ref.starts_with("keyring://") {
        let clean_key = crate::providers::validate_cli_path_arg(&req.ssh_key_ref, "ssh_key_ref")?;
        cmd.args(["-i", clean_key]);
    }
    cmd.arg("--")
        .arg(format!("{clean_user}@{clean_host}"))
        .arg(&remote_cmd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| {
        crate::tf!(
            "SSH pipe başlatılamadı: {e}",
            "Failed to start SSH pipe: {e}"
        )
    })?;
    if let Some(mut stdin) = child.stdin.take() {
        use std::io::Write;
        stdin.write_all(&payload).map_err(|e| e.to_string())?;
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(crate::tf!(
            "Uzak partition yazımı başarısız: {stderr}",
            "Remote partition write failed: {stderr}"
        ));
    }
    let dev = &req.target_device;
    let total_len = payload.len();
    Ok(FlashOutcome {
        job_id: req.job_id.clone(),
        ok: true,
        sha256: String::new(),
        bytes_written: total_len as u64,
        summary: crate::tf!(
            "{dev} üzerine {total_len} bayt SSH üzerinden yazıldı.",
            "Wrote {total_len} bytes to {dev} over SSH."
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::MemoryEventSink;

    fn sample_req(target_device: &str) -> SshRawFlashRequest {
        SshRawFlashRequest {
            job_id: "job-ssh-raw-test".into(),
            host: "192.168.10.50".into(),
            ssh_user: "root".into(),
            ssh_key_ref: String::new(),
            image_path: "core-image-minimal.wic".into(),
            target_device: target_device.into(),
            use_bmaptool: false,
            mock_mode: true,
            confirmed: true,
        }
    }

    #[test]
    fn ssh_raw_rejects_shell_injection_and_unlisted_devices() {
        let sink = Arc::new(MemoryEventSink::default());
        assert!(flash_remote_partition(&sample_req("/dev/mmcblk2p3; id"), sink.clone()).is_err());
        assert!(flash_remote_partition(&sample_req("/dev/sdb1"), sink.clone()).is_err());
        assert!(flash_remote_partition(&sample_req("/dev/mmcblk2p2"), sink.clone()).is_err());
        assert!(flash_remote_partition(&sample_req("/dev/mmcblk2p3"), sink).is_ok());
    }
}
