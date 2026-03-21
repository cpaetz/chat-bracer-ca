<#
.SYNOPSIS
    Manually registers this machine with Bracer Chat and installs the Bracer Chat app.

.DESCRIPTION
    Standalone version of the Bracer Chat deployment script for manual installation.
    Run as Administrator. Prompts for Company Name and API Secret if not supplied
    as parameters.

    Collects machine info, calls the Bracer Chat Registration API, DPAPI-encrypts
    the session credentials (LocalMachine scope), writes them to
    C:\ProgramData\BracerChat\session.dat, then downloads and silently installs
    the Bracer Chat Electron app.

    Idempotent: if session.dat already exists with a valid access_token, registration
    is skipped and the script proceeds directly to install.

.PARAMETER CompanyName
    The client company name. Prompted interactively if not provided.

.PARAMETER ApiSecret
    The Bracer Chat Registration API secret. Prompted interactively if not provided.

.EXAMPLE
    # Interactive (prompts for both values)
    .\BracerChatInstall-Manual.ps1

.EXAMPLE
    # Non-interactive (fully unattended)
    .\BracerChatInstall-Manual.ps1 -CompanyName "Acme Corp" -ApiSecret "your-secret-here"

.NOTES
    Version:        1.0
    Author:         Bracer Systems Inc.
    Creation Date:  2026-03-21
    Purpose:        Bracer Chat — Manual Deployment
#>

#Requires -Version 5.1
#Requires -RunAsAdministrator

[CmdletBinding()]
param(
    [Parameter(Mandatory = $false)]
    [string]$CompanyName,

    [Parameter(Mandatory = $false)]
    [string]$ApiSecret
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$SessionDatPath  = 'C:\ProgramData\BracerChat\session.dat'
$InstallerUrl    = 'https://chat.bracer.ca/install/BracerChat-Setup-1.0.0.exe'
$InstallerPath   = 'C:\BracerTools\Temp\BracerChatSetup.exe'
$RegistrationUrl = 'https://chat.bracer.ca/api/register'

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
# Install Bracer Chat
# ---------------------------------------------------------------------------
function Install-BracerChat {
    Log-Message "Downloading Bracer Chat installer from ${InstallerUrl}."
    try {
        $TempDir = Split-Path -Path $InstallerPath -Parent
        if (-not (Test-Path -Path $TempDir)) {
            New-Item -Path $TempDir -ItemType Directory -Force -ErrorAction Stop | Out-Null
        }
        Invoke-WebRequest -Uri $InstallerUrl -OutFile $InstallerPath -UseBasicParsing -ErrorAction Stop
        Log-Message "Installer downloaded to ${InstallerPath}."
    } catch {
        Log-Message "Failed to download installer: $($_.Exception.Message)" -Level 'ERROR'
        throw
    }

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
        if (Test-Path -Path $InstallerPath) {
            Remove-Item -Path $InstallerPath -Force -ErrorAction SilentlyContinue
            Log-Message "Cleaned up installer temp file."
        }
    }
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
    # Idempotency check
    # ------------------------------------------------------------------
    if (Test-Path -Path $SessionDatPath) {
        Log-Message "session.dat found — checking for valid access_token."
        try {
            $EncBytes = [System.IO.File]::ReadAllBytes($SessionDatPath)
            $DecBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
                $EncBytes, $null, [System.Security.Cryptography.DataProtectionScope]::LocalMachine
            )
            $Existing = [System.Text.Encoding]::UTF8.GetString($DecBytes) | ConvertFrom-Json
            if (-not [string]::IsNullOrEmpty($Existing.access_token)) {
                Log-Message "Valid session.dat found. Skipping registration — proceeding to install."
                Install-BracerChat
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

        $WinUser = (Get-WmiObject -Class Win32_ComputerSystem -ErrorAction Stop).UserName
        if ([string]::IsNullOrEmpty($WinUser)) { $WinUser = 'UNKNOWN' }

        $Nic = Get-WmiObject -Class Win32_NetworkAdapterConfiguration -ErrorAction Stop |
               Where-Object { $_.IPEnabled -eq $true -and $_.DefaultIPGateway } |
               Select-Object -First 1

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
    # Build session.dat JSON — flatten rooms.* to room_id_*
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
    # Install
    # ------------------------------------------------------------------
    Install-BracerChat
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

Log-Message "=== Bracer Chat Manual Install started ==="

# Prompt for any missing values
if ([string]::IsNullOrEmpty($CompanyName)) {
    $CompanyName = Read-Host "Enter Company Name (e.g. Acme Corp)"
}
if ([string]::IsNullOrEmpty($ApiSecret)) {
    $SecureSecret = Read-Host "Enter Bracer Chat API Secret" -AsSecureString
    $ApiSecret = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureSecret)
    )
}

if ([string]::IsNullOrEmpty($CompanyName)) {
    Log-Message 'Company Name cannot be empty.' -Level 'ERROR'
    exit 1
}
if ([string]::IsNullOrEmpty($ApiSecret)) {
    Log-Message 'API Secret cannot be empty.' -Level 'ERROR'
    exit 1
}

try {
    Invoke-BracerChatDeploy -ApiSecret $ApiSecret -CompanyName $CompanyName
    Log-Message "=== Bracer Chat Manual Install completed successfully ==="
    Write-Host "`nBracer Chat has been installed successfully. Check the system tray." -ForegroundColor Green
    exit 0
} catch {
    Log-Message "=== Script failed: $($_.Exception.Message) ===" -Level 'ERROR'
    Write-Host "`nInstallation failed. See log at: $Global:DefaultLogFile" -ForegroundColor Red
    exit 1
}
