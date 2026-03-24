!include "LogicLib.nsh"

Name "Bracer Chat Installer"
OutFile "{{EXE_NAME}}"
RequestExecutionLevel admin
SilentInstall silent
ShowInstDetails nevershow

Section "Install"
  SetOutPath "$TEMP\BracerInstall-{{TOKEN_SHORT}}"
  File "install.ps1"

  ExecWait 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "$TEMP\BracerInstall-{{TOKEN_SHORT}}\install.ps1"' $0

  RMDir /r "$TEMP\BracerInstall-{{TOKEN_SHORT}}"

  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Bracer Chat installation failed.$\nCheck C:\BracerTools\Logs\BracerChatInstall.log for details."
  ${EndIf}
SectionEnd
