<#
.SYNOPSIS
    All-in-one Bracer Chat deployment: register, install, update, and repair.

.DESCRIPTION
    Single script for all Bracer Chat deployment scenarios via SuperOps RMM:

    1. NEW MACHINE: Registers with Bracer Chat API, creates RC user + rooms,
       writes DPAPI-encrypted session.dat, downloads and installs the app.
    2. EXISTING + OUTDATED: Checks installed version against server. If only
       the asar changed, does a fast asar-only update with SHA-256 verification.
       If native modules are missing (app.asar.unpacked), does a full reinstall.
    3. EXISTING + CURRENT: Exits cleanly (safe to run on a schedule).
    4. BROKEN SESSION: Detects invalid/expired RC credentials and re-registers.

    Idempotent and safe to run repeatedly. 5-minute cooldown prevents SuperOps
    queue storms when assets reconnect after being offline.

    SuperOps runtime variables required (injected into global scope by policy):
        $CompanyName             - client company name
        $OpServiceAccountToken   - 1Password service account token (masked policy variable)
                                   1Password item: chat-bracer-ca > Service Account Auth Token: chat-bracer-ca-superops
        $OverrideCooldown        - (optional) Set to 1 to bypass cooldown guard

.NOTES
    Version:        1.0
    Author:         Bracer Systems Inc.
    Creation Date:  2026-04-03
    Purpose:        Unified deployment replacing BracerChatRegister.ps1 + BracerChatUpdateAsar.ps1
#>

#Requires -Version 5.1

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$SessionDatPath  = 'C:\ProgramData\BracerChat\session.dat'
$VersionUrl      = 'https://chat.bracer.ca/install/latest.txt'
$InstallerUrl    = 'https://chat.bracer.ca/install/BracerChat-Setup-latest.exe'
$ElectronVerUrl  = 'https://chat.bracer.ca/install/electron-version.txt'
$ElectronVerFile = 'C:\Program Files\Bracer Chat\resources\electron-version.txt'
$AsarUrl         = 'https://chat.bracer.ca/install/app-latest.asar'
$HashUrl         = 'https://chat.bracer.ca/install/app-latest.asar.sha256'
$AsarDest        = 'C:\Program Files\Bracer Chat\resources\app.asar'
$UnpackedDir     = 'C:\Program Files\Bracer Chat\resources\app.asar.unpacked'
$AppExe          = 'C:\Program Files\Bracer Chat\Bracer Chat.exe'
$RegistrationUrl = 'https://chat.bracer.ca/api/register'
$ValidationUrl   = 'https://chat.bracer.ca/api/v1/me'
$MaxRetries      = 3
$LockFile        = 'C:\ProgramData\BracerChat\update-lastrun.txt'
$CooldownSeconds = 300
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
# 1Password CLI bootstrap
# ---------------------------------------------------------------------------
function Install-OpCli {
    if (Test-Path $OpExePath) { return }
    $ZipPath = Join-Path $OpTempDir 'op.zip'
    try {
        New-Item -Path $OpTempDir -ItemType Directory -Force | Out-Null
        Log-Message "Downloading 1Password CLI..."
        Invoke-WebRequest -Uri $OpCliUrl -OutFile $ZipPath -UseBasicParsing -ErrorAction Stop
        $ExpectedHash = '7834D9A381379E7D6A7F47A860F4782D22701A5FEF3E48414C72DA277DC8F501'
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
# Session validation — decrypt session.dat and check if RC token is valid
# Returns: $null (no session / invalid), or the session object
# ---------------------------------------------------------------------------
function Get-ValidSession {
    if (-not (Test-Path -Path $SessionDatPath)) {
        Log-Message "No session.dat found."
        return $null
    }

    # Decrypt
    try {
        Add-Type -AssemblyName System.Security
        $EncBytes = [System.IO.File]::ReadAllBytes($SessionDatPath)
        $DecBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
            $EncBytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
        $Session = [System.Text.Encoding]::UTF8.GetString($DecBytes) | ConvertFrom-Json
    } catch {
        Log-Message "session.dat decrypt failed: $($_.Exception.Message). Will re-register." -Level 'WARNING'
        return $null
    }

    # Must have RC-format authToken (not just legacy Matrix access_token)
    if ([string]::IsNullOrEmpty($Session.authToken)) {
        Log-Message "session.dat has no authToken (may be legacy Matrix format). Will re-register." -Level 'WARNING'
        return $null
    }

    # Validate token against RC server
    try {
        $Headers = @{
            'X-Auth-Token' = $Session.authToken
            'X-User-Id'    = $Session.userId
        }
        $Response = Invoke-WebRequest -Uri $ValidationUrl -Headers $Headers -UseBasicParsing -ErrorAction Stop
        $Result = $Response.Content | ConvertFrom-Json
        if ($Result.success -eq $true) {
            Log-Message "Session valid (RC user: $($Result.username))."
            return $Session
        }
    } catch {
        Log-Message "RC token validation failed: $($_.Exception.Message). Will re-register." -Level 'WARNING'
    }

    return $null
}

# ---------------------------------------------------------------------------
# Registration — create RC user + rooms, write session.dat
# ---------------------------------------------------------------------------
function Invoke-Registration {
    param(
        [string]$ApiSecret,
        [string]$Company
    )

    Log-Message "Collecting machine info."
    $Hostname = $env:COMPUTERNAME
    $Serial   = (Get-WmiObject -Class Win32_BIOS -ErrorAction Stop).SerialNumber.Trim()
    $WinUser  = (Get-WmiObject -Class Win32_ComputerSystem -ErrorAction Stop).UserName
    if ([string]::IsNullOrEmpty($WinUser)) { $WinUser = 'UNKNOWN' }
    Log-Message "Hostname=${Hostname} | Serial=${Serial} | User=${WinUser}"

    Log-Message "Calling Registration API at ${RegistrationUrl}."
    $Body = @{
        hostname       = $Hostname
        company        = $Company
        elevated       = $false
        logged_in_user = $WinUser
    } | ConvertTo-Json

    $RegParams = @{
        Uri             = $RegistrationUrl
        Method          = 'POST'
        Headers         = @{ 'Authorization' = "Bearer ${ApiSecret}"; 'Content-Type' = 'application/json' }
        Body            = $Body
        UseBasicParsing = $true
        ErrorAction     = 'Stop'
    }
    $Response  = Invoke-WebRequest @RegParams
    $ApiResult = $Response.Content | ConvertFrom-Json
    Log-Message "Registration successful. user_id=$($ApiResult.user_id)"

    # Build and encrypt session.dat
    $SessionData = [ordered]@{
        userId            = $ApiResult.user_id
        authToken         = $ApiResult.auth_token
        elevated          = $ApiResult.elevated
        room_id_machine   = $ApiResult.rooms.machine
        room_id_broadcast = $ApiResult.rooms.broadcast
        room_id_company   = $ApiResult.rooms.company_broadcast
    }

    Add-Type -AssemblyName System.Security
    $Dir = Split-Path -Path $SessionDatPath -Parent
    if (-not (Test-Path -Path $Dir)) {
        New-Item -Path $Dir -ItemType Directory -Force | Out-Null
    }
    $JsonBytes = [System.Text.Encoding]::UTF8.GetBytes(($SessionData | ConvertTo-Json -Compress))
    $Encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
        $JsonBytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )
    if (Test-Path -Path $SessionDatPath) {
        Remove-Item -Path $SessionDatPath -Force -ErrorAction SilentlyContinue
    }
    [System.IO.File]::WriteAllBytes($SessionDatPath, $Encrypted)
    Log-Message "session.dat written (DPAPI encrypted)."
}

# ---------------------------------------------------------------------------
# ACL hardening — C:\ProgramData\BracerChat
# ---------------------------------------------------------------------------
function Set-BracerChatAcl {
    $Dir = Split-Path -Path $SessionDatPath -Parent
    if (-not (Test-Path -Path $Dir)) {
        New-Item -Path $Dir -ItemType Directory -Force | Out-Null
    }
    Log-Message "Applying ACL hardening to ${Dir}."
    try {
        & takeown.exe /F $Dir /R /D Y 2>&1 | Out-Null
        & icacls.exe $Dir /reset /T /Q | Out-Null
        & icacls.exe $Dir /inheritance:r /grant 'BUILTIN\Administrators:(OI)(CI)F' /grant 'NT AUTHORITY\SYSTEM:(OI)(CI)F' /grant 'BUILTIN\Users:(OI)(CI)R' /Q | Out-Null
        & icacls.exe "$Dir\*" /inheritance:r /grant 'BUILTIN\Administrators:F' /grant 'NT AUTHORITY\SYSTEM:F' /grant 'BUILTIN\Users:R' /T /Q | Out-Null
        Log-Message "ACL applied."
    } catch {
        Log-Message "ACL failed (non-fatal): $($_.Exception.Message)" -Level 'WARNING'
    }
}

# ---------------------------------------------------------------------------
# Stale task cleanup + watchdog rebuild
# ---------------------------------------------------------------------------
function Repair-ScheduledTasks {
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

    # Rebuild watchdog with correct settings
    $WatchdogName = 'Bracer Chat Watchdog'
    Unregister-ScheduledTask -TaskName $WatchdogName -Confirm:$false -ErrorAction SilentlyContinue
    $Action    = New-ScheduledTaskAction -Execute "`"$AppExe`"" -Argument '--watchdog'
    $Trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
    $Settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
    $Principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
    Register-ScheduledTask -TaskName $WatchdogName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
    Log-Message "Watchdog task rebuilt."

    # Fix HKLM Run key
    $RunKeyPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run'
    Set-ItemProperty -Path $RunKeyPath -Name 'Bracer Chat' -Value "`"$AppExe`" --startup" -ErrorAction SilentlyContinue
    Log-Message "HKLM Run key updated."
    Log-Message "Stale tasks cleaned up."
}

# ---------------------------------------------------------------------------
# Relaunch app in the logged-in user's session
# ---------------------------------------------------------------------------
function Start-BracerChatAsUser {
    if (-not (Test-Path $AppExe)) {
        Log-Message "App not found - skipping relaunch." -Level 'WARNING'
        return
    }
    if (Get-Process -Name 'Bracer Chat' -ErrorAction SilentlyContinue) {
        Log-Message "Bracer Chat already running - skipping relaunch."
        return
    }

    # Wait for old process to fully exit
    for ($w = 0; $w -lt 15; $w++) {
        if (-not (Get-Process -Name 'Bracer Chat' -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
    }
    Start-Sleep -Seconds 2

    $TaskName = 'BracerChatPostInstallLaunch'
    try {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
        $Action    = New-ScheduledTaskAction -Execute "`"$AppExe`"" -Argument '--startup'
        $Trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(30)
        $Settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero)
        $Principal = New-ScheduledTaskPrincipal -GroupId 'S-1-5-32-545' -RunLevel Limited
        Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Principal $Principal -Settings $Settings -Force | Out-Null
        Log-Message "Relaunch task registered - fires in ~30 s."
    } catch {
        Log-Message "Failed to register relaunch task: $($_.Exception.Message)" -Level 'WARNING'
    }
}

# ---------------------------------------------------------------------------
# Get installed version from asar (returns "0.0.0" if not installed)
# ---------------------------------------------------------------------------
function Get-InstalledVersion {
    if (-not (Test-Path $AsarDest)) { return '0.0.0' }
    try {
        $Bytes = [System.IO.File]::ReadAllBytes($AsarDest)
        $Text  = [System.Text.Encoding]::UTF8.GetString($Bytes)
        if ($Text -match '"version"\s*:\s*"([0-9]+\.[0-9]+\.[0-9]+)"') {
            return $Matches[1]
        }
    } catch { }
    return '0.0.0'
}

# ---------------------------------------------------------------------------
# Download asar with SHA-256 verification + retry
# ---------------------------------------------------------------------------
function Download-VerifiedAsar {
    param([string]$AuthHeader, [string]$DestPath)

    for ($Attempt = 1; $Attempt -le $MaxRetries; $Attempt++) {
        Log-Message "ASAR download attempt $Attempt/$MaxRetries..."

        try {
            $HashResponse = Invoke-WebRequest -Uri $HashUrl -Headers @{ Authorization = $AuthHeader } -UseBasicParsing -ErrorAction Stop
            if ($HashResponse.Content -is [byte[]]) {
                $ExpectedHash = [System.Text.Encoding]::UTF8.GetString($HashResponse.Content).Trim().ToUpper()
            } else {
                $ExpectedHash = $HashResponse.Content.Trim().ToUpper()
            }
            Log-Message "Expected SHA-256: $ExpectedHash"
        } catch {
            Log-Message "Hash download failed: $($_.Exception.Message)" -Level 'WARNING'
            if ($Attempt -lt $MaxRetries) { Start-Sleep -Seconds 5; continue }
            throw "Failed to download SHA-256 hash after $MaxRetries attempts."
        }

        try {
            Invoke-WebRequest -Uri $AsarUrl -Headers @{ Authorization = $AuthHeader } -OutFile $DestPath -UseBasicParsing -ErrorAction Stop
            $SizeMB = [math]::Round((Get-Item $DestPath).Length / 1MB, 1)
            Log-Message "Downloaded $SizeMB MB."
        } catch {
            Remove-Item $DestPath -Force -ErrorAction SilentlyContinue
            Log-Message "ASAR download failed: $($_.Exception.Message)" -Level 'WARNING'
            if ($Attempt -lt $MaxRetries) { Start-Sleep -Seconds 5; continue }
            throw "Failed to download ASAR after $MaxRetries attempts."
        }

        $ActualHash = (Get-FileHash -Path $DestPath -Algorithm SHA256).Hash.ToUpper()
        if ($ActualHash -eq $ExpectedHash) {
            Log-Message "SHA-256 verified OK."
            return
        }

        Log-Message "SHA-256 MISMATCH! Expected $ExpectedHash, got $ActualHash" -Level 'WARNING'
        Remove-Item $DestPath -Force -ErrorAction SilentlyContinue
        if ($Attempt -lt $MaxRetries) { Start-Sleep -Seconds 5 }
    }

    throw "ASAR SHA-256 verification failed after $MaxRetries attempts."
}

# ---------------------------------------------------------------------------
# Full NSIS install (fresh install or repair when unpacked dir missing)
# ---------------------------------------------------------------------------
function Invoke-FullInstall {
    param([string]$AuthHeader)

    $TempExe = Join-Path $env:TEMP 'BracerChatSetup.exe'
    Log-Message "Downloading full installer from $InstallerUrl..."
    try {
        Invoke-WebRequest -Uri $InstallerUrl -Headers @{ Authorization = $AuthHeader } -OutFile $TempExe -UseBasicParsing -ErrorAction Stop
        $SizeMB = [math]::Round((Get-Item $TempExe).Length / 1MB, 1)
        Log-Message "Downloaded installer ($SizeMB MB). Running silent install..."

        Stop-Process -Name 'Bracer Chat' -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2

        $Proc = Start-Process -FilePath $TempExe -ArgumentList '/S' -Wait -PassThru -NoNewWindow -ErrorAction Stop
        Remove-Item $TempExe -Force -ErrorAction SilentlyContinue
        if ($Proc.ExitCode -ne 0) {
            throw "Installer exited with code $($Proc.ExitCode)"
        }
        Log-Message "Full install complete."
    } catch {
        Remove-Item $TempExe -Force -ErrorAction SilentlyContinue
        Log-Message "Full install failed: $($_.Exception.Message)" -Level 'ERROR'
        throw
    }
}

# ---------------------------------------------------------------------------
# ASAR-only update (fast path — replaces just app.asar)
# ---------------------------------------------------------------------------
function Invoke-AsarUpdate {
    param([string]$AuthHeader)

    $TempAsar = Join-Path $env:TEMP 'BracerChatUpdate.asar'
    Download-VerifiedAsar -AuthHeader $AuthHeader -DestPath $TempAsar

    $RunningProc = Get-Process -Name 'Bracer Chat' -ErrorAction SilentlyContinue
    if ($RunningProc) {
        Log-Message "Stopping Bracer Chat before update."
        Stop-Process -Name 'Bracer Chat' -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 3
    }

    Log-Message "Replacing $AsarDest..."
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
}

# ---------------------------------------------------------------------------
# Install or update — decides between full install and asar-only update
# ---------------------------------------------------------------------------
function Install-OrUpdate {
    param([string]$AuthHeader)

    # Fetch server version
    $ServerVersion = $null
    try {
        $VerResponse = Invoke-WebRequest -Uri $VersionUrl -Headers @{ Authorization = $AuthHeader } -UseBasicParsing -ErrorAction Stop
        $ServerVersion = $VerResponse.Content.Trim()
        Log-Message "Server version: ${ServerVersion}"
    } catch {
        Log-Message "Failed to fetch server version: $($_.Exception.Message). Skipping update." -Level 'WARNING'
        return
    }

    # Fetch expected Electron version from server
    $ServerElectron = $null
    try {
        $ElecResponse = Invoke-WebRequest -Uri $ElectronVerUrl -Headers @{ Authorization = $AuthHeader } -UseBasicParsing -ErrorAction Stop
        $ServerElectron = $ElecResponse.Content.Trim()
        Log-Message "Server Electron version: ${ServerElectron}"
    } catch {
        Log-Message "Failed to fetch server Electron version. Will use full install if needed." -Level 'WARNING'
    }

    # Read installed Electron version from local file (deployed by NSIS installer)
    $InstalledElectron = $null
    if (Test-Path $ElectronVerFile) {
        $InstalledElectron = (Get-Content $ElectronVerFile -Raw).Trim()
        Log-Message "Installed Electron version: ${InstalledElectron}"
    }

    $InstalledVersion = Get-InstalledVersion
    $AppInstalled     = Test-Path $AppExe
    $HasUnpacked      = Test-Path $UnpackedDir

    # Case 1: App not installed at all — full install
    if (-not $AppInstalled) {
        Log-Message "Bracer Chat not installed. Running full installer."
        Invoke-FullInstall -AuthHeader $AuthHeader
        return
    }

    # Case 2: Already at server version — skip
    if ($InstalledVersion -eq $ServerVersion) {
        Log-Message "Already at v${InstalledVersion} - no update needed."
        return
    }

    Log-Message "Version: installed v${InstalledVersion}, server v${ServerVersion}."

    # Case 3: Electron version mismatch — full install required
    if ($null -ne $ServerElectron -and $InstalledElectron -ne $ServerElectron) {
        Log-Message "Electron version changed (${InstalledElectron} -> ${ServerElectron}). Full install required."
        Invoke-FullInstall -AuthHeader $AuthHeader
        return
    }

    # Case 4: Native modules missing (app.asar.unpacked) or no version file — full install
    if (-not $HasUnpacked -or $null -eq $InstalledElectron) {
        Log-Message "app.asar.unpacked or electron-version.txt missing. Full install required."
        Invoke-FullInstall -AuthHeader $AuthHeader
        return
    }

    # Case 5: Normal update — asar-only (fast path)
    Log-Message "Electron version matches. Performing asar-only update."
    Invoke-AsarUpdate -AuthHeader $AuthHeader
}

# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------
function Invoke-BracerChatDeploy {
    param(
        [string]$ApiSecret,
        [string]$Company,
        [string]$AuthHeader
    )

    # 1. Check for valid RC session (BEFORE ACL hardening — icacls can disrupt DPAPI reads)
    $Session = Get-ValidSession

    # 2. ACL hardening
    Set-BracerChatAcl

    # 3. Register if no valid session
    if ($null -eq $Session) {
        Log-Message "No valid RC session. Registering machine."
        Invoke-Registration -ApiSecret $ApiSecret -Company $Company
    } else {
        Log-Message "Valid session found. Skipping registration."
    }

    # 4. Install or update the app
    Install-OrUpdate -AuthHeader $AuthHeader

    # 5. Clean up stale tasks, rebuild watchdog
    Repair-ScheduledTasks

    # 6. Relaunch
    Start-BracerChatAsUser
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if ($null -eq $Global:DefaultLogFile) {
    $LogDir = 'C:\BracerTools\Logs'
    if (-not (Test-Path $LogDir)) { New-Item -Path $LogDir -ItemType Directory -Force | Out-Null }
    $Global:DefaultLogFile = "${LogDir}\BracerChatDeploy_$(Get-Date -Format 'yyyyMMddHHmmss').log"
}

Log-Message "=== Bracer Chat Deploy Script v1.0 started ==="

# Cooldown guard
if ($OverrideCooldown -eq 1) {
    Log-Message "Cooldown override enabled."
} elseif (Test-Path $LockFile) {
    try {
        $LastRun = [datetime]::Parse((Get-Content $LockFile -Raw).Trim())
        $Elapsed = ((Get-Date) - $LastRun).TotalSeconds
        if ($Elapsed -lt $CooldownSeconds) {
            Log-Message ("Cooldown active (" + [math]::Round($Elapsed) + "s / ${CooldownSeconds}s). Exiting.")
            exit 0
        }
    } catch { }
}
$LockDir = Split-Path $LockFile -Parent
if (-not (Test-Path $LockDir)) { New-Item -Path $LockDir -ItemType Directory -Force | Out-Null }
Set-Content -Path $LockFile -Value (Get-Date -Format 'o') -Force

# Validate required variables
if ([string]::IsNullOrEmpty($OpServiceAccountToken)) {
    Log-Message 'CRITICAL: $OpServiceAccountToken is missing.' -Level 'ERROR'
    exit 1
}
if ([string]::IsNullOrEmpty($CompanyName)) {
    Log-Message 'CRITICAL: $CompanyName is missing.' -Level 'ERROR'
    exit 1
}

try {
    Install-OpCli
    Log-Message "Reading secrets from 1Password..."
    $ApiSecret         = Read-OpSecret 'op://chat-bracer-ca/bracer-register API secret/password'
    $BracerInstallAuth = Read-OpSecret 'op://chat-bracer-ca/bracer-install Basic Auth/password'
    $AuthHeader        = 'Basic ' + [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("bracer-install:${BracerInstallAuth}"))
    Log-Message "Secrets loaded."

    Invoke-BracerChatDeploy -ApiSecret $ApiSecret -Company $CompanyName -AuthHeader $AuthHeader
    Log-Message "=== Bracer Chat Deploy completed successfully ==="
    exit 0
} catch {
    Log-Message "=== Script failed: $($_.Exception.Message) ===" -Level 'ERROR'
    exit 1
} finally {
    Remove-OpCli
}
