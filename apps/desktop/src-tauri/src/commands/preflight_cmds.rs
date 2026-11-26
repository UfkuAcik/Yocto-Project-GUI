use crate::commands::AppState;
use serde::{Deserialize, Serialize};
use sysinfo::{Disks, System};
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreFlightHostProfile {
    pub cpu_cores: usize,
    pub ram_total_gb: f64,
    pub ram_available_gb: f64,
    pub disk_free_gb: f64,
    pub psi_supported: bool,
    pub provider: String,
}

fn detect_psi_support() -> bool {
    #[cfg(target_os = "linux")]
    {
        std::path::Path::new("/proc/pressure/cpu").exists()
            && std::path::Path::new("/proc/pressure/memory").exists()
    }
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("wsl.exe");
        cmd.args(["--", "test", "-r", "/proc/pressure/cpu"]);
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.output().map(|o| o.status.success()).unwrap_or(false)
    }
    #[cfg(all(not(target_os = "linux"), not(windows)))]
    {
        false
    }
}

pub fn collect_host_profile() -> PreFlightHostProfile {
    let mut sys = System::new_all();
    sys.refresh_memory();
    let cpu_cores = sys.cpus().len().max(1);
    let ram_total_gb = (sys.total_memory() as f64) / (1024.0 * 1024.0 * 1024.0);
    let ram_available_gb = (sys.available_memory() as f64) / (1024.0 * 1024.0 * 1024.0);

    let disks = Disks::new_with_refreshed_list();
    let disk_free_bytes = disks
        .list()
        .iter()
        .map(|d| d.available_space())
        .max()
        .unwrap_or(0);
    let disk_free_gb = (disk_free_bytes as f64) / (1024.0 * 1024.0 * 1024.0);
    let psi_supported = detect_psi_support();

    let provider = if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(windows) {
        "wsl2"
    } else {
        "mock"
    };

    PreFlightHostProfile {
        cpu_cores,
        ram_total_gb: (ram_total_gb * 10.0).round() / 10.0,
        ram_available_gb: (ram_available_gb * 10.0).round() / 10.0,
        disk_free_gb: (disk_free_gb * 10.0).round() / 10.0,
        psi_supported,
        provider: provider.to_string(),
    }
}

#[tauri::command]
pub async fn get_preflight_host_profile() -> Result<PreFlightHostProfile, String> {
    tokio::task::spawn_blocking(collect_host_profile)
        .await
        .map_err(|e| format!("Pre-Flight host profile error: {e}"))
}

#[tauri::command]
pub fn get_preflight_gate_enabled(state: State<'_, AppState>) -> Result<bool, String> {
    match state
        .db
        .get_setting("preflight.gate_enabled")
        .map_err(|e| e.to_string())?
    {
        Some(v) => Ok(v != "false" && v != "0"),
        None => Ok(true),
    }
}

#[tauri::command]
pub fn set_preflight_gate_enabled(
    state: State<'_, AppState>,
    enabled: bool,
) -> Result<(), String> {
    state
        .db
        .set_setting(
            "preflight.gate_enabled",
            if enabled { "true" } else { "false" },
        )
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn host_profile_reports_nonzero_resources() {
        let p = collect_host_profile();
        assert!(p.cpu_cores >= 1);
        assert!(p.ram_total_gb > 0.5);
    }

    #[test]
    fn sqlite_preflight_gate_setting_roundtrip() {
        let db = Database::open_in_memory().unwrap();
        assert_eq!(db.get_setting("preflight.gate_enabled").unwrap(), None);
        db.set_setting("preflight.gate_enabled", "false").unwrap();
        assert_eq!(
            db.get_setting("preflight.gate_enabled").unwrap().as_deref(),
            Some("false")
        );
        db.set_setting("preflight.gate_enabled", "true").unwrap();
        assert_eq!(
            db.get_setting("preflight.gate_enabled").unwrap().as_deref(),
            Some("true")
        );
    }
}
