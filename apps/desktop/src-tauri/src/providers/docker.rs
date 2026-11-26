use crate::i18n::tr_en;
use crate::providers::{
    BoxFuture, CheckItem, CommandOutput, ExecutionProvider, ProviderKind, ProviderProbeResult,
    ProviderProfile, ProviderTestResult,
};
use serde::{Deserialize, Serialize};
use std::process::Command;
use std::time::Instant;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const CROPS_DEFAULT_IMAGE: &str = "crops/poky:ubuntu-24.04";
pub const KAS_DEFAULT_IMAGE: &str = "ghcr.io/siemens/kas/kas:latest";
pub const DEFAULT_VOLUMES: [&str; 4] = [
    "yocto-studio-workspace",
    "yocto-studio-sstate-cache",
    "yocto-studio-downloads",
    "yocto-studio-build-tmp",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DockerStatus {
    pub installed: bool,
    pub daemon_running: bool,
    pub version: Option<String>,
}

pub fn probe_docker() -> DockerStatus {
    let mut cmd = Command::new("docker");
    cmd.arg("--version");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let ver_out = match cmd.output() {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => {
            return DockerStatus {
                installed: false,
                daemon_running: false,
                version: None,
            }
        }
    };

    let mut info_cmd = Command::new("docker");
    info_cmd.args(["info", "--format", "{{.ServerVersion}}"]);
    #[cfg(windows)]
    info_cmd.creation_flags(CREATE_NO_WINDOW);
    let daemon_running = matches!(info_cmd.output(), Ok(out) if out.status.success());

    DockerStatus {
        installed: true,
        daemon_running,
        version: Some(ver_out),
    }
}

/// Builds `docker run` arguments for CROPS / Siemens `kas` using dedicated ext4 named volumes
/// so Windows NTFS host directories are never used for BitBake `build/tmp`.
pub fn build_crops_run_args(profile: &ProviderProfile, inner_cmd: &str) -> Vec<String> {
    let image = profile
        .docker_image
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or(CROPS_DEFAULT_IMAGE);
    let sstate_vol = profile
        .docker_sstate_vol
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("yocto-studio-sstate-cache");
    let dl_vol = profile
        .docker_dl_vol
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("yocto-studio-downloads");
    let tmp_vol = profile
        .docker_tmp_vol
        .as_deref()
        .filter(|s| !s.is_empty())
        .unwrap_or("yocto-studio-build-tmp");

    vec![
        "run".to_string(),
        "--rm".to_string(),
        "-v".to_string(),
        "yocto-studio-workspace:/workdir".to_string(),
        "-v".to_string(),
        format!("{sstate_vol}:/workdir/sstate-cache"),
        "-v".to_string(),
        format!("{dl_vol}:/workdir/downloads"),
        "-v".to_string(),
        format!("{tmp_vol}:/workdir/build/tmp"),
        image.to_string(),
        "bash".to_string(),
        "-lc".to_string(),
        inner_cmd.to_string(),
    ]
}

pub fn ensure_named_volumes(volumes: &[&str]) -> Result<Vec<String>, String> {
    let mut ensured = Vec::new();
    for vol in volumes {
        let mut cmd = Command::new("docker");
        cmd.args(["volume", "create", vol]);
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let out = cmd.output().map_err(|e| {
            crate::tf!(
                "docker volume create hatası ({vol}): {e}",
                "docker volume create failed ({vol}): {e}"
            )
        })?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        ensured.push((*vol).to_string());
    }
    Ok(ensured)
}

pub async fn test_docker_connection(profile: &ProviderProfile) -> ProviderTestResult {
    let started = Instant::now();
    let image = profile
        .docker_image
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| CROPS_DEFAULT_IMAGE.to_string());

    let st = tokio::task::spawn_blocking(probe_docker)
        .await
        .unwrap_or(DockerStatus {
            installed: false,
            daemon_running: false,
            version: None,
        });

    let reachable = st.installed && st.daemon_running;
    let summary = if reachable {
        let ver = st.version.as_deref().unwrap_or("ok");
        crate::tf!(
            "Docker daemon aktif ({ver}) · Hedef imaj: {image}",
            "Docker daemon active ({ver}) · Target image: {image}"
        )
    } else if st.installed {
        tr_en(
            "Docker CLI kurulu ancak Docker Desktop daemon çalışmıyor.",
            "Docker CLI is installed, but the Docker daemon is not running.",
        )
        .to_string()
    } else {
        tr_en(
            "Docker kurulu değil (CROPS/kas için Docker Desktop gerekli).",
            "Docker is not installed (Docker Desktop is required for CROPS/kas).",
        )
        .to_string()
    };

    ProviderTestResult {
        provider: ProviderKind::Docker,
        reachable,
        latency_ms: started.elapsed().as_millis() as u64,
        summary: summary.clone(),
        remote_ram_gb: None,
        remote_disk_free_gb: None,
        missing_packages: Vec::new(),
        checks: vec![CheckItem {
            id: "docker-daemon".to_string(),
            label: format!("Docker / CROPS ({image})"),
            status: if reachable { "ok" } else { "warn" }.to_string(),
            detail: summary,
            fix_command: if st.installed {
                None
            } else {
                Some("winget install Docker.DockerDesktop".to_string())
            },
        }],
    }
}

pub struct DockerProvider {
    pub profile: ProviderProfile,
}

impl Default for DockerProvider {
    fn default() -> Self {
        Self {
            profile: ProviderProfile {
                id: "docker-default".to_string(),
                name: "Docker CROPS".to_string(),
                kind: ProviderKind::Docker,
                wsl_distro: None,
                docker_image: Some(CROPS_DEFAULT_IMAGE.to_string()),
                docker_sstate_vol: Some("yocto-studio-sstate-cache".to_string()),
                docker_dl_vol: Some("yocto-studio-downloads".to_string()),
                docker_tmp_vol: Some("yocto-studio-build-tmp".to_string()),
                ssh_host: None,
                ssh_port: None,
                ssh_user: None,
                ssh_key_path: None,
                ssh_use_agent: None,
                remote_workspace_root: None,
                is_default: None,
            },
        }
    }
}

impl ExecutionProvider for DockerProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Docker
    }

    fn probe(&self) -> BoxFuture<'_, ProviderProbeResult> {
        Box::pin(async {
            let st = tokio::task::spawn_blocking(probe_docker)
                .await
                .unwrap_or(DockerStatus {
                    installed: false,
                    daemon_running: false,
                    version: None,
                });
            let detail = match (&st.version, st.daemon_running) {
                (Some(v), true) => crate::tf!(
                    "{v} (Daemon aktif — CROPS/kas hazır)",
                    "{v} (Daemon active — CROPS/kas ready)"
                ),
                (Some(v), false) => crate::tf!(
                    "{v} (Docker Desktop daemon çalışmıyor)",
                    "{v} (Docker daemon is not running)"
                ),
                (None, _) => tr_en("Docker CLI bulunamadı", "Docker CLI not found").to_string(),
            };
            ProviderProbeResult {
                provider: ProviderKind::Docker,
                available: st.installed && st.daemon_running,
                summary: detail.clone(),
                checks: vec![CheckItem {
                    id: "docker-crops".to_string(),
                    label: "Docker / CROPS / Siemens kas".to_string(),
                    status: if st.daemon_running { "ok" } else { "warn" }.to_string(),
                    detail,
                    fix_command: if st.installed {
                        None
                    } else {
                        Some("winget install Docker.DockerDesktop".to_string())
                    },
                }],
            }
        })
    }

    fn exec_command<'a>(
        &'a self,
        cmd_str: &'a str,
        _cwd: Option<&'a str>,
    ) -> BoxFuture<'a, Result<CommandOutput, String>> {
        let args = build_crops_run_args(&self.profile, cmd_str);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut cmd = Command::new("docker");
                cmd.args(&args);
                #[cfg(windows)]
                cmd.creation_flags(CREATE_NO_WINDOW);
                let out = cmd.output().map_err(|e| {
                    crate::tf!(
                        "docker çalıştırılamadı: {e}",
                        "Failed to run docker: {e}"
                    )
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

    #[test]
    fn crops_run_args_use_ext4_named_volumes_only() {
        let prof = DockerProvider::default().profile;
        let args = build_crops_run_args(&prof, "bitbake --version");
        let joined = args.join(" ");
        assert!(joined.contains("yocto-studio-sstate-cache:/workdir/sstate-cache"));
        assert!(joined.contains("yocto-studio-downloads:/workdir/downloads"));
        assert!(joined.contains("yocto-studio-build-tmp:/workdir/build/tmp"));
        assert!(!joined.contains("C:\\"));
        assert!(!joined.contains("/mnt/c"));
    }
}
