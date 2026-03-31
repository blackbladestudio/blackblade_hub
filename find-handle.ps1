$path = "d:\workspace\blackblade-utility\studio_hub\dist\win-unpacked\resources\app.asar"
$matchingProcesses = @()
Get-Process | ForEach-Object {
    try {
        $handles = $_.Modules | Where-Object { $_.FileName -like "*app.asar*" }
        if ($handles) { $matchingProcesses += $_ }
    } catch {}
}
if ($matchingProcesses.Count -gt 0) {
    $matchingProcesses | ForEach-Object { Write-Host "Killing $($_.ProcessName) (PID=$($_.Id))"; Stop-Process -Id $_.Id -Force }
} else {
    Write-Host "No process found with app.asar handle"
}
$HandlesResult = & handle "$path" 2>$null | Select-Object -First 10
Write-Host $HandlesResult
