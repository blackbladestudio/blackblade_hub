# =============================================================================
# install_bb_cli.ps1
# 从 GitHub Release 安装 BlackBlade CLI (bb) 到 ~/.blackblade/bb.exe 并加入 PATH
#
# 实际安装逻辑由 bb cli 仓库的 install.ps1 负责，本脚本只负责拉取并执行。
# 仓库需为 public，否则 raw.githubusercontent.com 会返回 404。
# =============================================================================

$ErrorActionPreference = "Stop"

$InstallUrl = 'https://raw.githubusercontent.com/blackbladestudio/blackblade-cli/main/install.ps1'

function Write-Step { param([string]$msg); Write-Host "=== $msg ===" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg); Write-Host "OK: $msg" -ForegroundColor Green }
function Write-Err  { param([string]$msg); Write-Host "[ERROR] $msg" -ForegroundColor Red }

Write-Host "======================================" -ForegroundColor Magenta
Write-Host "  BlackBlade CLI (bb) Installer" -ForegroundColor Magenta
Write-Host "======================================" -ForegroundColor Magenta

# ── 1. 拉取远程 install.ps1 ─────────────────────────────────────────────────
Write-Step "Checking source"
Write-Host "  从 GitHub 拉取安装脚本: $InstallUrl"

try {
    $scriptContent = Invoke-RestMethod -Uri $InstallUrl -UseBasicParsing
} catch {
    Write-Err "拉取安装脚本失败: $_"
    Write-Host "  请确认仓库 blackbladestudio/blackblade-cli 已设为 public" -ForegroundColor Yellow
    exit 1
}
Write-OK "安装脚本已就绪"

# ── 2. 执行安装 ─────────────────────────────────────────────────────────────
Write-Step "Installing to ~/.blackblade"
Write-Host "  开始下载并安装 bb cli..."

try {
    & ([scriptblock]::Create($scriptContent))
} catch {
    Write-Err "安装失败: $_"
    exit 1
}

# ── 3. 验证 ─────────────────────────────────────────────────────────────────
Write-Step "Verifying installation"

$DestBin = Join-Path $env:USERPROFILE ".blackblade\bb.exe"
if (Test-Path $DestBin) {
    Write-OK "bb.exe installed to: $DestBin"
} else {
    Write-Err "bb.exe not found after install: $DestBin"
    exit 1
}

Write-Host "`n======================================" -ForegroundColor Magenta
Write-OK "BlackBlade CLI installed successfully!"
Write-Host "  You can now use 'bb' in any new terminal." -ForegroundColor Gray
Write-Host "  Run 'bb --help' to get started." -ForegroundColor Gray
