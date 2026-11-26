<#
.SYNOPSIS
    Yocto Studio Windows Desktop Release Packaging Script (NSIS + MSI)
#>
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$DesktopDir = Join-Path $Root "apps\desktop"
$CargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $CargoBin) {
    $env:PATH = "$CargoBin;$env:PATH"
}

$Pnpm = if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) { "pnpm.cmd" } else { "pnpm" }

Write-Host "==> [1/4] Building @yocto-studio/shared-protocol" -ForegroundColor Cyan
& $Pnpm --dir $Root --filter @yocto-studio/shared-protocol build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> [2/4] Typechecking & building Vite frontend" -ForegroundColor Cyan
& $Pnpm --dir $Root --filter @yocto-studio/desktop typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> [3/4] Running cargo clippy & cargo test" -ForegroundColor Cyan
Push-Location (Join-Path $DesktopDir "src-tauri")
try {
    cargo clippy --all-targets -- -D warnings
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    cargo test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}

Write-Host "==> [4/4] Building Tauri v2 Windows bundles (NSIS + MSI)" -ForegroundColor Cyan
& $Pnpm --dir $Root --filter @yocto-studio/desktop tauri build --bundles nsis msi
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "==> Packaging complete! Check apps/desktop/src-tauri/target/release/bundle/" -ForegroundColor Green
