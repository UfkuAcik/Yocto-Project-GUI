## Summary

Describe the change and reference any related issues (`Closes #...`).

## Scope

- [ ] Shared Protocol (`packages/shared-protocol`)
- [ ] Python `yocto-bridge` (`packages/yocto-bridge`)
- [ ] Rust Tauri Host Core (`apps/desktop/src-tauri`)
- [ ] React / TypeScript UI (`apps/desktop/src`)
- [ ] Documentation / i18n (`README*`, `docs/`, `src/i18n/`)

## Verification Checklist

- [ ] `pnpm --filter @yocto-studio/shared-protocol build` passes with 0 errors
- [ ] `pnpm --filter @yocto-studio/desktop test` & `build` (`tsc --noEmit && vite build`) pass
- [ ] `cargo clippy --all-targets -- -D warnings` & `cargo test` pass
- [ ] `ruff check .` & `pytest -v` pass
- [ ] No plain-text secrets, OS-disk bypasses, or `/mnt/c` NTFS regressions introduced
- [ ] Both `src/i18n/tr.json` and `src/i18n/en.json` updated (if UI copy changed)
