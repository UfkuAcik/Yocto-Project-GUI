use crate::deploy::{
    DeployEventSink, DeployLogEvent, DeployProgressEvent, FlashOutcome, FlashRequest, TargetFlasher,
};
use crate::i18n::tr_en;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const FORBIDDEN_TEMPLATE_PATTERNS: [&str; 7] = [";", "|", "&&", "||", "`", "$(", ">"];

pub fn expand_cli_template(
    template: &str,
    vars: &HashMap<&str, String>,
) -> Result<(String, Vec<String>), String> {
    let trimmed = template.trim();
    if trimmed.is_empty() {
        return Err(tr_en(
            "Özel CLI şablonu boş olamaz.",
            "Custom CLI template cannot be empty.",
        )
        .into());
    }

    for pat in FORBIDDEN_TEMPLATE_PATTERNS {
        if trimmed.contains(pat) {
            return Err(crate::tf!(
                "Güvenlik Kısıtı: CLI şablonunda shell kontrol operatörü ('{pat}') kullanılamaz.",
                "Security Constraint: Shell control operator ('{pat}') cannot be used in a CLI template."
            ));
        }
    }
    if trimmed.contains('<') {
        return Err(tr_en(
            "Güvenlik Kısıtı: CLI şablonunda yönlendirme ('<') kullanılamaz.",
            "Security Constraint: Redirection ('<') cannot be used in a CLI template.",
        )
        .into());
    }

    // Tokenize BEFORE variable substitution so injected paths/names cannot split into extra flags/commands.
    let raw_tokens = shell_words::split(trimmed).map_err(|e| {
        crate::tf!(
            "CLI şablonu ayrıştırılamadı: {e}",
            "Failed to parse CLI template: {e}"
        )
    })?;
    if raw_tokens.is_empty() {
        return Err(tr_en(
            "CLI şablonunda çalıştırılabilir program adı bulunamadı.",
            "No executable program name was found in the CLI template.",
        )
        .into());
    }

    let mut expanded = Vec::with_capacity(raw_tokens.len());
    for mut tok in raw_tokens {
        for (k, val) in vars {
            if tok.contains(k) {
                for bad in [';', '|', '&', '`', '\n', '\r', '\0'] {
                    if val.contains(bad) {
                        return Err(crate::tf!(
                            "Güvenlik Kısıtı: '{k}' değişken değerinde yasak karakter bulundu.",
                            "Security Constraint: Forbidden character found in variable '{k}'."
                        ));
                    }
                }
                tok = tok.replace(k, val);
            }
        }
        expanded.push(tok);
    }

    let program = expanded.remove(0);
    if program.contains('{') || program.contains('}') {
        return Err(tr_en(
            "Program adı çözümlenmemiş yer tutucu içeremez.",
            "Program name cannot contain unresolved placeholders.",
        )
        .into());
    }
    Ok((program, expanded))
}

pub struct CustomCliFlasher;

impl TargetFlasher for CustomCliFlasher {
    fn kind(&self) -> &'static str {
        "custom_cli"
    }

    fn validate_request(&self, req: &FlashRequest) -> Result<(), String> {
        let tmpl = req.custom_template.as_deref().unwrap_or("");
        let vars = build_vars(req);
        let _ = expand_cli_template(tmpl, &vars)?;
        Ok(())
    }

    fn execute(
        &self,
        req: &FlashRequest,
        cancel: Arc<AtomicBool>,
        sink: Arc<dyn DeployEventSink>,
    ) -> Result<FlashOutcome, String> {
        let tmpl = req.custom_template.as_deref().unwrap_or("");
        let vars = build_vars(req);
        let (program, args) = expand_cli_template(tmpl, &vars)?;

        if req.mock_mode {
            sink.emit_log(DeployLogEvent {
                job_id: req.job_id.clone(),
                stream: "stdout".into(),
                line: format!("[mock custom_cli] exec: {program} {}", args.join(" ")),
                ts_ms: 0,
            });
            for pct in [35.0, 70.0, 100.0] {
                if cancel.load(Ordering::Relaxed) {
                    return Err(tr_en(
                        "Özel CLI işlemi iptal edildi.",
                        "Custom CLI operation was cancelled.",
                    )
                    .into());
                }
                sink.emit_progress(DeployProgressEvent {
                    job_id: req.job_id.clone(),
                    phase: "custom-cli".into(),
                    percent: pct,
                    bytes_written: 0,
                    total_bytes: 0,
                    speed_mb_s: 0.0,
                    message: crate::tf!(
                        "{program} çalıştırılıyor (%{pct:.0})",
                        "Running {program} ({pct:.0}%)"
                    ),
                });
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            return Ok(FlashOutcome {
                job_id: req.job_id.clone(),
                ok: true,
                sha256: req.confirmed_sha256.clone().unwrap_or_default(),
                bytes_written: 0,
                summary: crate::tf!(
                    "Mock Özel CLI ({program}) başarıyla çalıştırıldı.",
                    "Mock Custom CLI ({program}) executed successfully."
                ),
            });
        }

        let mut cmd = Command::new(&program);
        cmd.args(&args).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        let mut child = cmd.spawn().map_err(|e| {
            crate::tf!(
                "Özel CLI çalıştırılamadı ({program}): {e}",
                "Failed to spawn Custom CLI ({program}): {e}"
            )
        })?;
        if let Some(stdout) = child.stdout.take() {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                sink.emit_log(DeployLogEvent {
                    job_id: req.job_id.clone(),
                    stream: "stdout".into(),
                    line,
                    ts_ms: 0,
                });
            }
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            return Err(crate::tf!(
                "{program} sıfır dışı çıkış kodu döndürdü.",
                "{program} returned a non-zero exit code."
            ));
        }
        Ok(FlashOutcome {
            job_id: req.job_id.clone(),
            ok: true,
            sha256: req.confirmed_sha256.clone().unwrap_or_default(),
            bytes_written: 0,
            summary: crate::tf!(
                "{program} başarıyla tamamlandı.",
                "{program} completed successfully."
            ),
        })
    }
}

fn build_vars(req: &FlashRequest) -> HashMap<&'static str, String> {
    let mut vars = HashMap::new();
    vars.insert("{IMAGE_PATH}", req.image_path.clone());
    vars.insert("{DEPLOY_DIR}", req.deploy_dir.clone());
    vars.insert("{MACHINE}", req.machine.clone());
    vars.insert("{KERNEL}", req.kernel_path.clone());
    vars.insert("{DTB}", req.dtb_path.clone());
    vars.insert("{SERIAL_PORT}", req.serial_port.clone());
    vars
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_placeholders_safely() {
        let mut vars = HashMap::new();
        vars.insert("{IMAGE_PATH}", "C:\\staging\\my image.wic".to_string());
        vars.insert("{MACHINE}", "rk3588-evk".to_string());
        let (prog, args) = expand_cli_template(
            "rkdeveloptool wl 0 \"{IMAGE_PATH}\" --chip {MACHINE}",
            &vars,
        )
        .unwrap();
        assert_eq!(prog, "rkdeveloptool");
        assert_eq!(
            args,
            vec!["wl", "0", "C:\\staging\\my image.wic", "--chip", "rk3588-evk"]
        );
    }

    #[test]
    fn blocks_shell_injection_in_template_and_values() {
        let mut vars = HashMap::new();
        vars.insert("{IMAGE_PATH}", "ok.wic".to_string());
        assert!(expand_cli_template("uuu {IMAGE_PATH}; rm -rf /", &vars).is_err());
        assert!(expand_cli_template("uuu {IMAGE_PATH} && whoami", &vars).is_err());
        assert!(expand_cli_template("uuu $(id)", &vars).is_err());

        vars.insert("{IMAGE_PATH}", "bad;rm -rf".to_string());
        assert!(expand_cli_template("uuu {IMAGE_PATH}", &vars).is_err());
    }
}
