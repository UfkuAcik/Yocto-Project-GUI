# Yocto Studio — Complete Module Guide (Modules 1–11)

## Module 1–2: Environment Doctor & Provider Orchestrator
- Probes host CPU cores, total/available RAM, free disk space, WSL2 distros, Docker daemon, and OpenSSH connectivity.
- Manages `.wslconfig` safely without overwriting unrelated user settings, generates `.vhdx` maintenance commands, and initializes Docker `ext4` volumes (`yocto-sstate`, `yocto-dl`, `yocto-tmp`).

## Module 3: Workspace & Layer Ecosystem
- Creates or imports Yocto workspaces using `bitbake-setup`, `kas` YAML (two-way AST parser & serializer + `kas lock`/`checkout`/`build`), or `oe-init-build-env`.
- Searches the live **OpenEmbedded Layer Index API** (filtering by `wrynose`, `scarthgap`, `clang`, etc.), runs `bitbake-layers show-layers` / `show-appends` / `show-overlayed`, and generates compliant `meta-*` layers.

## Module 4: Config Studio & Variable Trace
- Edits `conf/local.conf` and `conf/bblayers.conf` using a **lossless AST parser** that preserves every comment and inline annotation.
- Inspects BitBake variable assignment history (`bitbake -e`) and enables/disables config fragments cleanly.

## Module 5: Recipe & `devtool` IDE
- Full **Monaco Editor** with BitBake syntax highlighting and unified diff comparison.
- Generates recipes across **CMake, Meson, Autotools, Cargo (Rust), Python, and Go** via `recipetool create`, manages `devtool` workspaces (`add`, `modify`, `build`, `deploy-target`, `finish`, `reset`), and opens real `xterm.js` PTY sessions (`devshell`, `menuconfig`, `diffconfig`, `runqemu`).

## Module 6: Live Build Engine & Task DAG
- Streams structured `bitbake` task lifecycle events, CPU/RAM/Disk I/O telemetry, 100k+ line virtualized logs, and interactive `task-depends.dot` dependency graphs with *"Why was package X included?"* reverse-chain tracing.

## Module 7: Artifacts, SBOM/CVE, WIC, QEMU & SDK
- Inspects deployed images, parses SPDX 3.0 JSON-LD SBOMs and `sbom-cve-check`/`cve-check` findings, edits `.wks` partition layouts visually, launches `runqemu`, inspects `buildhistory` deltas, and builds standard/eSDK installers.

## Module 8: Target Deploy, Flashing & Hardware Console
- Host-native flashing over **USB** (Zero-Brick Raw Disk, `fastboot`, `dfu-util`, NXP `uuu`, `STM32_Programmer_CLI`, **TI Sitara `dfu-boot`**, **MediaTek `sp-flash-tool`**, **Rockchip `rkdeveloptool`**, validated Custom CLI), **Ethernet** (embedded TFTP server + U-Boot script generator, SWUpdate, RAUC A/B, SSH partition writer), and **UART Serial Console** (`COM` / `/dev/ttyUSB*` + U-Boot autoboot macros).

## Module 9: Pre-Flight Inspector & Image Advisor
- Pre-build compatibility matrix (`LAYERSERIES_COMPAT`, `LAYERDEPENDS`, `PREFERRED_VERSION`/`PROVIDER`), `bitbake -n` simulation, `INCOMPATIBLE_LICENSE` shield, package bloat detector, `sstate`/hashserve probe, PSI/OOM `PARALLEL_MAKE` optimizer, Image Planner wizard, and optional Build Pre-Flight Gate.

## Module 10: Pro Suite
- **Kernel & Device Tree Studio:** `.cfg` fragment diffing & `.dts`/`.dtsi` tree inspector with `dtc` syntax check and node `status = "okay" | "disabled"` toggles.
- **Runtime QA & Boot Profiler:** `testimage.bbclass`, `ptest`, hardware smoke-test suite (`dmesg`/`i2c`/network/storage), and `systemd-analyze` timeline with Markdown/HTML export.
- **EU CRA & Secure Boot:** OpenVEX triage + SPDX 3.0 compliance `.zip` packager, plus FIT signature + `dm-verity` `.inc` generator.
- **Opt-In AI Triage, `buildstats` & CI/CD:** Privacy-first log redaction (`Ollama` or OS-Keyring BYOK), build bottleneck Gantt chart, and GitLab CI / GitHub Actions YAML exporter.

## Module 11: Enterprise & Completeness Pack
- **Multiconfig (`BBMULTICONFIG`):** Visual `conf/multiconfig/*.conf` editor and heterogeneous `mc:<cfg>:<target>` orchestration.
- **Air-Gapped Offline & GPL Archiver:** `AUTOREV` scanner/pinner, `--runall=fetch` + `BB_NO_NETWORK`, and `archiver.bbclass` `.tar.gz` exporter.
- **RootFS Treemap & `diffsigs`:** 40+ package interactive Treemap, `oe-pkgdata-util find-path` with 1-click Monaco IDE jump, and `bitbake-diffsigs` root-cause simplifier.
- **Remote `sstate-cache` & Hash Equivalence CI Analytics:** Fleet hit-rate telemetry, `outHash -> uniHash` deduplication breakdown, and `NATIVELSBSTRING` skew anomaly alerts across CI runners.
- **Remote Cross-Debug & Live Monitor:** `.vscode/launch.json` + `c_cpp_properties.json` generator, SSH `gdbserver` launcher, and live CPU/RAM/Thermal/`systemctl --failed`/`journalctl` dashboard.
- **LTS Migration Wizard:** Static rule engine (`kirkstone 4.0 → scarthgap 5.0 → wrynose 6.0`) with unified Auto-Migrate Diff.
- **Multi-Layer Git, `.yoctostudio` Snapshot, TR/EN i18n & Auto-Updater:** Unified Git management across all `meta-*` layers, secret-free team snapshots, instant TR/EN switching, and signed Tauri v2 updater integration.
