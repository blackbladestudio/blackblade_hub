. "$PSScriptRoot\horde_config.ps1"

$AgentWorkDir = "$HORDE_AGENT_ROOT\Agent"

if (-not (Test-Path $AgentWorkDir)) {
    Write-Host "[ERROR] Horde Agent not installed. Please run install_horde_agent.ps1 first." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=== Configuring Horde Agent ===" -ForegroundColor Cyan

pushd $AgentWorkDir

try {
    dotnet HordeAgent.dll SetServer -Name=HordeServer -Url="$HORDE_SERVE_URL" -Token="$HORDE_SERVER_TOKEN" -Default
    Write-Host "✅ Horde Agent configured successfully" -ForegroundColor Green
    Write-Host "   Server: $HORDE_SERVE_URL" -ForegroundColor Gray
} catch {
    Write-Host "❌ Configuration failed: $_" -ForegroundColor Red
} finally {
    popd
}
