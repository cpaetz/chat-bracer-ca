; installer.nsh -- Custom NSIS macros for Bracer Chat
; Runs after files are installed / before files are removed.

; -- Post-install --------------------------------------------------------------
!macro customInstall

  ; Set HKLM Run key so the app auto-starts for every user that logs in
  WriteRegStr HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "Bracer Chat" "$\"$INSTDIR\Bracer Chat.exe$\""

  ; Grant BUILTIN\Users modify rights on app.asar so the in-app updater can
  ; replace it as the logged-in user without elevation or a SYSTEM task.
  nsExec::ExecToLog 'icacls "$INSTDIR\resources\app.asar" /grant "*S-1-5-32-545:(M)" /Q'

  ; Register watchdog scheduled task via base64-encoded PowerShell command.
  ; Task runs every 5 min for any logged-in user (GroupId = BUILTIN\Users).
  ; Single-instance lock means a duplicate launch is harmless if app is already running.
  ; ExecutionTimeLimit set to [TimeSpan]::Zero — no limit. Previous value of 2 minutes
  ; caused Task Scheduler to kill the app 2 minutes after launch.
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand JABhACAAPQAgAE4AZQB3AC0AUwBjAGgAZQBkAHUAbABlAGQAVABhAHMAawBBAGMAdABpAG8AbgAgAC0ARQB4AGUAYwB1AHQAZQAgACcAQwA6AFwAUAByAG8AZwByAGEAbQAgAEYAaQBsAGUAcwBcAEIAcgBhAGMAZQByACAAQwBoAGEAdABcAEIAcgBhAGMAZQByACAAQwBoAGEAdAAuAGUAeABlACcACgAkAHQAIAA9ACAATgBlAHcALQBTAGMAaABlAGQAdQBsAGUAZABUAGEAcwBrAFQAcgBpAGcAZwBlAHIAIAAtAE8AbgBjAGUAIAAtAEEAdAAgACgARwBlAHQALQBEAGEAdABlACkACgAkAHQALgBSAGUAcABlAHQAaQB0AGkAbwBuAC4ASQBuAHQAZQByAHYAYQBsACAAPQAgACcAUABUADUATQAnAAoAJAB0AC4AUgBlAHAAZQB0AGkAdABpAG8AbgAuAFMAdABvAHAAQQB0AEQAdQByAGEAdABpAG8AbgBFAG4AZAAgAD0AIAAkAGYAYQBsAHMAZQAKACQAcwAgAD0AIABOAGUAdwAtAFMAYwBoAGUAZAB1AGwAZQBkAFQAYQBzAGsAUwBlAHQAdABpAG4AZwBzAFMAZQB0ACAALQBTAHQAYQByAHQAVwBoAGUAbgBBAHYAYQBpAGwAYQBiAGwAZQAgAC0ARQB4AGUAYwB1AHQAaQBvAG4AVABpAG0AZQBMAGkAbQBpAHQAIAAoAFsAVABpAG0AZQBTAHAAYQBuAF0AOgA6AFoAZQByAG8AKQAKACQAcAAgAD0AIABOAGUAdwAtAFMAYwBoAGUAZAB1AGwAZQBkAFQAYQBzAGsAUAByAGkAbgBjAGkAcABhAGwAIAAtAEcAcgBvAHUAcABJAGQAIAAnAFMALQAxAC0ANQAtADMAMgAtADUANAA1ACcAIAAtAFIAdQBuAEwAZQB2AGUAbAAgAEwAaQBtAGkAdABlAGQACgBSAGUAZwBpAHMAdABlAHIALQBTAGMAaABlAGQAdQBsAGUAZABUAGEAcwBrACAALQBUAGEAcwBrAE4AYQBtAGUAIAAnAEIAcgBhAGMAZQByACAAQwBoAGEAdAAgAFcAYQB0AGMAaABkAG8AZwAnACAALQBBAGMAdABpAG8AbgAgACQAYQAgAC0AVAByAGkAZwBnAGUAcgAgACQAdAAgAC0AUAByAGkAbgBjAGkAcABhAGwAIAAkAHAAIAAtAFMAZQB0AHQAaQBuAGcAcwAgACQAcwAgAC0ARgBvAHIAYwBlACAAfAAgAE8AdQB0AC0ATgB1AGwAbAA='

!macroend

; -- Pre-uninstall -------------------------------------------------------------
!macro customUnInstall

  ; Remove HKLM Run key
  DeleteRegValue HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "Bracer Chat"

  ; Remove watchdog scheduled task
  nsExec::ExecToLog 'schtasks.exe /delete /tn "Bracer Chat Watchdog" /f'

!macroend
