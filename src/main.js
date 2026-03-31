'use strict';

// Set up file logging before anything else so all console output and
// uncaught errors are captured to C:\ProgramData\BracerChat\bracer-chat.log
require('./logger').setupLogging();

/**
 * main.js
 * Bracer Chat — Electron main process.
 *
 * Startup sequence:
 *   1. Decrypt session.dat (DPAPI LocalMachine)
 *   2. Collect machine info (hostname, serial, IP, MAC, Windows user)
 *   3. Create system-tray icon + hidden chat window
 *   4. Connect to Matrix homeserver, set display name
 *   5. Start long-poll sync loop; popup window on new staff/bot message
 *   6. On first launch: auto-post machine info to the machine room
 *   7. Poll every 60 s for Windows user changes → update Matrix display name
 */

const {
  app,
  ipcMain,
  dialog,
  desktopCapturer,
  screen,
  shell,
  clipboard,
  nativeImage,
  Menu,
  BrowserWindow
} = require('electron');

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { readSession, writeSession }       = require('./credentials');
const { getMachineInfo, getWindowsUser, getWindowsUserAsync, getCpuAndMemory, getDiskInfo, getNetworkInfo, getUptimeInfo } = require('./machine-info');
const { MatrixClient }                   = require('./matrix-client');
const { createTray, destroyTray, setTrayBadge, clearTrayBadge } = require('./tray');
const { createWindow, showWindow, hideWindow, getWindow, sendToRenderer, flashWindow, setAlwaysOnTop } = require('./window');
const { readCache, writeCache, cleanupExpired }               = require('./media-cache');
const { getAppVersion }                                      = require('./updater');
const { startLogUploader }                                    = require('./logUploader');

// ── Win32 screen-capture exclusion (WDA_EXCLUDEFROMCAPTURE) ───────────────
// Set up once at module load — koffi registers types globally and throws on duplicates.
// HWND is passed as uintptr_t (pointer-sized integer) — passing as a koffi pointer type
// gives Windows the address of the buffer, not the HWND value itself (ERROR_INVALID_WINDOW_HANDLE).
const koffi  = require('koffi');
const _user32 = koffi.load('user32.dll');
const _SetWindowDisplayAffinity = _user32.func(
  'bool __stdcall SetWindowDisplayAffinity(uintptr_t hWnd, uint32_t dwAffinity)'
);
const _GetLastError = koffi.load('kernel32.dll').func('uint32_t __stdcall GetLastError()');
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;
const WDA_NONE               = 0x00000000;

// Staff user IDs authorised to run diagnostic bang commands
const STAFF_USERS = new Set([
  '@chris.paetz:chat.bracer.ca',
  '@teri.sauve:chat.bracer.ca',
  '@bracerbot:chat.bracer.ca',
]);

// Staff bang commands — hidden from client chat UI (both the command and the response)
const HIDDEN_BANG_COMMANDS = new Set([
  '!machineinfo', '!version', '!cpu', '!disk', '!ip', '!uptime', '!help', '!alwaysontop',
]);
// Prefixes that identify diagnostic responses sent by the machine itself
const HIDDEN_RESPONSE_PREFIXES = [
  '**Disk Info**', '**CPU & Memory**', '**System Uptime**', '**Network Adapters**',
  '**Version Info**', '**Staff Commands**', '**Machine Info**',
];

/**
 * Returns true if a Matrix event should be hidden from the client chat UI.
 * Hides staff bang commands and the machine's own diagnostic responses.
 */
function isHiddenDiagnosticEvent(event, selfUserId) {
  if (event.type !== 'm.room.message') return false;
  const body = (event.content && event.content.body) || '';
  const bodyLower = body.trim().toLowerCase();
  // Hide bang commands from staff (but not !ticket)
  if (HIDDEN_BANG_COMMANDS.has(bodyLower) && STAFF_USERS.has(event.sender)) return true;
  // Hide diagnostic responses sent by this machine
  if (event.sender === selfUserId && HIDDEN_RESPONSE_PREFIXES.some(p => body.startsWith(p))) return true;
  return false;
}

// ── Constants ──────────────────────────────────────────────────────────────

const HOMESERVER_URL    = 'https://chat.bracer.ca';
const MAX_FILE_BYTES    = 100 * 1024 * 1024; // 100 MB — matches server upload limit

// ── App-level flags ────────────────────────────────────────────────────────

// Required for Windows toast notifications and proper taskbar suppression
app.setAppUserModelId('ca.bracer.chat');

// ── Single-instance lock ───────────────────────────────────────────────────
// If a second instance is launched (e.g. user double-clicks desktop shortcut
// while app is already running), quit the new instance immediately.
// The first instance handles 'second-instance' inside the ready handler
// where winInstance is in scope.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// Improves stability on headless/RDP sessions common in managed environments
app.disableHardwareAcceleration();

// ── State ──────────────────────────────────────────────────────────────────

let session          = null;   // Decrypted session.dat contents
let matrixClient     = null;
let machineInfo      = null;
let currentUser      = null;   // Currently logged-in Windows username
let userPollInterval = null;
let isAppQuitting    = false;
let companyName      = null;   // Derived from company broadcast room name
let unreadCount      = 0;      // Messages received while window not focused

// ── Window position prefs ──────────────────────────────────────────────────

const WINDOW_PREFS_PATH = 'C:\\ProgramData\\BracerChat\\window-prefs.json';

function readWindowPrefs() {
  try {
    if (fs.existsSync(WINDOW_PREFS_PATH)) {
      return JSON.parse(fs.readFileSync(WINDOW_PREFS_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[BracerChat] Failed to read window prefs:', err.message);
  }
  return { pinned: false, alwaysOnTop: true };
}

function saveWindowPrefs(prefs) {
  try {
    fs.writeFileSync(WINDOW_PREFS_PATH, JSON.stringify(prefs), 'utf8');
  } catch (err) {
    console.error('[BracerChat] Failed to save window prefs:', err.message);
  }
}

function getDefaultBounds() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + workArea.width - 360, y: workArea.y, width: 360, height: workArea.height };
}

/**
 * Show the window, resetting it to its default position/size first if unpinned.
 * Only resets when the window is currently hidden (not while visible and in use).
 */
function boundsVisibleOnAnyDisplay(b) {
  // Require at least 50px of the window to be on-screen
  const MIN_OVERLAP = 50;
  return screen.getAllDisplays().some(d => {
    const wa = d.workArea;
    return b.x + b.width  > wa.x + MIN_OVERLAP &&
           b.x            < wa.x + wa.width  - MIN_OVERLAP &&
           b.y + b.height > wa.y + MIN_OVERLAP &&
           b.y            < wa.y + wa.height - MIN_OVERLAP;
  });
}

function showAndResetIfNeeded() {
  const win = getWindow();
  const prefs = readWindowPrefs();
  let bounds = null;
  if (win && !win.isDestroyed() && !win.isVisible()) {
    if (prefs.pinned && prefs.bounds && boundsVisibleOnAnyDisplay(prefs.bounds)) {
      bounds = prefs.bounds;
    } else if (!prefs.pinned) {
      bounds = getDefaultBounds();
    } else {
      // Pinned bounds are off-screen (monitor removed/resolution changed) — fall back to default
      bounds = getDefaultBounds();
    }
  }
  const onTop = prefs.alwaysOnTop !== undefined ? prefs.alwaysOnTop : true;
  showWindow(onTop, bounds);
}

// ── Badge rendering ────────────────────────────────────────────────────────

// Renders a red circle with a white count label using a canvas element in the
// renderer process — no external dependencies required.

async function renderOverlayBadge(count) {
  const win = getWindow();
  if (!win || win.isDestroyed()) return null;
  const label    = count > 99 ? '99+' : String(count);
  const fontSize = label.length > 1 ? 8 : 11;
  const script   = `(() => {
    const c = document.createElement('canvas');
    c.width = 20; c.height = 20;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#DC2626';
    ctx.beginPath(); ctx.arc(10, 10, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'white';
    ctx.font = 'bold ${fontSize}px Arial';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(${JSON.stringify(label)}, 10, 11);
    return c.toDataURL('image/png');
  })()`;
  try {
    return nativeImage.createFromDataURL(await win.webContents.executeJavaScript(script));
  } catch (err) {
    console.error('[BracerChat] renderOverlayBadge failed:', err.message);
    return null;
  }
}

async function renderTrayBadge(count) {
  const win = getWindow();
  if (!win || win.isDestroyed()) return null;
  const label    = count > 99 ? '99+' : String(count);
  const fontSize = label.length > 1 ? 7 : 9;
  const trayUrl  = 'file:///' + path.join(__dirname, '..', 'assets', 'tray.png').replace(/\\/g, '/');
  const script   = `new Promise(resolve => {
    const c = document.createElement('canvas');
    c.width = 32; c.height = 32;
    const ctx = c.getContext('2d');
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, 32, 32);
      ctx.fillStyle = '#DC2626';
      ctx.beginPath(); ctx.arc(24, 8, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'white';
      ctx.font = 'bold ${fontSize}px Arial';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(${JSON.stringify(label)}, 24, 9);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = ${JSON.stringify(trayUrl)};
  })`;
  try {
    const dataUrl = await win.webContents.executeJavaScript(script);
    return dataUrl ? nativeImage.createFromDataURL(dataUrl) : null;
  } catch (err) {
    console.error('[BracerChat] renderTrayBadge failed:', err.message);
    return null;
  }
}

async function updateBadges(count) {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  if (count <= 0) {
    win.setOverlayIcon(null, '');
    clearTrayBadge();
    return;
  }
  const [overlayImg, trayImg] = await Promise.all([renderOverlayBadge(count), renderTrayBadge(count)]);
  if (overlayImg) win.setOverlayIcon(overlayImg, `${count} unread message${count === 1 ? '' : 's'}`);
  if (trayImg)   setTrayBadge(trayImg);
}

// ── Startup ────────────────────────────────────────────────────────────────

app.on('ready', async () => {

  // 1. Load credentials ──────────────────────────────────────────────────
  session = readSession();

  // 2. Machine info (needed for reauth if session decrypt fails) ────────
  machineInfo  = getMachineInfo();
  currentUser  = machineInfo.windowsUser;

  // If DPAPI decrypt failed (e.g., different user logged in), try server reauth
  if (!session || !session.access_token) {
    console.warn('[BracerChat] session.dat unreadable — attempting server reauth...');
    try {
      const reauthResp = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({ hostname: machineInfo.hostname, serial: machineInfo.serial });
        const opts = new URL('https://chat.bracer.ca/api/machine/reauth');
        const req = require('https').request({
          hostname: opts.hostname, path: opts.pathname, method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) }
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => res.statusCode === 200 ? resolve(JSON.parse(data)) : reject(new Error(`HTTP ${res.statusCode}: ${data}`)));
        });
        req.on('error', reject);
        req.setTimeout(15_000, () => { req.destroy(); reject(new Error('Reauth timeout')); });
        req.write(postData);
        req.end();
      });
      session = reauthResp;
      writeSession(session);
      console.log('[BracerChat] Reauth successful — new credentials saved with CurrentUser DPAPI');
    } catch (err) {
      console.error('[BracerChat] Reauth failed:', err.message);
      console.error('[BracerChat] session.dat missing and reauth failed. Run the deployment script.');
      app.quit();
      return;
    }
  }

  // 3. Startup cleanup ───────────────────────────────────────────────────
  cleanupExpired();

  // 3a. Connect to Matrix BEFORE creating the window so the renderer gets
  //     correct room IDs on its first getSessionInfo() call.
  matrixClient = new MatrixClient({
    homeserverUrl : HOMESERVER_URL,
    accessToken   : session.access_token,
    userId        : session.user_id
  });

  const displayName = `${machineInfo.hostname} (${currentUser})`;
  try {
    await matrixClient.setDisplayName(displayName);
  } catch (err) {
    console.error('[BracerChat] Failed to set display name:', err.message);
  }

  // Derive company name from company broadcast room
  if (session.room_id_company) {
    try {
      const roomName = await matrixClient.getRoomName(session.room_id_company);
      if (roomName) companyName = roomName.split(' — ')[0].trim();
    } catch (err) {
      console.warn('[BracerChat] Could not get company room name:', err.message);
    }
  }

  // Resolve broadcast room by alias — fixes stale room IDs after room rebuilds.
  // Done before createWindow so the renderer gets the correct ID immediately.
  try {
    const resolvedId = await matrixClient.resolveRoomAlias('#bracer-broadcast:chat.bracer.ca');
    if (resolvedId && resolvedId !== session.room_id_broadcast) {
      console.log(`[BracerChat] Broadcast room ID updated: ${session.room_id_broadcast} → ${resolvedId}`);
      session.room_id_broadcast = resolvedId;
      // Persist the updated room ID so future startups don't need resolution
      writeSession(session);
    }
  } catch (err) {
    console.warn('[BracerChat] Could not resolve broadcast room alias:', err.message);
  }

  // 4. Create UI ─────────────────────────────────────────────────────────
  const winInstance = createWindow(
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, '..', 'renderer', 'index.html')
  );

  // Second instance launched — only show the window if the user explicitly
  // opened the app (no flags). Automated launches (watchdog, startup, post-update
  // relaunch) pass flags and should be silently ignored.
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--watchdog') || argv.includes('--startup')) return;
    showAndResetIfNeeded();
  });

  // Close button → hide to tray (not quit)
  winInstance.on('close', (e) => {
    if (!isAppQuitting) {
      e.preventDefault();
      winInstance.hide();
    }
  });

  // Whenever the window hides, persist the current bounds if pinned.
  // This captures any resizing/moving done after the pin button was clicked.
  winInstance.on('hide', () => {
    const prefs = readWindowPrefs();
    if (prefs.pinned) {
      prefs.bounds = winInstance.getBounds();
      saveWindowPrefs(prefs);
    }
  });

  // Stop flashing and clear badges once the user focuses the window
  winInstance.on('focus', () => {
    flashWindow(false);
    if (unreadCount > 0) {
      unreadCount = 0;
      updateBadges(0);
    }
  });

  // Show window on manual launch (double-click shortcut, run from Start Menu, etc.)
  // --startup flag is passed by the HKLM Run key and the post-update relaunch task,
  // so those start hidden in the tray. Any other launch shows the window immediately.
  const isSilentLaunch = process.argv.includes('--startup') || process.argv.includes('--watchdog');
  if (!app.isPackaged || !isSilentLaunch) {
    showAndResetIfNeeded();
  }

  const initialPrefs = readWindowPrefs();
  createTray(
    path.join(__dirname, '..', 'assets', 'icon.ico'),
    () => showAndResetIfNeeded(),
    () => {
      isAppQuitting = true;
      if (matrixClient) matrixClient.stopSync();
      clearInterval(userPollInterval);
      destroyTray();
      app.quit();
    },
    () => {
      isAppQuitting = true;
      if (matrixClient) matrixClient.stopSync();
      clearInterval(userPollInterval);
      app.relaunch();
      app.quit();
    },
    () => {
      dialog.showMessageBox({
        type   : 'info',
        title  : 'About Bracer Chat',
        message: 'Bracer Chat',
        detail : [
          `Version ${app.getVersion()}`,
          '',
          'A Bracer Systems Inc. product',
          '\u00A9 2026 Bracer Systems Inc.'
        ].join('\n'),
        buttons  : ['Close'],
        defaultId: 0,
        cancelId : 0
      });
    },
    (key, value) => {
      // Setting changed from tray menu — persist and apply immediately
      const prefs = readWindowPrefs();
      prefs[key] = value;
      saveWindowPrefs(prefs);
      if (key === 'alwaysOnTop') setAlwaysOnTop(value);
    },
    { alwaysOnTop: initialPrefs.alwaysOnTop !== undefined ? initialPrefs.alwaysOnTop : true }
  );

  // 5. Listen for new messages → popup ───────────────────────────────────
  matrixClient.onMessage(({ roomId, event }) => {
    // Hidden staff commands — handled silently, never shown in the chat
    const msgBody = event.type === 'm.room.message' ? event.content?.body?.trim().toLowerCase() : null;
    const isStaff = event.sender && STAFF_USERS.has(event.sender);
    if (msgBody === '!alwaysontop' && isStaff && event.sender !== session.user_id) {
      console.log('[BracerChat] !alwaysontop received from', event.sender);
      showAndResetIfNeeded();
      setAlwaysOnTop(true);
      // Revert to the user's saved preference after 15 minutes
      setTimeout(() => {
        const savedPrefs = readWindowPrefs();
        const savedOnTop = savedPrefs.alwaysOnTop !== undefined ? savedPrefs.alwaysOnTop : true;
        setAlwaysOnTop(savedOnTop);
      }, 15 * 60 * 1000);
      return; // Don't render or pop up for this command
    }

    // !machineinfo — reply silently, don't show to client
    if (msgBody === '!machineinfo' && isStaff && event.sender !== session.user_id) {
      console.log('[BracerChat] !machineinfo received from', event.sender);
      postMachineInfo().catch(err =>
        console.error('[BracerChat] !machineinfo reply failed:', err.message));
      return;
    }

    // !version — app version, Windows version, hostname
    if (msgBody === '!version' && isStaff && event.sender !== session.user_id) {
      (async () => {
        const text = [
          '**Version Info**',
          `App:      Bracer Chat v${app.getVersion()}`,
          `Hostname: ${os.hostname()}`,
          `OS:       ${os.type()} ${os.release()} (${os.arch()})`,
          `Electron: ${process.versions.electron}`,
          `Node:     ${process.versions.node}`,
        ].join('\n');
        await matrixClient.sendMessage(session.room_id_machine, text);
      })().catch(err => console.error('[BracerChat] !version failed:', err.message));
      return;
    }

    // !cpu — CPU model, usage %, RAM used/total
    if (msgBody === '!cpu' && isStaff && event.sender !== session.user_id) {
      (async () => {
        const info = await getCpuAndMemory();
        const text = [
          '**CPU & Memory**',
          `CPU:    ${info.cpuModel}`,
          `Usage:  ${info.cpuUsage}`,
          `Memory: ${info.memory}`,
        ].join('\n');
        await matrixClient.sendMessage(session.room_id_machine, text);
      })().catch(err => console.error('[BracerChat] !cpu failed:', err.message));
      return;
    }

    // !disk — drive info with brand, model, serial, usage
    if (msgBody === '!disk' && isStaff && event.sender !== session.user_id) {
      (async () => {
        const info = await getDiskInfo();
        const lines = ['**Disk Info**'];
        if (info.disks.length) {
          lines.push('');
          for (const d of info.disks) {
            lines.push(`Drive: ${d.model} (${d.sizeGB} GB)`);
            lines.push(`  Serial: ${d.serial}`);
          }
        }
        if (info.volumes.length) {
          lines.push('');
          for (const v of info.volumes) {
            lines.push(`${v.drive} ${v.label ? '(' + v.label + ')' : ''} — ${v.usage}`);
          }
        }
        if (!info.disks.length && !info.volumes.length) {
          lines.push('Could not retrieve disk information.');
        }
        await matrixClient.sendMessage(session.room_id_machine, lines.join('\n'));
      })().catch(err => console.error('[BracerChat] !disk failed:', err.message));
      return;
    }

    // !ip — all network adapters with IPs
    if (msgBody === '!ip' && isStaff && event.sender !== session.user_id) {
      (async () => {
        const adapters = getNetworkInfo();
        const lines = ['**Network Adapters**'];
        if (adapters.length) {
          for (const a of adapters) {
            lines.push(`${a.name}: ${a.ip} (MAC: ${a.mac})${a.internal ? ' [loopback]' : ''}`);
          }
        } else {
          lines.push('No network adapters found.');
        }
        await matrixClient.sendMessage(session.room_id_machine, lines.join('\n'));
      })().catch(err => console.error('[BracerChat] !ip failed:', err.message));
      return;
    }

    // !uptime — system uptime + last reboot
    if (msgBody === '!uptime' && isStaff && event.sender !== session.user_id) {
      (async () => {
        const info = await getUptimeInfo();
        const text = [
          '**System Uptime**',
          `Uptime:      ${info.uptime}`,
          `Last Reboot: ${info.lastReboot}`,
        ].join('\n');
        await matrixClient.sendMessage(session.room_id_machine, text);
      })().catch(err => console.error('[BracerChat] !uptime failed:', err.message));
      return;
    }

    // !help — list available staff commands (technician only)
    if (msgBody === '!help' && isStaff && event.sender !== session.user_id) {
      (async () => {
        const text = [
          '**Staff Commands**',
          '',
          '!version     — App version, OS, hostname',
          '!cpu         — CPU model, usage %, RAM',
          '!disk        — Disk drives, models, serials, usage',
          '!ip          — Network adapters and IPs',
          '!uptime      — System uptime and last reboot',
          '!machineinfo — All-in-one machine summary',
          '!alwaysontop — Force window on top for 15 min',
          '!help        — This list',
        ].join('\n');
        await matrixClient.sendMessage(session.room_id_machine, text);
      })().catch(err => console.error('[BracerChat] !help failed:', err.message));
      return;
    }

    // Hide staff diagnostic commands and machine's own responses from the client UI
    if (isHiddenDiagnosticEvent(event, session.user_id)) return;

    // Forward all other messages to the renderer for display
    console.log('[BracerChat] forwarding to renderer — roomId:', roomId, 'type:', event.type, 'sender:', event.sender, 'eventId:', event.event_id);
    sendToRenderer('new-message', { roomId, event });

    // Never pop up for messages sent by this device
    if (event.sender === session.user_id) return;

    // Popup for machine room and broadcast rooms
    const isBroadcast = roomId === session.room_id_broadcast || roomId === session.room_id_company;
    if (roomId === session.room_id_machine || isBroadcast) {
      const prefs = readWindowPrefs();
      const onTop = prefs.alwaysOnTop !== undefined ? prefs.alwaysOnTop : true;
      if (onTop) {
        // Always-on-top mode: show the window immediately
        showAndResetIfNeeded();
        sendToRenderer('focus-message', { eventId: event.event_id });
      } else if (!winInstance.isVisible()) {
        // Not-on-top mode: show window behind other apps so the taskbar
        // button exists for flashing and badge overlay. Don't steal focus.
        winInstance.showInactive();
      }
      // Always flash taskbar and update badges for unread messages
      flashWindow(true);
      if (!winInstance.isFocused()) {
        updateBadges(++unreadCount);
      }
    }
  });

  // Forward typing indicators to renderer
  matrixClient.onTyping(({ roomId, userIds }) => {
    sendToRenderer('typing-update', { roomId, userIds });
  });

  matrixClient.startSync();

  // 6. Windows user polling ──────────────────────────────────────────────
  userPollInterval = setInterval(checkUserChange, 60_000);

  // 7. Self-update check ─────────────────────────────────────────────────
  // Updates are pushed via SuperOps RMM — no in-app self-updater.
  // The watchdog task (every 15 min) relaunches the app after a push update.

  // 8. Log uploader ──────────────────────────────────────────────────────
  // Uploads error log on startup (if changed) and every hour thereafter.
  startLogUploader(session.access_token);
});

app.on('before-quit', () => {
  isAppQuitting = true;
});

// Keep running in tray even when all windows are closed
app.on('window-all-closed', () => {});

// Log renderer crashes (GPU process gone, renderer killed, etc.)
app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('[BracerChat] Renderer process gone — reason:', details.reason, '| exit code:', details.exitCode);
});

app.on('child-process-gone', (_event, details) => {
  console.error('[BracerChat] Child process gone — type:', details.type, '| reason:', details.reason, '| exit code:', details.exitCode);
});

// ── Machine info command ───────────────────────────────────────────────────

async function postMachineInfo() {
  const { hostname, serial, ip, mac } = machineInfo;
  const text = [
    '**Machine Info**',
    `Hostname: ${hostname}`,
    `User:     ${currentUser}`,
    `Serial:   ${serial}`,
    `IP:       ${ip}`,
    `MAC:      ${mac}`,
    `Version:  ${app.getVersion()}`
  ].join('\n');
  await matrixClient.sendMessage(session.room_id_machine, text);
}

// ── Dynamic display name ───────────────────────────────────────────────────

async function checkUserChange() {
  try {
    const user = await getWindowsUserAsync();
    if (user && user !== currentUser && user !== 'Unknown') {
      currentUser = user;
      const newName = `${machineInfo.hostname} (${currentUser})`;
      await matrixClient.setDisplayName(newName);
      console.log('[BracerChat] Display name updated:', newName);
    }
  } catch (err) {
    console.error('[BracerChat] User-change check failed:', err.message);
  }
}

// ── IPC helpers ────────────────────────────────────────────────────────────

/** Validate that a roomId is one of the session's authorised rooms. */
function isAuthorisedRoom(roomId) {
  if (!session || typeof roomId !== 'string') return false;
  return roomId === session.room_id_machine ||
         roomId === session.room_id_broadcast ||
         roomId === session.room_id_company;
}

/** IPC rate limiter — keyed by channel name, configurable per-channel. */
const _ipcRateLimits = {};
function ipcRateLimit(channel, maxPerSec = 5) {
  const now = Date.now();
  if (!_ipcRateLimits[channel]) _ipcRateLimits[channel] = [];
  const calls = _ipcRateLimits[channel];
  // Purge entries older than 1 second
  while (calls.length && calls[0] < now - 1000) calls.shift();
  if (calls.length >= maxPerSec) return false; // rate limited
  calls.push(now);
  return true;
}

// ── IPC handlers ───────────────────────────────────────────────────────────

ipcMain.handle('get-session-info', () => {
  console.log('[BracerChat] session room IDs — machine:', session.room_id_machine,
    'broadcast:', session.room_id_broadcast, 'company:', session.room_id_company);
  return {
    userId          : session.user_id,
    machineRoomId   : session.room_id_machine,
    broadcastRoomId : session.room_id_broadcast,
    companyRoomId   : session.room_id_company,
    hostname        : machineInfo.hostname,
    windowsUser     : currentUser,
    companyName     : companyName || 'Company'
  };
});

ipcMain.handle('get-room-history', async (_event, roomId, sinceTs) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  const messages = await matrixClient.getRoomMessages(roomId, sinceTs || 0);
  return messages.filter(e => !isHiddenDiagnosticEvent(e, session.user_id));
});

ipcMain.handle('send-message', async (_event, roomId, text) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-message', 5)) throw new Error('Rate limited');
  await matrixClient.sendMessage(roomId, text);
});

ipcMain.handle('send-reply', async (_event, roomId, text, replyToEvent) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-reply', 5)) throw new Error('Rate limited');
  // Only pass the fields we actually need from the reply event
  const safeReply = {
    event_id: replyToEvent?.event_id,
    sender: replyToEvent?.sender,
    content: { body: replyToEvent?.content?.body || '[attachment]' }
  };
  await matrixClient.sendReply(roomId, text, safeReply);
});

ipcMain.handle('send-poll-response', async (_event, roomId, pollEventId, answerId) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-poll-response', 3)) throw new Error('Rate limited');
  await matrixClient.sendPollResponse(roomId, pollEventId, answerId);
});

ipcMain.handle('send-typing', async (_event, roomId, typing) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-typing', 2)) return; // silently drop excess typing
  await matrixClient.sendTyping(roomId, typing);
});

ipcMain.handle('send-read-receipt', async (_event, roomId, eventId) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-read-receipt', 3)) return; // silently drop
  await matrixClient.sendReadReceipt(roomId, eventId);
});

ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters    : [
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;

  const filePath = result.filePaths[0];
  const buf      = fs.readFileSync(filePath);
  const name     = path.basename(filePath);
  // Basic mime type detection by extension
  const ext      = path.extname(filePath).toLowerCase().slice(1);
  const mimeMap  = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain',
    zip: 'application/zip', mp4: 'video/mp4', mp3: 'audio/mpeg'
  };
  const mimeType = mimeMap[ext] || 'application/octet-stream';

  return { data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), name, mimeType };
});

ipcMain.handle('send-file', async (_event, roomId, fileData, fileName, mimeType) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-file', 2)) throw new Error('Rate limited');
  const buf          = Buffer.from(fileData);
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`File exceeds 100 MB limit (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  const resolvedMime = mimeType || 'application/octet-stream';
  const mxcUri       = await matrixClient.sendFile(roomId, buf, fileName, resolvedMime);
  return { mxcUri, fileName, mimeType: resolvedMime };
});

// Returns display layout instantly (no capture) — used to show the picker immediately.
ipcMain.handle('get-screen-layout', () => {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  return displays.map((display, i) => ({
    id        : null, // sourceId filled in later by get-screens
    label     : `Display ${i + 1}${display.id === primaryId ? ' (Primary)' : ''}`,
    bounds    : display.bounds,
    thumbnail : null
  }));
});

// Returns all connected displays with positional bounds and small thumbnails for the picker UI.
ipcMain.handle('get-screens', async () => {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;

  const sources = await desktopCapturer.getSources({
    types         : ['screen'],
    thumbnailSize : { width: 160, height: 90 }
  });

  // On Windows, desktopCapturer screen sources are ordered to match getAllDisplays().
  return displays.map((display, i) => ({
    id        : sources[i]?.id ?? null,
    label     : `Display ${i + 1}${display.id === primaryId ? ' (Primary)' : ''}`,
    bounds    : display.bounds,
    thumbnail : sources[i]?.thumbnail.toDataURL() ?? null
  }));
});

ipcMain.handle('send-screenshot', async (_event, roomId, sourceId) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  // Use WDA_EXCLUDEFROMCAPTURE to exclude this window from the DWM capture
  // pipeline — window stays visible to the user but is absent from the screenshot.
  const winRef = require('./window').getWindow();
  if (!winRef || winRef.isDestroyed()) throw new Error('Window not available for screenshot');
  // Read HWND as BigInt — getNativeWindowHandle() returns an 8-byte LE buffer on x64 Windows
  const hwnd = winRef.getNativeWindowHandle().readBigUInt64LE(0);

  _SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);

  try {
    await new Promise(r => setTimeout(r, 32));

    const sources = await desktopCapturer.getSources({
      types         : ['screen'],
      thumbnailSize : { width: 1920, height: 1080 }
    });
    if (!sources.length) throw new Error('No screen sources available');

    // Use the caller-selected sourceId; fall back to first source if not found.
    const source = (sourceId && sources.find(s => s.id === sourceId)) || sources[0];

    const pngBuffer = source.thumbnail.toPNG();
    const fileName  = `screenshot-${Date.now()}.png`;
    const mxcUri    = await matrixClient.sendImage(roomId, pngBuffer, fileName, 'image/png');
    return { mxcUri, fileName };
  } finally {
    _SetWindowDisplayAffinity(hwnd, WDA_NONE);
  }
});

ipcMain.handle('resolve-media-url', async (_event, mxcUri) => {
  // Check encrypted local cache first — avoids re-fetching on every app open.
  const cached = readCache(mxcUri);
  if (cached) {
    return `data:${cached.mimeType};base64,${cached.buffer.toString('base64')}`;
  }

  // Cache miss — fetch from Matrix with auth, then cache for next time.
  try {
    const { buffer, mimeType } = await matrixClient.fetchMedia(mxcUri);
    writeCache(mxcUri, buffer, mimeType);
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.error('[BracerChat] resolve-media-url failed:', err.message);
    return null;
  }
});

ipcMain.handle('clipboard-write', (_event, text) => {
  clipboard.writeText(typeof text === 'string' ? text : '');
});

ipcMain.handle('clipboard-write-image', (_event, dataUrl) => {
  // L6: Validate data URL format and enforce size limit (10 MB) to prevent memory exhaustion
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('Invalid image data URL');
  const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;
  if (dataUrl.length > MAX_DATA_URL_BYTES) throw new Error('Image data too large for clipboard');
  const img = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(img);
});

ipcMain.handle('save-text-file', async (_event, { content, defaultName, filters }) => {
  // M6: Validate content — size limit and basic format check
  if (typeof content !== 'string') throw new Error('Invalid content');
  const MAX_EXPORT_BYTES = 10 * 1024 * 1024; // 10 MB
  if (Buffer.byteLength(content, 'utf8') > MAX_EXPORT_BYTES) throw new Error('Export too large (max 10 MB)');
  const { filePath, canceled } = await dialog.showSaveDialog({
    title      : 'Export Chat',
    defaultPath: path.join(os.homedir(), 'Downloads', defaultName || 'export.html'),
    buttonLabel: 'Save',
    filters    : filters || [{ name: 'HTML', extensions: ['html'] }]
  });
  if (canceled || !filePath) return false;
  fs.writeFileSync(filePath, content, 'utf8');
  await shell.showItemInFolder(filePath);
  return true;
});

// Only allow opening https:// URLs to prevent protocol-handler abuse
ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url);
  }
});

// Open an image in the default OS photo app — saves to temp, no Save As prompt
// L2: Restrict to known image extensions to prevent OS handler abuse
const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.heic']);

ipcMain.handle('open-image-in-app', async (_event, mxcUri, fileName) => {
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = path.extname(safeName).toLowerCase();
  // Force .png if the extension is not a known image type
  const safeFinal = ALLOWED_IMAGE_EXTS.has(ext) ? safeName : safeName + '.png';
  const tmpPath   = path.join(os.tmpdir(), `bracer-img-${Date.now()}-${safeFinal}`);
  const { buffer } = await matrixClient.fetchMedia(mxcUri);
  fs.writeFileSync(tmpPath, buffer);
  await shell.openPath(tmpPath);
});

// Show a native Cut / Copy / Paste context menu for text inputs.
// The Paste item checks the Electron clipboard directly so that image data
// (Win+Shift+S snips, copied images) is sent as an m.image upload rather than
// falling back to an empty / blank file that webContents.paste() would produce.
ipcMain.on('show-input-context-menu', (event) => {
  const menu = Menu.buildFromTemplate([
    { role: 'cut' },
    { role: 'copy' },
    {
      label      : 'Paste',
      accelerator: 'CmdOrCtrl+V',
      click      : () => {
        const img = clipboard.readImage();
        if (!img.isEmpty()) {
          // Send PNG buffer as base64 to renderer for upload
          event.sender.send('paste-clipboard-image', img.toPNG().toString('base64'));
        } else {
          BrowserWindow.fromWebContents(event.sender).webContents.paste();
        }
      }
    },
    { type: 'separator' },
    { role: 'selectAll' }
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(event.sender) });
});

// Read clipboard image via Electron native API — used as a fallback in the renderer
// paste handler when clipboardData.items returns an empty file (Windows DIB format).
ipcMain.handle('read-clipboard-image', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return img.toPNG().toString('base64');
});

// Fetch a single Matrix event by ID (used to resolve pinned event details)
ipcMain.handle('get-room-event', async (_event, roomId, eventId) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  return matrixClient.getEvent(roomId, eventId);
});

// Pinned events — read from / write to Matrix m.room.pinned_events state
ipcMain.handle('get-pinned-events', async (_event, roomId) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  return matrixClient.getPinnedEvents(roomId);
});

ipcMain.handle('set-pinned-events', async (_event, roomId, pinnedIds) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!Array.isArray(pinnedIds)) throw new Error('Invalid pinnedIds');
  return matrixClient.setPinnedEvents(roomId, pinnedIds);
});

// Download a file (with auth) — shows a native Save As dialog
ipcMain.handle('download-file', async (_event, mxcUri, fileName) => {
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');

  const { filePath, canceled } = await dialog.showSaveDialog({
    title      : 'Save file',
    defaultPath: path.join(os.homedir(), 'Downloads', safeName),
    buttonLabel: 'Save'
  });

  if (canceled || !filePath) return;

  const { buffer } = await matrixClient.fetchMedia(mxcUri);
  fs.writeFileSync(filePath, buffer);
  await shell.showItemInFolder(filePath); // reveal in Explorer after save
});

// Window pin state — controls whether the window returns to its default
// position/size when shown, or remembers a custom position.
ipcMain.handle('get-pin-state', () => {
  return readWindowPrefs();
});

ipcMain.handle('set-pin-state', (_event, pinned) => {
  const prefs = readWindowPrefs();
  prefs.pinned = pinned;
  if (pinned) {
    const win = getWindow();
    if (win && !win.isDestroyed()) prefs.bounds = win.getBounds();
  } else {
    delete prefs.bounds;
  }
  saveWindowPrefs(prefs);
});
