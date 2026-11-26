use crate::i18n::tr_en;
use crate::providers::{
    BoxFuture, CheckItem, CommandOutput, ExecutionProvider, ProviderKind, ProviderProbeResult,
    ProviderProfile, ProviderTestResult,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::process::Command;
use std::time::Instant;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub const REQUIRED_YOCTO_PACKAGES: &[&str] = &[
    "gawk",
    "chrpath",
    "diffstat",
    "zstd",
    "lz4",
    "python3",
    "git",
    "file",
    "gcc",
    "make",
    "tar",
    "cpio",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WslDistroInfo {
    pub name: String,
    pub state: String,
    pub version: u8,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WslConfigInfo {
    pub path: String,
    pub exists: bool,
    pub memory: Option<String>,
    pub processors: Option<String>,
    pub swap: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Wsl2Status {
    pub installed: bool,
    pub default_version: Option<u8>,
    pub distros: Vec<WslDistroInfo>,
    pub wslconfig: WslConfigInfo,
    pub raw_status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VhdxMaintenancePlan {
    pub vhdx_path: String,
    pub mount_point: String,
    pub size_gb: u32,
    pub create_and_mount_commands: Vec<String>,
    pub optimize_vhd_command: String,
    pub prune_sstate_command: String,
}

/// Decodes stdout from wsl.exe which on Windows may be UTF-8 or UTF-16LE (with null bytes).
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let has_utf16_bom = bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE;
    let looks_utf16le = has_utf16_bom
        || (bytes.len() >= 4
            && bytes.iter().skip(1).step_by(2).filter(|&&b| b == 0).count() > bytes.len() / 4);

    if looks_utf16le {
        let slice = if has_utf16_bom { &bytes[2..] } else { bytes };
        let u16s: Vec<u16> = slice
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
            .replace('\0', "")
            .trim()
            .to_string()
    } else {
        String::from_utf8_lossy(bytes)
            .replace('\0', "")
            .trim()
            .to_string()
    }
}

pub fn parse_wslconfig_content(path: &str, exists: bool, content: &str) -> WslConfigInfo {
    let mut memory = None;
    let mut processors = None;
    let mut swap = None;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') || line.starts_with('[')
        {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim().to_ascii_lowercase();
            let val = v.trim().to_string();
            match key.as_str() {
                "memory" => memory = Some(val),
                "processors" => processors = Some(val),
                "swap" => swap = Some(val),
                _ => {}
            }
        }
    }

    WslConfigInfo {
        path: path.to_string(),
        exists,
        memory,
        processors,
        swap,
    }
}

/// Losslessly updates `[wsl2]` keys (`memory`, `processors`, `swap`) while preserving other sections & comments.
pub fn update_wslconfig_content(
    existing: &str,
    memory: &str,
    processors: u32,
    swap: Option<&str>,
) -> String {
    let mut out_lines: Vec<String> = Vec::new();
    let mut in_wsl2 = false;
    let mut has_wsl2_section = false;
    let mut wrote_mem = false;
    let mut wrote_proc = false;
    let mut wrote_swap = swap.is_none();

    for line in existing.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            if in_wsl2 {
                if !wrote_mem {
                    out_lines.push(format!("memory={memory}"));
                    wrote_mem = true;
                }
                if !wrote_proc {
                    out_lines.push(format!("processors={processors}"));
                    wrote_proc = true;
                }
                if !wrote_swap {
                    if let Some(sw) = swap {
                        out_lines.push(format!("swap={sw}"));
                    }
                    wrote_swap = true;
                }
            }
            in_wsl2 = trimmed.eq_ignore_ascii_case("[wsl2]");
            if in_wsl2 {
                has_wsl2_section = true;
            }
            out_lines.push(line.to_string());
            continue;
        }

        if in_wsl2 && !trimmed.starts_with('#') && !trimmed.starts_with(';') {
            if let Some((k, _)) = trimmed.split_once('=') {
                let key = k.trim().to_ascii_lowercase();
                if key == "memory" {
                    out_lines.push(format!("memory={memory}"));
                    wrote_mem = true;
                    continue;
                }
                if key == "processors" {
                    out_lines.push(format!("processors={processors}"));
                    wrote_proc = true;
                    continue;
                }
                if key == "swap" {
                    if let Some(sw) = swap {
                        out_lines.push(format!("swap={sw}"));
                    }
                    wrote_swap = true;
                    continue;
                }
            }
        }
        out_lines.push(line.to_string());
    }

    if !has_wsl2_section {
        if !out_lines.is_empty() && !out_lines.last().unwrap().is_empty() {
            out_lines.push(String::new());
        }
        out_lines.push("[wsl2]".to_string());
    }
    if !wrote_mem {
        out_lines.push(format!("memory={memory}"));
    }
    if !wrote_proc {
        out_lines.push(format!("processors={processors}"));
    }
    if !wrote_swap {
        if let Some(sw) = swap {
            out_lines.push(format!("swap={sw}"));
        }
    }

    out_lines.join("\n") + "\n"
}

pub fn write_user_wslconfig(
    memory: &str,
    processors: u32,
    swap: Option<&str>,
) -> Result<WslConfigInfo, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let cfg_path = home.join(".wslconfig");
    let existing = std::fs::read_to_string(&cfg_path).unwrap_or_default();
    let updated = update_wslconfig_content(&existing, memory, processors, swap);
    std::fs::write(&cfg_path, &updated).map_err(|e| {
        crate::tf!(
            ".wslconfig yazılamadı: {e}",
            "Failed to write .wslconfig: {e}"
        )
    })?;
    let path_str = cfg_path.to_string_lossy().to_string();
    Ok(parse_wslconfig_content(&path_str, true, &updated))
}

pub fn build_vhdx_maintenance_plan(
    vhdx_path: &str,
    mount_point: &str,
    size_gb: u32,
    sstate_dir: &str,
) -> VhdxMaintenancePlan {
    VhdxMaintenancePlan {
        vhdx_path: vhdx_path.to_string(),
        mount_point: mount_point.to_string(),
        size_gb,
        create_and_mount_commands: vec![
            format!("New-VHD -Path \"{vhdx_path}\" -SizeBytes {size_gb}GB -Dynamic"),
            format!("wsl --mount \"{vhdx_path}\" --vhd --bare"),
            format!("wsl -u root -- mkfs.ext4 -L yocto-ext4 /dev/sdX && wsl -u root -- mkdir -p {mount_point}"),
        ],
        optimize_vhd_command: format!(
            "wsl --shutdown ; Optimize-VHD -Path \"{vhdx_path}\" -Mode Full"
        ),
        prune_sstate_command: format!("find {sstate_dir} -type f -atime +30 -delete"),
    }
}

pub fn parse_missing_packages(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| line.strip_prefix("MISSING:"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn build_wsl_bridge_command(distro: &str, linux_bridge_dir: &str, port: u16) -> Vec<String> {
    let quoted_dir = crate::providers::shell_single_quote(linux_bridge_dir);
    vec![
        "-d".to_string(),
        distro.to_string(),
        "--".to_string(),
        "bash".to_string(),
        "-lc".to_string(),
        format!("cd {quoted_dir} && python3 -m bridge.server --live --port {port}"),
    ]
}

pub fn parse_wsl_list_verbose(output: &str) -> Vec<WslDistroInfo> {
    let mut distros = Vec::new();
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("NAME") || trimmed.starts_with("---") {
            continue;
        }
        let is_default = trimmed.starts_with('*');
        let clean = trimmed.trim_start_matches('*').trim();
        let parts: Vec<&str> = clean.split_whitespace().collect();
        if parts.len() >= 3 {
            let version = parts[parts.len() - 1].parse::<u8>().unwrap_or(2);
            let state = parts[parts.len() - 2].to_string();
            let name = parts[..parts.len() - 2].join(" ");
            distros.push(WslDistroInfo {
                name,
                state,
                version,
                is_default,
            });
        }
    }
    distros
}

fn read_user_wslconfig() -> WslConfigInfo {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let cfg_path = home.join(".wslconfig");
    let path_str = cfg_path.to_string_lossy().to_string();
    match std::fs::read_to_string(&cfg_path) {
        Ok(content) => parse_wslconfig_content(&path_str, true, &content),
        Err(_) => parse_wslconfig_content(&path_str, false, ""),
    }
}

pub fn probe_wsl2() -> Wsl2Status {
    let wslconfig = read_user_wslconfig();

    #[cfg(not(windows))]
    {
        Wsl2Status {
            installed: false,
            default_version: None,
            distros: Vec::new(),
            wslconfig,
            raw_status: "Not running on Windows host".to_string(),
        }
    }

    #[cfg(windows)]
    {
        let mut status_cmd = Command::new("wsl.exe");
        status_cmd
            .arg("--status")
            .env("WSL_UTF8", "1")
            .creation_flags(CREATE_NO_WINDOW);
        let status_out = match status_cmd.output() {
            Ok(out) => out,
            Err(err) => {
                return Wsl2Status {
                    installed: false,
                    default_version: None,
                    distros: Vec::new(),
                    wslconfig,
                    raw_status: err.to_string(),
                };
            }
        };

        let status_text = {
            let stdout = decode_wsl_output(&status_out.stdout);
            if stdout.is_empty() {
                decode_wsl_output(&status_out.stderr)
            } else {
                stdout
            }
        };

        let mut list_cmd = Command::new("wsl.exe");
        list_cmd
            .args(["--list", "--verbose"])
            .env("WSL_UTF8", "1")
            .creation_flags(CREATE_NO_WINDOW);
        let distros = match list_cmd.output() {
            Ok(out) if out.status.success() => {
                parse_wsl_list_verbose(&decode_wsl_output(&out.stdout))
            }
            _ => Vec::new(),
        };

        let installed =
            status_out.status.success() && (!distros.is_empty() || !status_text.contains("--install"));
        Wsl2Status {
            installed,
            default_version: if installed { Some(2) } else { None },
            distros,
            wslconfig,
            raw_status: status_text,
        }
    }
}

pub fn exec_in_wsl2(
    distro: Option<&str>,
    cmd_str: &str,
    cwd: Option<&str>,
) -> Result<CommandOutput, String> {
    let full_cmd = match cwd {
        Some(dir) if !dir.is_empty() => {
            let quoted_dir = crate::providers::shell_single_quote(dir);
            format!("cd {quoted_dir} && {cmd_str}")
        }
        _ => cmd_str.to_string(),
    };

    let mut cmd = Command::new("wsl.exe");
    if let Some(d) = distro {
        if !d.is_empty() {
            if d.starts_with('-') || d.chars().any(char::is_control) {
                return Err(tr_en(
                    "Güvenlik Kısıtı: Geçersiz WSL dağıtım adı.",
                    "Security Constraint: Invalid WSL distribution name.",
                )
                .to_string());
            }
            cmd.args(["-d", d]);
        }
    }
    cmd.args(["--", "bash", "-lc", &full_cmd])
        .env("WSL_UTF8", "1");
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let out = cmd.output().map_err(|e| {
        crate::tf!(
            "wsl.exe çalıştırılamadı: {e}",
            "Failed to run wsl.exe: {e}"
        )
    })?;
    Ok(CommandOutput {
        exit_code: out.status.code().unwrap_or(-1),
        stdout: decode_wsl_output(&out.stdout),
        stderr: decode_wsl_output(&out.stderr),
    })
}

pub async fn test_wsl2_connection(profile: &ProviderProfile) -> ProviderTestResult {
    let started = Instant::now();
    let distro = profile.wsl_distro.clone();

    let status = tokio::task::spawn_blocking(probe_wsl2)
        .await
        .unwrap_or_else(|_| Wsl2Status {
            installed: false,
            default_version: None,
            distros: Vec::new(),
            wslconfig: read_user_wslconfig(),
            raw_status: tr_en("WSL2 taraması başarısız", "WSL2 scan failed").to_string(),
        });

    if !status.installed {
        return ProviderTestResult {
            provider: ProviderKind::Wsl2,
            reachable: false,
            latency_ms: started.elapsed().as_millis() as u64,
            summary: tr_en(
                "WSL2 kurulu değil veya aktif dağıtım yok.",
                "WSL2 is not installed or has no active distribution.",
            )
            .to_string(),
            remote_ram_gb: None,
            remote_disk_free_gb: None,
            missing_packages: Vec::new(),
            checks: vec![CheckItem {
                id: "wsl2-install".to_string(),
                label: tr_en("WSL2 Kurulumu", "WSL2 Installation").to_string(),
                status: "error".to_string(),
                detail: tr_en(
                    "wsl.exe --status kurulu bir WSL2 dağıtımı bulamadı.",
                    "wsl.exe --status found no installed WSL2 distribution.",
                )
                .to_string(),
                fix_command: Some("wsl --install -d Ubuntu-24.04".to_string()),
            }],
        };
    }

    let pkg_check_script = format!(
        "for p in {}; do command -v $p >/dev/null 2>&1 || echo MISSING:$p; done",
        REQUIRED_YOCTO_PACKAGES.join(" ")
    );
    let pkg_out = tokio::task::spawn_blocking(move || exec_in_wsl2(distro.as_deref(), &pkg_check_script, None))
        .await
        .ok()
        .and_then(|r| r.ok());

    let missing = pkg_out
        .as_ref()
        .map(|o| parse_missing_packages(&o.stdout))
        .unwrap_or_default();

    let distro_count = status.distros.len();
    let mut checks = vec![CheckItem {
        id: "wsl2-distro".to_string(),
        label: tr_en("WSL2 Dağıtımı", "WSL2 Distribution").to_string(),
        status: "ok".to_string(),
        detail: crate::tf!(
            "{distro_count} dağıtım hazır (WSL2).",
            "{distro_count} distribution(s) ready (WSL2)."
        ),
        fix_command: None,
    }];
    if !missing.is_empty() {
        let joined_missing = missing.join(", ");
        checks.push(CheckItem {
            id: "wsl2-pkgs".to_string(),
            label: tr_en(
                "Yocto 6.0 Eksik Host Paketleri",
                "Yocto 6.0 Missing Host Packages",
            )
            .to_string(),
            status: "warn".to_string(),
            detail: crate::tf!("Eksik: {joined_missing}", "Missing: {joined_missing}"),
            fix_command: Some(format!(
                "sudo apt-get update && sudo apt-get install -y {}",
                missing.join(" ")
            )),
        });
    } else {
        checks.push(CheckItem {
            id: "wsl2-pkgs".to_string(),
            label: tr_en("Yocto 6.0 Host Paketleri", "Yocto 6.0 Host Packages").to_string(),
            status: "ok".to_string(),
            detail: tr_en(
                "Tüm gerekli host araçları mevcut.",
                "All required host tools are installed.",
            )
            .to_string(),
            fix_command: None,
        });
    }

    ProviderTestResult {
        provider: ProviderKind::Wsl2,
        reachable: true,
        latency_ms: started.elapsed().as_millis() as u64,
        summary: tr_en(
            "WSL2 bağlantısı doğrulandı.",
            "WSL2 connection verified.",
        )
        .to_string(),
        remote_ram_gb: None,
        remote_disk_free_gb: None,
        missing_packages: missing,
        checks,
    }
}

#[derive(Default)]
pub struct Wsl2Provider {
    pub distro: Option<String>,
}

impl ExecutionProvider for Wsl2Provider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Wsl2
    }

    fn probe(&self) -> BoxFuture<'_, ProviderProbeResult> {
        Box::pin(async {
            let status = tokio::task::spawn_blocking(probe_wsl2)
                .await
                .unwrap_or_else(|_| Wsl2Status {
                    installed: false,
                    default_version: None,
                    distros: Vec::new(),
                    wslconfig: read_user_wslconfig(),
                    raw_status: "WSL2 probe failed".to_string(),
                });

            let distro_count = status.distros.len();
            let mut checks = Vec::new();
            if status.installed {
                checks.push(CheckItem {
                    id: "wsl2-runtime".to_string(),
                    label: tr_en(
                        "WSL2 Çekirdeği & Dağıtımlar",
                        "WSL2 Kernel & Distributions",
                    )
                    .to_string(),
                    status: "ok".to_string(),
                    detail: crate::tf!(
                        "{distro_count} dağıtım algılandı.",
                        "{distro_count} distribution(s) detected."
                    ),
                    fix_command: None,
                });
            } else {
                checks.push(CheckItem {
                    id: "wsl2-runtime".to_string(),
                    label: tr_en(
                        "WSL2 Çekirdeği & Dağıtımlar",
                        "WSL2 Kernel & Distributions",
                    )
                    .to_string(),
                    status: "warn".to_string(),
                    detail: tr_en(
                        "Windows Subsystem for Linux (WSL2) henüz kurulu değil veya dağıtım yok.",
                        "Windows Subsystem for Linux (WSL2) is not installed yet or has no distributions.",
                    )
                    .to_string(),
                    fix_command: Some("wsl --install -d Ubuntu-24.04".to_string()),
                });
            }

            ProviderProbeResult {
                provider: ProviderKind::Wsl2,
                available: status.installed,
                summary: if status.installed {
                    crate::tf!(
                        "WSL2 hazır ({distro_count} dağıtım)",
                        "WSL2 ready ({distro_count} distributions)"
                    )
                } else {
                    tr_en(
                        "WSL2 kurulu değil (Mock veya SSH kullanılabilir)",
                        "WSL2 is not installed (Mock or SSH can be used)",
                    )
                    .to_string()
                },
                checks,
            }
        })
    }

    fn exec_command<'a>(
        &'a self,
        cmd: &'a str,
        cwd: Option<&'a str>,
    ) -> BoxFuture<'a, Result<CommandOutput, String>> {
        let distro = self.distro.clone();
        let cmd_owned = cmd.to_string();
        let cwd_owned = cwd.map(|s| s.to_string());
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                exec_in_wsl2(distro.as_deref(), &cmd_owned, cwd_owned.as_deref())
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
    fn decodes_utf16le_wsl_output_without_nulls() {
        let sample =
            "  NAME            STATE           VERSION\r\n* Ubuntu-24.04    Running         2\r\n";
        let mut utf16_bytes = vec![0xFFu8, 0xFEu8];
        for unit in sample.encode_utf16() {
            utf16_bytes.extend_from_slice(&unit.to_le_bytes());
        }
        let decoded = decode_wsl_output(&utf16_bytes);
        assert!(decoded.contains("Ubuntu-24.04"));
        assert!(!decoded.contains('\0'));

        let distros = parse_wsl_list_verbose(&decoded);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu-24.04");
        assert_eq!(distros[0].version, 2);
        assert!(distros[0].is_default);
    }

    #[test]
    fn parses_and_updates_wslconfig_losslessly() {
        let raw = "# User comment\n[wsl2]\nmemory=16GB\nprocessors=8\n# keep comment\nnestedVirtualization=true\n";
        let updated = update_wslconfig_content(raw, "28GB", 12, Some("16GB"));
        assert!(updated.contains("# User comment"));
        assert!(updated.contains("# keep comment"));
        assert!(updated.contains("nestedVirtualization=true"));
        assert!(updated.contains("memory=28GB"));
        assert!(updated.contains("processors=12"));
        assert!(updated.contains("swap=16GB"));

        let cfg = parse_wslconfig_content("C:\\Users\\dev\\.wslconfig", true, &updated);
        assert_eq!(cfg.memory.as_deref(), Some("28GB"));
        assert_eq!(cfg.processors.as_deref(), Some("12"));
        assert_eq!(cfg.swap.as_deref(), Some("16GB"));
    }

    #[test]
    fn parses_missing_packages_and_vhdx_plan() {
        let missing = parse_missing_packages("MISSING:chrpath\nMISSING:diffstat\n");
        assert_eq!(missing, vec!["chrpath", "diffstat"]);

        let plan = build_vhdx_maintenance_plan(
            "D:\\Yocto\\yocto-ext4.vhdx",
            "/mnt/yocto-ext4",
            200,
            "/mnt/yocto-ext4/sstate-cache",
        );
        assert!(plan.optimize_vhd_command.contains("Optimize-VHD"));
        assert!(plan.prune_sstate_command.contains("-atime +30 -delete"));
    }
}
