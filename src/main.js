'use strict';

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
  shell,
  session: electronSession
} = require('electron');

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const { readSession }                    = require('./credentials');
const { getMachineInfo, getWindowsUser } = require('./machine-info');
const { MatrixClient }                   = require('./matrix-client');
const { createTray, destroyTray }        = require('./tray');
const { createWindow, showWindow, sendToRenderer } = require('./window');

// ── Constants ──────────────────────────────────────────────────────────────

const HOMESERVER_URL    = 'https://chat.bracer.ca';
const FIRST_LAUNCH_PATH = 'C:\\ProgramData\\BracerChat\\first_launch_done';
const MAX_FILE_BYTES    = 100 * 1024 * 1024; // 100 MB — matches server upload limit

// ── App-level flags ────────────────────────────────────────────────────────

// Required for Windows toast notifications and proper taskbar suppression
app.setAppUserModelId('ca.bracer.chat');

// Improves stability on headless/RDP sessions common in managed environments
app.disableHardwareAcceleration();

// ── State ──────────────────────────────────────────────────────────────────

let session          = null;   // Decrypted session.dat contents
let matrixClient     = null;
let machineInfo      = null;
let currentUser      = null;   // Currently logged-in Windows username
let userPollInterval = null;
let isAppQuitting    = false;

// ── Startup ────────────────────────────────────────────────────────────────

app.on('ready', async () => {

  // 1. Load credentials ──────────────────────────────────────────────────
  session = readSession();
  if (!session || !session.access_token) {
    console.error('[BracerChat] session.dat missing or invalid. Run the deployment script first.');
    app.quit();
    return;
  }

  // 2. Machine info ──────────────────────────────────────────────────────
  machineInfo  = getMachineInfo();
  currentUser  = machineInfo.windowsUser;

  // 3. Create UI ─────────────────────────────────────────────────────────
  const winInstance = createWindow(
    path.join(__dirname, 'preload.js'),
    path.join(__dirname, '..', 'renderer', 'index.html')
  );

  // Close button → hide to tray (not quit)
  winInstance.on('close', (e) => {
    if (!isAppQuitting) {
      e.preventDefault();
      winInstance.hide();
    }
  });

  // In dev mode, show the window immediately for testing
  if (!app.isPackaged) {
    showWindow(false);
  }

  createTray(
    path.join(__dirname, '..', 'assets', 'tray.png'),
    () => showWindow(false),
    () => {
      isAppQuitting = true;
      if (matrixClient) matrixClient.stopSync();
      clearInterval(userPollInterval);
      destroyTray();
      app.quit();
    }
  );

  // 4a. Inject auth header for authenticated media downloads ─────────────
  // Synapse 1.99+ requires auth on /_matrix/client/v1/media/download
  electronSession.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${HOMESERVER_URL}/_matrix/client/v1/media/*`] },
    (details, callback) => {
      if (session && session.access_token) {
        details.requestHeaders['Authorization'] = `Bearer ${session.access_token}`;
      }
      callback({ requestHeaders: details.requestHeaders });
    }
  );

  // 4. Connect to Matrix ─────────────────────────────────────────────────
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

  // 5. Listen for new messages → popup ───────────────────────────────────
  matrixClient.onMessage(({ roomId, event }) => {
    // Forward all messages to the renderer for display
    sendToRenderer('new-message', { roomId, event });

    // Only trigger the popup for the machine's own support room
    if (roomId === session.room_id_machine) {
      showWindow(true); // alwaysOnTop for 5 s
      // Tell renderer to expand pinned panel and scroll to this message
      sendToRenderer('focus-message', { eventId: event.event_id });
    }
  });

  matrixClient.startSync();

  // 6. First-launch info post ────────────────────────────────────────────
  if (!fs.existsSync(FIRST_LAUNCH_PATH)) {
    try {
      await postMachineInfo();
      fs.writeFileSync(FIRST_LAUNCH_PATH, new Date().toISOString());
    } catch (err) {
      console.error('[BracerChat] First-launch post failed:', err.message);
    }
  }

  // 7. Windows user polling ──────────────────────────────────────────────
  userPollInterval = setInterval(checkUserChange, 60_000);
});

app.on('before-quit', () => {
  isAppQuitting = true;
});

// Keep running in tray even when all windows are closed
app.on('window-all-closed', () => {});

// ── First-launch info post ─────────────────────────────────────────────────

async function postMachineInfo() {
  const { hostname, windowsUser, serial, ip, mac } = machineInfo;
  const text = [
    '**Machine registered with Bracer Chat**',
    `Hostname: ${hostname}`,
    `User:     ${windowsUser}`,
    `Serial:   ${serial}`,
    `IP:       ${ip}`,
    `MAC:      ${mac}`
  ].join('\n');
  await matrixClient.sendMessage(session.room_id_machine, text);
}

// ── Dynamic display name ───────────────────────────────────────────────────

async function checkUserChange() {
  try {
    const user = getWindowsUser();
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

// ── IPC handlers ───────────────────────────────────────────────────────────

ipcMain.handle('get-session-info', () => ({
  userId          : session.user_id,
  machineRoomId   : session.room_id_machine,
  broadcastRoomId : session.room_id_broadcast,
  companyRoomId   : session.room_id_company,
  hostname        : machineInfo.hostname,
  windowsUser     : currentUser
}));

ipcMain.handle('get-room-history', async (_event, roomId) => {
  return matrixClient.getRoomMessages(roomId);
});

ipcMain.handle('send-message', async (_event, roomId, text) => {
  await matrixClient.sendMessage(roomId, text);
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
  const buf          = Buffer.from(fileData);
  if (buf.length > MAX_FILE_BYTES) {
    throw new Error(`File exceeds 100 MB limit (${(buf.length / 1024 / 1024).toFixed(1)} MB)`);
  }
  const resolvedMime = mimeType || 'application/octet-stream';
  const mxcUri       = await matrixClient.sendFile(roomId, buf, fileName, resolvedMime);
  return { mxcUri, fileName, mimeType: resolvedMime };
});

ipcMain.handle('send-screenshot', async (_event, roomId) => {
  const sources = await desktopCapturer.getSources({
    types         : ['screen'],
    thumbnailSize : { width: 1920, height: 1080 }
  });
  if (!sources.length) throw new Error('No screen sources available');

  const pngBuffer = sources[0].thumbnail.toPNG();
  const fileName  = `screenshot-${Date.now()}.png`;
  const mxcUri    = await matrixClient.sendImage(roomId, pngBuffer, fileName, 'image/png');
  return { mxcUri, fileName };
});

ipcMain.handle('resolve-media-url', (_event, mxcUri) => {
  return matrixClient.resolveMediaUrl(mxcUri);
});

// Only allow opening https:// URLs to prevent protocol-handler abuse
ipcMain.handle('open-external', (_event, url) => {
  if (typeof url === 'string' && url.startsWith('https://')) {
    shell.openExternal(url);
  }
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
