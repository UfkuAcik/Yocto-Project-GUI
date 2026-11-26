use std::sync::atomic::{AtomicU8, Ordering};

const LANG_TR: u8 = 0;
const LANG_EN: u8 = 1;

struct LangStore(AtomicU8);

impl LangStore {
    const fn new() -> Self {
        Self(AtomicU8::new(LANG_TR))
    }

    fn set(&self, lang: &str) -> &'static str {
        let norm = normalize_lang(lang);
        let code = if norm == "en" { LANG_EN } else { LANG_TR };
        self.0.store(code, Ordering::Relaxed);
        norm
    }

    fn is_en(&self) -> bool {
        self.0.load(Ordering::Relaxed) == LANG_EN
    }
}

static CURRENT_LANG: LangStore = LangStore::new();

#[cfg(test)]
std::thread_local! {
    static TEST_LANG_OVERRIDE: std::cell::Cell<Option<u8>> = const { std::cell::Cell::new(None) };
}

pub fn normalize_lang(lang: &str) -> &'static str {
    let trimmed = lang.trim();
    let lower = trimmed.to_ascii_lowercase();
    if lower == "en" || lower.starts_with("en-") || lower.starts_with("en_") {
        "en"
    } else {
        "tr"
    }
}

pub fn set_lang(lang: &str) -> &'static str {
    CURRENT_LANG.set(lang)
}

pub fn is_en() -> bool {
    #[cfg(test)]
    if let Some(code) = TEST_LANG_OVERRIDE.with(std::cell::Cell::get) {
        return code == LANG_EN;
    }
    CURRENT_LANG.is_en()
}

pub fn get_lang() -> &'static str {
    if is_en() {
        "en"
    } else {
        "tr"
    }
}

pub fn tr_en(tr: &'static str, en: &'static str) -> &'static str {
    if is_en() {
        en
    } else {
        tr
    }
}

#[macro_export]
macro_rules! tf {
    ($tr:literal, $en:literal, $($arg:tt)+) => {{
        if $crate::i18n::is_en() {
            ::std::format!($en, $($arg)+)
        } else {
            ::std::format!($tr, $($arg)+)
        }
    }};
    ($tr:literal, $en:literal) => {{
        if $crate::i18n::is_en() {
            ::std::format!($en)
        } else {
            ::std::format!($tr)
        }
    }};
}

#[cfg(test)]
pub struct TestLangGuard {
    prev: Option<u8>,
}

#[cfg(test)]
impl Drop for TestLangGuard {
    fn drop(&mut self) {
        TEST_LANG_OVERRIDE.with(|cell| cell.set(self.prev));
    }
}

#[cfg(test)]
#[must_use]
pub fn enter_test_lang(lang: &str) -> TestLangGuard {
    let code = if normalize_lang(lang) == "en" {
        LANG_EN
    } else {
        LANG_TR
    };
    let prev = TEST_LANG_OVERRIDE.with(|cell| {
        let prev = cell.get();
        cell.set(Some(code));
        prev
    });
    TestLangGuard { prev }
}

#[cfg(test)]
pub fn with_test_lang<R>(lang: &str, f: impl FnOnce() -> R) -> R {
    let _guard = enter_test_lang(lang);
    f()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_triage::{run_ai_triage, AiSettings, AiTriageRequest};
    use crate::commands::enterprise_cmds::parse_tauri_updater_manifest;
    use crate::deploy::net_deploy::tftp_server::{list_network_interfaces, resolve_safe_tftp_file};
    use crate::deploy::serial::uboot_macros::default_uboot_macros;
    use crate::deploy::usb_flashers::{
        custom_cli::expand_cli_template,
        raw_disk::{assert_safe_raw_target, list_safe_removable_drives},
        rockchip_rkdev::validate_lba_offset,
    };
    use crate::deploy::{DeployManager, FlashRequest, MemoryEventSink};
    use crate::flash::{build_flash_plan, list_removable_drives, validate_flash_target};
    use crate::providers::{
        local::test_local_connection, test_provider_connection, validate_linux_workspace_path,
        ProviderKind, ProviderProfile,
    };
    use std::collections::HashMap;
    use std::sync::Arc;

    fn assert_no_turkish_leak(text: &str) {
        for ch in ['ğ', 'Ğ', 'ş', 'Ş', 'ı', 'İ', 'ç', 'Ç', 'ö', 'Ö', 'ü', 'Ü'] {
            assert!(
                !text.contains(ch),
                "Found Turkish diacritic {ch:?} in EN text: {text}"
            );
        }
        let lower = text.to_ascii_lowercase();
        for marker in ["aktif", "hazir", "hata analizi", "zorunludur", "standart seri"] {
            assert!(
                !lower.contains(marker),
                "Found ASCII-Turkish marker {marker:?} in EN text: {text}"
            );
        }
    }

    #[test]
    fn lang_store_normalizes_and_switches() {
        let store = LangStore::new();
        assert!(!store.is_en());
        assert_eq!(store.set("en"), "en");
        assert!(store.is_en());
        assert_eq!(store.set("en-US"), "en");
        assert_eq!(store.set("TR"), "tr");
        assert!(!store.is_en());
        assert_eq!(store.set("fr"), "tr");
        assert_eq!(normalize_lang("  EN_gb "), "en");
    }

    #[test]
    fn english_mode_returns_no_turkish_leaks_across_modules() {
        with_test_lang("en", || {
            assert_eq!(get_lang(), "en");
            assert!(is_en());

            for bad_path in [
                "",
                "C:\\yocto\\build",
                "\\\\wsl$\\Ubuntu\\home\\yocto",
                "rel/path",
                "/home/yocto/../etc",
                "/mnt/c/Users/dev",
                "/",
                "/home/yocto/proj",
            ] {
                let res = validate_linux_workspace_path(bad_path, ProviderKind::Wsl2);
                assert_no_turkish_leak(&res.reason);
            }

            for d in list_removable_drives(true) {
                assert_no_turkish_leak(&d.name);
            }
            assert_no_turkish_leak(&validate_flash_target("", &[]).unwrap_err());
            assert_no_turkish_leak(&validate_flash_target("/dev/sda", &[]).unwrap_err());
            assert_no_turkish_leak(&build_flash_plan("", "mock://sd", &[]).unwrap_err());
            let plan = build_flash_plan("/tmp/test.img", "mock://sd-card", &[]).unwrap();
            assert_no_turkish_leak(&plan.command);
            for w in &plan.warnings {
                assert_no_turkish_leak(w);
            }

            let mgr = DeployManager::new(std::env::temp_dir().join("yocto_i18n_unit_test"));
            for tool in mgr.check_tools_health() {
                assert_no_turkish_leak(&tool.install_hint);
            }
            let Err(unknown_err) = mgr.resolve_flasher("nonexistent") else {
                panic!("expected unknown flasher error");
            };
            assert_no_turkish_leak(&unknown_err);
            let sink = Arc::new(MemoryEventSink::default());
            let unconfirmed_err = mgr
                .start_flash_job(FlashRequest::default(), sink)
                .unwrap_err();
            assert_no_turkish_leak(&unconfirmed_err);

            for mac in default_uboot_macros() {
                assert_no_turkish_leak(&mac.label);
                assert_no_turkish_leak(&mac.description);
            }

            for dev in list_safe_removable_drives(true) {
                assert_no_turkish_leak(&dev.name);
                assert_no_turkish_leak(&dev.details);
            }
            assert_no_turkish_leak(&assert_safe_raw_target("", &[]).unwrap_err());
            assert_no_turkish_leak(&assert_safe_raw_target("/dev/sda", &[]).unwrap_err());

            let empty_vars: HashMap<&str, String> = HashMap::new();
            assert_no_turkish_leak(&expand_cli_template("", &empty_vars).unwrap_err());
            assert_no_turkish_leak(&expand_cli_template("uuu ; rm", &empty_vars).unwrap_err());
            assert_no_turkish_leak(&validate_lba_offset("bad-lba").unwrap_err());

            for nic in list_network_interfaces() {
                assert_no_turkish_leak(&nic.name);
            }
            assert_no_turkish_leak(
                &resolve_safe_tftp_file(&std::env::temp_dir(), "../secret").unwrap_err(),
            );

            let update_avail = parse_tauri_updater_manifest(
                &serde_json::json!({"version": "99.0.0"}),
                "0.1.0",
                "2026-11-25T00:00:00Z",
            );
            assert_no_turkish_leak(&update_avail.message);
            let up_to_date = parse_tauri_updater_manifest(
                &serde_json::json!({"version": "0.1.0"}),
                "0.1.0",
                "2026-11-25T00:00:00Z",
            );
            assert_no_turkish_leak(&up_to_date.message);
        });

        with_test_lang("tr", || {
            assert_eq!(get_lang(), "tr");
            assert!(!is_en());
            let empty_res = validate_linux_workspace_path("", ProviderKind::Wsl2);
            assert_eq!(empty_res.reason, "Çalışma alanı yolu boş olamaz.");
            let nics = list_network_interfaces();
            assert_eq!(nics[0].name, "Tüm Arayüzler (Any)");
            let up_to_date = parse_tauri_updater_manifest(
                &serde_json::json!({"version": "0.1.0"}),
                "0.1.0",
                "2026-11-25T00:00:00Z",
            );
            assert_eq!(up_to_date.message, "Uygulama güncel.");
        });
    }

    #[tokio::test]
    async fn async_en_triage_and_providers_have_no_turkish_leaks() {
        let _guard = enter_test_lang("en");

        let req = AiTriageRequest {
            recipe: "sensor-daemon".into(),
            task: "do_compile".into(),
            log_content: "ERROR: missing nlohmann/json.hpp".into(),
            recipe_snippet: "DEPENDS = \"mosquitto\"".into(),
        };
        let disabled_err = run_ai_triage(&AiSettings::default(), None, &req)
            .await
            .unwrap_err();
        assert_no_turkish_leak(&disabled_err);

        let mock_ai = AiSettings {
            enabled: true,
            provider: "mock".into(),
            ..Default::default()
        };
        let res = run_ai_triage(&mock_ai, None, &req).await.unwrap();
        assert_no_turkish_leak(&res.root_cause);
        assert_no_turkish_leak(&res.explanation);

        let mock_prof = ProviderProfile {
            id: "mock-1".into(),
            name: "Mock".into(),
            kind: ProviderKind::Mock,
            wsl_distro: None,
            docker_image: None,
            docker_sstate_vol: None,
            docker_dl_vol: None,
            docker_tmp_vol: None,
            ssh_host: None,
            ssh_port: None,
            ssh_user: None,
            ssh_key_path: None,
            ssh_use_agent: None,
            remote_workspace_root: None,
            is_default: None,
        };
        let mock_conn = test_provider_connection(&mock_prof).await;
        assert_no_turkish_leak(&mock_conn.summary);
        for c in &mock_conn.checks {
            assert_no_turkish_leak(&c.label);
            assert_no_turkish_leak(&c.detail);
        }

        let local_conn = test_local_connection().await;
        assert_no_turkish_leak(&local_conn.summary);
        for c in &local_conn.checks {
            assert_no_turkish_leak(&c.label);
            assert_no_turkish_leak(&c.detail);
        }
    }
}

