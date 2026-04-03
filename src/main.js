'use strict';

// Set up file logging before anything else so all console output and
// uncaught errors are captured to C:\ProgramData\BracerChat\bracer-chat.log
require('./logger').setupLogging();

/**
 * main.js
 * Bracer Chat — Electron main process.
 *
 * Startup sequence:
 *   1. Decrypt session.dat (DPAPI CurrentUser)
 *   2. Collect machine info (hostname, serial, IP, MAC, Windows user)
 *   3. Create system-tray icon + hidden chat window
 *   4. Connect to Rocket.Chat via REST + DDP WebSocket
 *   5. Subscribe to rooms; popup window on new staff/bot message
 *   6. Poll every 60 s for Windows user changes
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
const { RocketChatClient }                = require('./rocketchat-client');
const { createTray, destroyTray, setTrayBadge, clearTrayBadge } = require('./tray');
const { createWindow, showWindow, hideWindow, getWindow, sendToRenderer, flashWindow, setAlwaysOnTop } = require('./window');
const { readCache, writeCache, cleanupExpired }               = require('./media-cache');
const { getAppVersion }                                      = require('./updater');
const { startLogUploader }                                    = require('./logUploader');

// ── Win32 screen-capture exclusion (WDA_EXCLUDEFROMCAPTURE) ───────────────
const koffi  = require('koffi');
const _user32 = koffi.load('user32.dll');
const _SetWindowDisplayAffinity = _user32.func(
  'bool __stdcall SetWindowDisplayAffinity(uintptr_t hWnd, uint32_t dwAffinity)'
);
const _GetLastError = koffi.load('kernel32.dll').func('uint32_t __stdcall GetLastError()');
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;
const WDA_NONE               = 0x00000000;

// Staff usernames authorised to run diagnostic bang commands (RC usernames, not IDs)
const STAFF_USERS = new Set([
  'chris.paetz',
  'teri.sauve',
  'bracerbot',
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
 * Returns true if an RC message should be hidden from the client chat UI.
 * Hides staff bang commands and the machine's own diagnostic responses.
 * @param {object} message  RC message object { msg, u: { username, _id }, ... }
 * @param {string} selfUserId  Our RC user ID
 */
function isHiddenDiagnosticMessage(message, selfUserId) {
  const body = (message.msg || '').trim();
  const bodyLower = body.toLowerCase();
  const senderUsername = message.u?.username || '';

  // Hide bang commands from staff (but not !ticket)
  if (HIDDEN_BANG_COMMANDS.has(bodyLower) && STAFF_USERS.has(senderUsername)) return true;

  // Hide diagnostic responses sent by this machine
  if (message.u?._id === selfUserId && HIDDEN_RESPONSE_PREFIXES.some(p => body.startsWith(p))) return true;

  return false;
}

// ── Constants ──────────────────────────────────────────────────────────────

const SERVER_URL        = 'https://chat.bracer.ca';
const MAX_FILE_BYTES    = 100 * 1024 * 1024; // 100 MB — matches server upload limit

// ── App-level flags ────────────────────────────────────────────────────────

app.setAppUserModelId('ca.bracer.chat');

// ── Single-instance lock ───────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.disableHardwareAcceleration();

// ── State ──────────────────────────────────────────────────────────────────

let session          = null;   // Decrypted session.dat contents
let rcClient         = null;
let machineInfo      = null;
let currentUser      = null;   // Currently logged-in Windows username
let userPollInterval = null;
let isAppQuitting    = false;
let companyName      = null;
let unreadCount      = 0;

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

function boundsVisibleOnAnyDisplay(b) {
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
      bounds = getDefaultBounds();
    }
  }
  const onTop = prefs.alwaysOnTop !== undefined ? prefs.alwaysOnTop : true;
  showWindow(onTop, bounds);
}

// ── Badge rendering ────────────────────────────────────────────────────────

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

// ── Helper: get room IDs from session ──────────────────────────────────────

function getRoomIds() {
  if (!session) return {};
  // Support both old Matrix field names and new RC format
  return {
    machine  : session.roomIds?.machine   || session.room_id_machine,
    broadcast: session.roomIds?.broadcast  || session.room_id_broadcast,
    company  : session.roomIds?.company    || session.room_id_company,
  };
}

// ── Startup ────────────────────────────────────────────────────────────────

app.on('ready', async () => {

  // 1. Load credentials ──────────────────────────────────────────────────
  session = readSession();

  // 2. Machine info (needed for reauth if session decrypt fails) ────────
  machineInfo  = getMachineInfo();
  currentUser  = machineInfo.windowsUser;

  // Check for RC-format auth token (authToken) or legacy Matrix format (access_token)
  const hasValidSession = session && (session.authToken || session.access_token);

  if (!hasValidSession) {
    console.warn('[BracerChat] session.dat unreadable — attempting server reauth...');
    try {
      const reauthResp = await new Promise((resolve, reject) => {
        const postData = JSON.stringify({ hostname: machineInfo.hostname, serial: machineInfo.serial });
        const opts = new URL(`${SERVER_URL}/api/machine/reauth`);
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

  // Extract auth credentials (support both new RC and legacy Matrix field names)
  const authToken = session.authToken || session.access_token;
  const userId    = session.userId    || session.user_id;
  const roomIds   = getRoomIds();

  // 3a. Connect to Rocket.Chat BEFORE creating the window so the renderer gets
  //     correct room IDs on its first getSessionInfo() call.
  rcClient = new RocketChatClient({
    serverUrl : SERVER_URL,
    authToken,
    userId
  });

  // Get user info (sets rcClient.username)
  try {
    await rcClient.getMe();
  } catch (err) {
    console.error('[BracerChat] Failed to get user info:', err.message);
  }

  // Derive company name from company broadcast room
  if (roomIds.company) {
    try {
      const roomName = await rcClient.getRoomName(roomIds.company);
      if (roomName) companyName = roomName.split(' — ')[0].trim();
    } catch (err) {
      console.warn('[BracerChat] Could not get company room name:', err.message);
    }
  }

  // 4. Create UI ─────────────────────────────────────────────────────────
  const winInstance = createWindow(
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, '..', 'renderer', 'index.html')
  );

  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--watchdog') || argv.includes('--startup')) return;
    showAndResetIfNeeded();
  });

  winInstance.on('close', (e) => {
    if (!isAppQuitting) {
      e.preventDefault();
      winInstance.hide();
    }
  });

  winInstance.on('hide', () => {
    const prefs = readWindowPrefs();
    if (prefs.pinned) {
      prefs.bounds = winInstance.getBounds();
      saveWindowPrefs(prefs);
    }
  });

  winInstance.on('focus', () => {
    flashWindow(false);
    if (unreadCount > 0) {
      unreadCount = 0;
      updateBadges(0);
    }
  });

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
      if (rcClient) rcClient.disconnectDDP();
      clearInterval(userPollInterval);
      destroyTray();
      app.quit();
    },
    () => {
      isAppQuitting = true;
      if (rcClient) rcClient.disconnectDDP();
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
      const prefs = readWindowPrefs();
      prefs[key] = value;
      saveWindowPrefs(prefs);
      if (key === 'alwaysOnTop') setAlwaysOnTop(value);
    },
    { alwaysOnTop: initialPrefs.alwaysOnTop !== undefined ? initialPrefs.alwaysOnTop : true }
  );

  // 5. Listen for new messages via DDP ──────────────────────────────────
  rcClient.onMessage(({ roomId, message }) => {
    const msgBody  = (message.msg || '').trim().toLowerCase();
    const senderUsername = message.u?.username || '';
    const senderId = message.u?._id || '';
    const isStaff  = STAFF_USERS.has(senderUsername);
    const selfId   = userId;

    // !alwaysontop — show + force on top for 15 min
    if (msgBody === '!alwaysontop' && isStaff && senderId !== selfId) {
      console.log('[BracerChat] !alwaysontop received from', senderUsername);
      showAndResetIfNeeded();
      setAlwaysOnTop(true);
      setTimeout(() => {
        const savedPrefs = readWindowPrefs();
        const savedOnTop = savedPrefs.alwaysOnTop !== undefined ? savedPrefs.alwaysOnTop : true;
        setAlwaysOnTop(savedOnTop);
      }, 15 * 60 * 1000);
      return;
    }

    // !machineinfo — reply silently
    if (msgBody === '!machineinfo' && isStaff && senderId !== selfId) {
      console.log('[BracerChat] !machineinfo received from', senderUsername);
      postMachineInfo().catch(err =>
        console.error('[BracerChat] !machineinfo reply failed:', err.message));
      return;
    }

    // !version
    if (msgBody === '!version' && isStaff && senderId !== selfId) {
      (async () => {
        const text = [
          '**Version Info**',
          `App:      Bracer Chat v${app.getVersion()}`,
          `Hostname: ${os.hostname()}`,
          `OS:       ${os.type()} ${os.release()} (${os.arch()})`,
          `Electron: ${process.versions.electron}`,
          `Node:     ${process.versions.node}`,
        ].join('\n');
        await rcClient.sendNotice(roomIds.machine, text);
      })().catch(err => console.error('[BracerChat] !version failed:', err.message));
      return;
    }

    // !cpu
    if (msgBody === '!cpu' && isStaff && senderId !== selfId) {
      (async () => {
        const info = await getCpuAndMemory();
        const text = [
          '**CPU & Memory**',
          `CPU:    ${info.cpuModel}`,
          `Usage:  ${info.cpuUsage}`,
          `Memory: ${info.memory}`,
        ].join('\n');
        await rcClient.sendNotice(roomIds.machine, text);
      })().catch(err => console.error('[BracerChat] !cpu failed:', err.message));
      return;
    }

    // !disk
    if (msgBody === '!disk' && isStaff && senderId !== selfId) {
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
        await rcClient.sendNotice(roomIds.machine, lines.join('\n'));
      })().catch(err => console.error('[BracerChat] !disk failed:', err.message));
      return;
    }

    // !ip
    if (msgBody === '!ip' && isStaff && senderId !== selfId) {
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
        await rcClient.sendNotice(roomIds.machine, lines.join('\n'));
      })().catch(err => console.error('[BracerChat] !ip failed:', err.message));
      return;
    }

    // !uptime
    if (msgBody === '!uptime' && isStaff && senderId !== selfId) {
      (async () => {
        const info = await getUptimeInfo();
        const text = [
          '**System Uptime**',
          `Uptime:      ${info.uptime}`,
          `Last Reboot: ${info.lastReboot}`,
        ].join('\n');
        await rcClient.sendNotice(roomIds.machine, text);
      })().catch(err => console.error('[BracerChat] !uptime failed:', err.message));
      return;
    }

    // !help
    if (msgBody === '!help' && isStaff && senderId !== selfId) {
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
        await rcClient.sendNotice(roomIds.machine, text);
      })().catch(err => console.error('[BracerChat] !help failed:', err.message));
      return;
    }

    // Hide staff diagnostic commands and machine's own responses from the client UI
    if (isHiddenDiagnosticMessage(message, selfId)) return;

    // Forward all other messages to the renderer for display
    console.log('[BracerChat] forwarding to renderer — roomId:', roomId, 'sender:', senderUsername, 'msgId:', message._id);
    sendToRenderer('new-message', { roomId, message });

    // Never pop up for messages sent by this device
    if (senderId === selfId) return;

    // Popup for machine room and broadcast rooms
    const isBroadcast = roomId === roomIds.broadcast || roomId === roomIds.company;
    if (roomId === roomIds.machine || isBroadcast) {
      const prefs = readWindowPrefs();
      const onTop = prefs.alwaysOnTop !== undefined ? prefs.alwaysOnTop : true;
      if (onTop) {
        showAndResetIfNeeded();
        sendToRenderer('focus-message', { messageId: message._id });
      } else if (!winInstance.isVisible()) {
        winInstance.showInactive();
      }
      flashWindow(true);
      if (!winInstance.isFocused()) {
        updateBadges(++unreadCount);
      }
    }
  });

  // Forward typing indicators to renderer
  // RC DDP sends individual typing events: { roomId, username, isTyping }
  // We accumulate active typers per room and forward the current list.
  const _activeTypers = {}; // roomId -> { username: timeoutId }

  rcClient.onTyping(({ roomId, username, isTyping }) => {
    if (!_activeTypers[roomId]) _activeTypers[roomId] = {};

    // Clear any existing timeout for this user
    if (_activeTypers[roomId][username]) {
      clearTimeout(_activeTypers[roomId][username]);
    }

    if (isTyping) {
      // Auto-expire after 5 seconds (in case stop-typing is missed)
      _activeTypers[roomId][username] = setTimeout(() => {
        delete _activeTypers[roomId][username];
        const usernames = Object.keys(_activeTypers[roomId]);
        sendToRenderer('typing-update', { roomId, usernames });
      }, 5000);
    } else {
      delete _activeTypers[roomId][username];
    }

    const usernames = Object.keys(_activeTypers[roomId]);
    sendToRenderer('typing-update', { roomId, usernames });
  });

  // Connect DDP WebSocket and subscribe to all rooms
  const allRoomIds = [roomIds.machine, roomIds.broadcast, roomIds.company].filter(Boolean);
  try {
    await rcClient.connectDDP(allRoomIds);
    console.log('[BracerChat] DDP connected, subscribed to', allRoomIds.length, 'rooms');
  } catch (err) {
    console.error('[BracerChat] DDP connection failed:', err.message);
    // App still works via REST — DDP will auto-reconnect
  }

  // 6. Windows user polling ──────────────────────────────────────────────
  userPollInterval = setInterval(checkUserChange, 60_000);

  // 7. Log uploader ──────────────────────────────────────────────────────
  startLogUploader(authToken);
});

app.on('before-quit', () => {
  isAppQuitting = true;
});

app.on('window-all-closed', () => {});

app.on('render-process-gone', (_event, _webContents, details) => {
  console.error('[BracerChat] Renderer process gone — reason:', details.reason, '| exit code:', details.exitCode);
});

app.on('child-process-gone', (_event, details) => {
  console.error('[BracerChat] Child process gone — type:', details.type, '| reason:', details.reason, '| exit code:', details.exitCode);
});

// ── Machine info command ───────────────────────────────────────────────────

async function postMachineInfo() {
  const { hostname, serial, ip, mac } = machineInfo;
  const roomIds = getRoomIds();
  const text = [
    '**Machine Info**',
    `Hostname: ${hostname}`,
    `User:     ${currentUser}`,
    `Serial:   ${serial}`,
    `IP:       ${ip}`,
    `MAC:      ${mac}`,
    `Version:  ${app.getVersion()}`
  ].join('\n');
  await rcClient.sendNotice(roomIds.machine, text);
}

// ── Dynamic display name (user change detection) ─────────────────────────

async function checkUserChange() {
  try {
    const user = await getWindowsUserAsync();
    if (user && user !== currentUser && user !== 'Unknown') {
      currentUser = user;
      // RC doesn't support display name changes via API in the same way as Matrix.
      // The hostname (username) is set at registration. We just track the user change
      // for session info and machine info commands.
      console.log('[BracerChat] Windows user changed to:', currentUser);
    }
  } catch (err) {
    console.error('[BracerChat] User-change check failed:', err.message);
  }
}

// ── IPC helpers ────────────────────────────────────────────────────────────

function isAuthorisedRoom(roomId) {
  if (!session || typeof roomId !== 'string') return false;
  const rooms = getRoomIds();
  return roomId === rooms.machine ||
         roomId === rooms.broadcast ||
         roomId === rooms.company;
}

const _ipcRateLimits = {};
function ipcRateLimit(channel, maxPerSec = 5) {
  const now = Date.now();
  if (!_ipcRateLimits[channel]) _ipcRateLimits[channel] = [];
  const calls = _ipcRateLimits[channel];
  while (calls.length && calls[0] < now - 1000) calls.shift();
  if (calls.length >= maxPerSec) return false;
  calls.push(now);
  return true;
}

// ── IPC handlers ───────────────────────────────────────────────────────────

ipcMain.handle('get-session-info', () => {
  const rooms = getRoomIds();
  console.log('[BracerChat] session room IDs — machine:', rooms.machine,
    'broadcast:', rooms.broadcast, 'company:', rooms.company);
  return {
    userId          : session.userId || session.user_id,
    username        : rcClient?.username || '',
    machineRoomId   : rooms.machine,
    broadcastRoomId : rooms.broadcast,
    companyRoomId   : rooms.company,
    hostname        : machineInfo.hostname,
    windowsUser     : currentUser,
    companyName     : companyName || 'Company'
  };
});

ipcMain.handle('get-room-history', async (_event, roomId, sinceTs) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  const messages = await rcClient.getRoomMessages(roomId, sinceTs || 0);
  const selfId = session.userId || session.user_id;
  return messages.filter(m => !isHiddenDiagnosticMessage(m, selfId));
});

ipcMain.handle('send-message', async (_event, roomId, text) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-message', 5)) throw new Error('Rate limited');
  return rcClient.sendMessage(roomId, text);
});

ipcMain.handle('send-reply', async (_event, roomId, text, replyToMsg) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-reply', 5)) throw new Error('Rate limited');
  // Only need the _id from the message being replied to
  const safeReply = { _id: replyToMsg?._id };
  return rcClient.sendReply(roomId, text, safeReply);
});

ipcMain.handle('send-typing', async (_event, roomId, typing) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-typing', 2)) return;
  rcClient.sendTyping(roomId, typing);
});

ipcMain.handle('send-read-receipt', async (_event, roomId) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  if (!ipcRateLimit('send-read-receipt', 3)) return;
  await rcClient.sendReadReceipt(roomId);
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
  const buf = Buffer.from(fileData);
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`File exceeds 100 MB limit (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  const resolvedMime = mimeType || 'application/octet-stream';
  const msg = await rcClient.sendFile(roomId, buf, fileName, resolvedMime);
  // Return file URL from the message attachments
  const fileUrl = msg?.attachments?.[0]?.title_link || msg?.file?._id || null;
  return { fileUrl, fileName, mimeType: resolvedMime };
});

ipcMain.handle('get-screen-layout', () => {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;
  return displays.map((display, i) => ({
    id        : null,
    label     : `Display ${i + 1}${display.id === primaryId ? ' (Primary)' : ''}`,
    bounds    : display.bounds,
    thumbnail : null
  }));
});

ipcMain.handle('get-screens', async () => {
  const displays = screen.getAllDisplays();
  const primaryId = screen.getPrimaryDisplay().id;

  const sources = await desktopCapturer.getSources({
    types         : ['screen'],
    thumbnailSize : { width: 160, height: 90 }
  });

  return displays.map((display, i) => ({
    id        : sources[i]?.id ?? null,
    label     : `Display ${i + 1}${display.id === primaryId ? ' (Primary)' : ''}`,
    bounds    : display.bounds,
    thumbnail : sources[i]?.thumbnail.toDataURL() ?? null
  }));
});

ipcMain.handle('send-screenshot', async (_event, roomId, sourceId) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  const winRef = require('./window').getWindow();
  if (!winRef || winRef.isDestroyed()) throw new Error('Window not available for screenshot');
  const hwnd = winRef.getNativeWindowHandle().readBigUInt64LE(0);

  _SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);

  try {
    await new Promise(r => setTimeout(r, 32));

    const sources = await desktopCapturer.getSources({
      types         : ['screen'],
      thumbnailSize : { width: 1920, height: 1080 }
    });
    if (!sources.length) throw new Error('No screen sources available');

    const source = (sourceId && sources.find(s => s.id === sourceId)) || sources[0];

    const pngBuffer = source.thumbnail.toPNG();
    const fileName  = `screenshot-${Date.now()}.png`;
    const msg       = await rcClient.sendImage(roomId, pngBuffer, fileName, 'image/png');
    const fileUrl   = msg?.attachments?.[0]?.title_link || null;
    return { fileUrl, fileName };
  } finally {
    _SetWindowDisplayAffinity(hwnd, WDA_NONE);
  }
});

ipcMain.handle('resolve-media-url', async (_event, mediaUri) => {
  // Check encrypted local cache first
  const cached = readCache(mediaUri);
  if (cached) {
    return `data:${cached.mimeType};base64,${cached.buffer.toString('base64')}`;
  }

  // Cache miss — fetch from RC with auth, then cache for next time.
  try {
    const { buffer, mimeType } = await rcClient.fetchMedia(mediaUri);
    writeCache(mediaUri, buffer, mimeType);
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
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) throw new Error('Invalid image data URL');
  const MAX_DATA_URL_BYTES = 10 * 1024 * 1024;
  if (dataUrl.length > MAX_DATA_URL_BYTES) throw new Error('Image data too large for clipboard');
  const img = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(img);
});

ipcMain.handle('save-text-file', async (_event, { content, defaultName, filters }) => {
  if (typeof content !== 'string') throw new Error('Invalid content');
  const MAX_EXPORT_BYTES = 10 * 1024 * 1024;
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

ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url);
  }
});

const ALLOWED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.svg', '.heic']);

ipcMain.handle('open-image-in-app', async (_event, mediaUri, fileName) => {
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
  const ext = path.extname(safeName).toLowerCase();
  const safeFinal = ALLOWED_IMAGE_EXTS.has(ext) ? safeName : safeName + '.png';
  const tmpPath   = path.join(os.tmpdir(), `bracer-img-${Date.now()}-${safeFinal}`);
  const { buffer } = await rcClient.fetchMedia(mediaUri);
  fs.writeFileSync(tmpPath, buffer);
  await shell.openPath(tmpPath);
});

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

ipcMain.handle('read-clipboard-image', () => {
  const img = clipboard.readImage();
  if (img.isEmpty()) return null;
  return img.toPNG().toString('base64');
});

// Fetch a single RC message by ID (used to resolve pinned message details, replies)
ipcMain.handle('get-room-event', async (_event, roomId, messageId) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  return rcClient.getMessage(messageId);
});

// Pinned messages — uses RC native pin API
ipcMain.handle('get-pinned-events', async (_event, roomId) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  return rcClient.getPinnedMessages(roomId);
});

ipcMain.handle('set-pinned-events', async (_event, roomId, pinnedIds) => {
  if (!isAuthorisedRoom(roomId)) throw new Error('Unauthorised room');
  // RC uses individual pin/unpin per message, not a full list overwrite.
  // This handler accepts a list and is called from the renderer with the updated list.
  // For now, we delegate pin/unpin logic to the renderer which calls
  // pin-message or unpin-message directly. Keep this handler for backwards compat.
  return pinnedIds;
});

ipcMain.handle('pin-message', async (_event, messageId) => {
  return rcClient.pinMessage(messageId);
});

ipcMain.handle('unpin-message', async (_event, messageId) => {
  return rcClient.unpinMessage(messageId);
});

// Download a file (with auth) — shows a native Save As dialog
ipcMain.handle('download-file', async (_event, mediaUri, fileName) => {
  const safeName = path.basename(fileName).replace(/[^a-zA-Z0-9._-]/g, '_');

  const { filePath, canceled } = await dialog.showSaveDialog({
    title      : 'Save file',
    defaultPath: path.join(os.homedir(), 'Downloads', safeName),
    buttonLabel: 'Save'
  });

  if (canceled || !filePath) return;

  const { buffer } = await rcClient.fetchMedia(mediaUri);
  fs.writeFileSync(filePath, buffer);
  await shell.showItemInFolder(filePath);
});

// Window pin state
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
