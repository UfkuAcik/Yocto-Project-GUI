use crate::i18n::tr_en;
use crate::providers::{
    BoxFuture, CheckItem, CommandOutput, ExecutionProvider, ProviderKind, ProviderProbeResult,
    ProviderProfile, ProviderTestResult,
};
use serde::{Deserialize, Serialize};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshStatus {
    pub client_available: bool,
    pub version: Option<String>,
    pub configured_hosts: Vec<String>,
}

pub fn probe_ssh() -> SshStatus {
    let mut cmd = Command::new("ssh");
    cmd.arg("-V");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let (client_available, version) = match cmd.output() {
        Ok(out) => {
            let raw = format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )
            .trim()
            .to_string();
            (out.status.success() || !raw.is_empty(), Some(raw))
        }
        Err(_) => (false, None),
    };

    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let config_path = home.join(".ssh").join("config");
    let mut hosts = Vec::new();
    if let Ok(content) = std::fs::read_to_string(config_path) {
        for line in content.lines() {
            let trimmed = line.trim();
            if let Some(rest) = trimmed.strip_prefix("Host ") {
                for h in rest.split_whitespace() {
                    if h != "*" {
                        hosts.push(h.to_string());
                    }
                }
            }
        }
    }

    SshStatus {
        client_available,
        version,
        configured_hosts: hosts,
    }
}

/// Builds OpenSSH CLI arguments using ControlMaster + SSH Agent/key auth (never passwords).
pub fn build_ssh_command_args(
    profile: &ProviderProfile,
    tunnel_port: Option<u16>,
    remote_cmd: Option<&str>,
) -> Result<Vec<String>, String> {
    let host_raw = profile
        .ssh_host
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            tr_en(
                "SSH sunucu adresi (host) boş olamaz.",
                "SSH server host cannot be empty.",
            )
            .to_string()
        })?;
    let host = crate::providers::validate_ssh_token(host_raw, "SSH host")?;
    let user_raw = profile
        .ssh_user
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            tr_en(
                "SSH kullanıcı adı boş olamaz.",
                "SSH username cannot be empty.",
            )
            .to_string()
        })?;
    let user = crate::providers::validate_ssh_token(user_raw, "SSH user")?;
    let port = profile.ssh_port.unwrap_or(22);

    let mut args = vec![
        "-p".to_string(),
        port.to_string(),
        "-o".to_string(),
        "BatchMode=yes".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
        "-o".to_string(),
        "ConnectTimeout=6".to_string(),
    ];

    if !cfg!(windows) {
        args.extend([
            "-o".to_string(),
            "ControlMaster=auto".to_string(),
            "-o".to_string(),
            "ControlPersist=10m".to_string(),
        ]);
    }

    if let Some(key_path) = profile.ssh_key_path.as_deref().filter(|s| !s.trim().is_empty()) {
        let clean_key = crate::providers::validate_cli_path_arg(key_path, "SSH key path")?;
        args.push("-i".to_string());
        args.push(clean_key.to_string());
    }

    if let Some(tp) = tunnel_port {
        args.push("-L".to_string());
        args.push(format!("127.0.0.1:{tp}:127.0.0.1:{tp}"));
    }

    args.push("--".to_string());
    args.push(format!("{user}@{host}"));
    if let Some(cmd) = remote_cmd {
        args.push(cmd.to_string());
    }
    Ok(args)
}

pub async fn test_ssh_connection(profile: &ProviderProfile) -> ProviderTestResult {
    let started = Instant::now();
    let host = profile.ssh_host.clone().unwrap_or_default();
    let port = profile.ssh_port.unwrap_or(22);
    let workspace_root = profile
        .remote_workspace_root
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/home".to_string());
    let quoted_root = crate::providers::shell_single_quote(&workspace_root);

    let remote_probe = format!(
        "uname -srm; free -m | awk '/Mem:/ {{print \"RAM_MB=\"$2}}'; df -BG {quoted_root} | tail -1 | awk '{{print \"DISK_GB=\"$4}}'"
    );
    let args = match build_ssh_command_args(profile, None, Some(&remote_probe)) {
        Ok(a) => a,
        Err(msg) => {
            return ProviderTestResult {
                provider: ProviderKind::Ssh,
                reachable: false,
                latency_ms: started.elapsed().as_millis() as u64,
                summary: msg.clone(),
                remote_ram_gb: None,
                remote_disk_free_gb: None,
                missing_packages: Vec::new(),
                checks: vec![CheckItem {
                    id: "ssh-config".to_string(),
                    label: tr_en("SSH Profil Doğrulama", "SSH Profile Validation").to_string(),
                    status: "error".to_string(),
                    detail: msg,
                    fix_command: None,
                }],
            };
        }
    };

    // Fast TCP pre-flight check (2s timeout) so unreachable hosts fail quickly
    let tcp_ok = tokio::task::spawn_blocking({
        let addr_str = format!("{host}:{port}");
        move || {
            addr_str
                .to_socket_addrs()
                .ok()
                .and_then(|mut it| it.next())
                .map(|sock| TcpStream::connect_timeout(&sock, Duration::from_secs(2)).is_ok())
                .unwrap_or(false)
        }
    })
    .await
    .unwrap_or(false);

    if !tcp_ok {
        return ProviderTestResult {
            provider: ProviderKind::Ssh,
            reachable: false,
            latency_ms: started.elapsed().as_millis() as u64,
            summary: crate::tf!(
                "{host}:{port} TCP bağlantısı kurulamadı.",
                "Could not establish TCP connection to {host}:{port}."
            ),
            remote_ram_gb: None,
            remote_disk_free_gb: None,
            missing_packages: Vec::new(),
            checks: vec![CheckItem {
                id: "ssh-tcp".to_string(),
                label: crate::tf!(
                    "SSH Bağlantısı ({host}:{port})",
                    "SSH Connection ({host}:{port})"
                ),
                status: "error".to_string(),
                detail: tr_en(
                    "Sunucuya erişilemiyor veya port 22/SSH kapalı.",
                    "Server is unreachable or port 22/SSH is closed.",
                )
                .to_string(),
                fix_command: None,
            }],
        };
    }

    let ssh_res = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new("ssh");
        cmd.args(&args);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output()
    })
    .await;

    let latency_ms = started.elapsed().as_millis() as u64;
    match ssh_res {
        Ok(Ok(out)) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let ram_gb = stdout
                .lines()
                .find_map(|l| l.strip_prefix("RAM_MB="))
                .and_then(|v| v.trim().parse::<f64>().ok())
                .map(|mb| ((mb / 1024.0) * 10.0).round() / 10.0);
            let disk_gb = stdout
                .lines()
                .find_map(|l| l.strip_prefix("DISK_GB="))
                .and_then(|v| v.trim().trim_end_matches('G').parse::<f64>().ok());

            ProviderTestResult {
                provider: ProviderKind::Ssh,
                reachable: true,
                latency_ms,
                summary: crate::tf!(
                    "SSH bağlantısı başarılı ({host}:{port}, {latency_ms} ms).",
                    "SSH connection succeeded ({host}:{port}, {latency_ms} ms)."
                ),
                remote_ram_gb: ram_gb,
                remote_disk_free_gb: disk_gb,
                missing_packages: Vec::new(),
                checks: vec![CheckItem {
                    id: "ssh-auth".to_string(),
                    label: tr_en(
                        "SSH Anahtar / Agent Kimlik Doğrulama",
                        "SSH Key / Agent Authentication",
                    )
                    .to_string(),
                    status: "ok".to_string(),
                    detail: stdout.lines().next().unwrap_or("Linux host").to_string(),
                    fix_command: None,
                }],
            }
        }
        Ok(Ok(out)) => {
            let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
            ProviderTestResult {
                provider: ProviderKind::Ssh,
                reachable: false,
                latency_ms,
                summary: crate::tf!(
                    "SSH kimlik doğrulama hatası: {err}",
                    "SSH authentication error: {err}"
                ),
                remote_ram_gb: None,
                remote_disk_free_gb: None,
                missing_packages: Vec::new(),
                checks: vec![CheckItem {
                    id: "ssh-auth".to_string(),
                    label: tr_en(
                        "SSH Anahtar / Agent Kimlik Doğrulama",
                        "SSH Key / Agent Authentication",
                    )
                    .to_string(),
                    status: "error".to_string(),
                    detail: err,
                    fix_command: Some("ssh-copy-id user@host".to_string()),
                }],
            }
        }
        _ => ProviderTestResult {
            provider: ProviderKind::Ssh,
            reachable: false,
            latency_ms,
            summary: tr_en(
                "ssh istemcisi çalıştırılamadı.",
                "Could not execute ssh client.",
            )
            .to_string(),
            remote_ram_gb: None,
            remote_disk_free_gb: None,
            missing_packages: Vec::new(),
            checks: Vec::new(),
        },
    }
}

pub struct SshProvider {
    pub profile: ProviderProfile,
}

impl ExecutionProvider for SshProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Ssh
    }

    fn probe(&self) -> BoxFuture<'_, ProviderProbeResult> {
        Box::pin(async {
            let st = tokio::task::spawn_blocking(probe_ssh)
                .await
                .unwrap_or(SshStatus {
                    client_available: false,
                    version: None,
                    configured_hosts: Vec::new(),
                });
            let ver_str = st
                .version
                .clone()
                .unwrap_or_else(|| tr_en("SSH yok", "No SSH").to_string());
            let host_count = st.configured_hosts.len();
            ProviderProbeResult {
                provider: ProviderKind::Ssh,
                available: st.client_available,
                summary: st.version.clone().unwrap_or_else(|| {
                    tr_en(
                        "OpenSSH istemcisi bulunamadı",
                        "OpenSSH client was not found",
                    )
                    .to_string()
                }),
                checks: vec![CheckItem {
                    id: "ssh-client".to_string(),
                    label: tr_en(
                        "Remote SSH Derleme Sunucusu Desteği",
                        "Remote SSH Build Server Support",
                    )
                    .to_string(),
                    status: if st.client_available { "ok" } else { "warn" }.to_string(),
                    detail: crate::tf!(
                        "{ver_str} ({host_count} kayıtlı SSH profili)",
                        "{ver_str} ({host_count} configured SSH host(s))"
                    ),
                    fix_command: None,
                }],
            }
        })
    }

    fn exec_command<'a>(
        &'a self,
        cmd_str: &'a str,
        cwd: Option<&'a str>,
    ) -> BoxFuture<'a, Result<CommandOutput, String>> {
        let full = match cwd {
            Some(dir) if !dir.is_empty() => {
                let quoted_dir = crate::providers::shell_single_quote(dir);
                format!("cd {quoted_dir} && {cmd_str}")
            }
            _ => cmd_str.to_string(),
        };
        let profile = self.profile.clone();
        Box::pin(async move {
            let args = build_ssh_command_args(&profile, None, Some(&full))?;
            tokio::task::spawn_blocking(move || {
                let mut cmd = Command::new("ssh");
                cmd.args(&args);
                #[cfg(windows)]
                cmd.creation_flags(CREATE_NO_WINDOW);
                let out = cmd.output().map_err(|e| {
                    crate::tf!("ssh çalıştırılamadı: {e}", "Failed to run ssh: {e}")
                })?;
                Ok(CommandOutput {
                    exit_code: out.status.code().unwrap_or(-1),
                    stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                    stderr: String::from_utf8_lossy(&out.stderr).to_string(),
                })
            })
            .await
            .map_err(|e| e.to_string())?
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_ssh_profile(host: &str, port: u16) -> ProviderProfile {
        ProviderProfile {
            id: "ssh-1".into(),
            name: "Build Server".into(),
            kind: ProviderKind::Ssh,
            wsl_distro: None,
            docker_image: None,
            docker_sstate_vol: None,
            docker_dl_vol: None,
            docker_tmp_vol: None,
            ssh_host: Some(host.into()),
            ssh_port: Some(port),
            ssh_user: Some("yocto".into()),
            ssh_key_path: Some("~/.ssh/id_ed25519".into()),
            ssh_use_agent: Some(true),
            remote_workspace_root: Some("/home/yocto/builds".into()),
            is_default: None,
        }
    }

    #[test]
    fn builds_ssh_args_with_tunnel_and_key_no_password() {
        let prof = sample_ssh_profile("build.example.local", 2222);
        let args = build_ssh_command_args(&prof, Some(18765), Some("uname -a")).unwrap();
        assert!(args.contains(&"BatchMode=yes".to_string()));
        assert!(args.contains(&"127.0.0.1:18765:127.0.0.1:18765".to_string()));
        assert!(args.contains(&"~/.ssh/id_ed25519".to_string()));
        assert!(args.contains(&"--".to_string()));
        assert!(args.contains(&"yocto@build.example.local".to_string()));
    }

    #[test]
    fn ssh_args_reject_option_and_command_injection() {
        let bad_host = sample_ssh_profile("-oProxyCommand=id", 22);
        assert!(build_ssh_command_args(&bad_host, None, Some("uname")).is_err());

        let mut bad_user = sample_ssh_profile("build.example.local", 22);
        bad_user.ssh_user = Some("-oBadUser".into());
        assert!(build_ssh_command_args(&bad_user, None, Some("uname")).is_err());
    }

    #[tokio::test]
    async fn ssh_test_handles_unreachable_port_cleanly() {
        let prof = sample_ssh_profile("127.0.0.1", 1);
        let res = test_ssh_connection(&prof).await;
        assert!(!res.reachable);
    }
}
