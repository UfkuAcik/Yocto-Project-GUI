use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RedactionResult {
    pub redacted_text: String,
    pub replacements_count: usize,
    pub categories: Vec<String>,
}

/// Extract first ERROR/fatal context window + trailing 120 lines to keep LLM context compact.
pub fn extract_error_window(log_content: &str) -> String {
    let lines: Vec<&str> = log_content.lines().collect();
    if lines.len() <= 140 {
        return log_content.to_string();
    }

    let first_err = lines
        .iter()
        .position(|l| l.contains("ERROR:") || l.to_ascii_lowercase().contains("fatal:"));
    let mut selected = Vec::new();
    if let Some(pos) = first_err {
        let start = pos.saturating_sub(10);
        let end = (pos + 25).min(lines.len());
        selected.extend_from_slice(&lines[start..end]);
        selected.push("--- [...] ---");
    }
    let tail_start = lines.len().saturating_sub(120);
    selected.extend_from_slice(&lines[tail_start..]);
    selected.join("\n")
}

fn is_rfc1918_ip(octets: [u8; 4]) -> bool {
    octets[0] == 10
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

fn mask_token_prefixes(line: &str, count: &mut usize, cats: &mut Vec<String>) -> String {
    let prefixes = ["sk-", "ghp_", "gho_", "AKIA", "xoxb-"];
    let mut out_words = Vec::new();
    for word in line.split_inclusive(char::is_whitespace) {
        let trimmed = word.trim_end();
        let ws = &word[trimmed.len()..];
        let clean = trimmed.trim_matches(|c| c == '"' || c == '\'' || c == ',');
        if prefixes.iter().any(|p| clean.starts_with(p) && clean.len() > p.len() + 6) {
            *count += 1;
            if !cats.contains(&"API_KEY".to_string()) {
                cats.push("API_KEY".to_string());
            }
            out_words.push(format!("[REDACTED_API_KEY]{ws}"));
        } else if let Some((a, rest)) = clean.split_once("://") {
            if let Some((creds, host_part)) = rest.split_once('@') {
                if creds.contains(':') {
                    *count += 1;
                    if !cats.contains(&"URL_CREDENTIAL".to_string()) {
                        cats.push("URL_CREDENTIAL".to_string());
                    }
                    out_words.push(format!("{a}://[REDACTED_CREDS]@{host_part}{ws}"));
                    continue;
                }
            }
            out_words.push(word.to_string());
        } else if let Some(ip_res) = clean.parse::<std::net::Ipv4Addr>().ok().filter(|ip| is_rfc1918_ip(ip.octets())) {
            let _ = ip_res;
            *count += 1;
            if !cats.contains(&"INTERNAL_IP".to_string()) {
                cats.push("INTERNAL_IP".to_string());
            }
            out_words.push(format!("[REDACTED_INTERNAL_IP]{ws}"));
        } else if clean.ends_with(".internal") || clean.ends_with(".corp") {
            *count += 1;
            if !cats.contains(&"INTERNAL_HOST".to_string()) {
                cats.push("INTERNAL_HOST".to_string());
            }
            out_words.push(format!("[REDACTED_INTERNAL_HOST]{ws}"));
        } else {
            out_words.push(word.to_string());
        }
    }
    out_words.concat()
}

/// Mask API keys, Bearer tokens, passwords, PEM private keys, RFC1918 IPs, and internal domains.
pub fn redact_secrets(input: &str) -> RedactionResult {
    let mut count = 0usize;
    let mut cats = Vec::<String>::new();
    let mut out_lines = Vec::new();
    let mut in_pem_block = false;

    for raw_line in input.lines() {
        let trimmed = raw_line.trim();
        if trimmed.contains("-----BEGIN ") && trimmed.contains("PRIVATE KEY") {
            in_pem_block = true;
            count += 1;
            if !cats.contains(&"PRIVATE_KEY".to_string()) {
                cats.push("PRIVATE_KEY".to_string());
            }
            out_lines.push("[REDACTED_PRIVATE_KEY_BLOCK]".to_string());
            continue;
        }
        if in_pem_block {
            if trimmed.contains("-----END ") {
                in_pem_block = false;
            }
            continue;
        }

        let lower = raw_line.to_ascii_lowercase();
        if let Some(idx) = lower.find("bearer ") {
            count += 1;
            if !cats.contains(&"BEARER_TOKEN".to_string()) {
                cats.push("BEARER_TOKEN".to_string());
            }
            let prefix = &raw_line[..idx + 7];
            out_lines.push(format!("{prefix}[REDACTED_TOKEN]"));
            continue;
        }

        let is_kv_secret = ["password=", "api_key=", "apikey=", "secret=", "token="]
            .iter()
            .find(|k| lower.contains(*k));
        if let Some(k) = is_kv_secret {
            if let Some(pos) = lower.find(k) {
                count += 1;
                if !cats.contains(&"SECRET_ASSIGNMENT".to_string()) {
                    cats.push("SECRET_ASSIGNMENT".to_string());
                }
                let head = &raw_line[..pos + k.len()];
                out_lines.push(format!("{head}[REDACTED]"));
                continue;
            }
        }

        out_lines.push(mask_token_prefixes(raw_line, &mut count, &mut cats));
    }

    RedactionResult {
        redacted_text: out_lines.join("\n"),
        replacements_count: count,
        categories: cats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_api_keys_passwords_private_keys_and_internal_ips() {
        let sample = "\
ERROR: fetch failed from https://buildbot:superpass123@git.company.internal/repo.git
Authorization: Bearer my-secret-jwt-token-xyz
OPENAI_API_KEY=sk-proj-1234567890abcdef
Connecting to 192.168.10.44 failed
-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmU=
-----END OPENSSH PRIVATE KEY-----
";
        let res = redact_secrets(sample);
        assert!(res.replacements_count >= 5);
        assert!(!res.redacted_text.contains("superpass123"));
        assert!(!res.redacted_text.contains("my-secret-jwt-token-xyz"));
        assert!(!res.redacted_text.contains("sk-proj-1234567890abcdef"));
        assert!(!res.redacted_text.contains("192.168.10.44"));
        assert!(!res.redacted_text.contains("b3BlbnNzaC1rZXktdjE"));
    }

    #[test]
    fn extracts_error_context_window() {
        let mut big = String::new();
        for i in 0..200 {
            if i == 15 {
                big.push_str("ERROR: my-sensor-daemon do_compile failed\n");
            } else {
                big.push_str(&format!("NOTE: compiling unit {i}\n"));
            }
        }
        let win = extract_error_window(&big);
        assert!(win.contains("ERROR: my-sensor-daemon do_compile failed"));
        assert!(win.contains("compiling unit 199"));
    }
}
