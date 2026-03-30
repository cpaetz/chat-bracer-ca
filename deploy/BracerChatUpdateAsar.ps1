<#
.SYNOPSIS
    Force-pushes the latest Bracer Chat app.asar to this machine immediately.

.DESCRIPTION
    Downloads only the app.asar file (~22 MB) from the update server and replaces
    it in-place in C:\Program Files\Bracer Chat\resources\.
    Stops the running app, replaces the asar, then relaunches it in the
    logged-in user's interactive session via a one-shot scheduled task.

    If the app is not yet installed, falls back automatically to the full NSIS
    installer (~83 MB) so this script is safe to run on any machine regardless
    of state.

    Use this script for emergency or manual rollouts when you don't want to
    wait for the in-app auto-update (which has up to 4-hour jitter).

    SuperOps runtime variables required:
        $OpServiceAccountToken   - 1Password service account token (masked policy variable)
                                   1Password item: chat-bracer-ca > Service Account Auth Token: chat-bracer-ca-superops

.NOTES
    Version:        1.0
    Author:         Bracer Systems Inc.
    Creation Date:  2026-03-24
#>

#Requires -Version 5.1

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$AsarUrl         = 'https://chat.bracer.ca/install/app-latest.asar'
$AsarDest        = 'C:\Program Files\Bracer Chat\resources\app.asar'
$AppExe          = 'C:\Program Files\Bracer Chat\Bracer Chat.exe'
$InstallerUrl    = 'https://chat.bracer.ca/install/BracerChat-Setup-latest.exe'
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
        Expand-Archive -Path $ZipPath -DestinationPath $OpTempDir -Force -ErrorAction Stop
        Remove-Item $ZipPath -Force -ErrorAction SilentlyContinue
        Log-Message "1Password CLI ready."
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
        'BracerChatUpdate',
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

    # Stop running instance so the asar file isn't locked
    $RunningProc = Get-Process -Name 'Bracer Chat' -ErrorAction SilentlyContinue
    if ($RunningProc) {
        Log-Message "Stopping Bracer Chat before update."
        Stop-Process -Name 'Bracer Chat' -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }

    # Download asar to temp
    $TempAsar = Join-Path $env:TEMP 'BracerChatUpdate.asar'
    Log-Message "Downloading app.asar from ${AsarUrl}..."
    try {
        Invoke-WebRequest -Uri $AsarUrl -Headers @{ Authorization = $AuthHeader } -OutFile $TempAsar -UseBasicParsing -ErrorAction Stop
        $SizeMB = [math]::Round((Get-Item $TempAsar).Length / 1MB, 1)
        Log-Message "Downloaded ${SizeMB} MB."
    } catch {
        Log-Message "Download failed: $($_.Exception.Message)" -Level 'ERROR'
        throw
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

    Log-Message "app.asar replaced successfully."

    # app.asar is now updated via SYSTEM scheduled task — no Users modify needed.
    # Remove any legacy Users modify ACL on app.asar (security hardening H2).
    try {
        icacls $AsarDest /remove '*S-1-5-32-545' /Q | Out-Null
        Log-Message "Removed Users modify rights on app.asar (SYSTEM task handles updates now)."
    } catch {
        Log-Message "icacls remove on app.asar failed (non-fatal): $($_.Exception.Message)" -Level 'WARNING'
    }

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

    # Create secure staging directory for in-app updates — SYSTEM-only, no user write.
    $UpdateDir = 'C:\ProgramData\BracerChat\updates'
    if (-not (Test-Path $UpdateDir)) { New-Item -Path $UpdateDir -ItemType Directory -Force | Out-Null }
    try {
        icacls $UpdateDir /inheritance:r /grant 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' /Q | Out-Null
        Log-Message "Secure updates directory created at $UpdateDir."
    } catch {
        Log-Message "icacls on updates dir failed (non-fatal): $($_.Exception.Message)" -Level 'WARNING'
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
