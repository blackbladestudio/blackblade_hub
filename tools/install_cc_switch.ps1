# =============================================================================
# install_cc_switch.ps1
# 下载并安装工作室特供版 CC-Switch（从 GitHub fork 仓库的最新 Release 拉取 MSI）
# =============================================================================

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$msg); Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg); Write-Host "✅ $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg); Write-Host "⚠️  $msg" -ForegroundColor Yellow }
function Write-Info { param([string]$msg); Write-Host "  $msg" -ForegroundColor Gray }
function Write-Err  { param([string]$msg); Write-Host "[ERROR] $msg" -ForegroundColor Red }

$Repo    = "blackbladestudio/cc-switch"
$ApiUrl  = "https://api.github.com/repos/$Repo/releases/latest"
$TempDir = "$env:LOCALAPPDATA\Temp\CCSwitch"
$MsiPath = "$TempDir\CC-Switch-Setup.msi"

Write-Host "======================================" -ForegroundColor Magenta
Write-Host "  CC-Switch Installer (工作室特供版)" -ForegroundColor Magenta
Write-Host "======================================" -ForegroundColor Magenta
Write-Info "Repo : $Repo"

# ── 1. 查询最新 Release ──────────────────────────────────────────────────────
Write-Step "1/3 Querying latest release"

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri $ApiUrl -UseBasicParsing -Headers @{ "User-Agent" = "BlackBlade-Hub" }
} catch {
    Write-Err "Failed to query GitHub releases: $_"
    Write-Info "Please check network access to github.com"
    exit 1
}

$asset = $release.assets | Where-Object { $_.name -like "*-Windows.msi" } | Select-Object -First 1
if (-not $asset) {
    Write-Err "No Windows MSI asset found in latest release ($($release.tag_name))"
    exit 1
}
$DownloadUrl = $asset.browser_download_url
Write-OK "Latest version: $($release.tag_name)"
Write-Info "Asset: $($asset.name)"

# ── 2. 下载 MSI ──────────────────────────────────────────────────────────────
Write-Step "2/3 Downloading CC-Switch"

if (-not (Test-Path $TempDir)) {
    New-Item -ItemType Directory -Force -Path $TempDir | Out-Null
}

try {
    Write-Info "Downloading..."
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $MsiPath -UseBasicParsing
    $sizeMB = [math]::Round((Get-Item $MsiPath).Length / 1MB, 1)
    Write-OK "Download completed ($sizeMB MB): $MsiPath"
} catch {
    Write-Err "Download failed: $_"
    exit 1
}

# ── 3. 安装 MSI ──────────────────────────────────────────────────────────────
Write-Step "3/3 Installing CC-Switch"
Write-Info "Running msiexec (this may trigger a UAC prompt)..."

try {
    $proc = Start-Process -FilePath "msiexec.exe" `
        -ArgumentList "/i `"$MsiPath`" /passive /norestart" `
        -Wait -PassThru
    if ($proc.ExitCode -eq 0) {
        Write-OK "CC-Switch installed successfully"
    } elseif ($proc.ExitCode -eq 3010) {
        Write-OK "CC-Switch installed (restart required to complete)"
    } else {
        Write-Warn "msiexec exited with code $($proc.ExitCode)"
        Write-Info "Check Windows Event Viewer for details"
    }
} catch {
    Write-Err "Installation failed: $_"
    exit 1
}

Write-Host "`n======================================" -ForegroundColor Magenta
Write-OK "Done! You can now launch CC-Switch from the Start Menu."
Write-Host ""
