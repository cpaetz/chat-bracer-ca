$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Security

$token    = '{{TOKEN}}'
$claimUrl = 'https://chat.bracer.ca/api/installer/claim'
$appUrl   = 'https://chat.bracer.ca/api/installer/app'
$hostname = $env:COMPUTERNAME.ToLower()
$dataDir  = 'C:\ProgramData\BracerChat'
$logDir   = 'C:\BracerTools\Logs'
$logFile  = "$logDir\BracerChatInstall.log"

function Write-Log {
    param([string]$msg)
    $ts   = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    $line = "[$ts] $msg"
    Write-Host $line
    if (!(Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
    Add-Content -Path $logFile -Value $line -ErrorAction SilentlyContinue
}

try {
    Write-Log "BracerChat installer started. Hostname: $hostname"

    # 1. Claim credentials from server
    Write-Log "Claiming credentials..."
    $resp = Invoke-RestMethod -Uri "${claimUrl}?token=${token}&hostname=${hostname}" -Method GET -UseBasicParsing
    Write-Log "Credentials received for $($resp.user_id)"

    # 2. Build session.dat JSON
    $sessionObj = [ordered]@{
        user_id           = $resp.user_id
        access_token      = $resp.access_token
        device_id         = $resp.device_id
        elevated          = $resp.elevated
        room_id_machine   = $resp.room_id_machine
        room_id_broadcast = $resp.room_id_broadcast
        room_id_company   = $resp.room_id_company
    }
    $sessionJson = $sessionObj | ConvertTo-Json -Compress

    # 3. DPAPI encrypt (LocalMachine scope)
    $bytes     = [System.Text.Encoding]::UTF8.GetBytes($sessionJson)
    $encrypted = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytes, $null,
        [System.Security.Cryptography.DataProtectionScope]::LocalMachine
    )

    # 4. Heal ACL and write session.dat
    Write-Log "Writing session.dat..."
    if (!(Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir -Force | Out-Null }
    & takeown /F $dataDir /R /D Y 2>&1 | Out-Null
    & icacls $dataDir /reset /T /Q 2>&1 | Out-Null
    & icacls $dataDir /inheritance:r /grant "Administrators:(OI)(CI)F" "SYSTEM:(OI)(CI)F" "Users:(OI)(CI)R" 2>&1 | Out-Null
    & icacls "$dataDir\*" /inheritance:r /grant "Administrators:F" "SYSTEM:F" "Users:R" /T 2>&1 | Out-Null
    $sessionPath = Join-Path $dataDir 'session.dat'
    if (Test-Path $sessionPath) { Remove-Item $sessionPath -Force }
    [System.IO.File]::WriteAllBytes($sessionPath, $encrypted)
    Write-Log "session.dat written"

    # 5. Stop existing BracerChat before installing (locked files cause silent partial installs)
    Write-Log "Stopping existing BracerChat (if running)..."
    Get-Process -Name "Bracer Chat" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2

    # 6. Download BracerChat installer
    Write-Log "Downloading BracerChat installer..."
    $installer = Join-Path $env:TEMP 'BracerChatSetup.exe'
    Invoke-WebRequest -Uri "${appUrl}?token=${token}" -OutFile $installer -UseBasicParsing
    $sizeMB = [math]::Round((Get-Item $installer).Length / 1MB, 1)
    Write-Log "Download complete ($sizeMB MB)"

    # 7. Install silently
    Write-Log "Installing BracerChat..."
    $proc = Start-Process -FilePath $installer -ArgumentList '/S' -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -ne 0) { throw "Installer exited with code $($proc.ExitCode)" }
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    Write-Log "BracerChat installed"

    # 8. Set HKLM Run key for auto-start on boot
    $exePath = 'C:\Program Files\Bracer Chat\Bracer Chat.exe'
    if (Test-Path $exePath) {
        Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' `
            -Name 'BracerChat' -Value "`"$exePath`" --startup" -ErrorAction SilentlyContinue
        Write-Log "Auto-start registry key set"
    }

    # 9. Launch BracerChat immediately as the current user
    if (Test-Path $exePath) {
        Write-Log "Launching BracerChat..."
        $action    = New-ScheduledTaskAction -Execute $exePath -Argument '--startup'
        $trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(3)
        $settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
        Register-ScheduledTask -TaskName 'BracerChatLaunch' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
        Start-ScheduledTask -TaskName 'BracerChatLaunch'
        Write-Log "Launch task scheduled"
    }

    Write-Log "Installation complete."
    exit 0

} catch {
    Write-Log "ERROR: $_"
    [System.Windows.Forms.MessageBox]::Show(
        "Bracer Chat installation failed:`n`n$_`n`nCheck log: $logFile",
        "Bracer Chat Installer",
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}
