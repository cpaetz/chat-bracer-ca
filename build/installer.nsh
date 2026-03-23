; installer.nsh -- Custom NSIS macros for Bracer Chat
; Runs after files are installed / before files are removed.

; -- Post-install --------------------------------------------------------------
!macro customInstall

  ; Set HKLM Run key so the app auto-starts for every user that logs in
  WriteRegStr HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "Bracer Chat" "$\"$INSTDIR\Bracer Chat.exe$\""

  ; Register watchdog scheduled task via base64-encoded PowerShell command.
  ; Task runs every 5 min for any logged-in user (GroupId = BUILTIN\Users).
  ; Single-instance lock means a duplicate launch is harmless if app is already running.
  nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand JABhACAAPQAgAE4AZQB3AC0AUwBjAGgAZQBkAHUAbABlAGQAVABhAHMAawBBAGMAdABpAG8AbgAgAC0ARQB4AGUAYwB1AHQAZQAgACcAQwA6AFwAUAByAG8AZwByAGEAbQAgAEYAaQBsAGUAcwBcAEIAcgBhAGMAZQByACAAQwBoAGEAdABcAEIAcgBhAGMAZQByACAAQwBoAGEAdAAuAGUAeABlACcACgAkAHQAIAA9ACAATgBlAHcALQBTAGMAaABlAGQAdQBsAGUAZABUAGEAcwBrAFQAcgBpAGcAZwBlAHIAIAAtAE8AbgBjAGUAIAAtAEEAdAAgACgARwBlAHQALQBEAGEAdABlACkACgAkAHQALgBSAGUAcABlAHQAaQB0AGkAbwBuAC4ASQBuAHQAZQByAHYAYQBsACAAPQAgACcAUABUADUATQAnAAoAJAB0AC4AUgBlAHAAZQB0AGkAdABpAG8AbgAuAFMAdABvAHAAQQB0AEQAdQByAGEAdABpAG8AbgBFAG4AZAAgAD0AIAAkAGYAYQBsAHMAZQAKACQAcwAgAD0AIABOAGUAdwAtAFMAYwBoAGUAZAB1AGwAZQBkAFQAYQBzAGsAUwBlAHQAdABpAG4AZwBzAFMAZQB0ACAALQBTAHQAYQByAHQAVwBoAGUAbgBBAHYAYQBpAGwAYQBiAGwAZQAgAC0ARQB4AGUAYwB1AHQAaQBvAG4AVABpAG0AZQBMAGkAbQBpAHQAIAAoAE4AZQB3AC0AVABpAG0AZQBTAHAAYQBuACAALQBNAGkAbgB1AHQAZQBzACAAMgApAAoAJABwACAAPQAgAE4AZQB3AC0AUwBjAGgAZQBkAHUAbABlAGQAVABhAHMAawBQAHIAaQBuAGMAaQBwAGEAbAAgAC0ARwByAG8AdQBwAEkAZAAgACcAUwAtADEALQA1AC0AMwAyAC0ANQA0ADUAJwAgAC0AUgB1AG4ATABlAHYAZQBsACAATABpAG0AaQB0AGUAZAAKAFIAZQBnAGkAcwB0AGUAcgAtAFMAYwBoAGUAZAB1AGwAZQBkAFQAYQBzAGsAIAAtAFQAYQBzAGsATgBhAG0AZQAgACcAQgByAGEAYwBlAHIAIABDAGgAYQB0ACAAVwBhAHQAYwBoAGQAbwBnACcAIAAtAEEAYwB0AGkAbwBuACAAJABhACAALQBUAHIAaQBnAGcAZQByACAAJAB0ACAALQBQAHIAaQBuAGMAaQBwAGEAbAAgACQAcAAgAC0AUwBlAHQAdABpAG4AZwBzACAAJABzACAALQBGAG8AcgBjAGUAIAB8ACAATwB1AHQALQBOAHUAbABsAA=='

!macroend

; -- Pre-uninstall -------------------------------------------------------------
!macro customUnInstall

  ; Remove HKLM Run key
  DeleteRegValue HKLM "SOFTWARE\Microsoft\Windows\CurrentVersion\Run" "Bracer Chat"

  ; Remove watchdog scheduled task
  nsExec::ExecToLog 'schtasks.exe /delete /tn "Bracer Chat Watchdog" /f'

!macroend
