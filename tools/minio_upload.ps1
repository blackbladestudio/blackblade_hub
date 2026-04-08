<#
.SYNOPSIS
    Upload game build to MinIO via mc (MinIO Client).
    Handles large files (100G+) with automatic multipart upload, streaming, and retry.
    Designed to be called from Jenkins after a successful build.

.PARAMETER ServerUrl
    MinIO S3 API URL, e.g. http://10.248.15.20:9000
    Default: http://10.248.15.20:9002/

.PARAMETER AccessKey
    MinIO access key (root user or service account)

.PARAMETER SecretKey
    MinIO secret key (root password or service account secret)

.PARAMETER Bucket
    Target bucket name, e.g. builds-client

.PARAMETER LocalPath
    Local path to the build output (file or directory)

.PARAMETER RemotePath
    Destination prefix inside the bucket, e.g. Win64/v0.1.0-CL12345

.PARAMETER Presign
    If set, generates a presigned download URL after upload (valid 7 days)

.EXAMPLE
    .\upload_build.ps1 `
        -AccessKey "minioadmin" -SecretKey "your_password" `
        -Bucket "builds-client" `
        -LocalPath "D:\Builds\Win64\" `
        -RemotePath "Win64/v0.1.0-CL12345" `
        -Presign
#>

param(
    [Parameter(Mandatory=$false)][string] $ServerUrl = "http://10.248.15.20:9000/",
    [Parameter(Mandatory)][string] $AccessKey,
    [Parameter(Mandatory)][string] $SecretKey,
    [Parameter(Mandatory)][string] $Bucket,
    [Parameter(Mandatory)][string] $LocalPath,
    [Parameter(Mandatory)][string] $RemotePath,
    [switch] $Presign
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$ServerUrl = $ServerUrl.TrimEnd('/')
$RemotePath = $RemotePath.TrimStart('/').TrimEnd('/')

$MC_DOWNLOAD_URL = "https://dl.min.io/client/mc/release/windows-amd64/mc.exe"
$ALIAS = "bb"

# ── mc bootstrap ──────────────────────────────────────────────────────────────

function Find-Mc {
    $candidate = Get-Command mc.exe -ErrorAction SilentlyContinue
    if ($candidate) { return $candidate.Source }

    $localMc = Join-Path $PSScriptRoot "mc.exe"
    if (Test-Path $localMc) { return $localMc }

    return $null
}

function Install-Mc {
    $localMc = Join-Path $PSScriptRoot "mc.exe"
    Write-Host "mc.exe not found. Downloading from $MC_DOWNLOAD_URL ..."
    Invoke-WebRequest -Uri $MC_DOWNLOAD_URL -OutFile $localMc -UseBasicParsing
    if (-not (Test-Path $localMc)) {
        Write-Error "Failed to download mc.exe"
    }
    Write-Host "  Saved to: $localMc"
    return $localMc
}

function Invoke-Mc {
    param([string[]]$Args_)
    $output = & $mc @Args_ 2>&1
    if ($LASTEXITCODE -ne 0) {
        $errMsg = ($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
        if (-not $errMsg) { $errMsg = $output -join "`n" }
        throw "mc failed (exit $LASTEXITCODE): $errMsg"
    }
    return $output
}

# ── Main ──────────────────────────────────────────────────────────────────────

Write-Host "=== BlackBlade File Station — MinIO Build Upload ==="
Write-Host "  Server  : $ServerUrl"
Write-Host "  Bucket  : $Bucket"
Write-Host "  Local   : $LocalPath"
Write-Host "  Remote  : $RemotePath/"
Write-Host ""

# 1. Ensure mc is available
$mc = Find-Mc
if (-not $mc) { $mc = Install-Mc }
Write-Host "[1/4] mc: $mc"

# 2. Configure alias
Write-Host "[2/4] Configuring alias..."
Invoke-Mc @("alias", "set", $ALIAS, $ServerUrl, $AccessKey, $SecretKey, "--api", "S3v4") | Out-Null

$cleanup = {
    & $mc alias rm $ALIAS 2>$null | Out-Null
}

try {
    # 3. Ensure bucket exists
    Write-Host "[3/4] Checking bucket: $Bucket"
    $bucketExists = $true
    try {
        Invoke-Mc @("ls", "$ALIAS/$Bucket") | Out-Null
    } catch {
        $bucketExists = $false
    }

    if (-not $bucketExists) {
        Write-Host "  Bucket not found. Creating '$Bucket'..."
        Invoke-Mc @("mb", "$ALIAS/$Bucket")
        Write-Host "  Created."
    }

    # 4. Upload
    Write-Host "[4/4] Uploading..."
    $dest = "$ALIAS/$Bucket/$RemotePath/"

    if (Test-Path $LocalPath -PathType Container) {
        $totalSize = (Get-ChildItem $LocalPath -Recurse -File | Measure-Object -Property Length -Sum).Sum
        $totalFiles = (Get-ChildItem $LocalPath -Recurse -File | Measure-Object).Count
        $sizeGB = [math]::Round($totalSize / 1GB, 2)
        Write-Host "  Source: $totalFiles files, $sizeGB GB total"
        Write-Host "  Dest:   $dest"
        Write-Host ""

        Invoke-Mc @("mirror", "--remove", "$LocalPath", $dest)
    } elseif (Test-Path $LocalPath -PathType Leaf) {
        $fileSize = (Get-Item $LocalPath).Length
        $sizeMB = [math]::Round($fileSize / 1MB, 1)
        Write-Host "  Source: $(Split-Path $LocalPath -Leaf) ($sizeMB MB)"
        Write-Host "  Dest:   $dest"
        Write-Host ""

        Invoke-Mc @("cp", "$LocalPath", $dest)
    } else {
        Write-Error "Local path not found: $LocalPath"
    }

    Write-Host "`nUpload complete."

    # Presigned URL
    if ($Presign) {
        Write-Host "`nGenerating presigned URL (valid 7 days)..."
        try {
            $shareOutput = Invoke-Mc @("share", "download", "--expire=168h", $dest)
            $url = ($shareOutput | Select-String -Pattern 'http\S+' | Select-Object -First 1).Matches[0].Value
            if ($url) {
                Write-Host "  Presigned URL: $url"
                $urlFile = Join-Path (Get-Location) ".download_url"
                $url | Set-Content -Path $urlFile -ErrorAction SilentlyContinue
            }
        } catch {
            Write-Host "  WARNING: Could not generate presigned URL: $_"
        }
    }

} finally {
    & $cleanup
}

Write-Host "`nDone."
