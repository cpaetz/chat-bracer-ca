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
    [string]$ApiSecret,

    [Parameter(Mandatory = $false)]
    [string]$InstallAuth,

    [Parameter(Mandatory = $false)]
    [string]$OpServiceAccountToken
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$SessionDatPath    = 'C:\ProgramData\BracerChat\session.dat'
$InstallerUrl      = 'https://chat.bracer.ca/install/BracerChat-Setup-1.0.0.exe'
$InstallerPath     = 'C:\BracerTools\Temp\BracerChatSetup.exe'
$RegistrationUrl   = 'https://chat.bracer.ca/api/register'
$OpTempDir         = Join-Path $env:TEMP 'bracer-op'
$OpExePath         = Join-Path $OpTempDir 'op.exe'
$OpCliUrl          = 'https://cache.agilebits.com/dist/1P/op2/pkg/v2.33.0/op_windows_amd64_v2.33.0.zip'

# ---------------------------------------------------------------------------
# 1Password CLI bootstrap — secrets are pulled at runtime, never stored on disk.
# The SA token is set only as a process env var and cleared on exit.
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
    if ([string]::IsNullOrEmpty($Value)) {
        throw "1Password read returned empty value for: $Reference"
    }
    return $Value
}

function Remove-OpCli {
    $env:OP_SERVICE_ACCOUNT_TOKEN = $null
    [System.Environment]::SetEnvironmentVariable('OP_SERVICE_ACCOUNT_TOKEN', $null, 'Process')
    if (Test-Path $OpTempDir) {
        Remove-Item $OpTempDir -Recurse -Force -ErrorAction SilentlyContinue
        Log-Message "1Password CLI removed from temp."
    }
}

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
        Invoke-WebRequest -Uri $InstallerUrl -Headers @{ Authorization = $InstallBasicAuth } -OutFile $InstallerPath -UseBasicParsing -ErrorAction Stop
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

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------------------
# GUI: API Secret dialog
# ---------------------------------------------------------------------------
function Show-ApiSecretDialog {
    $Form = New-Object System.Windows.Forms.Form
    $Form.Text            = 'Bracer Chat — API Secret'
    $Form.Size            = New-Object System.Drawing.Size(400, 160)
    $Form.StartPosition   = 'CenterScreen'
    $Form.FormBorderStyle = 'FixedDialog'
    $Form.MaximizeBox     = $false
    $Form.MinimizeBox     = $false
    $Form.TopMost         = $true

    $Lbl = New-Object System.Windows.Forms.Label
    $Lbl.Text     = 'Enter the Bracer Chat API Secret:'
    $Lbl.Location = New-Object System.Drawing.Point(14, 16)
    $Lbl.Size     = New-Object System.Drawing.Size(360, 20)

    $Txt = New-Object System.Windows.Forms.TextBox
    $Txt.Location     = New-Object System.Drawing.Point(14, 40)
    $Txt.Size         = New-Object System.Drawing.Size(358, 24)
    $Txt.PasswordChar = [char]0x2022   # bullet

    $BtnOK = New-Object System.Windows.Forms.Button
    $BtnOK.Text         = 'OK'
    $BtnOK.Location     = New-Object System.Drawing.Point(196, 82)
    $BtnOK.Size         = New-Object System.Drawing.Size(80, 30)
    $BtnOK.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $Form.AcceptButton  = $BtnOK

    $BtnCancel = New-Object System.Windows.Forms.Button
    $BtnCancel.Text         = 'Cancel'
    $BtnCancel.Location     = New-Object System.Drawing.Point(292, 82)
    $BtnCancel.Size         = New-Object System.Drawing.Size(80, 30)
    $BtnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $Form.CancelButton      = $BtnCancel

    $Form.Controls.AddRange(@($Lbl, $Txt, $BtnOK, $BtnCancel))

    if ($Form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
    return $Txt.Text
}

# ---------------------------------------------------------------------------
# GUI: Company picker — fetches active companies from the registration API
# ---------------------------------------------------------------------------
function Show-CompanyPicker {
    param([string]$ApiSecret)

    # Fetch active companies from server
    $Companies = @()
    try {
        $Headers  = @{ 'Authorization' = "Bearer $ApiSecret" }
        $Response = Invoke-WebRequest -Uri 'https://chat.bracer.ca/api/companies' `
                        -Headers $Headers -UseBasicParsing -ErrorAction Stop
        $Data      = $Response.Content | ConvertFrom-Json
        $Companies = @($Data.companies)
    } catch {
        Log-Message "Could not fetch company list: $($_.Exception.Message)" -Level 'WARNING'
        # Continue — tech can still type a name manually
    }

    $Form = New-Object System.Windows.Forms.Form
    $Form.Text            = 'Bracer Chat — Select Company'
    $Form.Size            = New-Object System.Drawing.Size(440, 430)
    $Form.StartPosition   = 'CenterScreen'
    $Form.FormBorderStyle = 'FixedDialog'
    $Form.MaximizeBox     = $false
    $Form.MinimizeBox     = $false
    $Form.TopMost         = $true

    $LblList = New-Object System.Windows.Forms.Label
    $LblList.Text     = 'Select an existing company:'
    $LblList.Location = New-Object System.Drawing.Point(14, 12)
    $LblList.Size     = New-Object System.Drawing.Size(400, 20)

    $ListBox = New-Object System.Windows.Forms.ListBox
    $ListBox.Location          = New-Object System.Drawing.Point(14, 36)
    $ListBox.Size              = New-Object System.Drawing.Size(398, 200)
    $ListBox.ScrollAlwaysVisible = $true
    foreach ($Co in $Companies) { [void]$ListBox.Items.Add($Co) }

    $LblNew = New-Object System.Windows.Forms.Label
    $LblNew.Text     = 'Or enter a new company name:'
    $LblNew.Location = New-Object System.Drawing.Point(14, 252)
    $LblNew.Size     = New-Object System.Drawing.Size(400, 20)

    $TxtNew = New-Object System.Windows.Forms.TextBox
    $TxtNew.Location = New-Object System.Drawing.Point(14, 275)
    $TxtNew.Size     = New-Object System.Drawing.Size(398, 24)

    # Clicking a list item populates the text box
    $ListBox.add_SelectedIndexChanged({
        if ($null -ne $ListBox.SelectedItem) {
            $TxtNew.Text = $ListBox.SelectedItem.ToString()
        }
    })

    $BtnOK = New-Object System.Windows.Forms.Button
    $BtnOK.Text         = 'OK'
    $BtnOK.Location     = New-Object System.Drawing.Point(240, 322)
    $BtnOK.Size         = New-Object System.Drawing.Size(80, 30)
    $BtnOK.DialogResult = [System.Windows.Forms.DialogResult]::OK
    $Form.AcceptButton  = $BtnOK

    $BtnCancel = New-Object System.Windows.Forms.Button
    $BtnCancel.Text         = 'Cancel'
    $BtnCancel.Location     = New-Object System.Drawing.Point(334, 322)
    $BtnCancel.Size         = New-Object System.Drawing.Size(80, 30)
    $BtnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
    $Form.CancelButton      = $BtnCancel

    $Form.Controls.AddRange(@($LblList, $ListBox, $LblNew, $TxtNew, $BtnOK, $BtnCancel))

    if ($Form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }

    $Selected = $TxtNew.Text.Trim()
    if ([string]::IsNullOrEmpty($Selected)) {
        [void][System.Windows.Forms.MessageBox]::Show(
            'Please select a company or type a new name.',
            'Bracer Chat',
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        )
        return $null
    }
    return $Selected
}

# ---------------------------------------------------------------------------
# Collect missing values — GUI if interactive, error if non-interactive
# ---------------------------------------------------------------------------
try {
    if (-not [string]::IsNullOrEmpty($OpServiceAccountToken)) {
        # Preferred path: pull all secrets from 1Password
        Install-OpCli
        Log-Message "Reading secrets from 1Password..."
        $ApiSecret       = Read-OpSecret 'op://chat-bracer-ca/bracer-register API secret/password'
        $InstallAuth     = Read-OpSecret 'op://chat-bracer-ca/bracer-install Basic Auth/password'
        Log-Message "Secrets loaded."
    } elseif ([string]::IsNullOrEmpty($ApiSecret)) {
        # Fallback: prompt manually (legacy path, no 1Password CLI available)
        $ApiSecret = Show-ApiSecretDialog
        if ([string]::IsNullOrEmpty($ApiSecret)) {
            Log-Message 'Installation cancelled — no API secret provided.' -Level 'ERROR'
            exit 1
        }
    }

    if ([string]::IsNullOrEmpty($InstallAuth)) {
        Log-Message 'InstallAuth is required. Pass -OpServiceAccountToken or -InstallAuth. Look up value in 1Password: chat-bracer-ca > bracer-install Basic Auth.' -Level 'ERROR'
        exit 1
    }
} catch {
    Log-Message "Failed to load secrets: $($_.Exception.Message)" -Level 'ERROR'
    Remove-OpCli
    exit 1
}

$InstallBasicAuth = 'Basic ' + [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes("bracer-install:${InstallAuth}"))

if ([string]::IsNullOrEmpty($CompanyName)) {
    $CompanyName = Show-CompanyPicker -ApiSecret $ApiSecret
    if ([string]::IsNullOrEmpty($CompanyName)) {
        Log-Message 'Installation cancelled — no company selected.' -Level 'ERROR'
        exit 1
    }
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
} finally {
    Remove-OpCli
}
