<#
.SYNOPSIS
    Generates a Tauri v2 minisign keypair and updates tauri.conf.json for signed Auto-Updater releases.
#>
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$KeyDir = Join-Path $env:USERPROFILE ".tauri"
$KeyPath = Join-Path $KeyDir "yocto-studio.key"
$PubPath = "$KeyPath.pub"
$TauriConfPath = Join-Path $Root "apps\desktop\src-tauri\tauri.conf.json"

New-Item -ItemType Directory -Force -Path $KeyDir | Out-Null

if (-not (Test-Path $KeyPath)) {
    Write-Host "==> Generating new Tauri v2 minisign keypair at $KeyPath" -ForegroundColor Cyan
    pnpm --dir $Root --filter @yocto-studio/desktop tauri signer generate -w $KeyPath
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} else {
    Write-Host "==> Existing signing key found at $KeyPath" -ForegroundColor Yellow
}

if (Test-Path $PubPath) {
    $PubKey = (Get-Content -Raw $PubPath).Trim()
    $Conf = Get-Content -Raw $TauriConfPath | ConvertFrom-Json
    $Conf.plugins.updater.pubkey = $PubKey
    $Conf | ConvertTo-Json -Depth 12 | Set-Content -Path $TauriConfPath -Encoding UTF8
    Write-Host "==> Updated plugins.updater.pubkey in tauri.conf.json" -ForegroundColor Green
}

Write-Host ""
Write-Host "Next step: add the private key contents ($KeyPath) and password as GitHub Actions secrets:" -ForegroundColor Cyan
Write-Host "  1. TAURI_SIGNING_PRIVATE_KEY"
Write-Host "  2. TAURI_SIGNING_PRIVATE_KEY_PASSWORD"
Write-Host "Then push a tag (e.g. git tag v1.1.0 && git push origin v1.1.0) to publish signed bundles + latest.json."
