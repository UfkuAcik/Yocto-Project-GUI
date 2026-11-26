use crate::i18n::tr_en;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StagingRequest {
    pub source_kind: String, // "local" | "wsl2" | "docker" | "ssh" | "mock"
    pub source_path: String,
    pub project_id: String,
    pub machine: String,
    pub wsl_distro: Option<String>,
    pub docker_container: Option<String>,
    pub ssh_host: Option<String>,
    pub ssh_user: Option<String>,
    pub ssh_port: Option<u16>,
    pub ssh_key_path: Option<String>,
    pub expected_sha256: Option<String>,
    pub mock_mode: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StagedArtifact {
    pub local_path: String,
    pub bmap_path: Option<String>,
    pub sha256_path: Option<String>,
    pub sha256: String,
    pub size_bytes: u64,
    pub cache_hit: bool,
    pub verified: bool,
    pub source_path: String,
}

fn sanitize_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if cleaned.is_empty() {
        "default".to_string()
    } else {
        cleaned
    }
}

pub fn compute_sha256_file(path: &Path) -> Result<String, String> {
    let path_disp = path.display();
    let mut file = File::open(path).map_err(|e| {
        crate::tf!(
            "SHA-256 için dosya açılamadı ({path_disp}): {e}",
            "Could not open file for SHA-256 ({path_disp}): {e}"
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| {
            crate::tf!(
                "SHA-256 okuma hatası ({path_disp}): {e}",
                "SHA-256 read error ({path_disp}): {e}"
            )
        })?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn parse_sha256_sidecar(content: &str) -> Option<String> {
    content
        .split_whitespace()
        .next()
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
}

fn validate_wsl_distro_name(raw: &str) -> Result<&str, String> {
    let trimmed = raw.trim();
    if trimmed.starts_with('-')
        || trimmed.contains("..")
        || trimmed
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\'))
    {
        return Err(crate::tf!(
            "Güvenlik Kısıtı: Geçersiz WSL dağıtım adı '{trimmed}'.",
            "Security Constraint: Invalid WSL distribution name '{trimmed}'."
        ));
    }
    Ok(trimmed)
}

fn copy_wsl2_file(distro: Option<&str>, posix_path: &str, dest: &Path) -> Result<(), String> {
    let clean_posix = posix_path.trim();
    if clean_posix.is_empty()
        || clean_posix.contains("..")
        || clean_posix.chars().any(|c| matches!(c, '\0' | '\r' | '\n'))
    {
        return Err(tr_en(
            "Güvenlik Kısıtı: Geçersiz WSL2 kaynak dosya yolu.",
            "Security Constraint: Invalid WSL2 source file path.",
        )
        .to_string());
    }
    let clean_distro = match distro.map(str::trim).filter(|s| !s.is_empty()) {
        Some(d) => Some(validate_wsl_distro_name(d)?),
        None => None,
    };

    #[cfg(windows)]
    if let Some(d) = clean_distro {
        let trimmed = clean_posix.trim_start_matches('/');
        let unc = PathBuf::from(format!("\\\\wsl.localhost\\{d}\\{}", trimmed.replace('/', "\\")));
        if unc.exists() && unc.is_file() {
            fs::copy(&unc, dest).map_err(|e| {
                crate::tf!(
                    "WSL UNC kopyalama hatası: {e}",
                    "WSL UNC copy error: {e}"
                )
            })?;
            return Ok(());
        }
    }

    let mut cmd = Command::new("wsl.exe");
    if let Some(d) = clean_distro {
        cmd.args(["-d", d]);
    }
    cmd.args(["--", "cat", "--", clean_posix]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let out = cmd.output().map_err(|e| {
        crate::tf!(
            "wsl.exe üzerinden imaj çekilemedi: {e}",
            "Failed to pull image via wsl.exe: {e}"
        )
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(crate::tf!(
            "WSL2 dosya okuma hatası: {stderr}",
            "WSL2 file read error: {stderr}"
        ));
    }
    fs::write(dest, &out.stdout).map_err(|e| {
        crate::tf!(
            "Staging dosyası yazılamadı: {e}",
            "Failed to write staging file: {e}"
        )
    })
}

fn copy_docker_file(container: &str, posix_path: &str, dest: &Path) -> Result<(), String> {
    let mut cmd = Command::new("docker");
    cmd.args(["cp", &format!("{container}:{posix_path}"), &dest.to_string_lossy()]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| {
        crate::tf!(
            "docker cp çalıştırılamadı: {e}",
            "Failed to execute docker cp: {e}"
        )
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(crate::tf!(
            "docker cp başarısız: {stderr}",
            "docker cp failed: {stderr}"
        ));
    }
    Ok(())
}

fn copy_ssh_file(
    host: &str,
    user: Option<&str>,
    port: Option<u16>,
    key_path: Option<&str>,
    remote_path: &str,
    dest: &Path,
) -> Result<(), String> {
    let clean_host = crate::providers::validate_ssh_token(host, "ssh_host")?;
    let clean_remote = remote_path.trim();
    if clean_remote.is_empty()
        || clean_remote.starts_with('-')
        || clean_remote.chars().any(|c| matches!(c, '\0' | '\r' | '\n'))
    {
        return Err(tr_en(
            "Güvenlik Kısıtı: Geçersiz uzak SSH dosya yolu.",
            "Security Constraint: Invalid remote SSH file path.",
        )
        .to_string());
    }
    let mut cmd = Command::new("scp");
    cmd.args([
        "-o",
        "BatchMode=yes",
        "-o",
        "StrictHostKeyChecking=accept-new",
    ]);
    if let Some(p) = port {
        cmd.args(["-P", &p.to_string()]);
    }
    if let Some(k) = key_path.filter(|s| !s.trim().is_empty()) {
        let clean_key = crate::providers::validate_cli_path_arg(k, "ssh_key_path")?;
        cmd.args(["-i", clean_key]);
    }
    let target = match user.filter(|s| !s.trim().is_empty()) {
        Some(u) => {
            let clean_user = crate::providers::validate_ssh_token(u, "ssh_user")?;
            format!("{clean_user}@{clean_host}:{clean_remote}")
        }
        None => format!("{clean_host}:{clean_remote}"),
    };
    cmd.arg("--").arg(target).arg(dest);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().map_err(|e| {
        crate::tf!(
            "scp çalıştırılamadı: {e}",
            "Failed to execute scp: {e}"
        )
    })?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(crate::tf!(
            "scp transfer hatası: {stderr}",
            "scp transfer error: {stderr}"
        ));
    }
    Ok(())
}

fn try_copy_optional_sidecar(
    req: &StagingRequest,
    sidecar_src: &str,
    sidecar_dest: &Path,
) -> Option<PathBuf> {
    let ok = match req.source_kind.as_str() {
        "local" => {
            let p = Path::new(sidecar_src);
            p.exists() && fs::copy(p, sidecar_dest).is_ok()
        }
        "wsl2" => copy_wsl2_file(req.wsl_distro.as_deref(), sidecar_src, sidecar_dest).is_ok(),
        "docker" => req
            .docker_container
            .as_deref()
            .is_some_and(|c| copy_docker_file(c, sidecar_src, sidecar_dest).is_ok()),
        "ssh" => req
            .ssh_host
            .as_deref()
            .is_some_and(|h| {
                copy_ssh_file(
                    h,
                    req.ssh_user.as_deref(),
                    req.ssh_port,
                    req.ssh_key_path.as_deref(),
                    sidecar_src,
                    sidecar_dest,
                )
                .is_ok()
            }),
        _ => false,
    };
    if ok {
        Some(sidecar_dest.to_path_buf())
    } else {
        None
    }
}

pub fn stage_artifact(staging_root: &Path, req: &StagingRequest) -> Result<StagedArtifact, String> {
    let trimmed_src = req.source_path.trim();
    if trimmed_src.is_empty() {
        return Err(
            tr_en(
                "Staging için kaynak dosya yolu boş olamaz.",
                "Source file path for staging cannot be empty.",
            )
            .to_string(),
        );
    }

    let filename = Path::new(trimmed_src)
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| {
            crate::tf!(
                "Geçersiz kaynak dosya adı: {trimmed_src}",
                "Invalid source filename: {trimmed_src}"
            )
        })?;

    let target_dir = staging_root
        .join(sanitize_segment(&req.project_id))
        .join(sanitize_segment(&req.machine));
    fs::create_dir_all(&target_dir).map_err(|e| {
        crate::tf!(
            "Staging dizini oluşturulamadı: {e}",
            "Failed to create staging directory: {e}"
        )
    })?;

    let local_file = target_dir.join(filename);
    let cache_meta = target_dir.join(format!("{filename}.sha256.cache"));
    let bmap_dest = target_dir.join(format!("{filename}.bmap"));
    let sha_dest = target_dir.join(format!("{filename}.sha256"));

    // Fast path: reuse cached staged file when expected/cached SHA-256 matches.
    if local_file.exists() && cache_meta.exists() {
        if let Ok(cached_hash) = fs::read_to_string(&cache_meta) {
            let cached_hash = cached_hash.trim().to_ascii_lowercase();
            let current_hash = compute_sha256_file(&local_file)?;
            let matches_expected = req
                .expected_sha256
                .as_ref()
                .map(|e| e.trim().eq_ignore_ascii_case(&current_hash))
                .unwrap_or(true);
            let local_matches_src = if req.source_kind == "local" && Path::new(trimmed_src).exists() {
                let src_len = fs::metadata(trimmed_src).map(|m| m.len()).unwrap_or(0);
                let dst_len = fs::metadata(&local_file).map(|m| m.len()).unwrap_or(u64::MAX);
                src_len == dst_len
            } else {
                true
            };
            if cached_hash == current_hash && matches_expected && local_matches_src {
                return Ok(StagedArtifact {
                    local_path: local_file.to_string_lossy().to_string(),
                    bmap_path: bmap_dest.exists().then(|| bmap_dest.to_string_lossy().to_string()),
                    sha256_path: sha_dest.exists().then(|| sha_dest.to_string_lossy().to_string()),
                    sha256: current_hash,
                    size_bytes: fs::metadata(&local_file).map(|m| m.len()).unwrap_or(0),
                    cache_hit: true,
                    verified: true,
                    source_path: trimmed_src.to_string(),
                });
            }
        }
    }

    let local_src_exists = Path::new(trimmed_src).exists();
    if req.source_kind == "local" && local_src_exists {
        fs::copy(trimmed_src, &local_file).map_err(|e| {
            crate::tf!(
                "Yerel dosya kopyalanamadı ({trimmed_src}): {e}",
                "Failed to copy local file ({trimmed_src}): {e}"
            )
        })?;
    } else if req.source_kind == "wsl2" && !req.mock_mode {
        copy_wsl2_file(req.wsl_distro.as_deref(), trimmed_src, &local_file)?;
    } else if req.source_kind == "docker" && !req.mock_mode {
        let container = req.docker_container.as_deref().ok_or_else(|| {
            tr_en(
                "Docker staging için container adı gerekli.",
                "Container name is required for Docker staging.",
            )
            .to_string()
        })?;
        copy_docker_file(container, trimmed_src, &local_file)?;
    } else if req.source_kind == "ssh" && !req.mock_mode {
        let host = req.ssh_host.as_deref().ok_or_else(|| {
            tr_en(
                "SSH staging için host gerekli.",
                "Host is required for SSH staging.",
            )
            .to_string()
        })?;
        copy_ssh_file(
            host,
            req.ssh_user.as_deref(),
            req.ssh_port,
            req.ssh_key_path.as_deref(),
            trimmed_src,
            &local_file,
        )?;
    } else if req.mock_mode || req.source_kind == "mock" {
        let mut f = File::create(&local_file).map_err(|e| {
            crate::tf!(
                "Mock staging dosyası oluşturulamadı: {e}",
                "Failed to create mock staging file: {e}"
            )
        })?;
        let header = format!("YOCTO-STUDIO-MOCK-IMAGE:{}:{}:{}\n", req.project_id, req.machine, filename);
        f.write_all(header.as_bytes()).map_err(|e| e.to_string())?;
        let pad = vec![0x5Au8; 64 * 1024];
        f.write_all(&pad).map_err(|e| e.to_string())?;
        fs::write(&bmap_dest, b"<bmap version=\"2.0\"></bmap>\n").map_err(|e| e.to_string())?;
    } else {
        return Err(crate::tf!(
            "Kaynak imaj bulunamadı: {trimmed_src}",
            "Source image not found: {trimmed_src}"
        ));
    }

    let mut bmap_out = try_copy_optional_sidecar(req, &format!("{trimmed_src}.bmap"), &bmap_dest);
    if bmap_out.is_none() && bmap_dest.exists() {
        bmap_out = Some(bmap_dest.clone());
    }

    let sha_out = try_copy_optional_sidecar(req, &format!("{trimmed_src}.sha256"), &sha_dest);
    let computed_hash = compute_sha256_file(&local_file)?;

    if let Some(ref exp) = req.expected_sha256 {
        let clean = exp.trim().to_ascii_lowercase();
        if !clean.is_empty() && clean != computed_hash {
            let _ = fs::remove_file(&local_file);
            return Err(crate::tf!(
                "SHA-256 doğrulama başarısız! Beklenen: {clean}, Hesaplanan: {computed_hash}",
                "SHA-256 verification failed! Expected: {clean}, Computed: {computed_hash}"
            ));
        }
    }

    if let Some(ref sfile) = sha_out {
        if let Ok(content) = fs::read_to_string(sfile) {
            if let Some(sidecar_hash) = parse_sha256_sidecar(&content) {
                if sidecar_hash != computed_hash {
                    let _ = fs::remove_file(&local_file);
                    return Err(crate::tf!(
                        ".sha256 sidecar doğrulama hatası! Beklenen: {sidecar_hash}, Hesaplanan: {computed_hash}",
                        ".sha256 sidecar verification failed! Expected: {sidecar_hash}, Computed: {computed_hash}"
                    ));
                }
            }
        }
    } else {
        fs::write(&sha_dest, format!("{computed_hash}  {filename}\n")).map_err(|e| {
            crate::tf!(
                ".sha256 yazılamadı: {e}",
                "Failed to write .sha256 file: {e}"
            )
        })?;
    }

    fs::write(&cache_meta, format!("{computed_hash}\n")).map_err(|e| {
        crate::tf!(
            "Staging cache yazılamadı: {e}",
            "Failed to write staging cache: {e}"
        )
    })?;

    Ok(StagedArtifact {
        local_path: local_file.to_string_lossy().to_string(),
        bmap_path: bmap_out.map(|p| p.to_string_lossy().to_string()),
        sha256_path: Some(sha_dest.to_string_lossy().to_string()),
        sha256: computed_hash,
        size_bytes: fs::metadata(&local_file).map(|m| m.len()).unwrap_or(0),
        cache_hit: false,
        verified: true,
        source_path: trimmed_src.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staging_computes_sha256_and_uses_cache_hit() {
        let root = std::env::temp_dir().join(format!("yocto_stage_ok_{}", std::process::id()));
        let src_dir = root.join("src");
        let cache_dir = root.join("cache");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&src_dir).unwrap();

        let img = src_dir.join("core-image-minimal.wic");
        fs::write(&img, b"YOCTO-STAGE-PAYLOAD-1234").unwrap();
        let expected = compute_sha256_file(&img).unwrap();

        let req = StagingRequest {
            source_kind: "local".into(),
            source_path: img.to_string_lossy().to_string(),
            project_id: "proj1".into(),
            machine: "imx8mp-evk".into(),
            wsl_distro: None,
            docker_container: None,
            ssh_host: None,
            ssh_user: None,
            ssh_port: None,
            ssh_key_path: None,
            expected_sha256: Some(expected.clone()),
            mock_mode: false,
        };

        let first = stage_artifact(&cache_dir, &req).expect("first stage");
        assert!(!first.cache_hit);
        assert!(first.verified);
        assert_eq!(first.sha256, expected);

        let second = stage_artifact(&cache_dir, &req).expect("second stage cache hit");
        assert!(second.cache_hit);
        assert_eq!(second.sha256, expected);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn staging_fails_on_sha256_mismatch() {
        let root = std::env::temp_dir().join(format!("yocto_stage_bad_{}", std::process::id()));
        let src_dir = root.join("src");
        let cache_dir = root.join("cache");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&src_dir).unwrap();

        let img = src_dir.join("bad.wic");
        fs::write(&img, b"ACTUAL-DATA").unwrap();

        let req = StagingRequest {
            source_kind: "local".into(),
            source_path: img.to_string_lossy().to_string(),
            project_id: "proj1".into(),
            machine: "imx8mp-evk".into(),
            wsl_distro: None,
            docker_container: None,
            ssh_host: None,
            ssh_user: None,
            ssh_port: None,
            ssh_key_path: None,
            expected_sha256: Some("0".repeat(64)),
            mock_mode: false,
        };

        let err = stage_artifact(&cache_dir, &req).unwrap_err();
        assert!(err.contains("SHA-256"));
        let _ = fs::remove_dir_all(&root);
    }
}
