pub mod redaction;

use crate::ai_triage::redaction::{extract_error_window, redact_secrets};
use crate::i18n::{is_en, tr_en};
use serde::{Deserialize, Serialize};
#[cfg(not(windows))]
use std::sync::{Mutex, OnceLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AiSettings {
    pub enabled: bool,
    pub provider: String, // "disabled" | "ollama" | "openai_compat" | "mock"
    pub endpoint: String,
    pub model: String,
    pub has_api_key: bool,
}

impl Default for AiSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: "disabled".into(),
            endpoint: "http://localhost:11434".into(),
            model: "qwen2.5-coder:7b".into(),
            has_api_key: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTriageRequest {
    pub recipe: String,
    pub task: String,
    pub log_content: String,
    pub recipe_snippet: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AiTriageResponse {
    pub root_cause: String,
    pub affected_file_line: String,
    pub explanation: String,
    pub suggested_fix_diff: String,
    pub target_file: String,
    pub redacted_preview: String,
    pub redaction_count: usize,
    pub provider_used: String,
}

const KEYRING_SERVICE: &str = "dev.yoctostudio.ai";
const KEYRING_USER: &str = "byok-api-key";

#[cfg(not(windows))]
static FALLBACK_KEY_STORE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

pub fn store_byok_api_key(key: &str) -> Result<(), String> {
    let clean = key.trim();
    #[cfg(windows)]
    {
        let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .map_err(|e| crate::tf!("Keyring açılamadı: {e}", "Failed to open Keyring: {e}"))?;
        if clean.is_empty() {
            let _ = entry.delete_credential();
            return Ok(());
        }
        entry.set_password(clean).map_err(|e| {
            crate::tf!(
                "Keyring anahtarı kaydedilemedi: {e}",
                "Failed to save Keyring key: {e}"
            )
        })
    }
    #[cfg(not(windows))]
    {
        let store = FALLBACK_KEY_STORE.get_or_init(|| Mutex::new(None));
        *store.lock().unwrap() = if clean.is_empty() {
            None
        } else {
            Some(clean.to_string())
        };
        let _ = (KEYRING_SERVICE, KEYRING_USER);
        Ok(())
    }
}

pub fn load_byok_api_key() -> Option<String> {
    #[cfg(windows)]
    {
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
            .ok()
            .and_then(|e| e.get_password().ok())
            .filter(|s| !s.trim().is_empty())
    }
    #[cfg(not(windows))]
    {
        let _ = (KEYRING_SERVICE, KEYRING_USER);
        FALLBACK_KEY_STORE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .ok()
            .and_then(|g| g.clone())
    }
}

pub async fn run_ai_triage(
    settings: &AiSettings,
    api_key: Option<String>,
    req: &AiTriageRequest,
) -> Result<AiTriageResponse, String> {
    if !settings.enabled || settings.provider == "disabled" {
        return Err(
            tr_en(
                "Gizlilik Koruması: AI Hata Teşhisi varsayılan olarak kapalıdır (Opt-In). Önce Ollama veya BYOK sağlayıcısını etkinleştirin.",
                "Privacy Guard: AI Error Triage is disabled by default (Opt-In). Enable Ollama or a BYOK provider first.",
            )
            .into(),
        );
    }

    let window = extract_error_window(&req.log_content);
    let redacted = redact_secrets(&window);
    let response_lang = if is_en() { "English" } else { "Turkish" };
    let prompt = format!(
        "Analyze this Yocto BitBake failure.\nRecipe: {}\nTask: {}\nRecipe snippet:\n{}\n\nRedacted Log:\n{}\n\n\
         Respond in {response_lang} using JSON with keys: root_cause, affected_file_line, explanation, suggested_fix_diff, target_file.",
        req.recipe, req.task, req.recipe_snippet, redacted.redacted_text
    );

    if settings.provider == "mock" {
        let recipe = &req.recipe;
        return Ok(AiTriageResponse {
            root_cause: crate::tf!(
                "{recipe} tarifinde eksik CMake/Meson bağımlılığı veya başlık dosyası (<nlohmann/json.hpp>)",
                "Missing CMake/Meson dependency or header file (<nlohmann/json.hpp>) in recipe {recipe}"
            ),
            affected_file_line: "src/telemetry_publisher.cpp:14".into(),
            explanation: tr_en(
                "Derleyici sysroot içinde `nlohmann/json.hpp` başlığını bulamadığı için `do_compile` sıfır dışı kodla durdu.",
                "The compiler could not locate the `nlohmann/json.hpp` header inside the sysroot, causing `do_compile` to exit with a non-zero status.",
            )
            .into(),
            suggested_fix_diff: format!(
                "--- a/recipes-apps/{0}/{0}_%.bbappend\n+++ b/recipes-apps/{0}/{0}_%.bbappend\n-DEPENDS = \"mosquitto libgpiod\"\n+DEPENDS += \" nlohmann-json\"",
                req.recipe
            ),
            target_file: format!("recipes-apps/{0}/{0}_%.bbappend", req.recipe),
            redacted_preview: redacted.redacted_text,
            redaction_count: redacted.replacements_count,
            provider_used: "offline-mock".into(),
        });
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| crate::tf!("HTTP istemcisi kurulamadı: {e}", "Failed to build HTTP client: {e}"))?;

    let content_str = if settings.provider == "ollama" {
        let url = format!("{}/api/chat", settings.endpoint.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": settings.model,
            "stream": false,
            "messages": [{"role": "user", "content": prompt}],
        });
        let resp = client.post(&url).json(&body).send().await.map_err(|e| {
            crate::tf!(
                "Yerel Ollama bağlantısı başarısız ({url}): {e}",
                "Local Ollama connection failed ({url}): {e}"
            )
        })?;
        let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        val["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string()
    } else {
        let key = api_key.ok_or_else(|| {
            tr_en(
                "BYOK API anahtarı Keyring içinde bulunamadı.",
                "BYOK API key was not found in the Keyring.",
            )
            .to_string()
        })?;
        let url = format!("{}/v1/chat/completions", settings.endpoint.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": settings.model,
            "messages": [{"role": "user", "content": prompt}],
        });
        let resp = client
            .post(&url)
            .bearer_auth(key)
            .json(&body)
            .send()
            .await
            .map_err(|e| {
                crate::tf!(
                    "LLM API bağlantısı başarısız ({url}): {e}",
                    "LLM API connection failed ({url}): {e}"
                )
            })?;
        let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        val["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .to_string()
    };

    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content_str) {
        return Ok(AiTriageResponse {
            root_cause: parsed["root_cause"]
                .as_str()
                .unwrap_or_else(|| tr_en("Kök neden ayrıştırıldı", "Root cause parsed"))
                .into(),
            affected_file_line: parsed["affected_file_line"].as_str().unwrap_or("—").into(),
            explanation: parsed["explanation"].as_str().unwrap_or(&content_str).into(),
            suggested_fix_diff: parsed["suggested_fix_diff"].as_str().unwrap_or("").into(),
            target_file: parsed["target_file"].as_str().unwrap_or("conf/local.conf").into(),
            redacted_preview: redacted.redacted_text,
            redaction_count: redacted.replacements_count,
            provider_used: settings.provider.clone(),
        });
    }

    let recipe = &req.recipe;
    let task = &req.task;
    Ok(AiTriageResponse {
        root_cause: crate::tf!("{recipe} ({task}) hata analizi", "{recipe} ({task}) failure analysis"),
        affected_file_line: "log.do_compile".into(),
        explanation: content_str,
        suggested_fix_diff: String::new(),
        target_file: "conf/local.conf".into(),
        redacted_preview: redacted.redacted_text,
        redaction_count: redacted.replacements_count,
        provider_used: settings.provider.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ai_triage_blocks_when_disabled_and_succeeds_in_mock_with_redaction() {
        let disabled = AiSettings::default();
        assert!(!disabled.enabled);
        let req = AiTriageRequest {
            recipe: "my-sensor-daemon".into(),
            task: "do_compile".into(),
            log_content: "ERROR: nlohmann/json.hpp not found | OPENAI_API_KEY=sk-1234567890abcdef".into(),
            recipe_snippet: "DEPENDS = \"mosquitto\"".into(),
        };
        assert!(run_ai_triage(&disabled, None, &req).await.is_err());

        let mock_cfg = AiSettings {
            enabled: true,
            provider: "mock".into(),
            ..Default::default()
        };
        let res = run_ai_triage(&mock_cfg, None, &req).await.unwrap();
        assert!(!res.redacted_preview.contains("sk-1234567890abcdef"));
        assert!(res.redaction_count >= 1);
        assert!(res.suggested_fix_diff.contains("nlohmann-json"));
    }
}
