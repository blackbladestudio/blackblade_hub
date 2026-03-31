$src = "d:\workspace\blackblade-utility\studio_hub\dist\win-unpacked"
$tmp = "$env:TEMP\studiohub_pack"
$zip = "d:\workspace\blackblade-utility\studio_hub\dist\StudioHub-1.0.0-win64-portable.zip"

if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Copy-Item $src $tmp -Recurse -Force

Compress-Archive -Path "$tmp\*" -DestinationPath $zip -Force
$size = (Get-Item $zip).Length
Write-Host "Done, size=$size"

Remove-Item $tmp -Recurse -Force
