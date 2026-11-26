# Changelog

All notable changes to **Yocto Studio** will be documented in this file. The format adheres to [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-11-25

### Added — Signed Releases, CI sstate Analytics & Additional Vendor Flashers
- **Signed Multi-Platform GitHub Releases & Auto-Updater Manifest (`.github/workflows/release.yml`, `scripts/setup-signing.ps1`):**
  - Tag-driven release matrix (`v*.*.*`) producing Windows (`.msi`, `.exe`) and Linux (`.AppImage`, `.deb`) installers plus `SHA256SUMS.txt` and live Tauri v2 `latest.json` auto-updater manifest publishing when `TAURI_SIGNING_PRIVATE_KEY` is configured.
  - Updated `enterprise_cmds::check_app_update` to parse signed Tauri v2 `latest.json` platform manifests cleanly (`download_url` + `signature_verified_manifest`).
- **Remote `sstate-cache` & Hash Equivalence CI Runner Analytics (`sstate_analytics.py`, `SstateAnalyticsView.tsx`):**
  - Parses BitBake `Sstate summary` / `unihash` logs across GitHub Actions, GitLab Runners, and SSH build hosts; visualizes 24h/7d/30d cache hit trends, recipe-level Hash Equivalence savings, quota/eviction risk, and `NATIVELSBSTRING` skew anomalies.
- **Additional Host-Native USB Flasher Presets (`ti_dfu_boot.rs`, `mediatek_sp.rs`, `rockchip_rkdev.rs`):**
  - **TI Sitara (`ti_dfu_boot`):** Multi-stage USB DFU (`tiboot3.bin` -> `tispl.bin` -> `u-boot.img` -> `rootfs`).
  - **MediaTek Genio (`mediatek_sp`):** `sp-flash-tool` BROM/Download Agent & scatter flashing.
  - **Rockchip (`rockchip_rkdev`):** `rkdeveloptool` MiniLoader + strict hex/numeric LBA offset validation (`wl`) + optional device reset (`rd`).

## [1.0.0] - 2026-11-25

### Added — Complete 11-Module Embedded Linux Engineering Suite
- **Modules 1–7 (Core Yocto IDE):**
  - Cross-platform Tauri v2 + Rust + React 19 + TypeScript + Tailwind v4 workbench for Yocto Project **6.0 Wrynose** & **5.0 Scarthgap**.
  - Pure-stdlib Python `yocto-bridge` daemon communicating via JSON-RPC 2.0 + RFC 6455 WebSocket + PTY.
  - **Environment Doctor & Provider Orchestrator:** Windows WSL2 (`ext4` verification & `-32001` `/mnt/c` NTFS guard, `.wslconfig` tuning, `.vhdx` maintenance), Docker/CROPS/`kas` named volumes, Remote SSH, and Native Linux.
  - **Layers & Config Studio:** Live OpenEmbedded Layer Index client, `bitbake-layers` inspection, lossless comment-preserving `local.conf`/`bblayers.conf` AST editor, and variable origin trace.
  - **Recipe & `devtool` IDE:** Monaco editor with BitBake highlighting, `recipetool` 6-build-system generator, `devtool` lifecycle (`add`, `modify`, `build`, `deploy-target`, `finish`), and xterm.js PTY (`devshell`, `menuconfig`, `runqemu`).
  - **Build Engine, DAG & Artifacts:** Live task telemetry, `task-depends.dot` React Flow DAG explorer, SPDX 3.0 SBOM, `sbom-cve-check` / `cve-check`, WIC editor, and `buildhistory` diff.
- **Module 8 (Target Deploy, Flashing & Hardware Console):**
  - Host-native USB flashers (`raw_disk` with OS-disk exclusion, `fastboot`, `dfu-util`, NXP `uuu`, `STM32_Programmer_CLI`, validated Custom CLI templates).
  - Ethernet & OTA deployment (embedded TFTP server + U-Boot script generator, SWUpdate, RAUC A/B, SSH block device flasher) and host-native UART Serial Console (`COM` / `/dev/ttyUSB*`) with U-Boot autoboot interrupt macros.
  - Automatic artifact staging with SHA-256 verification and SQLite target profiles.
- **Module 9 (Pre-Flight Inspector & Image Advisor):**
  - Fast pre-build compatibility audit (`LAYERSERIES_COMPAT`, `LAYERDEPENDS`, version conflicts, `bitbake -n` simulation, `INCOMPATIBLE_LICENSE`, bloat detection, `sstate`/hashserve probe), host resource optimizer (PSI / `PARALLEL_MAKE`), one-click Auto-Fix diffs, and optional Build Pre-Flight Gate.
- **Module 10 (Pro Suite):**
  - Kernel `.cfg` fragment & Device Tree (`.dts`/`.dtsi`) visual studio, `testimage`/`ptest` & hardware smoke/boot-time profiler, EU CRA OpenVEX + SPDX compliance bundle exporter, Secure Boot (`FIT` + `dm-verity`) wizard, Opt-In AI build error triage (Ollama / BYOK Keyring + automatic secret redaction), `buildstats` bottleneck timeline, and GitLab CI / GitHub Actions YAML generator.
- **Module 11 (Enterprise & Completeness Pack):**
  - Heterogeneous `BBMULTICONFIG` orchestrator (`mcdepends`), Air-Gapped offline mirror / `AUTOREV` pinning / GPL `archiver.bbclass`, interactive 40+ package RootFS Size Treemap + `oe-pkgdata-util` IDE jump + `bitbake-diffsigs` explainer, remote `gdbserver` + VS Code launch export + live target device monitor, Yocto LTS Migration Wizard (`4.0 → 5.0 → 6.0`), Multi-Layer Git Manager, Zero-Leakage `.yoctostudio` Team Snapshot (JSON/ZIP), full **Turkish / English** i18n (`react-i18next`), and signed Tauri v2 Auto-Updater config.
