# =============================================================================
# install_unreal_toolbox.ps1
# 从 Horde 服务器下载并安装 Unreal Toolbox（MSI）
# =============================================================================

$ErrorActionPreference = "Stop"

. "$PSScriptRoot\horde_config.ps1"

function Write-Step { param([string]$msg); Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg); Write-Host "✅ $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg); Write-Host "⚠️  $msg" -ForegroundColor Yellow }
function Write-Info { param([string]$msg); Write-Host "  $msg" -ForegroundColor Gray }
function Write-Err  { param([string]$msg); Write-Host "[ERROR] $msg" -ForegroundColor Red }

$DownloadUrl = "$HORDE_SERVE_URL/api/v1/tools/unreal-toolbox-msi?action=download"
$TempDir     = "$env:LOCALAPPDATA\Temp\UnrealToolbox"
$MsiPath     = "$TempDir\UnrealToolbox.msi"

Write-Host "======================================" -ForegroundColor Magenta
Write-Host "  Unreal Toolbox Installer" -ForegroundColor Magenta
Write-Host "======================================" -ForegroundColor Magenta
Write-Info "Horde Server : $HORDE_SERVE_URL"
Write-Info "Download URL : $DownloadUrl"

# ── 1. 创建临时目录 ──────────────────────────────────────────────────────────
Write-Step "1/3 Creating temp directory"
if (-not (Test-Path $TempDir)) {
    New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
}
Write-OK "Temp directory ready: $TempDir"

# ── 2. 下载 MSI ──────────────────────────────────────────────────────────────
Write-Step "2/3 Downloading Unreal Toolbox"

try {
    Write-Info "Downloading..."
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $MsiPath -UseBasicParsing
    $sizeMB = [math]::Round((Get-Item $MsiPath).Length / 1MB, 1)
    Write-OK "Download completed ($sizeMB MB): $MsiPath"
} catch {
    Write-Err "Download failed: $_"
    Write-Info "Please check that Horde server is reachable: $HORDE_SERVE_URL"
    exit 1
}

# ── 3. 安装 MSI ──────────────────────────────────────────────────────────────
Write-Step "3/3 Installing Unreal Toolbox"
Write-Info "Running msiexec (this may trigger a UAC prompt)..."

try {
    $proc = Start-Process -FilePath "msiexec.exe" `
        -ArgumentList "/i `"$MsiPath`" /passive /norestart" `
        -Wait -PassThru
    if ($proc.ExitCode -eq 0) {
        Write-OK "Unreal Toolbox installed successfully"
    } elseif ($proc.ExitCode -eq 3010) {
        Write-OK "Unreal Toolbox installed (restart required to complete)"
    } else {
        Write-Warn "msiexec exited with code $($proc.ExitCode)"
        Write-Info "Check Windows Event Viewer for details"
    }
} catch {
    Write-Err "Installation failed: $_"
    exit 1
}

Write-Host "`n======================================" -ForegroundColor Magenta
Write-OK "Done! You can now launch Unreal Toolbox from the Start Menu."
Write-Host ""
