pub mod deploy_cmds;
pub mod enterprise_cmds;
pub mod preflight_cmds;
pub mod pro_cmds;

use crate::bridge::{BridgeManager, BridgeStatus};
use crate::db::{BuildRunRecord, Database, SavedProjectRecord};
use crate::deploy::{
    net_deploy::tftp_server::TftpServerManager, serial::manager::SerialManager, DeployManager,
};
use crate::flash::{
    build_flash_plan as compute_flash_plan, copy_artifact_to_host as copy_to_host_fs,
    list_removable_drives as probe_removable_drives, CopyArtifactResult, FlashPlan,
    RemovableDriveInfo,
};
use crate::i18n::tr_en;
use crate::providers::{
    docker, ssh, test_provider_connection as probe_provider_conn, validate_linux_workspace_path,
    wsl2, CheckItem, EnvironmentHealth, PathValidationResult, ProviderKind, ProviderProfile,
    ProviderTestResult,
};
use crate::pty::{PtyManager, PtySessionDescriptor};
use std::sync::Arc;
use sysinfo::{Disks, System};
use tauri::{AppHandle, State};

pub struct AppState {
    pub db: Arc<Database>,
    pub bridge: Arc<BridgeManager>,
    pub pty: Arc<PtyManager>,
    pub deploy: Arc<DeployManager>,
    pub tftp: Arc<TftpServerManager>,
    pub serial: Arc<SerialManager>,
}

#[tauri::command]
pub fn set_app_language(lang: String) -> String {
    crate::i18n::set_lang(&lang).to_string()
}

#[tauri::command]
pub async fn get_environment_health() -> Result<EnvironmentHealth, String> {
    tokio::task::spawn_blocking(|| {
        let mut sys = System::new_all();
        sys.refresh_memory();
        let cpu_cores = sys.cpus().len().max(1);
        let ram_total_gb = (sys.total_memory() as f64) / (1024.0 * 1024.0 * 1024.0);

        let disks = Disks::new_with_refreshed_list();
        let disk_free_bytes = disks
            .list()
            .iter()
            .map(|d| d.available_space())
            .max()
            .unwrap_or(0);
        let disk_free_gb = (disk_free_bytes as f64) / (1024.0 * 1024.0 * 1024.0);

        let yocto6_ram_ok = ram_total_gb >= 31.0;
        let yocto6_disk_ok = disk_free_gb >= 140.0;

        let wsl_status = wsl2::probe_wsl2();
        let docker_status = docker::probe_docker();
        let ssh_status = ssh::probe_ssh();

        let recommended_provider = if cfg!(target_os = "linux") {
            ProviderKind::Local
        } else if wsl_status.installed {
            ProviderKind::Wsl2
        } else if docker_status.daemon_running {
            ProviderKind::Docker
        } else {
            ProviderKind::Mock
        };

        let distro_count = wsl_status.distros.len();
        let mut checks = vec![
            CheckItem {
                id: "host-ram".to_string(),
                label: tr_en(
                    "Sistem Belleği (Yocto 6.0 Wrynose ≥32 GiB)",
                    "System Memory (Yocto 6.0 Wrynose ≥32 GiB)",
                )
                .to_string(),
                status: if yocto6_ram_ok { "ok" } else { "warn" }.to_string(),
                detail: crate::tf!(
                    "{ram_total_gb:.1} GiB RAM algılandı ({cpu_cores} mantıksal çekirdek).",
                    "{ram_total_gb:.1} GiB RAM detected ({cpu_cores} logical cores)."
                ),
                fix_command: if yocto6_ram_ok {
                    None
                } else {
                    Some(
                        tr_en(
                            "Büyük imajlar için Remote SSH derleme sunucusu veya swap ayarı önerilir.",
                            "For large images, a Remote SSH build server or swap configuration is recommended.",
                        )
                        .to_string(),
                    )
                },
            },
            CheckItem {
                id: "host-disk".to_string(),
                label: tr_en(
                    "Boş Disk Alanı (Yocto 6.0 ≥140 GiB)",
                    "Free Disk Space (Yocto 6.0 ≥140 GiB)",
                )
                .to_string(),
                status: if yocto6_disk_ok { "ok" } else { "warn" }.to_string(),
                detail: crate::tf!(
                    "{disk_free_gb:.1} GiB kullanılabilir alan.",
                    "{disk_free_gb:.1} GiB available space."
                ),
                fix_command: None,
            },
            CheckItem {
                id: "wsl2-status".to_string(),
                label: tr_en("WSL2 Motoru (ext4 zorunlu)", "WSL2 Engine (ext4 required)")
                    .to_string(),
                status: if wsl_status.installed { "ok" } else { "warn" }.to_string(),
                detail: if wsl_status.installed {
                    crate::tf!(
                        "WSL2 aktif ({distro_count} dağıtım).",
                        "WSL2 active ({distro_count} distributions)."
                    )
                } else {
                    tr_en(
                        "WSL2 kurulu değil; Mock veya Remote SSH motoru ile geliştirme yapılabilir.",
                        "WSL2 is not installed; development can proceed with the Mock or Remote SSH engine.",
                    )
                    .to_string()
                },
                fix_command: if wsl_status.installed {
                    None
                } else {
                    Some("wsl --install -d Ubuntu-24.04".to_string())
                },
            },
            CheckItem {
                id: "docker-status".to_string(),
                label: "Docker Desktop / CROPS / kas".to_string(),
                status: if docker_status.daemon_running { "ok" } else { "warn" }.to_string(),
                detail: docker_status.version.clone().unwrap_or_else(|| {
                    tr_en("Docker kurulu değil.", "Docker is not installed.").to_string()
                }),
                fix_command: None,
            },
            CheckItem {
                id: "ssh-status".to_string(),
                label: tr_en(
                    "OpenSSH İstemcisi (Remote Linux)",
                    "OpenSSH Client (Remote Linux)",
                )
                .to_string(),
                status: if ssh_status.client_available { "ok" } else { "warn" }.to_string(),
                detail: ssh_status.version.clone().unwrap_or_else(|| {
                    tr_en("SSH istemcisi bulunamadı.", "SSH client not found.").to_string()
                }),
                fix_command: None,
            },
        ];

        if cfg!(windows) {
            checks.push(CheckItem {
                id: "ntfs-guard".to_string(),
                label: tr_en("NTFS (/mnt/c) Güvenlik Kuralı", "NTFS (/mnt/c) Security Rule")
                    .to_string(),
                status: "ok".to_string(),
                detail: tr_en(
                    "Aktif: /mnt/c, C:\\ ve UNC yolları Rust & Python katmanlarında engellenir.",
                    "Active: /mnt/c, C:\\, and UNC paths are blocked across Rust & Python layers.",
                )
                .to_string(),
                fix_command: None,
            });
        }

        EnvironmentHealth {
            host_os: std::env::consts::OS.to_string(),
            cpu_cores,
            ram_total_gb: (ram_total_gb * 10.0).round() / 10.0,
            disk_free_gb: (disk_free_gb * 10.0).round() / 10.0,
            yocto6_ram_ok,
            yocto6_disk_ok,
            recommended_provider,
            wsl2: wsl_status,
            docker: docker_status,
            ssh: ssh_status,
            checks,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn validate_workspace_path(path: String, provider: ProviderKind) -> PathValidationResult {
    validate_linux_workspace_path(&path, provider)
}

#[tauri::command]
pub async fn test_provider_connection(profile: ProviderProfile) -> Result<ProviderTestResult, String> {
    Ok(probe_provider_conn(&profile).await)
}

#[tauri::command]
pub fn list_provider_profiles(state: State<'_, AppState>) -> Result<Vec<ProviderProfile>, String> {
    state.db.list_provider_profiles().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_provider_profile(
    state: State<'_, AppState>,
    profile: ProviderProfile,
) -> Result<(), String> {
    state.db.upsert_provider_profile(&profile).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_provider_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state.db.delete_provider_profile(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_wslconfig(
    memory: String,
    processors: u32,
    swap: Option<String>,
) -> Result<wsl2::WslConfigInfo, String> {
    wsl2::write_user_wslconfig(&memory, processors, swap.as_deref())
}

#[tauri::command]
pub fn get_vhdx_maintenance_plan(
    vhdx_path: String,
    mount_point: String,
    size_gb: u32,
    sstate_dir: String,
) -> wsl2::VhdxMaintenancePlan {
    wsl2::build_vhdx_maintenance_plan(&vhdx_path, &mount_point, size_gb, &sstate_dir)
}

#[tauri::command]
pub async fn ensure_docker_volumes() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| docker::ensure_named_volumes(&docker::DEFAULT_VOLUMES))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn get_bridge_status(state: State<'_, AppState>) -> BridgeStatus {
    state.bridge.status()
}

#[tauri::command]
pub fn restart_bridge(state: State<'_, AppState>, mock: bool) -> BridgeStatus {
    state.bridge.stop();
    state.bridge.ensure_started(mock)
}

#[tauri::command]
pub fn list_saved_projects(state: State<'_, AppState>) -> Result<Vec<SavedProjectRecord>, String> {
    state.db.list_projects().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_project(state: State<'_, AppState>, record: SavedProjectRecord) -> Result<(), String> {
    state.db.upsert_project(&record).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_build_runs(state: State<'_, AppState>) -> Result<Vec<BuildRunRecord>, String> {
    state.db.list_build_runs(50).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_build_run(state: State<'_, AppState>, record: BuildRunRecord) -> Result<(), String> {
    state.db.record_build_run(&record).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_local_open(
    app: AppHandle,
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    shell_cmd: Option<String>,
    cwd: Option<String>,
) -> Result<PtySessionDescriptor, String> {
    state
        .pty
        .open_session(Some(&app), cols, rows, shell_cmd.as_deref(), cwd.as_deref())
}

#[tauri::command]
pub fn pty_local_write(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.pty.write(&session_id, &data)
}

#[tauri::command]
pub fn pty_local_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty.resize(&session_id, cols, rows)
}

#[tauri::command]
pub fn pty_local_close(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.pty.close(&session_id)
}

#[tauri::command]
pub async fn list_removable_drives(
    include_mock_if_empty: Option<bool>,
) -> Result<Vec<RemovableDriveInfo>, String> {
    let allow_mock = include_mock_if_empty.unwrap_or(true);
    tokio::task::spawn_blocking(move || probe_removable_drives(allow_mock))
        .await
        .map_err(|e| format!("Drive probe join error: {e}"))
}

#[tauri::command]
pub async fn build_flash_plan(
    image_path: String,
    target_device: String,
) -> Result<FlashPlan, String> {
    tokio::task::spawn_blocking(move || {
        let drives = probe_removable_drives(true);
        compute_flash_plan(&image_path, &target_device, &drives)
    })
    .await
    .map_err(|e| format!("Flash plan join error: {e}"))?
}

#[tauri::command]
pub async fn copy_artifact_to_host(
    source_path: String,
    dest_dir: Option<String>,
) -> Result<CopyArtifactResult, String> {
    tokio::task::spawn_blocking(move || copy_to_host_fs(&source_path, dest_dir.as_deref()))
        .await
        .map_err(|e| format!("Copy artifact join error: {e}"))?
}
