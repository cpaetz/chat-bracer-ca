; installer.nsh -- Custom NSIS macros for Bracer Chat
; Runs after files are installed / before files are removed.

; -- Post-install --------------------------------------------------------------
!macro customInstall

  ; Set HKLM Run key so the app auto-starts for every user that logs in
  WriteRegStr HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "Bracer Chat" "$\"$INSTDIR\Bracer Chat.exe$\" --startup"

  ; app.asar is now updated via SYSTEM scheduled task — no Users modify needed.
  ; (Removed icacls grant on app.asar — closes H2 security finding)

  ; Grant BUILTIN\Users modify rights on the ProgramData directory so the app
  ; can write window-prefs.json, update logs, etc. without elevation.
  CreateDirectory "C:\ProgramData\BracerChat"
  nsExec::ExecToLog 'icacls "C:\ProgramData\BracerChat" /grant "*S-1-5-32-545:(OI)(CI)(M)" /Q'

  ; Create secure staging directory for updates — SYSTEM-only, no user write access.
  ; This prevents TOCTOU attacks on update files between download and execution.
  CreateDirectory "C:\ProgramData\BracerChat\updates"
  nsExec::ExecToLog 'icacls "C:\ProgramData\BracerChat\updates" /inheritance:r /grant "SYSTEM:(OI)(CI)F" "Administrators:(OI)(CI)F" /Q'

  ; Register watchdog scheduled task via base64-encoded PowerShell command.
  ; Task runs every 15 min for any logged-in user (GroupId = BUILTIN\Users).
  ; Single-instance lock means a duplicate launch is harmless if app is already running.
  ; ExecutionTimeLimit set to [TimeSpan]::Zero — no limit. Previous value of 2 minutes
  ; caused Task Scheduler to kill the app 2 minutes after launch.
  ; Uses -RepetitionInterval parameter instead of setting Repetition.Interval
  ; directly — the latter fails on some Windows versions.
  ; Watchdog passes --watchdog so the single-instance handler knows not to show the window.
  ; Runs every 15 min — just needs to restart the app if it crashed or was killed.
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand JABhACAAPQAgAE4AZQB3AC0AUwBjAGgAZQBkAHUAbABlAGQAVABhAHMAawBBAGMAdABpAG8AbgAgAC0ARQB4AGUAYwB1AHQAZQAgACcAQwA6AFwAUAByAG8AZwByAGEAbQAgAEYAaQBsAGUAcwBcAEIAcgBhAGMAZQByACAAQwBoAGEAdABcAEIAcgBhAGMAZQByACAAQwBoAGEAdAAuAGUAeABlACcAIAAtAEEAcgBnAHUAbQBlAG4AdAAgACcALQAtAHcAYQB0AGMAaABkAG8AZwAnAAoAJAB0ACAAPQAgAE4AZQB3AC0AUwBjAGgAZQBkAHUAbABlAGQAVABhAHMAawBUAHIAaQBnAGcAZQByACAALQBPAG4AYwBlACAALQBBAHQAIAAoAEcAZQB0AC0ARABhAHQAZQApACAALQBSAGUAcABlAHQAaQB0AGkAbwBuAEkAbgB0AGUAcgB2AGEAbAAgACgATgBlAHcALQBUAGkAbQBlAFMAcABhAG4AIAAtAE0AaQBuAHUAdABlAHMAIAAxADUAKQAKACQAcwAgAD0AIABOAGUAdwAtAFMAYwBoAGUAZAB1AGwAZQBkAFQAYQBzAGsAUwBlAHQAdABpAG4AZwBzAFMAZQB0ACAALQBTAHQAYQByAHQAVwBoAGUAbgBBAHYAYQBpAGwAYQBiAGwAZQAgAC0ARQB4AGUAYwB1AHQAaQBvAG4AVABpAG0AZQBMAGkAbQBpAHQAIAAoAFsAVABpAG0AZQBTAHAAYQBuAF0AOgA6AFoAZQByAG8AKQAKACQAcAAgAD0AIABOAGUAdwAtAFMAYwBoAGUAZAB1AGwAZQBkAFQAYQBzAGsAUAByAGkAbgBjAGkAcABhAGwAIAAtAEcAcgBvAHUAcABJAGQAIAAnAFMALQAxAC0ANQAtADMAMgAtADUANAA1ACcAIAAtAFIAdQBuAEwAZQB2AGUAbAAgAEwAaQBtAGkAdABlAGQACgBSAGUAZwBpAHMAdABlAHIALQBTAGMAaABlAGQAdQBsAGUAZABUAGEAcwBrACAALQBUAGEAcwBrAE4AYQBtAGUAIAAnAEIAcgBhAGMAZQByACAAQwBoAGEAdAAgAFcAYQB0AGMAaABkAG8AZwAnACAALQBBAGMAdABpAG8AbgAgACQAYQAgAC0AVAByAGkAZwBnAGUAcgAgACQAdAAgAC0AUAByAGkAbgBjAGkAcABhAGwAIAAkAHAAIAAtAFMAZQB0AHQAaQBuAGcAcwAgACQAcwAgAC0ARgBvAHIAYwBlACAAfAAgAE8AdQB0AC0ATgB1AGwAbAA='

!macroend

; -- Pre-uninstall -------------------------------------------------------------
!macro customUnInstall

  ; Remove HKLM Run key
  DeleteRegValue HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "Bracer Chat"

  ; Remove watchdog scheduled task
  nsExec::ExecToLog 'schtasks.exe /delete /tn "Bracer Chat Watchdog" /f'

!macroend
