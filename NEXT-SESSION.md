# Bracer Chat v1 — Continue Build Session

## Read first
1. `Memory/Work & Projects/Bracer Chat.md`
2. `Memory/Session Log/2026-03-22 — Bracer Chat v1 Build Session.md`
3. Plan file: `C:\Users\Chris.Paetz\.claude\plans\mutable-orbiting-eagle.md`

## What was completed last session
- Per-machine install fixed (electron-builder --config flag bug — must pass `--config electron-builder.config.js` explicitly)
- App installs to `C:\Program Files\Bracer Chat\Bracer Chat.exe`
- Desktop + Start Menu shortcuts enabled and working
- Single-instance lock in main.js (double-click shortcut focuses existing window)
- Bracer Chat running and tested on P14s
- Commits: 737fbf6

## Next items to build (in order)

### 0. Fix desktop shortcut icon (~15 min) — START HERE
- The `.ico` file at `assets/icon.ico` is valid (5 sizes: 256, 48, 32, 24, 16px, 44KB)
- The latest build embedded it correctly (no "default Electron icon" warning)
- Issue: unclear whether the shortcut is showing the right icon or not — Chris needs to confirm what he sees
- If Windows icon cache is stale: run `ie4uinit.exe -show` or delete `%LocalAppData%\IconCache.db` and restart Explorer
- If icon looks wrong on the shortcut, check: does `assets/icon.ico` actually contain the Bracer logo? (It should — committed in dfd3d5d "replace placeholder icon with official Bracer logo")
- Root cause to guard against: `scripts/generate-icons.js` runs on every build and overwrites `icon.png` and `tray.png` with solid-blue placeholders — it does NOT touch `icon.ico`, so that should be safe

### 1. SuperOps portal link in ticket confirmation (~15 min)
- File: `deploy/bracer-bot/bot.py` lines ~265–342
- Append SuperOps ticket URL to the confirmation message sent back to the room after !ticket

### 2. 24h client-side message retention (~30 min)
- File: `src/matrix-client.js` — filter messages in getRoomMessages()
- Cutoff: `Date.now() - (24 * 60 * 60 * 1000)`
- Pinned messages (from localStorage `bracerChat_pinnedMessages`) exempt — always shown

### 3. ACL hardening (~20 min)
- File: `deploy/BracerChatRegister.ps1`
- After creating `C:\ProgramData\BracerChat\`, run:
  `icacls "C:\ProgramData\BracerChat" /inheritance:r /grant:r "BUILTIN\Administrators:(OI)(CI)F" "NT AUTHORITY\SYSTEM:(OI)(CI)F" "Authenticated Users:(OI)(CI)R" /T`

### 4. Combined BracerChatRegister.ps1 — install + update + diagnose/repair (~75 min)
- Detection tree: exe missing → install; wrong version → upgrade; session missing/invalid → re-register; process not running → start
- Version constant at top of script; compare with FileVersionInfo
- Correct exe path: `C:\Program Files\Bracer Chat\Bracer Chat.exe`
- Uninstaller path: `C:\Program Files\Bracer Chat\Uninstall Bracer Chat.exe`

### 5. BracerChatRemove.ps1 (~30 min)
- New file: `deploy/BracerChatRemove.ps1`
- Injectable: `$WipeSessionData` (default 0, set 1 to also delete session.dat)
- Steps: kill process → NSIS uninstall /S → remove ProgramData (conditional) → remove desktop shortcut → log
- Desktop shortcut path (per-machine install): `C:\Users\Public\Desktop\Bracer Chat.lnk`

### 6. Build + smoke test (~30 min)
- `npm run build` (uses --config flag correctly now)
- Upload to `https://chat.bracer.ca/install/`
- Test on P14s and VM (VM install was failing — investigate during this step)

### 7. SuperOps policies (~30 min)
- Update BracerChatRegister policy with new combined script
- Create BracerChatRemove policy with $WipeSessionData variable
- Test on 2 internal machines

## Key paths
- Project: `C:\Users\Chris.Paetz\Documents\Projects\bracer-chat\`
- Exe (installed): `C:\Program Files\Bracer Chat\Bracer Chat.exe`
- Uninstaller: `C:\Program Files\Bracer Chat\Uninstall Bracer Chat.exe`
- Session file: `C:\ProgramData\BracerChat\session.dat` (DPAPI LocalMachine — kept as-is)
- Bot: `deploy/bracer-bot/bot.py` on chat-bracer-ca server (137.220.53.85)
- Build output: `dist\Bracer Chat Setup 1.0.0.exe`
- Icon source: `assets/icon.ico` (44KB, 5 sizes — do NOT regenerate, generate-icons.js skips it)

## Environment
- Working on: Chris's P14s (this machine)
- Matrix homeserver: https://chat.bracer.ca (Vultr VPS 137.220.53.85)
- SuperOps: inject `$BracerChatApiSecret` and `$CompanyName` into PS1 policies

## Parked / later
- Website chat (relay API + per-session rooms + JS widget + IP blocking) — after v1 rollout
- Matrix 90-day account cleanup routine — after v1 rollout
- Website chat intake bot (9e) — needs more thought before building
- VM install debugging — will surface during smoke test (item 6)
