<#
.SYNOPSIS
    Uninstalls Bracer Chat from this machine.

.DESCRIPTION
    Called from a SuperOps policy. Stops the running app, runs the NSIS silent uninstaller,
    and removes app data from C:\ProgramData\BracerChat\.

    By default session.dat is PRESERVED so that a re-install reuses the existing Matrix
    account automatically. Set $WipeSessionData = 1 to delete session.dat as well
    (forces fresh account creation on next install).

    SuperOps runtime variable (optional, injected into global scope by policy):
        $WipeSessionData    - 0 (default) to preserve session.dat, 1 to delete it

.NOTES
    Version:        1.1
    Author:         Bracer Systems Inc.
    Creation Date:  2026-03-22
    Updated:        2026-03-22
    Purpose:        Bracer Chat - Phase 6 Removal Script
#>

#Requires -Version 5.1

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
$AppDataDir      = 'C:\ProgramData\BracerChat'
$SessionDatPath  = "${AppDataDir}\session.dat"
$UninstallerPath = 'C:\Program Files\Bracer Chat\Uninstall Bracer Chat.exe'

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
# Main removal function
# ---------------------------------------------------------------------------
function Invoke-BracerChatRemove {
    [CmdletBinding(SupportsShouldProcess = $true)]
    param(
        [int]$WipeSession = 0
    )

    # ------------------------------------------------------------------
    # Stop the running app (if open)
    # ------------------------------------------------------------------
    Log-Message "Stopping Bracer Chat process (if running)."
    try {
        $Procs = Get-Process -Name 'Bracer Chat' -ErrorAction SilentlyContinue
        if ($Procs) {
            if ($PSCmdlet.ShouldProcess("Bracer Chat process", "Stop-Process")) {
                $Procs | Stop-Process -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
            Log-Message "Bracer Chat process stopped."
        } else {
            Log-Message "Bracer Chat process not running."
        }
    } catch {
        Log-Message "Error stopping process: $($_.Exception.Message)" -Level 'WARNING'
    }

    # ------------------------------------------------------------------
    # Run NSIS silent uninstaller
    # ------------------------------------------------------------------
    if (Test-Path -Path $UninstallerPath) {
        Log-Message "Running NSIS silent uninstaller: ${UninstallerPath}"
        try {
            if (-not $PSCmdlet.ShouldProcess($UninstallerPath, "Run NSIS silent uninstaller")) { return }
            $Proc = Start-Process -FilePath $UninstallerPath -ArgumentList '/S' -Wait -PassThru -ErrorAction Stop
            if ($Proc.ExitCode -ne 0) {
                Log-Message "Uninstaller exited with code $($Proc.ExitCode)." -Level 'WARNING'
            } else {
                Log-Message "Uninstaller completed successfully."
            }
        } catch {
            Log-Message "Uninstaller failed: $($_.Exception.Message)" -Level 'WARNING'
        }
    } else {
        Log-Message "Uninstaller not found at ${UninstallerPath} - app may not be installed." -Level 'WARNING'
    }

    # ------------------------------------------------------------------
    # Remove app data (preserve or wipe session.dat per $WipeSession)
    # ------------------------------------------------------------------
    if (Test-Path -Path $AppDataDir) {
        Log-Message "Removing app data from ${AppDataDir}."

        if ($WipeSession -eq 1) {
            # Full wipe including session.dat
            Log-Message "WipeSessionData=1 — removing session.dat."
            if ($PSCmdlet.ShouldProcess($AppDataDir, "Remove-Item -Recurse (full wipe)")) {
                Remove-Item -Path $AppDataDir -Recurse -Force -ErrorAction SilentlyContinue
            }
            Log-Message "App data directory removed."
        } else {
            # Preserve session.dat; remove everything else
            Log-Message "WipeSessionData=0 — preserving session.dat."
            $Items = Get-ChildItem -Path $AppDataDir -Force -ErrorAction SilentlyContinue |
                     Where-Object { $_.FullName -ne $SessionDatPath }
            foreach ($Item in $Items) {
                if ($PSCmdlet.ShouldProcess($Item.FullName, "Remove-Item")) {
                    Remove-Item -Path $Item.FullName -Recurse -Force -ErrorAction SilentlyContinue
                }
            }
            if (Test-Path -Path $SessionDatPath) {
                Log-Message "session.dat preserved at ${SessionDatPath}."
            }
            Log-Message "App data cleaned (session.dat retained)."
        }
    } else {
        Log-Message "App data directory not found — nothing to clean."
    }

    Log-Message "Bracer Chat removal complete."
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
    $Global:DefaultLogFile = "${LogDir}\BracerChatRemove_${LogTimestamp}.log"
}

Log-Message "=== Bracer Chat Removal Script started ==="

# $WipeSessionData is injected by SuperOps policy (default 0 if not set)
$WipeArg = 0
if (-not [string]::IsNullOrEmpty($WipeSessionData)) {
    try { $WipeArg = [int]$WipeSessionData } catch { $WipeArg = 0 }
}
Log-Message "WipeSessionData=${WipeArg}"

try {
    Invoke-BracerChatRemove -WipeSession $WipeArg
    Log-Message "=== Bracer Chat Removal Script completed successfully ==="
    exit 0
} catch {
    Log-Message "=== Script failed: $($_.Exception.Message) ===" -Level 'ERROR'
    exit 1
}
