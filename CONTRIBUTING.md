# Contributing to Yocto Studio

Thank you for your interest in contributing to **Yocto Studio**! This project spans a React/TypeScript UI, a Rust/Tauri v2 host core, and a zero-dependency Python `yocto-bridge` daemon.

## Development Workflow

1. Fork the repository and create a branch from `main`.
2. Ensure local prerequisites are available: **Node.js 22+**, **pnpm 10+**, **Rust 1.80+**, and **Python 3.10+**.
3. Use **Mock Mode** for rapid UI, bridge, and deploy workflow iteration (`pnpm dev:bridge` + `pnpm dev:desktop`).
4. Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit messages (`feat:`, `fix:`, `docs:`, `ci:`, `refactor:`, `test:`).

## Code Quality & Architecture Guardrails

- **Python (`packages/yocto-bridge`):** Pure Python stdlib at runtime (no third-party pip runtime dependencies). Keep line length `<= 120` and pass `ruff check .` + `pytest -v`.
- **Rust (`apps/desktop/src-tauri`):** All host-native hardware I/O (`serialport`, disk flashing, USB tools, TFTP, OS Keyring) stays in Rust. Never execute raw/removable disk flashing without verifying OS-disk exclusion guardrails. Pass `cargo clippy --all-targets -- -D warnings` and `cargo test`.
- **Frontend (`apps/desktop` & `packages/shared-protocol`):** Update `packages/shared-protocol/src/methods.ts` before using new RPCs, update both `src/i18n/tr.json` and `src/i18n/en.json` for user-facing strings, and pass `vitest`, `tsc --noEmit`, and `vite build`.

## Verification Before Opening a Pull Request

```bash
# 1. Shared Protocol & Frontend
pnpm --filter @yocto-studio/shared-protocol build
pnpm --filter @yocto-studio/desktop test
pnpm --filter @yocto-studio/desktop build

# 2. Rust Host Core
cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml

# 3. Python Bridge
ruff check packages/yocto-bridge
pytest packages/yocto-bridge -v
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for how to add new `TargetFlasher` board profiles or Pre-Flight audit rules.
