use crate::i18n::tr_en;
use crate::providers::{
    BoxFuture, CheckItem, CommandOutput, ExecutionProvider, ProviderKind, ProviderProbeResult,
    ProviderTestResult,
};
use std::process::Command;
use std::time::Instant;

pub struct LocalProvider;

pub async fn test_local_connection() -> ProviderTestResult {
    let started = Instant::now();
    let is_linux = cfg!(target_os = "linux");
    ProviderTestResult {
        provider: ProviderKind::Local,
        reachable: is_linux,
        latency_ms: started.elapsed().as_millis() as u64,
        summary: if is_linux {
            tr_en(
                "Yerel Linux BitBake ortamı hazır.",
                "Local Linux BitBake environment is ready.",
            )
            .to_string()
        } else {
            tr_en(
                "Windows üzerinde yerel BitBake çalıştırılamaz; WSL2, Docker veya SSH kullanın.",
                "Local BitBake cannot run on Windows; use WSL2, Docker, or SSH.",
            )
            .to_string()
        },
        remote_ram_gb: None,
        remote_disk_free_gb: None,
        missing_packages: Vec::new(),
        checks: vec![CheckItem {
            id: "local-os".to_string(),
            label: tr_en("Yerel İşletim Sistemi", "Local Operating System").to_string(),
            status: if is_linux { "ok" } else { "warn" }.to_string(),
            detail: std::env::consts::OS.to_string(),
            fix_command: None,
        }],
    }
}

impl ExecutionProvider for LocalProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Local
    }

    fn probe(&self) -> BoxFuture<'_, ProviderProbeResult> {
        Box::pin(async {
            let is_linux = cfg!(target_os = "linux");
            ProviderProbeResult {
                provider: ProviderKind::Local,
                available: is_linux,
                summary: if is_linux {
                    tr_en("Native Linux ortamı hazır", "Native Linux environment is ready")
                        .to_string()
                } else {
                    tr_en(
                        "Windows ana bilgisayarda yerel BitBake desteklenmez (WSL2/Docker/SSH kullanın)",
                        "Local BitBake is not supported on Windows host (use WSL2/Docker/SSH)",
                    )
                    .to_string()
                },
                checks: vec![CheckItem {
                    id: "native-linux".to_string(),
                    label: tr_en(
                        "Native Linux BitBake Ortamı",
                        "Native Linux BitBake Environment",
                    )
                    .to_string(),
                    status: if is_linux { "ok" } else { "warn" }.to_string(),
                    detail: if is_linux {
                        tr_en(
                            "Doğrudan Linux POSIX çekirdeği üzerinde çalışıyor.",
                            "Running directly on a Linux POSIX kernel.",
                        )
                        .to_string()
                    } else {
                        tr_en(
                            "Windows çekirdeği POSIX pseudo ve case-sensitive ext4 sağlamaz.",
                            "Windows kernel does not provide POSIX pseudo or case-sensitive ext4.",
                        )
                        .to_string()
                    },
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
        let cmd_owned = cmd_str.to_string();
        let cwd_owned = cwd.map(|s| s.to_string());
        Box::pin(async move {
            if !cfg!(unix) {
                return Err(tr_en(
                    "Windows üzerinde yerel BitBake yürütme yasaktır; WSL2/Docker/SSH kullanın.",
                    "Local BitBake execution on Windows is prohibited; use WSL2/Docker/SSH.",
                )
                .to_string());
            }
            tokio::task::spawn_blocking(move || {
                let mut cmd = Command::new("bash");
                cmd.args(["-lc", &cmd_owned]);
                if let Some(dir) = cwd_owned {
                    cmd.current_dir(dir);
                }
                let out = cmd.output().map_err(|e| e.to_string())?;
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
