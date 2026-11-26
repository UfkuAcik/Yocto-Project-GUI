# Developer Guide

## 1. Local Setup

> **System Prerequisites:**
> - **Mock Mode / Browser UI:** Node.js `22+`, pnpm `10+`, Python `3.10+`. (`yocto-bridge` uses pure Python stdlib at runtime.)
> - **Tauri Desktop (`dev:tauri` / installers):** Rust `1.80+`, plus on **Windows** Visual Studio Build Tools (*Desktop development with C++* + Windows SDK) and WebView2; on **Linux (Ubuntu/Debian)** `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libudev-dev pkg-config libssl-dev libgtk-3-dev`.
> - **Windows PowerShell Note:** If PowerShell blocks `pnpm` or `.ps1` scripts (`ExecutionPolicy`), run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` or use `pnpm.cmd` / `cmd.exe`.

```bash
pnpm install
pnpm --filter @yocto-studio/shared-protocol build
```

Optional Python virtualenv for unit tests and lint (`pytest`, `pytest-asyncio`, `ruff`):

```powershell
# Windows PowerShell:
python -m venv packages/yocto-bridge/.venv
packages\yocto-bridge\.venv\Scripts\python.exe -m pip install pytest pytest-asyncio ruff
```

```bash
# Linux / macOS:
python3 -m venv packages/yocto-bridge/.venv
packages/yocto-bridge/.venv/bin/python -m pip install pytest pytest-asyncio ruff
```

Run Mock Mode (Browser UI at `http://localhost:1420`) in a single terminal:

```bash
pnpm dev
```

Or run the Mock Bridge + Vite dev server in two terminals (then open `http://localhost:1420`):

```bash
pnpm dev:bridge
pnpm dev:desktop
```

Or launch the full Tauri desktop shell:

```bash
pnpm dev:tauri
```

---

## 2. Extending Hardware Flasher Profiles (`TargetFlasher`)

Host-native USB flashers live in `apps/desktop/src-tauri/src/deploy/usb_flashers/`:
1. Implement `TargetFlasher` in a new Rust module (e.g., `rkdeveloptool.rs`), executing tools via `tokio::process::Command` argument arrays (never shell string interpolation).
2. Register the flasher variant in `apps/desktop/src-tauri/src/deploy/usb_flashers/mod.rs` and expose health checks in `deploy_cmds::get_flash_tools_health`.
3. Add UI preset selection inside `apps/desktop/src/features/target-deploy/UsbFlashView.tsx`.

---

## 3. Adding Pre-Flight Audit Rules & Migration Rules

- **Pre-Flight rules:** Add audit checks and `PreFlightFixAction` objects in `packages/yocto-bridge/bridge/preflight/` (`layer_audit.py`, `version_matrix.py`, or `dryrun_analyzer.py`) and cover them in `tests/test_preflight.py`.
- **LTS Migration rules:** Add regex/AST detectors and auto-fix transforms in `packages/yocto-bridge/bridge/enterprise/migration_linter.py` and test edge cases in `tests/test_enterprise.py`.

---

## 4. Refreshing README Screenshots

Requires Chrome or Edge installed locally (uses `playwright-core` against Vite preview + Mock Bridge):

```bash
pnpm --filter @yocto-studio/desktop build
node scripts/capture-screenshots.mjs
```

Screenshots are written at `1440×900` (`deviceScaleFactor: 2`) to `docs/assets/screenshots/` (Turkish) and `docs/assets/screenshots/en/` (English).

---

## 5. Release Packaging & Signed Updater Artifacts

- **Windows (NSIS `.exe` + `.msi`):** `.\scripts\package.ps1`
- **Linux (`.AppImage` + `.deb`):** `pnpm --filter @yocto-studio/desktop tauri build --bundles appimage deb`
- **Auto-Updater Signing:** Run `.\scripts\setup-signing.ps1` (or `pnpm --filter @yocto-studio/desktop tauri signer generate`), commit the updated `plugins.updater.pubkey` in `tauri.conf.json`, add `TAURI_SIGNING_PRIVATE_KEY` & `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` to GitHub repository secrets, and push a tag (`git tag v1.1.0 && git push origin v1.1.0`). `.github/workflows/release.yml` builds signed Windows (`.msi`, `.exe`) + Linux (`.AppImage`, `.deb`) installers, `latest.json`, and `SHA256SUMS.txt`.
