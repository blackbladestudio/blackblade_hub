# =============================================================================
# install_bb_cli.ps1
# 安装 BlackBlade CLI (bb) 到本地并添加到 PATH
# =============================================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HubBinDir = "$env:LOCALAPPDATA\BlackBlade Hub\bin"
$SourceBin = Join-Path $ScriptDir "..\bin\bb.exe"
$DestBin = Join-Path $HubBinDir "bb.exe"

function Write-Step { param([string]$msg); Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg); Write-Host "✅ $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg); Write-Host "⚠️  $msg" -ForegroundColor Yellow }
function Write-Info { param([string]$msg); Write-Host "  $msg" -ForegroundColor Gray }
function Write-Err  { param([string]$msg); Write-Host "[ERROR] $msg" -ForegroundColor Red }

Write-Host "======================================" -ForegroundColor Magenta
Write-Host "  BlackBlade CLI (bb) Installer" -ForegroundColor Magenta
Write-Host "======================================" -ForegroundColor Magenta

# ── 1. 检查源文件 ──────────────────────────────────────────────────────────
Write-Step "1/3 Checking source binary"

if (-not (Test-Path $SourceBin)) {
    Write-Err "Source binary not found: $SourceBin"
    Write-Info "This script should be run from BlackBlade Hub."
    exit 1
}
Write-OK "Source binary found: $SourceBin"

# ── 2. 创建目标目录并复制 ──────────────────────────────────────────────────
Write-Step "2/3 Installing to $HubBinDir"

if (-not (Test-Path $HubBinDir)) {
    New-Item -ItemType Directory -Force -Path $HubBinDir | Out-Null
    Write-Info "Created directory: $HubBinDir"
}

try {
    Copy-Item -Path $SourceBin -Destination $DestBin -Force
    Write-OK "bb.exe copied to: $DestBin"
} catch {
    Write-Err "Failed to copy bb.exe: $_"
    exit 1
}

# ── 3. 添加到 PATH ──────────────────────────────────────────────────────────
Write-Step "3/3 Adding to user PATH"

$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
$pathEntries = $currentPath -split ';' | Where-Object { $_ -ne '' -and $_ -ne $HubBinDir }

if ($pathEntries -contains $HubBinDir) {
    Write-OK "$HubBinDir is already in user PATH"
} else {
    $newPath = ($pathEntries + $HubBinDir) -join ';'
    try {
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        Write-OK "Added $HubBinDir to user PATH"

        # 同步更新当前进程的 PATH（仅影响当前命令行）
        $env:Path = "$env:Path;$HubBinDir"
        Write-Info "Current process PATH updated"
    } catch {
        Write-Err "Failed to update PATH: $_"
        exit 1
    }
}

# ── 验证 ────────────────────────────────────────────────────────────────────
Write-Step "Verifying installation"

$verifyExe = Get-Command bb -ErrorAction SilentlyContinue
if ($verifyExe) {
    Write-OK "bb is available: $($verifyExe.Source)"
} else {
    Write-Warn "bb not found in current PATH after installation."
    Write-Info "Please restart your terminal or run: refreshenv"
}

Write-Host "`n======================================" -ForegroundColor Magenta
Write-OK "BlackBlade CLI installed successfully!"
Write-Info "You can now use 'bb' in any new terminal."
Write-Info "Run 'bb --help' to get started."