# =============================================================================
# setup_p4_env.ps1
# 一键设置环境变量 - Perforce 编码等常用环境变量配置
# =============================================================================

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$msg); Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg); Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg); Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Info { param([string]$msg); Write-Host "  $msg" -ForegroundColor Gray }
function Write-Err  { param([string]$msg); Write-Host "[ERROR] $msg" -ForegroundColor Red }

Write-Host "==========================================" -ForegroundColor Magenta
Write-Host "  一键设置环境变量 (Environment Variables)" -ForegroundColor Magenta
Write-Host "==========================================" -ForegroundColor Magenta

# ── 1. 设置 P4CHARSET=utf8 ──────────────────────────────────────────────────
Write-Step "Setting P4CHARSET=utf8"

try {
    $p4Cmd = Get-Command p4 -ErrorAction SilentlyContinue
    if (-not $p4Cmd) {
        Write-Err "p4 command not found. Please ensure Perforce (Helix Core) is installed and in PATH."
        exit 1
    }

    Write-Info "Executing: p4 set P4CHARSET=utf8"
    & p4 set P4CHARSET=utf8
    if ($LASTEXITCODE -ne 0) {
        Write-Err "Failed to set P4CHARSET. Exit code: $LASTEXITCODE"
        exit 1
    }
    Write-OK "P4CHARSET set to utf8"
} catch {
    Write-Err "Failed to set P4CHARSET: $_"
    exit 1
}

# ── 验证 ────────────────────────────────────────────────────────────────────
Write-Step "Verifying P4 environment variables"

try {
    $p4Settings = & p4 set 2>&1
    Write-Host ""
    foreach ($line in $p4Settings) {
        if ($line -match "P4CHARSET") {
            Write-OK $line
        } else {
            Write-Info $line
        }
    }
} catch {
    Write-Warn "Could not read p4 settings: $_"
}

# ── 完成 ────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "==========================================" -ForegroundColor Magenta
Write-OK "环境变量设置完成!"
Write-Host ""
