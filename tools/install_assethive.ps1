$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "blackbladestudio/AssetHive"
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"
$tempDir = Join-Path $env:LOCALAPPDATA "Temp\AssetHive"
$msiPath = Join-Path $tempDir "AssetHive-Windows.msi"
$checksumPath = "$msiPath.sha256"
$headers = @{
  "User-Agent" = "BlackBlade-Hub"
  "Accept" = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

function Write-Step([string]$message) {
  Write-Host "[ASSETHIVE] $message"
}

function Assert-TrustedReleaseUrl([string]$url) {
  $uri = [Uri]$url
  $prefix = "/$repo/releases/download/"
  if ($uri.Scheme -ne "https" -or $uri.Host -ne "github.com" -or -not $uri.AbsolutePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Untrusted AssetHive release URL: $url"
  }
}

try {
  Write-Step "release: querying latest stable release"
  $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers -UseBasicParsing
  if ($release.draft -or $release.prerelease) {
    throw "Latest AssetHive release is not stable"
  }

  $version = ([string]$release.tag_name).Trim() -replace "^[vV]", ""
  if ($version -notmatch "^\d+\.\d+\.\d+$") {
    throw "Invalid AssetHive release tag: $($release.tag_name)"
  }

  $msiName = "AssetHive-$version-Windows.msi"
  $checksumName = "$msiName.sha256"
  $msiAssets = @($release.assets | Where-Object { $_.name -ceq $msiName })
  $checksumAssets = @($release.assets | Where-Object { $_.name -ceq $checksumName })
  if ($msiAssets.Count -ne 1 -or $checksumAssets.Count -ne 1) {
    throw "Release must contain one exact $msiName / $checksumName pair"
  }

  $msiUrl = [string]$msiAssets[0].browser_download_url
  $checksumUrl = [string]$checksumAssets[0].browser_download_url
  Assert-TrustedReleaseUrl $msiUrl
  Assert-TrustedReleaseUrl $checksumUrl

  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  Remove-Item -LiteralPath $msiPath, $checksumPath -Force -ErrorAction SilentlyContinue

  Write-Step "download: checksum"
  Invoke-WebRequest -Uri $checksumUrl -Headers $headers -OutFile $checksumPath -UseBasicParsing
  Write-Step "download: installer $msiName"
  Invoke-WebRequest -Uri $msiUrl -Headers $headers -OutFile $msiPath -UseBasicParsing

  $checksumText = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
  $escapedName = [Regex]::Escape($msiName)
  $match = [Regex]::Match($checksumText, "^([a-fA-F0-9]{64})\s+\*?$escapedName$")
  if (-not $match.Success) {
    throw "Invalid checksum file format"
  }
  $expectedHash = $match.Groups[1].Value.ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $msiPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
    throw "Installer SHA-256 verification failed"
  }
  Write-Step "verified: SHA-256 $actualHash"

  Write-Step "install: starting Windows Installer"
  $process = Start-Process -FilePath "msiexec.exe" `
    -ArgumentList "/i `"$msiPath`" /passive /norestart" `
    -Wait -PassThru

  if ($process.ExitCode -eq 0) {
    Write-Step "success: AssetHive $version installed"
  } elseif ($process.ExitCode -eq 3010) {
    Write-Step "restart-required: AssetHive $version installed"
  } else {
    throw "Windows Installer exited with code $($process.ExitCode)"
  }
  exit 0
} catch {
  Remove-Item -LiteralPath $msiPath -Force -ErrorAction SilentlyContinue
  Write-Error "[ASSETHIVE] error: $($_.Exception.Message)"
  exit 1
}
