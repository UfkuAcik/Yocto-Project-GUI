use crate::deploy::{
    DeployEventSink, DeployLogEvent, DeployProgressEvent, FlashOutcome,
};
use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SwUpdateRequest {
    pub job_id: String,
    pub target_url: String,
    pub swu_path: String,
    pub mock_mode: bool,
    pub confirmed: bool,
}

pub fn validate_swupdate_inputs(target_url: &str, swu_path: &str) -> Result<(String, String), String> {
    let raw_url = target_url.trim();
    let raw_path = swu_path.trim();
    if raw_url.is_empty() || raw_path.is_empty() {
        return Err(
            tr_en(
                "SWUpdate hedef URL ve `.swu` dosya yolu zorunludur.",
                "SWUpdate target URL and `.swu` file path are required.",
            )
            .into(),
        );
    }
    if raw_url.chars().any(|c| c.is_whitespace() || c.is_control()) || raw_url.contains('@') {
        return Err(tr_en(
            "Güvenlik Kısıtı: SWUpdate hedef URL geçersiz karakter içeriyor.",
            "Security Constraint: SWUpdate target URL contains invalid characters.",
        )
        .into());
    }
    let trimmed = raw_url.trim_start_matches("http://").trim_end_matches('/');
    let host_port = trimmed.split('/').next().unwrap_or("");
    let addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:8080")
    };
    if host_port.is_empty()
        || addr.is_empty()
        || addr
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '/' | '@'))
    {
        return Err(tr_en(
            "Güvenlik Kısıtı: Geçersiz SWUpdate sunucu adresi.",
            "Security Constraint: Invalid SWUpdate server address.",
        )
        .into());
    }

    if raw_path.chars().any(|c| matches!(c, '\r' | '\n' | '\0')) {
        return Err(tr_en(
            "Güvenlik Kısıtı: `.swu` dosya yolu kontrol karakteri içeremez.",
            "Security Constraint: `.swu` file path cannot contain control characters.",
        )
        .into());
    }
    let filename = Path::new(raw_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("update.swu");
    if filename.is_empty()
        || filename
            .chars()
            .any(|c| matches!(c, '\r' | '\n' | '\0' | '"' | '/' | '\\') || c.is_control())
    {
        return Err(tr_en(
            "Güvenlik Kısıtı: Geçersiz `.swu` dosya adı.",
            "Security Constraint: Invalid `.swu` filename.",
        )
        .into());
    }
    Ok((addr, filename.to_string()))
}

pub fn deploy_swupdate(
    req: &SwUpdateRequest,
    sink: Arc<dyn DeployEventSink>,
) -> Result<FlashOutcome, String> {
    if !req.confirmed {
        return Err(
            tr_en(
                "SWUpdate yüklemesi için kullanıcı onayı gereklidir.",
                "User confirmation is required for SWUpdate upload.",
            )
            .into(),
        );
    }
    let (addr, filename) = validate_swupdate_inputs(&req.target_url, &req.swu_path)?;

    if req.mock_mode {
        let stages = [
            (
                15.0,
                tr_en(
                    "SWUpdate HTTP POST /upload başlatılıyor",
                    "Starting SWUpdate HTTP POST /upload",
                ),
            ),
            (
                40.0,
                tr_en(
                    "sw-description imzası ve donanım uyumluluğu doğrulandı",
                    "Verified sw-description signature and hardware compatibility",
                ),
            ),
            (
                70.0,
                tr_en(
                    "Pasif rootfs slotu (/dev/mmcblk2p3) yazılıyor",
                    "Writing inactive rootfs slot (/dev/mmcblk2p3)",
                ),
            ),
            (
                92.0,
                tr_en(
                    "SHA-256 doğrulandı, bootloader env güncellendi",
                    "SHA-256 verified, bootloader environment updated",
                ),
            ),
            (
                100.0,
                tr_en(
                    "SWUpdate OTA güncellemesi başarıyla tamamlandı (SUCCESS)",
                    "SWUpdate OTA update completed successfully (SUCCESS)",
                ),
            ),
        ];
        for (pct, msg) in stages {
            sink.emit_log(DeployLogEvent {
                job_id: req.job_id.clone(),
                stream: "stdout".into(),
                line: format!("[mock swupdate @ {}] {msg}", req.target_url),
                ts_ms: 0,
            });
            sink.emit_progress(DeployProgressEvent {
                job_id: req.job_id.clone(),
                phase: "swupdate-ota".into(),
                percent: pct,
                bytes_written: (pct as u64) * 640_000,
                total_bytes: 64_000_000,
                speed_mb_s: 21.4,
                message: msg.into(),
            });
            std::thread::sleep(Duration::from_millis(55));
        }
        let target_url = &req.target_url;
        return Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: String::new(),
            bytes_written: 64_000_000,
            summary: crate::tf!(
                "Mock SWUpdate OTA ({target_url}) başarıyla tamamlandı.",
                "Mock SWUpdate OTA ({target_url}) completed successfully."
            ),
        });
    }

    let swu_path = &req.swu_path;
    let swu_bytes = std::fs::read(Path::new(swu_path)).map_err(|e| {
        crate::tf!(
            ".swu paketi okunamadı ({swu_path}): {e}",
            "Failed to read .swu package ({swu_path}): {e}"
        )
    })?;
    let boundary = "----YoctoStudioSWUpdateBoundary7f3a";
    let head = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
    );
    let tail = format!("\r\n--{boundary}--\r\n");
    let content_len = head.len() + swu_bytes.len() + tail.len();
    let req_hdr = format!(
        "POST /upload HTTP/1.1\r\nHost: {addr}\r\nContent-Type: multipart/form-data; boundary={boundary}\r\nContent-Length: {content_len}\r\nConnection: close\r\n\r\n"
    );

    let mut stream = TcpStream::connect(&addr).map_err(|e| {
        crate::tf!(
            "SWUpdate sunucusuna bağlanılamadı ({addr}): {e}",
            "Failed to connect to SWUpdate server ({addr}): {e}"
        )
    })?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    stream.write_all(req_hdr.as_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(head.as_bytes()).map_err(|e| e.to_string())?;
    stream.write_all(&swu_bytes).map_err(|e| e.to_string())?;
    stream.write_all(tail.as_bytes()).map_err(|e| e.to_string())?;
    stream.flush().map_err(|e| e.to_string())?;

    let mut resp = String::new();
    let _ = stream.read_to_string(&mut resp);
    sink.emit_log(DeployLogEvent {
        job_id: req.job_id.clone(),
        stream: "stdout".into(),
        line: resp.lines().next().unwrap_or("HTTP response received").to_string(),
        ts_ms: 0,
    });

    if !resp.contains("200") && !resp.contains("201") {
        return Err(crate::tf!(
            "SWUpdate HTTP yüklemesi beklenmeyen yanıt döndürdü: {resp}",
            "SWUpdate HTTP upload returned an unexpected response: {resp}"
        ));
    }

    sink.emit_progress(DeployProgressEvent {
        job_id: req.job_id.clone(),
        phase: "completed".into(),
        percent: 100.0,
        bytes_written: swu_bytes.len() as u64,
        total_bytes: swu_bytes.len() as u64,
        speed_mb_s: 0.0,
        message: tr_en(
            "SWUpdate yüklemesi tamamlandı",
            "SWUpdate upload completed",
        )
        .into(),
    });

    Ok(FlashOutcome {
        job_id: req.job_id.clone(),
        ok: true,
        sha256: String::new(),
        bytes_written: swu_bytes.len() as u64,
        summary: crate::tf!(
            "SWUpdate ({filename}) hedef cihaza ({addr}) yüklendi.",
            "SWUpdate ({filename}) uploaded to target device ({addr})."
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deploy::MemoryEventSink;

    #[test]
    fn swupdate_rejects_crlf_and_header_injection() {
        let sink = Arc::new(MemoryEventSink::default());
        let bad_url = SwUpdateRequest {
            job_id: "j-swu-1".into(),
            target_url: "http://192.168.10.50:8080\r\nX-Injected: true".into(),
            swu_path: "update.swu".into(),
            mock_mode: true,
            confirmed: true,
        };
        assert!(deploy_swupdate(&bad_url, sink.clone()).is_err());

        let bad_file = SwUpdateRequest {
            job_id: "j-swu-2".into(),
            target_url: "http://192.168.10.50:8080".into(),
            swu_path: "evil\"\r\nX-Test: 1.swu".into(),
            mock_mode: true,
            confirmed: true,
        };
        assert!(deploy_swupdate(&bad_file, sink).is_err());
    }
}
