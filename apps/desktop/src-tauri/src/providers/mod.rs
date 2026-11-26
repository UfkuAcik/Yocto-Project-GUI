pub mod docker;
pub mod local;
pub mod ssh;
pub mod wsl2;

use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::time::Instant;

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Mock,
    Wsl2,
    Docker,
    Ssh,
    Local,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PathValidationResult {
    pub valid: bool,
    pub error_code: Option<i32>,
    pub reason: String,
    pub recommendation: Option<String>,
    pub normalized_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CheckItem {
    pub id: String,
    pub label: String,
    pub status: String, // "ok" | "warn" | "error"
    pub detail: String,
    pub fix_command: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProbeResult {
    pub provider: ProviderKind,
    pub available: bool,
    pub summary: String,
    pub checks: Vec<CheckItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutput {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub wsl_distro: Option<String>,
    pub docker_image: Option<String>,
    pub docker_sstate_vol: Option<String>,
    pub docker_dl_vol: Option<String>,
    pub docker_tmp_vol: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_user: Option<String>,
    pub ssh_key_path: Option<String>,
    pub ssh_use_agent: Option<bool>,
    pub remote_workspace_root: Option<String>,
    pub is_default: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderTestResult {
    pub provider: ProviderKind,
    pub reachable: bool,
    pub latency_ms: u64,
    pub summary: String,
    pub remote_ram_gb: Option<f64>,
    pub remote_disk_free_gb: Option<f64>,
    pub missing_packages: Vec<String>,
    pub checks: Vec<CheckItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvironmentHealth {
    pub host_os: String,
    pub cpu_cores: usize,
    pub ram_total_gb: f64,
    pub disk_free_gb: f64,
    pub yocto6_ram_ok: bool,
    pub yocto6_disk_ok: bool,
    pub recommended_provider: ProviderKind,
    pub wsl2: wsl2::Wsl2Status,
    pub docker: docker::DockerStatus,
    pub ssh: ssh::SshStatus,
    pub checks: Vec<CheckItem>,
}

pub trait ExecutionProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn probe(&self) -> BoxFuture<'_, ProviderProbeResult>;
    fn exec_command<'a>(
        &'a self,
        cmd: &'a str,
        cwd: Option<&'a str>,
    ) -> BoxFuture<'a, Result<CommandOutput, String>>;
    fn validate_path(&self, path: &str) -> PathValidationResult {
        validate_linux_workspace_path(path, self.kind())
    }
}

pub async fn test_provider_connection(profile: &ProviderProfile) -> ProviderTestResult {
    let started = Instant::now();
    match profile.kind {
        ProviderKind::Mock => ProviderTestResult {
            provider: ProviderKind::Mock,
            reachable: true,
            latency_ms: started.elapsed().as_millis() as u64,
            summary: tr_en(
                "yocto-bridge Mock Simülasyon Motoru hazır.",
                "yocto-bridge Mock Simulation Engine is ready.",
            )
            .to_string(),
            remote_ram_gb: Some(32.0),
            remote_disk_free_gb: Some(240.0),
            missing_packages: Vec::new(),
            checks: vec![CheckItem {
                id: "mock".to_string(),
                label: "Mock Engine".to_string(),
                status: "ok".to_string(),
                detail: tr_en(
                    "Yerel WebSocket/JSON-RPC simülasyonu aktif.",
                    "Local WebSocket/JSON-RPC simulation is active.",
                )
                .to_string(),
                fix_command: None,
            }],
        },
        ProviderKind::Wsl2 => wsl2::test_wsl2_connection(profile).await,
        ProviderKind::Docker => docker::test_docker_connection(profile).await,
        ProviderKind::Ssh => ssh::test_ssh_connection(profile).await,
        ProviderKind::Local => local::test_local_connection().await,
    }
}

/// Non-negotiable workspace path validation for WSL2 & Linux Yocto builds.
/// Rejects /mnt/<drive>, Windows drive paths (C:\...), UNC paths, relative paths, and '..'.
pub fn validate_linux_workspace_path(path: &str, provider: ProviderKind) -> PathValidationResult {
    let raw = path.trim();
    if raw.is_empty() {
        return PathValidationResult {
            valid: false,
            error_code: Some(-32602),
            reason: tr_en(
                "Çalışma alanı yolu boş olamaz.",
                "Workspace path cannot be empty.",
            )
            .to_string(),
            recommendation: Some("/home/yocto/yocto-studio/my-project".to_string()),
            normalized_path: String::new(),
        };
    }

    let bytes = raw.as_bytes();
    if bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
    {
        return PathValidationResult {
            valid: false,
            error_code: Some(-32001),
            reason: tr_en(
                "Windows sürücü yolları (C:\\...) BitBake için yasaktır. BitBake POSIX izinleri, pseudo ve case-sensitive ext4 gerektirir.",
                "Windows drive paths (C:\\...) are forbidden for BitBake. BitBake requires POSIX permissions, pseudo, and case-sensitive ext4.",
            )
            .to_string(),
            recommendation: Some("/home/yocto/yocto-studio/my-project".to_string()),
            normalized_path: raw.to_string(),
        };
    }

    if raw.starts_with("\\\\") || raw.starts_with("//") {
        return PathValidationResult {
            valid: false,
            error_code: Some(-32001),
            reason: tr_en(
                "UNC ağ/WSL köprü yolları (\\\\...) çalışma alanı olarak kullanılamaz.",
                "UNC network/WSL bridge paths (\\\\...) cannot be used as a workspace.",
            )
            .to_string(),
            recommendation: Some("/home/yocto/yocto-studio/my-project".to_string()),
            normalized_path: raw.to_string(),
        };
    }

    if !raw.starts_with('/') {
        return PathValidationResult {
            valid: false,
            error_code: Some(-32602),
            reason: tr_en(
                "Yocto çalışma alanı yolu mutlak POSIX yolu ('/' ile başlayan) olmalıdır.",
                "Yocto workspace path must be an absolute POSIX path (starting with '/').",
            )
            .to_string(),
            recommendation: Some(format!(
                "/home/yocto/yocto-studio/{}",
                raw.trim_start_matches("./")
            )),
            normalized_path: raw.to_string(),
        };
    }

    let raw_parts: Vec<&str> = raw.split('/').filter(|s| !s.is_empty()).collect();
    if raw_parts.contains(&"..") {
        return PathValidationResult {
            valid: false,
            error_code: Some(-32602),
            reason: tr_en(
                "Güvenlik nedeniyle '..' içeren yollar kabul edilmez.",
                "Paths containing '..' are rejected for security reasons.",
            )
            .to_string(),
            recommendation: Some("/home/yocto/yocto-studio/my-project".to_string()),
            normalized_path: raw.to_string(),
        };
    }

    let normalized = if raw_parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", raw_parts.join("/"))
    };

    if raw_parts.len() >= 2
        && raw_parts[0] == "mnt"
        && raw_parts[1].len() == 1
        && raw_parts[1].chars().all(|c| c.is_ascii_alphabetic())
    {
        let tail = if raw_parts.len() > 2 {
            raw_parts[2..].join("/")
        } else {
            "my-project".to_string()
        };
        return PathValidationResult {
            valid: false,
            error_code: Some(-32001),
            reason: crate::tf!(
                "'{normalized}' yolu Windows NTFS (9p/DrvFs) bağlama noktasıdır. BitBake burada ciddi I/O darboğazı, sembolik/sabit bağlantı hataları ve büyük/küçük harf çakışmaları yaşar. WSL2 içinde yerel ext4 kullanılmalıdır.",
                "'{normalized}' is a Windows NTFS (9p/DrvFs) mount point. BitBake suffers severe I/O bottlenecks, symlink/hardlink failures, and case-sensitivity collisions here. Native ext4 inside WSL2 must be used."
            ),
            recommendation: Some(format!("/home/yocto/yocto-studio/{tail}")),
            normalized_path: normalized,
        };
    }

    if matches!(provider, ProviderKind::Wsl2 | ProviderKind::Local)
        && matches!(normalized.as_str(), "/" | "/mnt" | "/proc" | "/sys" | "/dev")
    {
        return PathValidationResult {
            valid: false,
            error_code: Some(-32602),
            reason: crate::tf!(
                "'{normalized}' sistem dizini çalışma alanı olarak kullanılamaz.",
                "System directory '{normalized}' cannot be used as a workspace."
            ),
            recommendation: Some("/home/yocto/yocto-studio/my-project".to_string()),
            normalized_path: normalized,
        };
    }

    PathValidationResult {
        valid: true,
        error_code: None,
        reason: tr_en(
            "Geçerli POSIX case-sensitive dosya sistemi yolu (ext4 uyumlu).",
            "Valid POSIX case-sensitive filesystem path (ext4 compatible).",
        )
        .to_string(),
        recommendation: None,
        normalized_path: normalized,
    }
}

pub fn shell_single_quote(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\"'\"'"))
}

pub fn validate_ssh_token<'a>(raw: &'a str, field_name: &str) -> Result<&'a str, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(crate::tf!(
            "{field_name} boş olamaz.",
            "{field_name} cannot be empty."
        ));
    }
    if trimmed.starts_with('-') {
        return Err(crate::tf!(
            "Güvenlik Kısıtı: {field_name} '-' ile başlayamaz.",
            "Security Constraint: {field_name} cannot start with '-'."
        ));
    }
    const FORBIDDEN: [char; 14] = [';', '|', '&', '`', '$', '\'', '"', '(', ')', '<', '>', '\\', '/', '@'];
    if trimmed
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || FORBIDDEN.contains(&c))
    {
        return Err(crate::tf!(
            "Güvenlik Kısıtı: {field_name} geçersiz veya tehlikeli karakter içeriyor.",
            "Security Constraint: {field_name} contains invalid or unsafe characters."
        ));
    }
    Ok(trimmed)
}

pub fn validate_cli_path_arg<'a>(raw: &'a str, field_name: &str) -> Result<&'a str, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(crate::tf!(
            "{field_name} boş olamaz.",
            "{field_name} cannot be empty."
        ));
    }
    if trimmed.starts_with('-') {
        return Err(crate::tf!(
            "Güvenlik Kısıtı: {field_name} '-' ile başlayamaz.",
            "Security Constraint: {field_name} cannot start with '-'."
        ));
    }
    if trimmed.chars().any(|c| matches!(c, '\0' | '\r' | '\n')) {
        return Err(crate::tf!(
            "Güvenlik Kısıtı: {field_name} kontrol karakteri içeremez.",
            "Security Constraint: {field_name} cannot contain control characters."
        ));
    }
    Ok(trimmed)
}

pub fn validate_remote_block_device(raw: &str) -> Result<&str, String> {
    let trimmed = raw.trim();
    if !trimmed.starts_with("/dev/") || trimmed.len() <= 5 || trimmed.contains("..") {
        return Err(crate::tf!(
            "Güvenlik Kısıtı: Geçersiz uzak blok aygıt yolu '{trimmed}'.",
            "Security Constraint: Invalid remote block device path '{trimmed}'."
        ));
    }
    let rest = &trimmed[5..];
    if !rest
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/'))
    {
        return Err(crate::tf!(
            "Güvenlik Kısıtı: Uzak aygıt yolunda izin verilmeyen karakter: '{trimmed}'.",
            "Security Constraint: Disallowed character in remote device path: '{trimmed}'."
        ));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_single_quote_escapes_embedded_quotes() {
        assert_eq!(shell_single_quote("/home/yocto"), "'/home/yocto'");
        assert_eq!(shell_single_quote("a'b"), "'a'\"'\"'b'");
    }

    #[test]
    fn validates_ssh_tokens_cli_paths_and_remote_block_devices() {
        assert_eq!(validate_ssh_token("192.168.10.50", "host").unwrap(), "192.168.10.50");
        assert!(validate_ssh_token("-oProxyCommand=id", "host").is_err());
        assert!(validate_ssh_token("host; id", "host").is_err());
        assert!(validate_ssh_token("root@host", "user").is_err());

        assert_eq!(validate_cli_path_arg("~/.ssh/id_ed25519", "key").unwrap(), "~/.ssh/id_ed25519");
        assert!(validate_cli_path_arg("-oBad", "key").is_err());
        assert!(validate_cli_path_arg("bad\nline", "key").is_err());

        assert_eq!(validate_remote_block_device("/dev/mmcblk2p3").unwrap(), "/dev/mmcblk2p3");
        assert!(validate_remote_block_device("/dev/mmcblk2p3; id").is_err());
        assert!(validate_remote_block_device("/tmp/disk.img").is_err());
        assert!(validate_remote_block_device("/dev/../etc/passwd").is_err());
    }

    #[test]
    fn blocks_ntfs_drvfs_and_windows_paths() {
        for bad in [
            "/mnt/c",
            "/mnt/c/Users/dev/yocto",
            "/mnt/D/builds",
            "C:\\yocto\\build",
            "d:/yocto",
            "\\\\wsl$\\Ubuntu\\home\\yocto",
        ] {
            let res = validate_linux_workspace_path(bad, ProviderKind::Wsl2);
            assert!(!res.valid, "Expected invalid for {bad}");
            assert_eq!(res.error_code, Some(-32001));
        }
    }

    #[test]
    fn blocks_relative_and_traversal_paths() {
        for bad in ["", "yocto/build", "/home/yocto/../mnt/c"] {
            let res = validate_linux_workspace_path(bad, ProviderKind::Wsl2);
            assert!(!res.valid);
            assert_eq!(res.error_code, Some(-32602));
        }
    }

    #[test]
    fn allows_native_ext4_paths() {
        let res =
            validate_linux_workspace_path("/home/yocto/yocto-studio/poky-wrynose", ProviderKind::Wsl2);
        assert!(res.valid);
        assert_eq!(res.error_code, None);
    }
}
