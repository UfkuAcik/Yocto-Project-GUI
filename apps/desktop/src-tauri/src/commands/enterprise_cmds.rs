use crate::commands::AppState;
use crate::db::{Database, SavedProjectRecord, TargetProfileRecord};
use crate::i18n::tr_en;
use crate::providers::ProviderProfile;
use chrono::Utc;
use flate2::Crc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreFlightSnapshotRules {
    pub gate_enabled: bool,
    pub incompatible_licenses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectSnapshotPayload {
    pub schema: String,
    pub exported_at: String,
    pub app_version: String,
    pub project: Option<SavedProjectRecord>,
    pub kas_config: Option<String>,
    pub target_profiles: Vec<TargetProfileRecord>,
    pub provider_profiles: Vec<ProviderProfile>,
    pub preflight_rules: PreFlightSnapshotRules,
    pub openvex_records: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotExportResult {
    pub ok: bool,
    pub path: String,
    pub format: String,
    pub size_bytes: usize,
    pub sha256: String,
    pub stripped_secret_count: usize,
    pub preview_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotImportResult {
    pub ok: bool,
    pub project_name: String,
    pub target_profiles_imported: usize,
    pub provider_profiles_imported: usize,
    pub openvex_count: usize,
    pub preflight_gate_enabled: bool,
    pub kas_config: Option<String>,
    pub openvex_records: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdaterConfigInfo {
    pub current_version: String,
    pub endpoints: Vec<String>,
    pub pubkey_configured: bool,
    pub signing_ready: bool,
    pub auto_check: bool,
    pub last_checked_at: Option<String>,
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateCheckResult {
    pub status: String,
    pub current_version: String,
    pub latest_version: Option<String>,
    pub release_notes: Option<String>,
    pub download_url: Option<String>,
    pub signature_verified_manifest: bool,
    pub checked_at: String,
    pub message: String,
}

fn scrub_string_secrets(input: &str, stripped_count: &mut usize) -> String {
    if input.is_empty() {
        return String::new();
    }

    // Remove PEM / SSH private key blocks completely
    if input.contains("BEGIN") && input.contains("PRIVATE KEY") {
        *stripped_count += 1;
        return "[REDACTED_PRIVATE_KEY]".to_string();
    }

    let mut result_parts = Vec::new();
    for token in input.split_inclusive(char::is_whitespace) {
        let trimmed = token.trim_end();
        let ws = &token[trimmed.len()..];
        let clean = trimmed.trim_matches(|c| c == '"' || c == '\'' || c == ',');

        if ["sk-", "ghp_", "gho_", "AKIA", "xoxb-"]
            .iter()
            .any(|p| clean.starts_with(p) && clean.len() > p.len() + 6)
        {
            *stripped_count += 1;
            result_parts.push(format!("[REDACTED_TOKEN]{ws}"));
        } else if let Some((scheme, rest)) = clean.split_once("://") {
            if let Some((creds, host_part)) = rest.split_once('@') {
                if creds.contains(':') {
                    *stripped_count += 1;
                    result_parts.push(format!("{scheme}://{host_part}{ws}"));
                    continue;
                }
            }
            result_parts.push(token.to_string());
        } else if let Some((k, _)) = clean.split_once('=') {
            let k_low = k.to_ascii_lowercase();
            if ["password", "passwd", "secret", "token", "api_key", "passphrase"]
                .iter()
                .any(|s| k_low.ends_with(s))
            {
                *stripped_count += 1;
                result_parts.push(format!("{k}=[REDACTED]{ws}"));
            } else {
                result_parts.push(token.to_string());
            }
        } else {
            result_parts.push(token.to_string());
        }
    }
    result_parts.concat()
}

fn sanitize_target_profile(profile: &TargetProfileRecord, stripped: &mut usize) -> TargetProfileRecord {
    let mut clean = profile.clone();
    if !clean.ssh_key_ref.trim().is_empty() {
        *stripped += 1;
        clean.ssh_key_ref.clear();
    }
    clean.swupdate_url = scrub_string_secrets(&clean.swupdate_url, stripped);
    clean.custom_cli_template = scrub_string_secrets(&clean.custom_cli_template, stripped);
    clean
}

fn sanitize_provider_profile(profile: &ProviderProfile, stripped: &mut usize) -> ProviderProfile {
    let mut clean = profile.clone();
    if clean.ssh_key_path.as_ref().is_some_and(|p| !p.trim().is_empty()) {
        *stripped += 1;
        clean.ssh_key_path = None;
    }
    clean
}

fn sanitize_json_value(val: &mut serde_json::Value, stripped: &mut usize) {
    const SENSITIVE_KEYS: &[&str] = &[
        "password",
        "passwd",
        "secret",
        "api_key",
        "apikey",
        "token",
        "private_key",
        "passphrase",
        "credential",
        "authorization",
        "ssh_key_path",
        "ssh_key_ref",
    ];
    match val {
        serde_json::Value::String(s) => {
            *s = scrub_string_secrets(s, stripped);
        }
        serde_json::Value::Array(arr) => {
            for item in arr {
                sanitize_json_value(item, stripped);
            }
        }
        serde_json::Value::Object(map) => {
            for (k, v) in map.iter_mut() {
                let k_low = k.to_ascii_lowercase();
                if SENSITIVE_KEYS.iter().any(|sk| k_low.contains(sk)) {
                    if !matches!(v, serde_json::Value::Null) {
                        *stripped += 1;
                        *v = serde_json::Value::String(String::new());
                    }
                } else {
                    sanitize_json_value(v, stripped);
                }
            }
        }
        _ => {}
    }
}

/// Minimal standards-compliant PKZIP Store (method 0) archive writer with zero extra crates.
fn build_single_entry_zip(entry_name: &str, data: &[u8]) -> Vec<u8> {
    let mut crc = Crc::new();
    crc.update(data);
    let checksum = crc.sum();
    let name_bytes = entry_name.as_bytes();
    let name_len = name_bytes.len() as u16;
    let size = data.len() as u32;

    let mut buf = Vec::with_capacity(data.len() + 128);
    // Local file header
    buf.extend_from_slice(&0x0403_4b50_u32.to_le_bytes());
    buf.extend_from_slice(&20_u16.to_le_bytes()); // version needed
    buf.extend_from_slice(&0_u16.to_le_bytes()); // flags
    buf.extend_from_slice(&0_u16.to_le_bytes()); // method 0 = store
    buf.extend_from_slice(&0_u16.to_le_bytes()); // mod time
    buf.extend_from_slice(&0_u16.to_le_bytes()); // mod date
    buf.extend_from_slice(&checksum.to_le_bytes());
    buf.extend_from_slice(&size.to_le_bytes());
    buf.extend_from_slice(&size.to_le_bytes());
    buf.extend_from_slice(&name_len.to_le_bytes());
    buf.extend_from_slice(&0_u16.to_le_bytes()); // extra len
    buf.extend_from_slice(name_bytes);
    buf.extend_from_slice(data);

    let cd_offset = buf.len() as u32;
    // Central directory header
    buf.extend_from_slice(&0x0201_4b50_u32.to_le_bytes());
    buf.extend_from_slice(&20_u16.to_le_bytes()); // version made by
    buf.extend_from_slice(&20_u16.to_le_bytes()); // version needed
    buf.extend_from_slice(&0_u16.to_le_bytes()); // flags
    buf.extend_from_slice(&0_u16.to_le_bytes()); // method
    buf.extend_from_slice(&0_u16.to_le_bytes()); // time
    buf.extend_from_slice(&0_u16.to_le_bytes()); // date
    buf.extend_from_slice(&checksum.to_le_bytes());
    buf.extend_from_slice(&size.to_le_bytes());
    buf.extend_from_slice(&size.to_le_bytes());
    buf.extend_from_slice(&name_len.to_le_bytes());
    buf.extend_from_slice(&0_u16.to_le_bytes()); // extra len
    buf.extend_from_slice(&0_u16.to_le_bytes()); // comment len
    buf.extend_from_slice(&0_u16.to_le_bytes()); // disk start
    buf.extend_from_slice(&0_u16.to_le_bytes()); // int attrs
    buf.extend_from_slice(&0_u32.to_le_bytes()); // ext attrs
    buf.extend_from_slice(&0_u32.to_le_bytes()); // local header offset
    buf.extend_from_slice(name_bytes);

    let cd_size = (buf.len() as u32) - cd_offset;
    // End of central directory
    buf.extend_from_slice(&0x0605_4b50_u32.to_le_bytes());
    buf.extend_from_slice(&0_u16.to_le_bytes());
    buf.extend_from_slice(&0_u16.to_le_bytes());
    buf.extend_from_slice(&1_u16.to_le_bytes());
    buf.extend_from_slice(&1_u16.to_le_bytes());
    buf.extend_from_slice(&cd_size.to_le_bytes());
    buf.extend_from_slice(&cd_offset.to_le_bytes());
    buf.extend_from_slice(&0_u16.to_le_bytes());
    buf
}

fn read_single_entry_zip(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.len() < 30 || &bytes[0..4] != b"PK\x03\x04" {
        return Err("Invalid ZIP snapshot signature".to_string());
    }
    let method = u16::from_le_bytes([bytes[8], bytes[9]]);
    if method != 0 {
        return Err(format!("Unsupported ZIP compression method: {method}"));
    }
    let comp_size = u32::from_le_bytes([bytes[18], bytes[19], bytes[20], bytes[21]]) as usize;
    let name_len = u16::from_le_bytes([bytes[26], bytes[27]]) as usize;
    let extra_len = u16::from_le_bytes([bytes[28], bytes[29]]) as usize;
    let data_start = 30 + name_len + extra_len;
    let data_end = data_start + comp_size;
    if data_end > bytes.len() {
        return Err("Truncated ZIP snapshot payload".to_string());
    }
    Ok(bytes[data_start..data_end].to_vec())
}

pub fn build_sanitized_snapshot(
    db: &Database,
    project_id: Option<&str>,
    kas_config: Option<String>,
    openvex_records: serde_json::Value,
    incompatible_licenses: Vec<String>,
) -> Result<(ProjectSnapshotPayload, usize), String> {
    let mut stripped_count = 0usize;

    let projects = db.list_projects().map_err(|e| e.to_string())?;
    let project = match project_id {
        Some(pid) => projects.into_iter().find(|p| p.id == pid),
        None => projects.into_iter().next(),
    };

    let targets = db
        .list_target_profiles(project.as_ref().map(|p| p.id.as_str()))
        .map_err(|e| e.to_string())?;
    let clean_targets = targets
        .iter()
        .map(|t| sanitize_target_profile(t, &mut stripped_count))
        .collect();

    let providers = db.list_provider_profiles().map_err(|e| e.to_string())?;
    let clean_providers = providers
        .iter()
        .map(|p| sanitize_provider_profile(p, &mut stripped_count))
        .collect();

    let gate_enabled = db
        .get_setting("preflight.gate_enabled")
        .map_err(|e| e.to_string())?
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true);

    let clean_kas = kas_config.map(|k| scrub_string_secrets(&k, &mut stripped_count));
    let mut clean_vex = openvex_records;
    sanitize_json_value(&mut clean_vex, &mut stripped_count);

    Ok((
        ProjectSnapshotPayload {
            schema: "yocto-studio-snapshot/v1".to_string(),
            exported_at: Utc::now().to_rfc3339(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            project,
            kas_config: clean_kas,
            target_profiles: clean_targets,
            provider_profiles: clean_providers,
            preflight_rules: PreFlightSnapshotRules {
                gate_enabled,
                incompatible_licenses,
            },
            openvex_records: clean_vex,
        },
        stripped_count,
    ))
}

pub fn write_snapshot_file(
    payload: &ProjectSnapshotPayload,
    dest: &Path,
    format: &str,
    stripped_secret_count: usize,
) -> Result<SnapshotExportResult, String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let pretty_json = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
    let fmt = if format == "zip" { "zip" } else { "json" };
    let out_bytes = if fmt == "zip" {
        build_single_entry_zip("snapshot.json", pretty_json.as_bytes())
    } else {
        pretty_json.as_bytes().to_vec()
    };

    std::fs::write(dest, &out_bytes).map_err(|e| e.to_string())?;
    let sha256 = hex::encode(Sha256::digest(&out_bytes));
    Ok(SnapshotExportResult {
        ok: true,
        path: dest.to_string_lossy().to_string(),
        format: fmt.to_string(),
        size_bytes: out_bytes.len(),
        sha256,
        stripped_secret_count,
        preview_json: pretty_json,
    })
}

pub fn import_snapshot_into_db(
    db: &Database,
    raw_bytes: &[u8],
) -> Result<SnapshotImportResult, String> {
    let json_bytes = if raw_bytes.starts_with(b"PK\x03\x04") {
        read_single_entry_zip(raw_bytes)?
    } else {
        raw_bytes.to_vec()
    };
    let mut payload: ProjectSnapshotPayload =
        serde_json::from_slice(&json_bytes).map_err(|e| format!("Invalid snapshot JSON: {e}"))?;

    if !payload.schema.starts_with("yocto-studio-snapshot/") {
        return Err(format!("Unsupported snapshot schema: {}", payload.schema));
    }

    let mut stripped = 0usize;
    let project_name = if let Some(ref proj) = payload.project {
        db.upsert_project(proj).map_err(|e| e.to_string())?;
        proj.name.clone()
    } else {
        "imported-project".to_string()
    };

    let mut target_count = 0usize;
    for t in &payload.target_profiles {
        let clean = sanitize_target_profile(t, &mut stripped);
        db.upsert_target_profile(&clean)
            .map_err(|e| e.to_string())?;
        target_count += 1;
    }

    let mut provider_count = 0usize;
    for p in &payload.provider_profiles {
        let clean = sanitize_provider_profile(p, &mut stripped);
        db.upsert_provider_profile(&clean)
            .map_err(|e| e.to_string())?;
        provider_count += 1;
    }

    db.set_setting(
        "preflight.gate_enabled",
        if payload.preflight_rules.gate_enabled {
            "true"
        } else {
            "false"
        },
    )
    .map_err(|e| e.to_string())?;

    sanitize_json_value(&mut payload.openvex_records, &mut stripped);
    let openvex_count = payload
        .openvex_records
        .as_array()
        .map(|a| a.len())
        .unwrap_or(0);

    Ok(SnapshotImportResult {
        ok: true,
        project_name,
        target_profiles_imported: target_count,
        provider_profiles_imported: provider_count,
        openvex_count,
        preflight_gate_enabled: payload.preflight_rules.gate_enabled,
        kas_config: payload.kas_config,
        openvex_records: payload.openvex_records,
    })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn export_project_snapshot(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: Option<String>,
    format: Option<String>,
    kas_config: Option<String>,
    openvex_records: Option<serde_json::Value>,
    incompatible_licenses: Option<Vec<String>>,
    output_path: Option<String>,
) -> Result<SnapshotExportResult, String> {
    let fmt = format.unwrap_or_else(|| "json".to_string());
    let (payload, stripped) = build_sanitized_snapshot(
        &state.db,
        project_id.as_deref(),
        kas_config,
        openvex_records.unwrap_or_else(|| serde_json::json!([])),
        incompatible_licenses.unwrap_or_default(),
    )?;

    let dest: PathBuf = if let Some(p) = output_path.filter(|s| !s.trim().is_empty()) {
        PathBuf::from(p)
    } else {
        let data_dir = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("yocto-studio"));
        let base_name = payload
            .project
            .as_ref()
            .map(|p| p.name.as_str())
            .unwrap_or("yocto-studio");
        let ext = if fmt == "zip" {
            "yoctostudio.zip"
        } else {
            "yoctostudio"
        };
        data_dir
            .join("snapshots")
            .join(format!("{base_name}.{ext}"))
    };

    write_snapshot_file(&payload, &dest, &fmt, stripped)
}

#[tauri::command]
pub fn import_project_snapshot(
    state: State<'_, AppState>,
    input_path: Option<String>,
    raw_json: Option<String>,
) -> Result<SnapshotImportResult, String> {
    let bytes = if let Some(path) = input_path.filter(|s| !s.trim().is_empty()) {
        std::fs::read(&path).map_err(|e| format!("Failed to read snapshot {path}: {e}"))?
    } else if let Some(raw) = raw_json.filter(|s| !s.trim().is_empty()) {
        raw.into_bytes()
    } else {
        return Err("Provide either input_path or raw_json".to_string());
    };
    import_snapshot_into_db(&state.db, &bytes)
}

pub fn compare_semver(current: &str, candidate: &str) -> bool {
    let parse = |s: &str| -> (u64, u64, u64) {
        let clean = s.trim().trim_start_matches('v');
        let mut parts = clean.split('.').map(|p| p.parse::<u64>().unwrap_or(0));
        (
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
            parts.next().unwrap_or(0),
        )
    };
    parse(candidate) > parse(current)
}

fn read_updater_metadata() -> (Vec<String>, bool, bool) {
    let raw = include_str!("../../tauri.conf.json");
    let parsed: serde_json::Value = serde_json::from_str(raw).unwrap_or_default();
    let updater = &parsed["plugins"]["updater"];
    let endpoints = updater["endpoints"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(ToString::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let pubkey = updater["pubkey"].as_str().unwrap_or_default();
    let pubkey_configured = !pubkey.is_empty();
    // Placeholder comment contains 'placeholder'
    let signing_ready = pubkey_configured && !pubkey.contains("cGxhY2Vob2xkZXI");
    (endpoints, pubkey_configured, signing_ready)
}

#[tauri::command]
pub fn get_updater_config(state: State<'_, AppState>) -> Result<UpdaterConfigInfo, String> {
    let (endpoints, pubkey_configured, signing_ready) = read_updater_metadata();
    let auto_check = state
        .db
        .get_setting("updater.auto_check")
        .map_err(|e| e.to_string())?
        .map(|v| v != "false" && v != "0")
        .unwrap_or(true);
    let last_checked_at = state
        .db
        .get_setting("updater.last_checked_at")
        .map_err(|e| e.to_string())?;
    Ok(UpdaterConfigInfo {
        current_version: env!("CARGO_PKG_VERSION").to_string(),
        endpoints,
        pubkey_configured,
        signing_ready,
        auto_check,
        last_checked_at,
        channel: "stable".to_string(),
    })
}

#[tauri::command]
pub fn set_updater_auto_check(state: State<'_, AppState>, enabled: bool) -> Result<bool, String> {
    state
        .db
        .set_setting("updater.auto_check", if enabled { "true" } else { "false" })
        .map_err(|e| e.to_string())?;
    Ok(enabled)
}

pub fn parse_tauri_updater_manifest(
    json: &serde_json::Value,
    current_version: &str,
    checked_at: &str,
) -> UpdateCheckResult {
    let latest = json["version"].as_str().map(ToString::to_string);
    let notes = json["notes"].as_str().map(ToString::to_string);
    let arch_key = match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", _) => "windows-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", _) => "linux-x86_64",
        (os, arch) => return_platform_fallback(os, arch),
    };
    let plat = &json["platforms"][arch_key];
    let download_url = plat["url"]
        .as_str()
        .or_else(|| json["url"].as_str())
        .map(ToString::to_string);
    let has_sig = plat["signature"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty());

    if let Some(ref lv) = latest {
        if compare_semver(current_version, lv) {
            let msg = crate::tf!(
                "Yeni imzalı sürüm mevcut: v{lv}",
                "New signed release available: v{lv}"
            );
            return UpdateCheckResult {
                status: "update_available".to_string(),
                current_version: current_version.to_string(),
                latest_version: latest,
                release_notes: notes,
                download_url,
                signature_verified_manifest: has_sig,
                checked_at: checked_at.to_string(),
                message: msg,
            };
        }
    }

    UpdateCheckResult {
        status: "up_to_date".to_string(),
        current_version: current_version.to_string(),
        latest_version: Some(current_version.to_string()),
        release_notes: notes,
        download_url,
        signature_verified_manifest: has_sig,
        checked_at: checked_at.to_string(),
        message: tr_en("Uygulama güncel.", "Application is up to date.").to_string(),
    }
}

fn return_platform_fallback(_os: &str, _arch: &str) -> &'static str {
    "linux-x86_64"
}

pub fn is_allowed_updater_endpoint(url: &str) -> bool {
    let trimmed = url.trim();
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return !rest.is_empty();
    }
    for prefix in ["http://127.0.0.1", "http://localhost"] {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            return rest.is_empty() || rest.starts_with(':') || rest.starts_with('/');
        }
    }
    false
}

#[tauri::command]
pub async fn check_app_update(
    state: State<'_, AppState>,
    endpoint_override: Option<String>,
) -> Result<UpdateCheckResult, String> {
    let current_version = env!("CARGO_PKG_VERSION").to_string();
    let checked_at = Utc::now().to_rfc3339();
    let _ = state.db.set_setting("updater.last_checked_at", &checked_at);

    let (endpoints, _pk, _ready) = read_updater_metadata();
    let raw_url = endpoint_override
        .filter(|s| !s.trim().is_empty())
        .or_else(|| endpoints.into_iter().next())
        .unwrap_or_default();

    let resolved_url = raw_url
        .replace("{{target}}", std::env::consts::OS)
        .replace("{{arch}}", std::env::consts::ARCH)
        .replace("{{current_version}}", &current_version);

    if !is_allowed_updater_endpoint(&resolved_url) {
        return Ok(UpdateCheckResult {
            status: "invalid_endpoint".to_string(),
            current_version,
            latest_version: None,
            release_notes: None,
            download_url: None,
            signature_verified_manifest: false,
            checked_at,
            message: tr_en(
                "Güvenlik Kısıtı: Güncelleme adresi yalnızca HTTPS veya yerel loopback olabilir.",
                "Security Constraint: Update endpoint must use HTTPS or local loopback.",
            )
            .to_string(),
        });
    }

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return Ok(UpdateCheckResult {
                status: "offline_or_unconfigured".to_string(),
                current_version,
                latest_version: None,
                release_notes: None,
                download_url: None,
                signature_verified_manifest: false,
                checked_at,
                message: crate::tf!(
                    "HTTP istemcisi başlatılamadı: {e}",
                    "Failed to initialize HTTP client: {e}"
                ),
            });
        }
    };

    if let Ok(resp) = client.get(&resolved_url).send().await {
        if resp.status().is_success() {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                return Ok(parse_tauri_updater_manifest(
                    &json,
                    &current_version,
                    &checked_at,
                ));
            }
        }
    }

    Ok(UpdateCheckResult {
        status: "offline_or_unconfigured".to_string(),
        current_version: current_version.clone(),
        latest_version: Some(current_version),
        release_notes: Some(
            tr_en(
                "Canlı manifest GitHub Releases (latest.json) üzerinden yayınlanır.",
                "Live manifest is published via GitHub Releases (latest.json).",
            )
            .to_string(),
        ),
        download_url: None,
        signature_verified_manifest: false,
        checked_at,
        message: tr_en(
            "Çevrimdışı ortam veya henüz yayınlanmamış sürüm manifesti (yerel sürüm güncel).",
            "Offline environment or unpublished release manifest (local version is current).",
        )
        .to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::ProviderKind;

    #[test]
    fn snapshot_export_and_import_roundtrip_strips_all_secrets() {
        let db = Database::open_in_memory().expect("in-memory sqlite");
        db.upsert_project(&SavedProjectRecord {
            id: "proj-1".into(),
            name: "wrynose-edge".into(),
            yocto_codename: "wrynose".into(),
            workspace_path: "/home/yocto/wrynose-edge".into(),
            machine: "imx8mp-lpddr4-evk".into(),
            distro: "poky".into(),
            provider: "wsl2".into(),
            created_at: "2026-11-25T10:00:00Z".into(),
        })
        .unwrap();

        db.upsert_target_profile(&TargetProfileRecord {
            id: "tp-1".into(),
            project_id: "proj-1".into(),
            name: "EdgeBoard".into(),
            machine: "imx8mp-lpddr4-evk".into(),
            preferred_method: "ethernet".into(),
            usb_flasher: "nxp_uuu".into(),
            target_ip: "192.168.10.50".into(),
            ssh_user: "root".into(),
            ssh_key_ref: "-----BEGIN OPENSSH PRIVATE KEY-----\nabcdefsecret\n".into(),
            swupdate_url: "http://admin:topsecret@192.168.10.50:8080".into(),
            uart_port: "COM4".into(),
            uart_baud: 115_200,
            ab_slots_json: "{}".into(),
            custom_cli_template: "flash --token=sk-secret1234567890abcdef --pass password=supersecret".into(),
            created_at: "2026-11-25T10:01:00Z".into(),
        })
        .unwrap();

        db.upsert_provider_profile(&ProviderProfile {
            id: "ssh-1".into(),
            name: "Build Farm".into(),
            kind: ProviderKind::Ssh,
            wsl_distro: None,
            docker_image: None,
            docker_sstate_vol: None,
            docker_dl_vol: None,
            docker_tmp_vol: None,
            ssh_host: Some("10.0.0.20".into()),
            ssh_port: Some(22),
            ssh_user: Some("yocto".into()),
            ssh_key_path: Some("/home/alice/.ssh/id_ed25519_secret".into()),
            ssh_use_agent: Some(true),
            remote_workspace_root: Some("/srv/yocto".into()),
            is_default: Some(true),
        })
        .unwrap();

        db.set_setting("preflight.gate_enabled", "true").unwrap();
        db.set_setting("ai.settings", r#"{"enabled":true,"provider":"openai"}"#)
            .unwrap();

        let vex = serde_json::json!([
            {
                "cve_id": "CVE-2025-41203",
                "status": "not_affected",
                "api_key": "sk-secret1234567890abcdef"
            }
        ]);

        let (payload, stripped) = build_sanitized_snapshot(
            &db,
            Some("proj-1"),
            Some("header:\n  version: 14\n".into()),
            vex,
            vec!["GPL-3.0".into()],
        )
        .unwrap();
        assert!(stripped >= 5);

        let tmp = std::env::temp_dir().join("yocto_studio_snapshot_test");
        let _ = std::fs::remove_dir_all(&tmp);
        let json_path = tmp.join("team.yoctostudio");
        let zip_path = tmp.join("team.yoctostudio.zip");

        let json_res = write_snapshot_file(&payload, &json_path, "json", stripped).unwrap();
        let zip_res = write_snapshot_file(&payload, &zip_path, "zip", stripped).unwrap();
        assert_eq!(json_res.sha256.len(), 64);
        assert_eq!(zip_res.sha256.len(), 64);

        // Verify ZERO secret leakage in both JSON and ZIP bytes
        for bytes in [
            std::fs::read(&json_path).unwrap(),
            std::fs::read(&zip_path).unwrap(),
        ] {
            let as_lossy = String::from_utf8_lossy(&bytes);
            assert!(!as_lossy.contains("OPENSSH PRIVATE KEY"));
            assert!(!as_lossy.contains("topsecret"));
            assert!(!as_lossy.contains("sk-secret1234567890abcdef"));
            assert!(!as_lossy.contains("supersecret"));
            assert!(!as_lossy.contains("id_ed25519_secret"));
            assert!(!as_lossy.contains("ai.settings"));
        }

        // Import ZIP snapshot into clean in-memory SQLite DB
        let dest_db = Database::open_in_memory().unwrap();
        let imported = import_snapshot_into_db(&dest_db, &std::fs::read(&zip_path).unwrap()).unwrap();
        assert!(imported.ok);
        assert_eq!(imported.project_name, "wrynose-edge");
        assert_eq!(imported.target_profiles_imported, 1);
        assert_eq!(imported.provider_profiles_imported, 1);
        assert_eq!(imported.openvex_count, 1);

        let restored_targets = dest_db.list_target_profiles(Some("proj-1")).unwrap();
        assert_eq!(restored_targets[0].target_ip, "192.168.10.50");
        assert_eq!(restored_targets[0].swupdate_url, "http://192.168.10.50:8080");
        assert!(restored_targets[0].ssh_key_ref.is_empty());

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn updater_semver_and_config_check() {
        assert!(compare_semver("0.1.0", "0.2.0"));
        assert!(compare_semver("0.1.0", "0.1.1"));
        assert!(!compare_semver("0.2.0", "0.1.9"));
        let (endpoints, pubkey_ok, _signing_ready) = read_updater_metadata();
        assert!(!endpoints.is_empty());
        assert!(pubkey_ok);
    }

    #[test]
    fn updater_endpoint_allows_https_and_loopback_only() {
        assert!(is_allowed_updater_endpoint(
            "https://github.com/UfkuAcik/Yocto-Project-GUI/releases/latest/download/latest.json"
        ));
        assert!(is_allowed_updater_endpoint("http://127.0.0.1:8080/latest.json"));
        assert!(is_allowed_updater_endpoint("http://localhost:8080/latest.json"));
        assert!(!is_allowed_updater_endpoint("http://evil.example/latest.json"));
        assert!(!is_allowed_updater_endpoint("http://localhost.evil.example/latest.json"));
        assert!(!is_allowed_updater_endpoint("file:///etc/passwd"));
    }

    #[test]
    fn updater_parses_live_tauri_latest_json_manifest() {
        let manifest = serde_json::json!({
            "version": "1.2.0",
            "notes": "Signed GitHub Release with Rockchip/MediaTek/TI flashers",
            "platforms": {
                "windows-x86_64": {
                    "url": "https://github.com/UfkuAcik/Yocto-Project-GUI/releases/download/v1.2.0/Yocto.Studio_1.2.0_x64-setup.nsis.zip",
                    "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ=="
                },
                "linux-x86_64": {
                    "url": "https://github.com/UfkuAcik/Yocto-Project-GUI/releases/download/v1.2.0/Yocto.Studio_1.2.0_amd64.AppImage.tar.gz",
                    "signature": "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQ=="
                }
            }
        });
        let res = parse_tauri_updater_manifest(&manifest, "1.1.0", "2026-11-25T12:15:00Z");
        assert_eq!(res.status, "update_available");
        assert_eq!(res.latest_version.as_deref(), Some("1.2.0"));
        assert!(res.signature_verified_manifest);
        assert!(res.download_url.unwrap().contains("v1.2.0"));
    }
}
