# =============================================================================
# install_horde_agent.ps1
# 在 Windows 构建机上安装 Horde Agent
# 用法:
#   .\install_horde_agent.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
. "$ScriptDir\horde_config.ps1"

$AgentWorkDir = "$env:LOCALAPPDATA\HordeAgent"
$AgentTempDir = "$env:LOCALAPPDATA\Temp\HordeAgent"

function Write-Step { param([string]$msg); Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg); Write-Host "✅ $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg); Write-Host "⚠️  $msg" -ForegroundColor Yellow }
function Write-Info { param([string]$msg); Write-Host "  $msg" -ForegroundColor Gray }
function Write-Err  { param([string]$msg); Write-Host "[ERROR] $msg" -ForegroundColor Red }

Write-Host "======================================" -ForegroundColor Magenta
Write-Host "  Horde Agent Installer" -ForegroundColor Magenta
Write-Host "======================================" -ForegroundColor Magenta
Write-Info "Horde Server: $HORDE_SERVE_URL"
Write-Info "Agent WorkDir: $AgentWorkDir"

# ── 1. 创建工作目录 ─────────────────────────────────────────────────────────
Write-Step "1/4 Creating work directory"
if (-not (Test-Path $AgentWorkDir)) {
    New-Item -ItemType Directory -Force -Path $AgentWorkDir | Out-Null
}
if (-not (Test-Path $AgentTempDir)) {
    New-Item -ItemType Directory -Force -Path $AgentTempDir | Out-Null
}
Write-OK "Work directory ready: $AgentWorkDir"

# ── 2. 下载 Agent 软件 ──────────────────────────────────────────────────────
Write-Step "2/4 Downloading Horde Agent"

$agentZip = Join-Path $AgentTempDir "HordeAgent.zip"
$downloadUrl = "$HORDE_SERVE_URL/api/v1/agentsoftware/default/zip"

Write-Info "Download URL: $downloadUrl"

try {
    Invoke-WebRequest -Uri $downloadUrl -OutFile $agentZip -UseBasicParsing
    Write-OK "Download completed"
} catch {
    Write-Err "Download failed: $_"
    Write-Info "If download fails, manually download from Horde Dashboard -> Tools"
    exit 1
}

# ── 3. 解压 Agent ───────────────────────────────────────────────────────────
Write-Step "3/4 Extracting Horde Agent"

$extractDir = Join-Path $AgentTempDir "HordeAgent"
if (Test-Path $extractDir) {
    Remove-Item -Path $extractDir -Recurse -Force
}

try {
    Expand-Archive -LiteralPath $agentZip -DestinationPath $extractDir -Force
    Write-OK "Extraction completed"

    Get-ChildItem $extractDir | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $AgentWorkDir -Recurse -Force
    }
    Write-Info "Files copied to: $AgentWorkDir"
} catch {
    Write-Err "Extraction failed: $_"
    exit 1
}

# ── 3.5 检查并安装所需 .NET Runtime ─────────────────────────────────────────
Write-Step "3.5/4 Checking .NET Runtime"

$runtimeConfigPath = Join-Path $AgentWorkDir "HordeAgent.runtimeconfig.json"

if (Test-Path $runtimeConfigPath) {
    $runtimeConfig = Get-Content $runtimeConfigPath | ConvertFrom-Json
    $requiredFramework = $runtimeConfig.runtimeOptions.framework
    $requiredName    = $requiredFramework.name
    $requiredVersion = $requiredFramework.version
    $majorMinor      = ($requiredVersion -split '\.')[0..1] -join '.'

    Write-Info "Required runtime: $requiredName $requiredVersion"

    $installedRuntimes = & dotnet --list-runtimes 2>$null
    $isInstalled = $installedRuntimes | Where-Object {
        $_ -match [regex]::Escape($requiredName) -and $_ -match "^$([regex]::Escape($requiredName)) $majorMinor\."
    }

    if ($isInstalled) {
        Write-OK ".NET $majorMinor Runtime already installed"
    } else {
        Write-Warn ".NET $majorMinor Runtime not found, installing..."

        $wingetId = if ($requiredName -match "AspNetCore") {
            "Microsoft.DotNet.AspNetCore.$majorMinor"
        } else {
            "Microsoft.DotNet.Runtime.$majorMinor"
        }

        Write-Info "Installing via winget: $wingetId"
        winget install --id $wingetId --silent --accept-package-agreements --accept-source-agreements

        if ($LASTEXITCODE -eq 0) {
            Write-OK ".NET $majorMinor Runtime installed successfully"
        } else {
            Write-Warn "winget install returned $LASTEXITCODE"
            Write-Info "Please manually install from: https://dotnet.microsoft.com/download/dotnet/$majorMinor"
            Write-Info "Required: $requiredName $requiredVersion (Windows x64)"
        }
    }
} else {
    Write-Warn "runtimeconfig.json not found at: $runtimeConfigPath"
    Write-Info "Skipping .NET version check"
}

# ── 4. 配置 Agent ───────────────────────────────────────────────────────────
Write-Step "4/4 Configuring Horde Agent"

$initScript = "$ScriptDir\initialize_horde_agent.ps1"
if (Test-Path $initScript) {
    Write-Info "Running initialization script..."
    try {
        & $initScript
        Write-OK "Configuration completed"
    } catch {
        Write-Warn "Initialization failed: $_"
        Write-Info "You can manually run: $initScript"
    }
} else {
    Write-Warn "Initialization script not found: $initScript"
    Write-Info "Please run initialize_horde_agent.ps1 manually"
}

Write-Host "`n======================================" -ForegroundColor Magenta
Write-OK "Installation completed!"
Write-Info "Work Directory: $AgentWorkDir"
Write-Host ""
