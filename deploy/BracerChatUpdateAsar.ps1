<#
.SYNOPSIS
    Pushes the latest Bracer Chat app.asar to this machine via SuperOps RMM.

.DESCRIPTION
    Checks if the installed version matches the server version. If already
    up-to-date, exits immediately (safe to run on a schedule).

    Downloads app.asar (~22 MB) and verifies its SHA-256 checksum against
    the server-published hash. Retries up to 3 times on hash mismatch.
    Stops the running app, replaces the asar, then relaunches in the
    logged-in user's interactive session via a one-shot scheduled task.

    If the app is not yet installed, falls back automatically to the full NSIS
    installer (~83 MB) so this script is safe to run on any machine regardless
    of state.

    SuperOps runtime variables required:
        $OpServiceAccountToken   - 1Password service account token (masked policy variable)
                                   1Password item: chat-bracer-ca > Service Account Auth Token: chat-bracer-ca-superops
        $OverrideCooldown        - Set to 1 to bypass the 5-minute cooldown guard (default: 0)

.NOTES
    Version:        2.0
    Author:         Bracer Systems Inc.
    Creation Date:  2026-03-24
    Updated:        2026-03-30 — Removed in-app self-updater, added version
                    skip and SHA-256 verification with retry.
#>

#Requires -Version 5.1

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$AsarUrl         = 'https://chat.bracer.ca/install/app-latest.asar'
$HashUrl         = 'https://chat.bracer.ca/install/app-latest.asar.sha256'
$VersionUrl      = 'https://chat.bracer.ca/install/latest.txt'
$AsarDest        = 'C:\Program Files\Bracer Chat\resources\app.asar'
$AppExe          = 'C:\Program Files\Bracer Chat\Bracer Chat.exe'
$InstallerUrl    = 'https://chat.bracer.ca/install/BracerChat-Setup-latest.exe'
$MaxRetries      = 3
$OpTempDir       = Join-Path $env:TEMP 'bracer-op'
$OpExePath       = Join-Path $OpTempDir 'op.exe'
$OpCliUrl        = 'https://cache.agilebits.com/dist/1P/op2/pkg/v2.33.0/op_windows_amd64_v2.33.0.zip'

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
function Log-Message {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARNING', 'ERROR')]
        [string]$Level = 'INFO',
        [string]$LogFile = $Global:DefaultLogFile
    )
    $Timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $FormattedMessage = "${Timestamp} - ${Level} - ${Message}"
    switch ($Level) {
        'INFO'    { Write-Host $FormattedMessage }
        'WARNING' { Write-Warning $FormattedMessage }
        'ERROR'   { Write-Host "ERROR: ${FormattedMessage}" -ForegroundColor Red }
    }
    if (-not [string]::IsNullOrEmpty($LogFile)) {
        try { Out-File -FilePath $LogFile -InputObject $FormattedMessage -Append -ErrorAction Stop }
        catch { Write-Warning "Failed to write to log: $($_.Exception.Message)" }
    }
}

# ---------------------------------------------------------------------------
# 1Password CLI bootstrap (same pattern as BracerChatRegister.ps1)
# ---------------------------------------------------------------------------
function Install-OpCli {
    if (Test-Path $OpExePath) { return }
    $ZipPath = Join-Path $OpTempDir 'op.zip'
    try {
        New-Item -Path $OpTempDir -ItemType Directory -Force | Out-Null
        Log-Message "Downloading 1Password CLI..."
        Invoke-WebRequest -Uri $OpCliUrl -OutFile $ZipPath -UseBasicParsing -ErrorAction Stop
        # L3: Verify SHA256 hash of downloaded 1Password CLI binary
        $ExpectedHash = 'B98A98098F49FCBBA75D0FF5E13D582688BA6E28BF7BB4FEFA11D3B226E5C893'
        $ActualHash   = (Get-FileHash -Path $ZipPath -Algorithm SHA256).Hash
        if ($ActualHash -ne $ExpectedHash) {
            Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
            throw "1Password CLI hash mismatch! Expected $ExpectedHash, got $ActualHash"
        }
        Expand-Archive -Path $ZipPath -DestinationPath $OpTempDir -Force -ErrorAction Stop
        Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
        Log-Message "1Password CLI ready (hash verified)."
    } catch {
        Log-Message "Failed to download 1Password CLI: $($_.Exception.Message)" -Level 'ERROR'
        throw
    }
}

function Read-OpSecret {
    param([string]$Reference)
    $env:OP_SERVICE_ACCOUNT_TOKEN = $OpServiceAccountToken
    $Value = & $OpExePath read $Reference 2>$null
    if ([string]::IsNullOrEmpty($Value)) { throw "1Password read returned empty for: $Reference" }
    return $Value
}

function Remove-OpCli {
    $env:OP_SERVICE_ACCOUNT_TOKEN = $null
    [System.Environment]::SetEnvironmentVariable('OP_SERVICE_ACCOUNT_TOKEN', $null, 'Process')
    if (Test-Path $OpTempDir) {
        Remove-Item $OpTempDir -Recurse -Force -ErrorAction SilentlyContinue
        Log-Message "1Password CLI removed."
    }
}

# ---------------------------------------------------------------------------
# Remove any stale BracerChat scheduled tasks and leftover temp files.
# ---------------------------------------------------------------------------
function Remove-StaleTasks {
    $StaleTasks = @(
        'BracerChatAsarRelaunch',
        'BracerChatAsarUpdate',
        'BracerChatRelaunch',
        'BracerChatRelaunchAsar',
        'BracerChatUpdate',
        'BracerChatUpdateAsar',
        'BracerChatPostInstallLaunch'
    )
    foreach ($TaskName in $StaleTasks) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    }
    $StaleTempFiles = @(
        (Join-Path $env:TEMP 'BracerChatUpdate.exe'),
        (Join-Path $env:TEMP 'BracerChatUpdate.asar'),
        (Join-Path $env:TEMP 'BracerChatUpdate.ps1')
    )
    foreach ($f in $StaleTempFiles) {
        Remove-Item $f -Force -ErrorAction SilentlyContinue
    }

    # Always rebuild the watchdog task to ensure ExecutionTimeLimit is zero.
    # Previous versions created it with (New-TimeSpan -Minutes 2) which caused
    # Task Scheduler to kill the app 2 minutes after every launch.
    $WatchdogName = 'Bracer Chat Watchdog'
    Unregister-ScheduledTask -TaskName $WatchdogName -Confirm:$false -ErrorAction SilentlyContinue
    $Action    = New-ScheduledTaskAction -Execute "`"${AppExe}`"" -Argument '--watchdog'
    $Trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
    $Settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    $Principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
    Register-ScheduledTask -TaskName $WatchdogName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
    Log-Message "Watchdog task rebuilt with --watchdog flag and no execution time limit."

    # Fix HKLM Run key to include --startup so the app starts hidden on boot.
    # Older installs wrote the key without this flag, causing the window to show on login.
    $RunKeyPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    $RunKeyValue = "`"${AppExe}`" --startup"
    Set-ItemProperty -Path $RunKeyPath -Name 'Bracer Chat' -Value $RunKeyValue -ErrorAction SilentlyContinue
    Log-Message "HKLM Run key updated with --startup flag."

    Log-Message "Stale tasks and temp files cleaned up."
}

# ---------------------------------------------------------------------------
# Relaunch app in the logged-in user's interactive session via scheduled task.
# GroupId BUILTIN\Users fires in the interactive session without needing the
# exact username — more robust than WMI username lookup.
# ---------------------------------------------------------------------------
function Start-BracerChatAsUser {
    if (-not (Test-Path $AppExe)) {
        Log-Message "App not found at ${AppExe} - skipping relaunch." -Level 'WARNING'
        return
    }
    $TaskName = 'BracerChatAsarRelaunch'
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        $Action    = New-ScheduledTaskAction -Execute "`"${AppExe}`"" -Argument '--startup'
        $Trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(10)
        $Settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
        $Principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
        Log-Message "Relaunch task registered - fires in ~10 s for all logged-in users."
    } catch {
        Log-Message "Failed to register relaunch task: $($_.Exception.Message)" -Level 'WARNING'
    }
}

# ---------------------------------------------------------------------------
# Full installer fallback (used when app is not yet installed)
# ---------------------------------------------------------------------------
function Invoke-FullInstall {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AuthHeader
    )

    $TempExe = Join-Path $env:TEMP 'BracerChatSetup.exe'
    Log-Message "App not installed. Falling back to full installer from ${InstallerUrl}..."
    try {
        Invoke-WebRequest -Uri $InstallerUrl -Headers @{ Authorization = $AuthHeader } -OutFile $TempExe -UseBasicParsing -ErrorAction Stop
        $SizeMB = [math]::Round((Get-Item $TempExe).Length / 1MB, 1)
        Log-Message "Downloaded installer (${SizeMB} MB). Running silent install..."
        $Proc = Start-Process -FilePath $TempExe -ArgumentList '/S' -Wait -PassThru -NoNewWindow -ErrorAction Stop
        Remove-Item $TempExe -Force -ErrorAction SilentlyContinue
        if ($Proc.ExitCode -ne 0) {
            throw "Installer exited with code $($Proc.ExitCode)"
        }
        Log-Message "Full install complete."
        Start-BracerChatAsUser
    } catch {
        Remove-Item $TempExe -Force -ErrorAction SilentlyContinue
        Log-Message "Full install failed: $($_.Exception.Message)" -Level 'ERROR'
        throw
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Version check — get installed version from the app's package.json inside asar.
# Returns "0.0.0" if the app isn't installed or version can't be read.
# ---------------------------------------------------------------------------
function Get-InstalledVersion {
    $PackageJson = 'C:\Program Files\Bracer Chat\resources\app.asar'
    if (-not (Test-Path $PackageJson)) { return '0.0.0' }
    # app.asar is an archive but package.json is at the start — read first 4KB
    try {
        $Bytes = [System.IO.File]::ReadAllBytes($PackageJson)
        $Text  = [System.Text.Encoding]::UTF8.GetString($Bytes)
        if ($Text -match '"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+)"') {
            return $Matches[1]
        }
    } catch { }
    return '0.0.0'
}

function Get-ServerVersion {
    param([string]$AuthHeader)
    try {
        $Response = Invoke-WebRequest -Uri $VersionUrl -Headers @{ Authorization = $AuthHeader } -UseBasicParsing -ErrorAction Stop
        return $Response.Content.Trim()
    } catch {
        Log-Message "Failed to fetch server version: $($_.Exception.Message)" -Level 'WARNING'
        return $null
    }
}

# ---------------------------------------------------------------------------
# Download asar with SHA-256 verification. Retries up to $MaxRetries times
# on hash mismatch (re-downloads both file and hash on each retry).
# ---------------------------------------------------------------------------
function Download-VerifiedAsar {
    param([string]$AuthHeader, [string]$DestPath)

    for ($Attempt = 1; $Attempt -le $MaxRetries; $Attempt++) {
        Log-Message "Download attempt ${Attempt}/${MaxRetries}..."

        # Download the SHA-256 hash file first
        try {
            $HashResponse = Invoke-WebRequest -Uri $HashUrl -Headers @{ Authorization = $AuthHeader } -UseBasicParsing -ErrorAction Stop
            $ExpectedHash = $HashResponse.Content.Trim().ToUpper()
            Log-Message "Expected SHA-256: ${ExpectedHash}"
        } catch {
            Log-Message "Hash file download failed: $($_.Exception.Message)" -Level 'WARNING'
            if ($Attempt -lt $MaxRetries) { Start-Sleep -Seconds 5; continue }
            throw "Failed to download SHA-256 hash after ${MaxRetries} attempts."
        }

        # Download the asar
        try {
            Invoke-WebRequest -Uri $AsarUrl -Headers @{ Authorization = $AuthHeader } -OutFile $DestPath -UseBasicParsing -ErrorAction Stop
            $SizeMB = [math]::Round((Get-Item $DestPath).Length / 1MB, 1)
            Log-Message "Downloaded ${SizeMB} MB."
        } catch {
            Remove-Item $DestPath -Force -ErrorAction SilentlyContinue
            Log-Message "ASAR download failed: $($_.Exception.Message)" -Level 'WARNING'
            if ($Attempt -lt $MaxRetries) { Start-Sleep -Seconds 5; continue }
            throw "Failed to download ASAR after ${MaxRetries} attempts."
        }

        # Verify SHA-256
        $ActualHash = (Get-FileHash -Path $DestPath -Algorithm SHA256).Hash.ToUpper()
        if ($ActualHash -eq $ExpectedHash) {
            Log-Message "SHA-256 verified OK."
            return
        }

        Log-Message "SHA-256 MISMATCH! Expected ${ExpectedHash}, got ${ActualHash}" -Level 'WARNING'
        Remove-Item $DestPath -Force -ErrorAction SilentlyContinue
        if ($Attempt -lt $MaxRetries) { Start-Sleep -Seconds 5 }
    }

    throw "ASAR SHA-256 verification failed after ${MaxRetries} attempts. Update aborted."
}

function Invoke-AsarUpdate {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AuthHeader
    )

    # Clean up any stale tasks/temp files from previous update attempts
    Remove-StaleTasks

    # If the app isn't installed yet, fall back to the full installer
    if (-not (Test-Path $AppExe)) {
        Invoke-FullInstall -AuthHeader $AuthHeader
        return
    }

    # Check if update is needed — skip if already at server version
    $InstalledVersion = Get-InstalledVersion
    $ServerVersion    = Get-ServerVersion -AuthHeader $AuthHeader
    if ($null -ne $ServerVersion -and $InstalledVersion -eq $ServerVersion) {
        Log-Message "Already at v${InstalledVersion} — no update needed. Exiting."
        return
    }
    Log-Message "Version check: installed v${InstalledVersion}, server v${ServerVersion}. Updating..."

    # Download and verify the asar (retries up to $MaxRetries on hash mismatch)
    $TempAsar = Join-Path $env:TEMP 'BracerChatUpdate.asar'
    Download-VerifiedAsar -AuthHeader $AuthHeader -DestPath $TempAsar

    # Stop running instance so the asar file isn't locked
    $RunningProc = Get-Process -Name 'Bracer Chat' -ErrorAction SilentlyContinue
    if ($RunningProc) {
        Log-Message "Stopping Bracer Chat before update."
        Stop-Process -Name 'Bracer Chat' -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }

    # Replace asar with retry loop (file may still be releasing)
    Log-Message "Replacing ${AsarDest}..."
    $Replaced = $false
    for ($i = 0; $i -lt 10; $i++) {
        try {
            Copy-Item -Path $TempAsar -Destination $AsarDest -Force -ErrorAction Stop
            $Replaced = $true
            break
        } catch {
            Log-Message "Replace attempt $($i+1) failed: $($_.Exception.Message). Retrying..." -Level 'WARNING'
            Start-Sleep -Seconds 2
        }
    }

    Remove-Item $TempAsar -Force -ErrorAction SilentlyContinue

    if (-not $Replaced) {
        throw "Failed to replace app.asar after 10 attempts."
    }

    Log-Message "app.asar replaced successfully (v${InstalledVersion} -> v${ServerVersion})."

    # Grant BUILTIN\Users modify rights on ProgramData\BracerChat so the app
    # can write window-prefs.json, update logs, etc. without elevation.
    $DataDir = 'C:\ProgramData\BracerChat'
    if (-not (Test-Path $DataDir)) { New-Item -Path $DataDir -ItemType Directory -Force | Out-Null }
    try {
        icacls $DataDir /grant '*S-1-5-32-545:(OI)(CI)(M)' /Q | Out-Null
        Log-Message "Granted Users modify rights on $DataDir."
    } catch {
        Log-Message "icacls on data dir failed (non-fatal): $($_.Exception.Message)" -Level 'WARNING'
    }

    # Fix MediaCache ACLs — early installs may have created this dir with Users:(R) only.
    $CacheDir = 'C:\ProgramData\BracerChat\MediaCache'
    if (Test-Path $CacheDir) {
        try {
            icacls $CacheDir /grant '*S-1-5-32-545:(OI)(CI)(M)' /Q | Out-Null
            Log-Message "Granted Users modify rights on $CacheDir."
        } catch {
            Log-Message "icacls on MediaCache failed (non-fatal): $($_.Exception.Message)" -Level 'WARNING'
        }
    }

    Start-BracerChatAsUser
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if ($null -eq $Global:DefaultLogFile) {
    $LogDir = 'C:\BracerTools\Logs'
    if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }
    $Global:DefaultLogFile = "${LogDir}\BracerChatUpdateAsar_$(Get-Date -Format 'yyyyMMddHHmmss').log"
}

Log-Message "=== Bracer Chat Update Script started (ASAR with full-install fallback) ==="

# ---------------------------------------------------------------------------
# Duplicate execution guard — skip if another instance ran within 5 minutes.
# SuperOps queues scripts while assets are offline and fires them all at once
# on reconnect, which can cause 10+ simultaneous copies of this script.
# ---------------------------------------------------------------------------
$LockFile = 'C:\ProgramData\BracerChat\update-lastrun.txt'
$CooldownSeconds = 300  # 5 minutes
if ($OverrideCooldown -eq 1) {
    Log-Message "Cooldown override enabled — skipping duplicate execution check."
} elseif (Test-Path $LockFile) {
    try {
        $LastRun = [datetime]::Parse((Get-Content $LockFile -Raw).Trim())
        $Elapsed = ((Get-Date) - $LastRun).TotalSeconds
        if ($Elapsed -lt $CooldownSeconds) {
            Log-Message "Another instance ran $([math]::Round($Elapsed))s ago (cooldown ${CooldownSeconds}s). Exiting."
            exit 0
        }
    } catch {
        # Corrupt lockfile — ignore and proceed
    }
}
# Write lockfile immediately so concurrent instances see it
$LockDir = Split-Path $LockFile -Parent
if (-not (Test-Path $LockDir)) { New-Item -Path $LockDir -ItemType Directory -Force | Out-Null }
Set-Content -Path $LockFile -Value (Get-Date -Format 'o') -Force

if ([string]::IsNullOrEmpty($OpServiceAccountToken)) {
    Log-Message 'CRITICAL: $OpServiceAccountToken is missing.' -Level 'ERROR'
    exit 1
}

try {
    Install-OpCli
    Log-Message "Reading credentials from 1Password..."
    $InstallAuth   = Read-OpSecret 'op://chat-bracer-ca/bracer-install Basic Auth/password'
    $AuthHeader    = 'Basic ' + [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("bracer-install:${InstallAuth}"))
    Log-Message "Credentials loaded."

    Invoke-AsarUpdate -AuthHeader $AuthHeader
    Log-Message "=== Update completed successfully ==="
    exit 0
} catch {
    Log-Message "=== Script failed: $($_.Exception.Message) ===" -Level 'ERROR'
    exit 1
} finally {
    Remove-OpCli
}
