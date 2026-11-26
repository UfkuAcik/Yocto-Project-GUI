use crate::commands::AppState;
use crate::db::TargetProfileRecord;
use crate::deploy::net_deploy::{
    rauc::{install_rauc_bundle, query_rauc_status, RaucInstallRequest, RaucStatus},
    ssh_raw::{flash_remote_partition, list_remote_block_devices, RemoteBlockDevice, SshRawFlashRequest},
    swupdate::{deploy_swupdate, SwUpdateRequest},
    tftp_server::{
        generate_uboot_tftp_script as build_tftp_script,
        list_network_interfaces as probe_network_interfaces, NetworkInterfaceInfo, TftpStatus,
    },
};
use crate::deploy::serial::{
    manager::{SerialOpenConfig, SerialPortInfo},
    uboot_macros::{default_uboot_macros, UbootMacro},
};
use crate::deploy::staging::{stage_artifact, StagedArtifact, StagingRequest};
use crate::deploy::usb_flashers::{
    collect_all_usb_devices,
    dfu::{list_dfu_altsettings as probe_dfu_altsettings, DfuAltSetting},
};
use crate::deploy::{
    DeployEventSink, DeployStatusEvent, FlashOutcome, FlashRequest, FlashToolStatus,
    TauriEventSink, UsbDetectedDevice,
};
use std::sync::Arc;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn list_target_profiles(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<Vec<TargetProfileRecord>, String> {
    state
        .db
        .list_target_profiles(project_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn save_target_profile(
    state: State<'_, AppState>,
    profile: TargetProfileRecord,
) -> Result<(), String> {
    state
        .db
        .upsert_target_profile(&profile)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_target_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .db
        .delete_target_profile(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_flash_tools_health(state: State<'_, AppState>) -> Result<Vec<FlashToolStatus>, String> {
    let deploy = Arc::clone(&state.deploy);
    let db = Arc::clone(&state.db);
    tokio::task::spawn_blocking(move || {
        for tid in [
            "fastboot",
            "dfu-util",
            "uuu",
            "stm32_prog",
            "rpiboot",
            "sp-flash-tool",
            "rkdeveloptool",
        ] {
            if let Ok(Some(saved)) = db.get_setting(&format!("tool.{tid}")) {
                deploy.set_tool_override(tid.to_string(), saved);
            }
        }
        deploy.check_tools_health()
    })
    .await
    .map_err(|e| format!("Tool health probe error: {e}"))
}

#[tauri::command]
pub fn set_flash_tool_path(
    state: State<'_, AppState>,
    tool_id: String,
    path: String,
) -> Result<(), String> {
    state
        .db
        .set_setting(&format!("tool.{tool_id}"), &path)
        .map_err(|e| e.to_string())?;
    state.deploy.set_tool_override(tool_id, path);
    Ok(())
}

#[tauri::command]
pub async fn stage_deploy_artifact(
    state: State<'_, AppState>,
    req: StagingRequest,
) -> Result<StagedArtifact, String> {
    let root = state.deploy.staging_root();
    tokio::task::spawn_blocking(move || stage_artifact(&root, &req))
        .await
        .map_err(|e| format!("Staging join error: {e}"))?
}

#[tauri::command]
pub async fn list_usb_deploy_devices(
    state: State<'_, AppState>,
    include_mock: Option<bool>,
) -> Result<Vec<UsbDetectedDevice>, String> {
    let fb = state.deploy.resolve_tool_binary("fastboot", "fastboot");
    let uuu = state.deploy.resolve_tool_binary("uuu", "uuu");
    let dfu = state.deploy.resolve_tool_binary("dfu-util", "dfu-util");
    let rk = state.deploy.resolve_tool_binary("rkdeveloptool", "rkdeveloptool");
    let mock = include_mock.unwrap_or(true);
    tokio::task::spawn_blocking(move || collect_all_usb_devices(&fb, &uuu, &dfu, &rk, mock))
        .await
        .map_err(|e| format!("USB device probe error: {e}"))
}

#[tauri::command]
pub async fn list_dfu_altsettings(
    state: State<'_, AppState>,
    include_mock: Option<bool>,
) -> Result<Vec<DfuAltSetting>, String> {
    let bin = state.deploy.resolve_tool_binary("dfu-util", "dfu-util");
    let mock = include_mock.unwrap_or(true);
    tokio::task::spawn_blocking(move || probe_dfu_altsettings(&bin, mock))
        .await
        .map_err(|e| format!("DFU probe error: {e}"))
}

#[tauri::command]
pub fn start_usb_flash(
    app: AppHandle,
    state: State<'_, AppState>,
    req: FlashRequest,
) -> Result<String, String> {
    let sink = Arc::new(TauriEventSink::new(app));
    state.deploy.start_flash_job(req, sink)
}

#[tauri::command]
pub fn cancel_deploy_job(state: State<'_, AppState>, job_id: String) -> bool {
    state.deploy.cancel_job(&job_id)
}

#[tauri::command]
pub fn list_network_interfaces() -> Vec<NetworkInterfaceInfo> {
    probe_network_interfaces()
}

#[tauri::command]
pub async fn start_tftp_server(
    app: AppHandle,
    state: State<'_, AppState>,
    bind_ip: String,
    port: u16,
    root_dir: Option<String>,
) -> Result<TftpStatus, String> {
    let resolved_root = root_dir
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| state.deploy.staging_root().to_string_lossy().to_string());
    state
        .tftp
        .start(Some(app), &bind_ip, port, &resolved_root)
        .await
}

#[tauri::command]
pub async fn stop_tftp_server(state: State<'_, AppState>) -> Result<TftpStatus, String> {
    Ok(state.tftp.stop().await)
}

#[tauri::command]
pub fn get_tftp_status(state: State<'_, AppState>) -> TftpStatus {
    state.tftp.status()
}

#[tauri::command]
pub fn generate_uboot_tftp_script(
    server_ip: String,
    target_ip: String,
    kernel_file: String,
    dtb_file: String,
) -> String {
    build_tftp_script(&server_ip, &target_ip, &kernel_file, &dtb_file)
}

#[tauri::command]
pub async fn swupdate_deploy(
    app: AppHandle,
    req: SwUpdateRequest,
) -> Result<FlashOutcome, String> {
    let sink = Arc::new(TauriEventSink::new(app));
    tokio::task::spawn_blocking(move || {
        let jid = req.job_id.clone();
        let res = deploy_swupdate(&req, Arc::clone(&sink) as Arc<dyn DeployEventSink>);
        match &res {
            Ok(out) => sink.emit_status(DeployStatusEvent {
                job_id: jid,
                status: "succeeded".into(),
                summary: out.summary.clone(),
                sha256: None,
            }),
            Err(e) => sink.emit_status(DeployStatusEvent {
                job_id: jid,
                status: "failed".into(),
                summary: e.clone(),
                sha256: None,
            }),
        }
        res
    })
    .await
    .map_err(|e| format!("SWUpdate join error: {e}"))?
}

#[tauri::command]
pub async fn rauc_get_status(
    host: String,
    ssh_user: String,
    ssh_key_ref: String,
    mock_mode: bool,
) -> Result<RaucStatus, String> {
    tokio::task::spawn_blocking(move || query_rauc_status(&host, &ssh_user, &ssh_key_ref, mock_mode))
        .await
        .map_err(|e| format!("RAUC query error: {e}"))?
}

#[tauri::command]
pub async fn rauc_install_bundle(
    app: AppHandle,
    req: RaucInstallRequest,
) -> Result<FlashOutcome, String> {
    let sink = Arc::new(TauriEventSink::new(app));
    tokio::task::spawn_blocking(move || {
        let jid = req.job_id.clone();
        let res = install_rauc_bundle(&req, Arc::clone(&sink) as Arc<dyn DeployEventSink>);
        match &res {
            Ok(out) => sink.emit_status(DeployStatusEvent {
                job_id: jid,
                status: "succeeded".into(),
                summary: out.summary.clone(),
                sha256: None,
            }),
            Err(e) => sink.emit_status(DeployStatusEvent {
                job_id: jid,
                status: "failed".into(),
                summary: e.clone(),
                sha256: None,
            }),
        }
        res
    })
    .await
    .map_err(|e| format!("RAUC install error: {e}"))?
}

#[tauri::command]
pub async fn ssh_list_block_devices(
    host: String,
    ssh_user: String,
    ssh_key_ref: String,
    mock_mode: bool,
) -> Result<Vec<RemoteBlockDevice>, String> {
    tokio::task::spawn_blocking(move || {
        list_remote_block_devices(&host, &ssh_user, &ssh_key_ref, mock_mode)
    })
    .await
    .map_err(|e| format!("SSH lsblk join error: {e}"))?
}

#[tauri::command]
pub async fn ssh_flash_partition(
    app: AppHandle,
    req: SshRawFlashRequest,
) -> Result<FlashOutcome, String> {
    let sink = Arc::new(TauriEventSink::new(app));
    tokio::task::spawn_blocking(move || {
        let jid = req.job_id.clone();
        let res = flash_remote_partition(&req, Arc::clone(&sink) as Arc<dyn DeployEventSink>);
        match &res {
            Ok(out) => sink.emit_status(DeployStatusEvent {
                job_id: jid,
                status: "succeeded".into(),
                summary: out.summary.clone(),
                sha256: None,
            }),
            Err(e) => sink.emit_status(DeployStatusEvent {
                job_id: jid,
                status: "failed".into(),
                summary: e.clone(),
                sha256: None,
            }),
        }
        res
    })
    .await
    .map_err(|e| format!("SSH raw join error: {e}"))?
}

#[tauri::command]
pub fn list_serial_ports(
    state: State<'_, AppState>,
    include_virtual: Option<bool>,
) -> Vec<SerialPortInfo> {
    state.serial.list_ports(include_virtual.unwrap_or(true))
}

#[tauri::command]
pub fn open_serial_port(
    app: AppHandle,
    state: State<'_, AppState>,
    config: SerialOpenConfig,
) -> Result<String, String> {
    state.serial.open_port(Some(&app), config, None)
}

#[tauri::command]
pub fn write_serial_port(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.serial.write(&session_id, &data)
}

#[tauri::command]
pub fn close_serial_port(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state.serial.close(&session_id)
}

#[tauri::command]
pub fn set_serial_auto_interrupt(
    state: State<'_, AppState>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    state.serial.set_auto_interrupt(&session_id, enabled)
}

#[tauri::command]
pub fn get_uboot_macros() -> Vec<UbootMacro> {
    default_uboot_macros()
}

#[tauri::command]
pub fn save_serial_log(
    state: State<'_, AppState>,
    session_id: String,
    dest_path: String,
) -> Result<usize, String> {
    state.serial.save_log(&session_id, &dest_path)
}
