# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `1.1.x` (`main`) | Yes |

## Security Architecture Highlights

Yocto Studio enforces strict defense-in-depth across host hardware operations, remote builds, AI diagnostics, and team collaboration:

1. **Zero-Brick OS Disk Protection:** Raw/UMS image flashing (`apps/desktop/src-tauri/src/flash/mod.rs` and `src/deploy/usb_flashers/raw_disk.rs`) strictly excludes OS system disks (e.g., Windows `PhysicalDrive0`, `C:\`, Linux `/`) and requires explicit confirmation with target device, disk size, filename, and SHA-256 verification.
2. **Command Injection & Option Injection Prevention:** Custom CLI flasher templates (`custom_cli.rs`), `devtool`, `kas`, Git actions, and SSH/SCP/WSL2 invocations reject shell metacharacters, separate options with `--`, escape shell arguments safely, verify remote block devices against discovered `lsblk` output, and execute via argument-array `Command` invocations (`shell=False`).
3. **Zero Plain-Text Credential Storage:** On Windows, BYOK API keys are stored only in the native Windows Credential Manager (`keyring` `windows-native`); on Linux/macOS, BYOK API keys are kept strictly ephemeral in-memory only (never persisted to SQLite or plaintext files on disk). SQLite only stores symbolic references (`keyring://...`).
4. **Opt-In AI with Automatic Secret Redaction:** AI build failure triage is **disabled by default**. Logs pass through `ai_triage::redaction::redact_secrets` before reaching local Ollama or a user-configured endpoint—scrubbing API tokens (`sk-`, `ghp_`, `AKIA`), PEM private keys, RFC 1918 internal IPs, internal hostnames, and URL credentials.
5. **Zero-Leakage Team Snapshots (`.yoctostudio`):** Snapshot export (`enterprise_cmds::build_sanitized_snapshot`) strips private keys, passwords, URL userinfo credentials, SSH private key paths, and keyring secrets across JSON and ZIP exports.
6. **WSL2 `/mnt/c` NTFS Guard:** Prevents accidental case-insensitive/permission corruption on WSL2 DrvFs mounts via error code `-32001` (`NTFS_PATH_FORBIDDEN`).
7. **Loopback Bridge Hardening (`yocto-bridge`):** Binds to loopback (`127.0.0.1`) with strict `Origin` and `Host` validation against CSWSH and DNS rebinding (reflecting only local origins instead of `Access-Control-Allow-Origin: *`), enforces 16 MiB HTTP body and WebSocket frame caps, confines live file RPC paths within workspace/build roots, and supports optional token authentication (`--token` / `YOCTO_BRIDGE_TOKEN`).
8. **Strict Tauri v2 WebView CSP:** Restricts scripts, workers, connections, and assets via a locked-down Content Security Policy in `apps/desktop/src-tauri/tauri.conf.json`.

## Reporting a Vulnerability

Please **do not** open public GitHub issues for sensitive security vulnerabilities. Instead, report privately via [GitHub Security Advisories](https://github.com/UfkuAcik/Yocto-Project-GUI/security/advisories/new) with reproduction steps, affected component (Rust/Tauri, Python bridge, or UI), and potential impact. We aim to acknowledge reports within 48 hours.
