use crate::ai_triage::{
    load_byok_api_key,
    redaction::{extract_error_window, redact_secrets, RedactionResult},
    run_ai_triage as execute_ai_triage, store_byok_api_key, AiSettings, AiTriageRequest,
    AiTriageResponse,
};
use crate::commands::AppState;
use crate::db::QaRunRecord;
use tauri::State;

#[tauri::command]
pub fn get_ai_settings(state: State<'_, AppState>) -> Result<AiSettings, String> {
    let mut settings = match state.db.get_setting("ai.settings").map_err(|e| e.to_string())? {
        Some(raw) => serde_json::from_str::<AiSettings>(&raw).unwrap_or_default(),
        None => AiSettings::default(),
    };
    settings.has_api_key = load_byok_api_key().is_some();
    Ok(settings)
}

#[tauri::command]
pub fn save_ai_settings(
    state: State<'_, AppState>,
    mut settings: AiSettings,
    api_key: Option<String>,
) -> Result<AiSettings, String> {
    if let Some(key) = api_key {
        store_byok_api_key(&key)?;
    }
    settings.has_api_key = load_byok_api_key().is_some();
    let json = serde_json::to_string(&settings).map_err(|e| e.to_string())?;
    state
        .db
        .set_setting("ai.settings", &json)
        .map_err(|e| e.to_string())?;
    Ok(settings)
}

#[tauri::command]
pub fn preview_redacted_log(log_content: String) -> RedactionResult {
    redact_secrets(&extract_error_window(&log_content))
}

#[tauri::command]
pub async fn run_ai_triage(
    state: State<'_, AppState>,
    req: AiTriageRequest,
) -> Result<AiTriageResponse, String> {
    let settings = match state.db.get_setting("ai.settings").map_err(|e| e.to_string())? {
        Some(raw) => serde_json::from_str::<AiSettings>(&raw).unwrap_or_default(),
        None => AiSettings::default(),
    };
    let key = load_byok_api_key();
    execute_ai_triage(&settings, key, &req).await
}

#[tauri::command]
pub fn list_qa_runs(state: State<'_, AppState>) -> Result<Vec<QaRunRecord>, String> {
    state.db.list_qa_runs(30).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn record_qa_run(state: State<'_, AppState>, record: QaRunRecord) -> Result<(), String> {
    state.db.record_qa_run(&record).map_err(|e| e.to_string())
}
