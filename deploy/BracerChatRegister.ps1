<#
.SYNOPSIS
    Registers this machine with Bracer Chat and installs or updates the Bracer Chat app.

.DESCRIPTION
    Called from a SuperOps policy. Collects machine info, calls the Bracer Chat Registration API,
    DPAPI-encrypts the session credentials (LocalMachine scope), writes them to
    C:\ProgramData\BracerChat\session.dat, then downloads and silently installs the
    Bracer Chat Electron app.

    Idempotent: if session.dat already exists and contains a valid access_token, registration
    is skipped and the script proceeds directly to ACL hardening and install/update.

    Update logic: if the app is already installed at the expected version, install is skipped.
    If a different version is installed, the new installer runs (NSIS handles upgrade).

    SuperOps runtime variables required (injected into global scope by policy):
        $CompanyName         - client company name
        $BracerChatApiSecret - shared API secret (masked policy variable)

.NOTES
    Version:        1.1
    Author:         Bracer Systems Inc.
    Creation Date:  2026-03-21
    Updated:        2026-03-22
    Purpose:        Bracer Chat - Phase 6 Deployment Script (install/update + ACL hardening)
#>

#Requires -Version 5.1

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$SessionDatPath  = 'C:\ProgramData\BracerChat\session.dat'
$InstallerUrl    = 'https://chat.bracer.ca/install/BracerChat-Setup-1.0.1.exe'
$InstallerPath   = 'C:\BracerTools\Temp\BracerChatSetup.exe'
$RegistrationUrl = 'https://chat.bracer.ca/api/register'
$ExpectedVersion = '1.0.1'
# Basic Auth for /install/* (bracer-install account — hardcoded per design)
$InstallerAuthHeader = 'Basic YnJhY2VyLWluc3RhbGw6S3g3ZkdKRGdCbVpicWxvNDZWN0tOVGdTOXZZ'

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
function Log-Message {
    param(
        [string]$Message,
        [ValidateSet('INFO', 'WARNING', 'ERROR', 'DEBUG')]
        [string]$Level = 'INFO',
        [string]$LogFile = $Global:DefaultLogFile
    )
    $Timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $FormattedMessage = "${Timestamp} - ${Level} - ${Message}"

    switch ($Level) {
        'INFO'    { Write-Host $FormattedMessage }
        'WARNING' { Write-Warning $FormattedMessage }
        'ERROR'   { Write-Host "ERROR: ${FormattedMessage}" -ForegroundColor Red }
        'DEBUG'   { Write-Debug $FormattedMessage }
    }

    if (-not [string]::IsNullOrEmpty($LogFile)) {
        try {
            Out-File -FilePath $LogFile -InputObject $FormattedMessage -Append -ErrorAction Stop
        } catch {
            Write-Warning "Failed to write to log file ${LogFile}: $($_.Exception.Message)"
        }
    }
}

# ---------------------------------------------------------------------------
# Get the installed Bracer Chat version from the registry (null if not installed)
# ---------------------------------------------------------------------------
function Get-InstalledVersion {
    $RegPaths = @(
        'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Bracer Chat',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Bracer Chat'
    )
    foreach ($Path in $RegPaths) {
        if (Test-Path -Path $Path) {
            $Ver = (Get-ItemProperty -Path $Path -Name 'DisplayVersion' -ErrorAction SilentlyContinue).DisplayVersion
            if ($Ver) { return $Ver }
        }
    }
    return $null
}

# ---------------------------------------------------------------------------
# Apply ACL to C:\ProgramData\BracerChat\
# Authenticated Users = Read, Admins/SYSTEM = Full Control
# ---------------------------------------------------------------------------
function Set-BracerChatAcl {
    $Dir = Split-Path -Path $SessionDatPath -Parent
    if (-not (Test-Path -Path $Dir)) {
        New-Item -Path $Dir -ItemType Directory -Force -ErrorAction SilentlyContinue | Out-Null
    }
    Log-Message "Applying ACL hardening to ${Dir}."
    try {
        $IcaclsArgs = @(
            $Dir,
            '/inheritance:r',
            '/grant', 'BUILTIN\Administrators:(OI)(CI)F',
            '/grant', 'NT AUTHORITY\SYSTEM:(OI)(CI)F',
            '/grant', 'BUILTIN\Users:(OI)(CI)R',
            '/T', '/Q'
        )
        $Proc = Start-Process -FilePath 'icacls.exe' -ArgumentList $IcaclsArgs `
                    -Wait -PassThru -NoNewWindow -ErrorAction Stop
        if ($Proc.ExitCode -ne 0) {
            Log-Message "icacls exited with code $($Proc.ExitCode)." -Level 'WARNING'
        } else {
            Log-Message "ACL applied successfully to ${Dir}."
        }
    } catch {
        Log-Message "Failed to apply ACL: $($_.Exception.Message)" -Level 'WARNING'
    }
}

# ---------------------------------------------------------------------------
# Download and silently install Bracer Chat
# ---------------------------------------------------------------------------
function Install-BracerChat {
    # Download
    Log-Message "Downloading Bracer Chat installer from ${InstallerUrl}."
    try {
        $TempDir = Split-Path -Path $InstallerPath -Parent
        if (-not (Test-Path -Path $TempDir)) {
            New-Item -Path $TempDir -ItemType Directory -Force -ErrorAction Stop | Out-Null
        }
        $Headers = @{ 'Authorization' = $InstallerAuthHeader }
        Invoke-WebRequest -Uri $InstallerUrl -OutFile $InstallerPath -Headers $Headers `
            -UseBasicParsing -ErrorAction Stop
        Log-Message "Installer downloaded to ${InstallerPath}."
    } catch {
        Log-Message "Failed to download installer: $($_.Exception.Message)" -Level 'ERROR'
        throw
    }

    # Install silently
    Log-Message "Running Bracer Chat installer silently."
    try {
        $Proc = Start-Process -FilePath $InstallerPath -ArgumentList '/S' -Wait -PassThru -ErrorAction Stop
        if ($Proc.ExitCode -ne 0) {
            throw "Installer exited with code $($Proc.ExitCode)."
        }
        Log-Message "Bracer Chat installed successfully (exit code 0)."
    } catch {
        Log-Message "Installer failed: $($_.Exception.Message)" -Level 'ERROR'
        throw
    } finally {
        # Clean up temp installer regardless of outcome
        if (Test-Path -Path $InstallerPath) {
            Remove-Item -Path $InstallerPath -Force -ErrorAction SilentlyContinue
            Log-Message "Cleaned up installer temp file."
        }
    }
}

# ---------------------------------------------------------------------------
# Install or update Bracer Chat based on installed version vs expected version
# ---------------------------------------------------------------------------
function Install-BracerChatIfNeeded {
    $InstalledVer = Get-InstalledVersion
    if ($InstalledVer -eq $ExpectedVersion) {
        Log-Message "Bracer Chat ${ExpectedVersion} already installed and up to date. Skipping install."
        return
    }
    if ($InstalledVer) {
        Log-Message "Bracer Chat ${InstalledVer} installed — updating to ${ExpectedVersion}."
    } else {
        Log-Message "Bracer Chat not installed — performing fresh install."
    }
    Install-BracerChat
}

# ---------------------------------------------------------------------------
# Main deploy function
# ---------------------------------------------------------------------------
function Invoke-BracerChatDeploy {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$ApiSecret,

        [Parameter(Mandatory = $true)]
        [ValidateNotNullOrEmpty()]
        [string]$CompanyName
    )

    Add-Type -AssemblyName System.Security

    # ------------------------------------------------------------------
    # Idempotency check - skip registration if valid session.dat exists
    # ------------------------------------------------------------------
    if (Test-Path -Path $SessionDatPath) {
        Log-Message "session.dat found - checking for valid access_token."
        try {
            $EncBytes  = [System.IO.File]::ReadAllBytes($SessionDatPath)
            $DecBytes  = [System.Security.Cryptography.ProtectedData]::Unprotect(
                $EncBytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine
            )
            $Existing  = [System.Text.Encoding]::UTF8.GetString($DecBytes) | ConvertFrom-Json
            if (-not [string]::IsNullOrEmpty($Existing.access_token)) {
                Log-Message "Valid session.dat found. Skipping registration."
                Set-BracerChatAcl
                Install-BracerChatIfNeeded
                return
            }
            Log-Message "session.dat found but access_token is empty. Re-registering." -Level 'WARNING'
        } catch {
            Log-Message "session.dat could not be decrypted or parsed: $($_.Exception.Message). Re-registering." -Level 'WARNING'
        }
    }

    # ------------------------------------------------------------------
    # Collect machine info
    # ------------------------------------------------------------------
    Log-Message "Collecting machine info."
    try {
        $Hostname = $env:COMPUTERNAME
        $Serial   = (Get-WmiObject -Class Win32_BIOS -ErrorAction Stop).SerialNumber.Trim()

        # Logged-in interactive user (returns DOMAIN\Username or empty if no one logged in)
        $WinUser = (Get-WmiObject -Class Win32_ComputerSystem -ErrorAction Stop).UserName
        if ([string]::IsNullOrEmpty($WinUser)) { $WinUser = 'UNKNOWN' }

        # Primary NIC - first adapter with a default gateway
        $Nic = Get-WmiObject -Class Win32_NetworkAdapterConfiguration -ErrorAction Stop |
               Where-Object { $_.IPEnabled -eq $true -and $_.DefaultIPGateway } |
               Select-Object -First 1

        # Fallback: first IP-enabled adapter if none has a gateway
        if ($null -eq $Nic) {
            $Nic = Get-WmiObject -Class Win32_NetworkAdapterConfiguration -ErrorAction Stop |
                   Where-Object { $_.IPEnabled -eq $true } |
                   Select-Object -First 1
        }

        $IpAddress  = if ($Nic -and $Nic.IPAddress) {
                          ($Nic.IPAddress | Where-Object { $_ -match '^\d+\.\d+\.\d+\.\d+$' })[0]
                      } else { 'UNKNOWN' }
        $MacAddress = if ($Nic -and $Nic.MACAddress) { $Nic.MACAddress } else { 'UNKNOWN' }

        Log-Message "Hostname=${Hostname} | Serial=${Serial} | IP=${IpAddress} | MAC=${MacAddress} | User=${WinUser}"
    } catch {
        Log-Message "Failed to collect machine info: $($_.Exception.Message)" -Level 'ERROR'
        throw
    }

    # ------------------------------------------------------------------
    # Call Registration API
    # ------------------------------------------------------------------
    Log-Message "Calling Registration API at ${RegistrationUrl}."
    try {
        $Body = @{
            hostname = $Hostname
            company  = $CompanyName
            elevated = $false
        } | ConvertTo-Json

        $Headers = @{
            'Authorization' = "Bearer ${ApiSecret}"
            'Content-Type'  = 'application/json'
        }

        $Response  = Invoke-WebRequest -Uri $RegistrationUrl -Method POST `
                         -Headers $Headers -Body $Body -UseBasicParsing -ErrorAction Stop
        $ApiResult = $Response.Content | ConvertFrom-Json

        Log-Message "Registration successful. user_id=$($ApiResult.user_id)"
    } catch {
        Log-Message "Registration API call failed: $($_.Exception.Message)" -Level 'ERROR'
        throw
    }

    # ------------------------------------------------------------------
    # Build session.dat JSON - flatten rooms.* to room_id_*
    # ------------------------------------------------------------------
    $SessionData = [ordered]@{
        user_id           = $ApiResult.user_id
        access_token      = $ApiResult.access_token
        device_id         = $ApiResult.device_id
        elevated          = $ApiResult.elevated
        room_id_machine   = $ApiResult.rooms.machine
        room_id_broadcast = $ApiResult.rooms.broadcast
        room_id_company   = $ApiResult.rooms.company_broadcast
    }

    # ------------------------------------------------------------------
    # DPAPI-encrypt and write session.dat (LocalMachine scope)
    # ------------------------------------------------------------------
    Log-Message "Encrypting and writing session.dat."
    try {
        $Dir = Split-Path -Path $SessionDatPath -Parent
        if (-not (Test-Path -Path $Dir)) {
            New-Item -Path $Dir -ItemType Directory -Force -ErrorAction Stop | Out-Null
        }

        $JsonBytes = [System.Text.Encoding]::UTF8.GetBytes(($SessionData | ConvertTo-Json -Compress))
        $Encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
            $JsonBytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine
        )
        [System.IO.File]::WriteAllBytes($SessionDatPath, $Encrypted)
        Log-Message "session.dat written to ${SessionDatPath}."
    } catch {
        Log-Message "Failed to write session.dat: $($_.Exception.Message)" -Level 'ERROR'
        throw
    }

    # ------------------------------------------------------------------
    # ACL hardening and install/update
    # ------------------------------------------------------------------
    Set-BracerChatAcl
    Install-BracerChatIfNeeded
}

# ---------------------------------------------------------------------------
# Script entry point
# ---------------------------------------------------------------------------
if ($null -eq $Global:DefaultLogFile) {
    $LogTimestamp = Get-Date -Format 'yyyyMMddHHmmss'
    $LogDir = 'C:\BracerTools\Logs'
    if (-not (Test-Path -Path $LogDir)) {
        New-Item -Path $LogDir -ItemType Directory -Force | Out-Null
    }
    $Global:DefaultLogFile = "${LogDir}\BracerChatRegister_${LogTimestamp}.log"
}

Log-Message "=== Bracer Chat Registration Script started ==="

if ([string]::IsNullOrEmpty($BracerChatApiSecret)) {
    Log-Message 'CRITICAL: SuperOps runtime variable $BracerChatApiSecret is missing or empty.' -Level 'ERROR'
    exit 1
}

if ([string]::IsNullOrEmpty($CompanyName)) {
    Log-Message 'CRITICAL: SuperOps runtime variable $CompanyName is missing or empty.' -Level 'ERROR'
    exit 1
}

try {
    Invoke-BracerChatDeploy -ApiSecret $BracerChatApiSecret -CompanyName $CompanyName
    Log-Message "=== Bracer Chat Registration Script completed successfully ==="
    exit 0
} catch {
    Log-Message "=== Script failed: $($_.Exception.Message) ===" -Level 'ERROR'
    exit 1
}
