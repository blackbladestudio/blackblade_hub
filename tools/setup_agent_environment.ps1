# =============================================================================
# setup_agent_environment.ps1
# 一键配置 Agent 环境 - 安装 Git, Python, Node.js, Go 等开发工具
# 用法: 以管理员身份运行
#   .\setup_agent_environment.ps1
# =============================================================================

param(
    [string]$GitVersion = "2.44.0",
    [string]$PythonVersion = "3.11.9",
    [switch]$SkipVSInstall = $false
)

$ErrorActionPreference = "Stop"

function Write-Step { param([string]$msg); Write-Host "`n=== $msg ===" -ForegroundColor Cyan }
function Write-OK   { param([string]$msg); Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg); Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Info { param([string]$msg); Write-Host "  $msg" -ForegroundColor Gray }
function Write-Err  { param([string]$msg); Write-Host "[ERROR] $msg" -ForegroundColor Red }

Write-Host "======================================" -ForegroundColor Magenta
Write-Host "  Agent Environment Setup (One-Click)" -ForegroundColor Magenta
Write-Host "======================================" -ForegroundColor Magenta

# ── 检查管理员权限 ───────────────────────────────────────────────────────────
Write-Step "Checking Administrator privileges"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Err "Please run this script as Administrator!"
    exit 1
}
Write-OK "Running as Administrator"

# ── 设置环境变量 ─────────────────────────────────────────────────────────────
Write-Step "Configuring environment variables"
$env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
Write-Info "PATH configured"

# ── 安装 Chocolatey ───────────────────────────────────────────────────────────
Write-Step "Installing Chocolatey (package manager)"
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
    Write-Info "Installing Chocolatey..."
    Set-ExecutionPolicy Bypass -Scope Process -Force
    [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
    Invoke-Expression ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
    refreshenv
    Write-OK "Chocolatey installed"
} else {
    Write-Info "Chocolatey already installed"
}

# ── 安装 Git ──────────────────────────────────────────────────────────────────
Write-Step "Installing Git"
$git = Get-Command git -ErrorAction SilentlyContinue
if ($git) {
    $gitVer = & git --version 2>&1
    Write-Info "Git already installed: $gitVer"
} else {
    Write-Info "Installing Git $GitVersion..."
    choco install git -y --no-progress --limit-output
    refreshenv
    Write-OK "Git installed"
}

# ── 安装 Python ───────────────────────────────────────────────────────────────
Write-Step "Installing Python"
$python = Get-Command python -ErrorAction SilentlyContinue
if ($python) {
    $pyVer = & python --version 2>&1
    Write-Info "Python already installed: $pyVer"
} else {
    Write-Info "Installing Python $PythonVersion..."
    choco install python --version=$PythonVersion -y --no-progress --limit-output
    refreshenv
    Write-OK "Python installed"
}

# ── 安装 Python pip ───────────────────────────────────────────────────────────
Write-Step "Ensuring pip is installed"
$pip = Get-Command pip -ErrorAction SilentlyContinue
if (-not $pip) {
    Write-Info "Installing pip..."
    python -m ensurepip --upgrade 2>&1 | Out-Null
    Write-OK "pip installed"
} else {
    Write-Info "pip already installed"
}

# ── 安装 Node.js ───────────────────────────────────────────────────────────────
Write-Step "Installing Node.js LTS"
$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
    $nodeVer = & node --version 2>&1
    Write-Info "Node.js already installed: $nodeVer"
} else {
    Write-Info "Installing Node.js LTS..."
    choco install nodejs-lts -y --no-progress --limit-output
    refreshenv
    Write-OK "Node.js installed"
}

# ── 安装 Go ───────────────────────────────────────────────────────────────────
Write-Step "Installing Go"
$go = Get-Command go -ErrorAction SilentlyContinue
if ($go) {
    $goVer = & go version 2>&1
    Write-Info "Go already installed: $goVer"
} else {
    Write-Info "Installing Go..."
    choco install golang -y --no-progress --limit-output
    refreshenv
    Write-OK "Go installed"
}

# ── 安装 Visual Studio Build Tools ───────────────────────────────────────────
if (-not $SkipVSInstall) {
    Write-Step "Installing Visual Studio Build Tools"
    $vsWhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    if (Test-Path $vsWhere) {
        $vsPath = & $vsWhere -latest -property installationPath -ErrorAction SilentlyContinue
        if ($vsPath) {
            Write-Info "Visual Studio already installed at: $vsPath"
        }
    } else {
        Write-Info "Installing Visual Studio Build Tools 2022..."
        $vsdownloadUrl = "https://aka.ms/vs/17/release/vs_buildtools.exe"
        $vsInstaller = "C:\Temp\vs_buildtools.exe"
        Invoke-WebRequest -Uri $vsdownloadUrl -OutFile $vsInstaller -UseBasicParsing
        Start-Process -FilePath $vsInstaller -ArgumentList "--add", "Microsoft.VisualStudio.Workload.VCTools", "--add", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "--add", "Microsoft.VisualStudio.Component.Windows11SDK.22621", "--add", "Microsoft.VisualStudio.Component.VC.CMake.Project", "--includeRecommended", "--quiet", "--wait" -Wait -NoNewWindow
        Remove-Item $vsInstaller -Force -ErrorAction SilentlyContinue
        Write-OK "Visual Studio Build Tools installed"
    }
} else {
    Write-Info "Skipping Visual Studio installation"
}

# ── 安装 CMake ────────────────────────────────────────────────────────────────
Write-Step "Installing CMake"
$cmake = Get-Command cmake -ErrorAction SilentlyContinue
if ($cmake) {
    $cmakeVer = & cmake --version 2>&1 | Select-Object -First 1
    Write-Info "CMake already installed: $cmakeVer"
} else {
    Write-Info "Installing CMake..."
    choco install cmake -y --no-progress --limit-output
    refreshenv
    Write-OK "CMake installed"
}

# ── 安装 7-Zip ────────────────────────────────────────────────────────────────
Write-Step "Installing 7-Zip"
$7z = Get-Command 7z -ErrorAction SilentlyContinue
if ($7z) {
    Write-Info "7-Zip already installed"
} else {
    choco install 7zip -y --no-progress --limit-output
    Write-OK "7-Zip installed"
}

# ── 安装 .NET SDK ─────────────────────────────────────────────────────────────
Write-Step "Installing .NET SDK"
$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if ($dotnet) {
    $dotnetVer = & dotnet --version 2>&1
    Write-Info ".NET SDK already installed: $dotnetVer"
} else {
    Write-Info "Installing .NET SDK..."
    choco install dotnet-sdk -y --no-progress --limit-output
    refreshenv
    Write-OK ".NET SDK installed"
}

# ── 验证安装 ─────────────────────────────────────────────────────────────────
Write-Step "Verifying installations"
$tools = @(
    @{Name="Git"; Cmd="git --version"},
    @{Name="Python"; Cmd="python --version"},
    @{Name="Node.js"; Cmd="node --version"},
    @{Name="Go"; Cmd="go version"},
    @{Name="CMake"; Cmd="cmake --version"},
    @{Name=".NET"; Cmd="dotnet --version"}
)

Write-Host ""
foreach ($tool in $tools) {
    try {
        $ver = Invoke-Expression $tool.Cmd 2>&1 | Select-Object -First 1
        Write-OK "$($tool.Name): $ver"
    } catch {
        Write-Warn "$($tool.Name): Not found or error"
    }
}

# ── 更新 PATH ─────────────────────────────────────────────────────────────────
Write-Step "Updating system PATH"
$machinePath = [System.Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
$currentPath = $env:Path
$newPath = "$userPath;$machinePath;$currentPath"
$env:Path = $newPath
Write-Info "PATH updated with new installations"

# ── 完成 ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "======================================" -ForegroundColor Magenta
Write-OK "Environment setup completed!"
Write-Info "Please restart your terminal for PATH changes to take effect"
Write-Info "Then run install_horde_agent.ps1 to install Horde Agent"
Write-Host ""
