param([switch]$DownloadOnly)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = "blackbladestudio/AssetHive"
$apiUrl = "https://api.github.com/repos/$repo/releases/latest"
$tempDir = Join-Path $env:LOCALAPPDATA "Temp\AssetHive"
$installerPath = $null
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

  $exeName = "AssetHive-$version-setup-win64.exe"
  $isInno = @($release.assets | Where-Object { $_.name -ceq $exeName }).Count -gt 0
  $installerName = if ($isInno) { $exeName } else { "AssetHive-$version-Windows.msi" }
  $checksumName = "$installerName.sha256"
  $installerAssets = @($release.assets | Where-Object { $_.name -ceq $installerName })
  $checksumAssets = @($release.assets | Where-Object { $_.name -ceq $checksumName })
  if ($installerAssets.Count -ne 1 -or $checksumAssets.Count -ne 1) {
    throw "Release must contain one exact $installerName / $checksumName pair"
  }

  $installerUrl = [string]$installerAssets[0].browser_download_url
  $checksumUrl = [string]$checksumAssets[0].browser_download_url
  Assert-TrustedReleaseUrl $installerUrl
  Assert-TrustedReleaseUrl $checksumUrl

  New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
  $installerPath = Join-Path $tempDir $installerName
  $checksumPath = "$installerPath.sha256"
  Remove-Item -LiteralPath $installerPath, $checksumPath -Force -ErrorAction SilentlyContinue

  Write-Step "download: checksum"
  Invoke-WebRequest -Uri $checksumUrl -Headers $headers -OutFile $checksumPath -UseBasicParsing
  Write-Step "download: installer $installerName"
  Invoke-WebRequest -Uri $installerUrl -Headers $headers -OutFile $installerPath -UseBasicParsing

  $checksumText = (Get-Content -LiteralPath $checksumPath -Raw).Trim()
  $escapedName = [Regex]::Escape($installerName)
  $match = [Regex]::Match($checksumText, "^([a-fA-F0-9]{64})\s+\*?$escapedName$")
  if (-not $match.Success) {
    throw "Invalid checksum file format"
  }
  $expectedHash = $match.Groups[1].Value.ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
    throw "Installer SHA-256 verification failed"
  }
  Write-Step "verified: SHA-256 $actualHash"

  if ($DownloadOnly) {
    Write-Step "download-only: verified $installerPath"
    exit 0
  }

  if ($isInno) {
    $logPath = Join-Path $tempDir "AssetHive-$version-install.log"
    $arguments = "/VERYSILENT /SUPPRESSMSGBOXES /SP- /NORESTART /RESTARTEXITCODE=3010 /LOG=`"$logPath`""
    $innoKey = "Software\Microsoft\Windows\CurrentVersion\Uninstall\{20B0EE58-5474-4F9F-A0AB-0FE3B39D98B4}_is1"
    $userInstall = Get-ItemProperty "HKCU:\$innoKey" -ErrorAction SilentlyContinue
    $machineInstall = Get-ItemProperty "HKLM:\$innoKey" -ErrorAction SilentlyContinue
    $previous = if ($userInstall) { $userInstall } else { $machineInstall }
    if ($previous -and $previous.DisplayName -match '^AssetHive( \d+\.\d+\.\d+)?$' -and $previous.Publisher -eq "BlackBlade Studio" -and $previous.InstallLocation -match '^[a-zA-Z]:\\' -and $previous.InstallLocation -notmatch '["\r\n]') {
      $mode = if ($userInstall) { "/CURRENTUSER" } else { "/ALLUSERS" }
      $arguments += " $mode /DIR=`"$($previous.InstallLocation)`""
    } else {
      $arguments += " /CURRENTUSER"
    }
    Write-Step "install: starting Inno Setup (log: $logPath)"
    $process = Start-Process -FilePath $installerPath -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  } else {
    Write-Step "install: starting Windows Installer"
    $process = Start-Process -FilePath "msiexec.exe" `
      -ArgumentList "/i `"$installerPath`" /passive /norestart" `
      -WindowStyle Hidden -Wait -PassThru
  }

  if ($process.ExitCode -eq 0) {
    Write-Step "success: AssetHive $version installed"
  } elseif ($process.ExitCode -eq 3010) {
    Write-Step "restart-required: AssetHive $version installed"
  } else {
    throw "AssetHive installer exited with code $($process.ExitCode)"
  }
  exit 0
} catch {
  if ($installerPath) { Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue }
  Write-Error "[ASSETHIVE] error: $($_.Exception.Message)"
  exit 1
}
