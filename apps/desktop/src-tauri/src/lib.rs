pub mod ai_triage;
pub mod bridge;
pub mod commands;
pub mod db;
pub mod deploy;
pub mod flash;
pub mod i18n;
pub mod providers;
pub mod pty;

use bridge::BridgeManager;
use commands::{deploy_cmds, enterprise_cmds, preflight_cmds, pro_cmds, AppState};
use db::Database;
use deploy::{
    net_deploy::tftp_server::TftpServerManager, serial::manager::SerialManager, DeployManager,
};
use pty::PtyManager;
use std::sync::Arc;
use tauri::{Manager, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "yocto_studio=info".into()),
        )
        .init();

    let bridge_manager = Arc::new(BridgeManager::new());
    let bridge_for_exit = Arc::clone(&bridge_manager);
    let pty_manager = Arc::new(PtyManager::new());
    let pty_for_exit = Arc::clone(&pty_manager);
    let tftp_manager = Arc::new(TftpServerManager::new());
    let tftp_for_exit = Arc::clone(&tftp_manager);
    let serial_manager = Arc::new(SerialManager::new());
    let serial_for_exit = Arc::clone(&serial_manager);
    let staging_default = std::env::temp_dir().join("yocto-studio-staging");
    let deploy_manager = Arc::new(DeployManager::new(staging_default));
    let deploy_for_exit = Arc::clone(&deploy_manager);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(move |app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| std::env::temp_dir().join("yocto-studio"));
            let db_path = data_dir.join("yocto_studio.db");
            let db = Arc::new(Database::open_at(&db_path).expect("failed to open SQLite database"));
            deploy_manager.set_staging_root(data_dir.join("staging"));

            // Start mock yocto-bridge automatically in Phase 1
            bridge_manager.ensure_started(true);

            app.manage(AppState {
                db,
                bridge: Arc::clone(&bridge_manager),
                pty: Arc::clone(&pty_manager),
                deploy: Arc::clone(&deploy_manager),
                tftp: Arc::clone(&tftp_manager),
                serial: Arc::clone(&serial_manager),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::set_app_language,
            commands::get_environment_health,
            commands::validate_workspace_path,
            commands::test_provider_connection,
            commands::list_provider_profiles,
            commands::save_provider_profile,
            commands::delete_provider_profile,
            commands::update_wslconfig,
            commands::get_vhdx_maintenance_plan,
            commands::ensure_docker_volumes,
            commands::get_bridge_status,
            commands::restart_bridge,
            commands::list_saved_projects,
            commands::save_project,
            commands::list_build_runs,
            commands::record_build_run,
            commands::pty_local_open,
            commands::pty_local_write,
            commands::pty_local_resize,
            commands::pty_local_close,
            commands::list_removable_drives,
            commands::build_flash_plan,
            commands::copy_artifact_to_host,
            deploy_cmds::list_target_profiles,
            deploy_cmds::save_target_profile,
            deploy_cmds::delete_target_profile,
            deploy_cmds::get_flash_tools_health,
            deploy_cmds::set_flash_tool_path,
            deploy_cmds::stage_deploy_artifact,
            deploy_cmds::list_usb_deploy_devices,
            deploy_cmds::list_dfu_altsettings,
            deploy_cmds::start_usb_flash,
            deploy_cmds::cancel_deploy_job,
            deploy_cmds::list_network_interfaces,
            deploy_cmds::start_tftp_server,
            deploy_cmds::stop_tftp_server,
            deploy_cmds::get_tftp_status,
            deploy_cmds::generate_uboot_tftp_script,
            deploy_cmds::swupdate_deploy,
            deploy_cmds::rauc_get_status,
            deploy_cmds::rauc_install_bundle,
            deploy_cmds::ssh_list_block_devices,
            deploy_cmds::ssh_flash_partition,
            deploy_cmds::list_serial_ports,
            deploy_cmds::open_serial_port,
            deploy_cmds::write_serial_port,
            deploy_cmds::close_serial_port,
            deploy_cmds::set_serial_auto_interrupt,
            deploy_cmds::get_uboot_macros,
            deploy_cmds::save_serial_log,
            preflight_cmds::get_preflight_host_profile,
            preflight_cmds::get_preflight_gate_enabled,
            preflight_cmds::set_preflight_gate_enabled,
            pro_cmds::get_ai_settings,
            pro_cmds::save_ai_settings,
            pro_cmds::preview_redacted_log,
            pro_cmds::run_ai_triage,
            pro_cmds::list_qa_runs,
            pro_cmds::record_qa_run,
            enterprise_cmds::export_project_snapshot,
            enterprise_cmds::import_project_snapshot,
            enterprise_cmds::get_updater_config,
            enterprise_cmds::set_updater_auto_check,
            enterprise_cmds::check_app_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Yocto Studio Tauri application");

    app.run(move |_app_handle, event| {
        if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
            serial_for_exit.close_all();
            deploy_for_exit.cancel_all();
            tftp_for_exit.stop_blocking();
            pty_for_exit.close_all();
            bridge_for_exit.stop();
        }
    });
}
