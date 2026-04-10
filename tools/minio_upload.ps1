<#
.SYNOPSIS
    Upload game build to MinIO via mc (MinIO Client).
    Handles large files (100G+) with automatic multipart upload, streaming, and retry.
    Designed to be called from Jenkins after a successful build.

.PARAMETER ServerUrl
    MinIO S3 API URL, e.g. http://10.248.15.20:9000
    Default: http://10.248.15.20:9000/

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
    .\minio_upload.ps1 `
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

# UTF-8 console so mc.exe handles Unicode filenames correctly on CN-Windows
$prevConsoleEncoding = [Console]::OutputEncoding
$prevOutputEncoding  = $OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding  = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
if ($env:OS -like '*Windows*') { chcp 65001 | Out-Null }

$ServerUrl  = $ServerUrl.TrimEnd('/')
$RemotePath = $RemotePath.TrimStart('/').TrimEnd('/')

$MC_DOWNLOAD_URL = "https://dl.min.io/client/mc/release/windows-amd64/mc.exe"
$ALIAS = "bb"
$startTime = Get-Date
$script:uploadOk = $true

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
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $output = & $mc @Args_ 2>&1
    } finally {
        $ErrorActionPreference = $prev
    }
    if ($LASTEXITCODE -ne 0) {
        $errMsg = ($output | Where-Object { $_ -is [System.Management.Automation.ErrorRecord] }) -join "`n"
        if (-not $errMsg) { $errMsg = $output -join "`n" }
        throw "mc failed (exit $LASTEXITCODE): $errMsg"
    }
    return $output
}

# ── Main ──────────────────────────────────────────────────────────────────────

Write-Host "=== BlackBlade File Station - MinIO Build Upload ==="
Write-Host "  Server  : $ServerUrl"
Write-Host "  Bucket  : $Bucket"
Write-Host "  Local   : $LocalPath"
Write-Host "  Remote  : $RemotePath/"
Write-Host ""

# 1. Ensure mc is available
$mc = Find-Mc
if (-not $mc) { $mc = Install-Mc }
Write-Host "[1/4] mc: $mc"

# 2. Configure alias (secrets masked in log)
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
    # IMPORTANT: dest must NOT have a trailing slash -- mc mirror bug in RELEASE.2025-08-13
    # sends an empty object key to MinIO when trailing slashes are present.
    $dest = "$ALIAS/$Bucket/$RemotePath"

    if (Test-Path $LocalPath -PathType Container) {
        $localSrc = $LocalPath.TrimEnd('\')
        $allFiles = @(Get-ChildItem $localSrc -Recurse -File)
        $totalFiles = $allFiles.Count
        $totalSize = ($allFiles | Measure-Object -Property Length -Sum).Sum
        $sizeGB = [math]::Round($totalSize / 1GB, 2)
        Write-Host "  Source: $totalFiles files, $sizeGB GB total"
        Write-Host "  Dest:   $dest/"
        Write-Host ""

        $uploadedCount = 0
        $skippedCount  = 0
        $errorMessages = [System.Collections.Generic.List[string]]::new()

        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            & $mc mirror --overwrite --remove --skip-errors --json "$localSrc" $dest 2>&1 | ForEach-Object {
                $line = $_.ToString()
                if (-not $line.StartsWith('{')) { return }
                try {
                    $entry = $line | ConvertFrom-Json -ErrorAction SilentlyContinue
                    if (-not $entry) { return }

                    if ($entry.status -eq 'success' -and $entry.target) {
                        $uploadedCount++
                        if ($uploadedCount % 2000 -eq 0) {
                            Write-Host "  ... $uploadedCount files uploaded"
                        }
                    } elseif ($entry.status -eq 'error') {
                        $skippedCount++
                        $msg = ""
                        if ($entry.error -and $entry.error.message) { $msg = [string]$entry.error.message }
                        elseif ($entry.error -is [string])           { $msg = $entry.error }
                        $src = if ($entry.source) { $entry.source } else { "" }
                        if ($src -or $msg) {
                            $errorMessages.Add("$src | $msg")
                        }
                    }
                } catch {}
            }
        } finally {
            $ErrorActionPreference = $prevEAP
        }

        Write-Host ""
        Write-Host "  Uploaded : $uploadedCount files"
        if ($skippedCount -gt 0) {
            $script:uploadOk = $false
            Write-Host "  Skipped  : $skippedCount files" -ForegroundColor Yellow
            Write-Host ""
            Write-Host "  --- Errors ---" -ForegroundColor Yellow
            foreach ($e in $errorMessages | Select-Object -First 20) {
                Write-Host "    $e" -ForegroundColor Yellow
            }
            if ($errorMessages.Count -gt 20) {
                Write-Host "    ... and $($errorMessages.Count - 20) more" -ForegroundColor Yellow
            }
        }
        if ($LASTEXITCODE -ne 0 -and $skippedCount -eq 0) {
            $script:uploadOk = $false
            Write-Warning "mc mirror exited with code $LASTEXITCODE."
        }

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
    [Console]::OutputEncoding = $prevConsoleEncoding
    $OutputEncoding = $prevOutputEncoding
}

$elapsed = (Get-Date) - $startTime
$elapsedStr = "{0:hh\:mm\:ss}" -f $elapsed

Write-Host ""
if ($script:uploadOk) {
    Write-Host "Upload completed successfully. (elapsed: $elapsedStr)"
} else {
    Write-Host "Upload completed with warnings -- some files may have been skipped. (elapsed: $elapsedStr)" -ForegroundColor Yellow
    exit 1
}
