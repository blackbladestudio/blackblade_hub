Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [System.IO.Compression.ZipFile]::OpenRead('d:\workspace\blackblade-utility\studio_hub\dist\StudioHub-1.0.0-win64-portable.zip')
$entry = $z.Entries | Where-Object { $_.Name -eq 'app.asar' }
if ($entry) {
    Write-Host "app.asar found in zip, size=$($entry.Length)"
} else {
    Write-Host "app.asar NOT found in zip - archive is incomplete!"
}
$z.Dispose()
