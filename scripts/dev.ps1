param(
  [int]$Port = 18765,
  [switch]$NoDesktop
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $Root "packages\yocto-bridge\.venv\Scripts\python.exe"
if (Test-Path $VenvPython) {
  $Python = $VenvPython
} else {
  $SysPython = Get-Command python -ErrorAction SilentlyContinue |
    Where-Object { $_.Source -notlike "*\WindowsApps\python.exe" } |
    Select-Object -First 1
  if ($SysPython) {
    $Python = $SysPython.Source
  } else {
    Write-Error "Python 3.10+ veya venv bulunamadı: $VenvPython"
  }
}

$Pnpm = if (Get-Command pnpm.cmd -ErrorAction SilentlyContinue) { "pnpm.cmd" } else { "pnpm" }

Write-Host "[Yocto Studio] yocto-bridge (mock mode) port $Port üzerinde başlatılıyor..." -ForegroundColor Cyan
$bridgeProc = Start-Process -FilePath $Python `
  -ArgumentList "-m", "bridge.server", "--mock", "--host", "127.0.0.1", "--port", "$Port" `
  -WorkingDirectory (Join-Path $Root "packages\yocto-bridge") `
  -PassThru -NoNewWindow

try {
  if (-not $NoDesktop) {
    Push-Location $Root
    & $Pnpm --filter @yocto-studio/desktop dev
    Pop-Location
  } else {
    Wait-Process -Id $bridgeProc.Id
  }
} finally {
  if ($bridgeProc -and -not $bridgeProc.HasExited) {
    Write-Host "[Yocto Studio] yocto-bridge kapatılıyor (PID $($bridgeProc.Id))..." -ForegroundColor Yellow
    Stop-Process -Id $bridgeProc.Id -Force -ErrorAction SilentlyContinue
  }
}
