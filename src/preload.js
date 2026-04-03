'use strict';

/**
 * preload.js
 * Exposes a narrow, typed API to the renderer via contextBridge.
 * The renderer has no direct access to Node.js or Electron internals.
 *
 * Rocket.Chat edition: message objects use { _id, msg, ts, u, attachments, tmid }
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bracerChat', {

  // ── Session ────────────────────────────────────────────────────────────
  /** @returns {Promise<{userId, username, machineRoomId, broadcastRoomId, companyRoomId, hostname, windowsUser, companyName}>} */
  getSessionInfo: () => ipcRenderer.invoke('get-session-info'),

  // ── Chat ───────────────────────────────────────────────────────────────
  /** @returns {Promise<object[]>} Array of RC message objects (chronological) */
  getRoomHistory: (roomId, sinceTs) => ipcRenderer.invoke('get-room-history', roomId, sinceTs),

  /** @returns {Promise<object>} The sent RC message object */
  sendMessage: (roomId, text) => ipcRenderer.invoke('send-message', roomId, text),

  /** Send a reply in a thread. @param {object} replyToMsg RC message being replied to */
  sendReply: (roomId, text, replyToMsg) => ipcRenderer.invoke('send-reply', roomId, text, replyToMsg),

  /**
   * Upload and send a file to a room.
   * @returns {Promise<{fileUrl, fileName, mimeType}>}
   */
  sendFile: (roomId, fileData, fileName, mimeType) =>
    ipcRenderer.invoke('send-file', roomId, fileData, fileName, mimeType),

  /** Opens a native file picker dialog and returns the file data. */
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),

  /** Returns display layout instantly (no capture). */
  getScreenLayout: () => ipcRenderer.invoke('get-screen-layout'),

  /** Returns all connected displays with bounds and thumbnails. */
  getScreens: () => ipcRenderer.invoke('get-screens'),

  /** Captures the selected screen and sends as an image. @returns {Promise<{fileUrl, fileName}>} */
  sendScreenshot: (roomId, sourceId) => ipcRenderer.invoke('send-screenshot', roomId, sourceId),

  // ── Media ──────────────────────────────────────────────────────────────
  /** Resolve a file URL to a base64 data URL (cached). @returns {Promise<string|null>} */
  resolveMediaUrl: (mediaUri) => ipcRenderer.invoke('resolve-media-url', mediaUri),

  /** Open a URL in the system default browser (https:// only). */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /** Download a file (with auth) and show Save As dialog. */
  downloadFile: (mediaUri, fileName) => ipcRenderer.invoke('download-file', mediaUri, fileName),

  /** Open an image in the default OS photo app (temp file). */
  openImageInApp: (mediaUri, fileName) => ipcRenderer.invoke('open-image-in-app', mediaUri, fileName),

  /** Write text to the system clipboard. */
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),

  /** Write an image (data URL) to the system clipboard. */
  clipboardWriteImage: (dataUrl) => ipcRenderer.invoke('clipboard-write-image', dataUrl),

  /** Show a Save As dialog and write text content to the chosen file. */
  saveTextFile: (opts) => ipcRenderer.invoke('save-text-file', opts),

  /** Show a native Cut/Copy/Paste context menu (for text inputs). */
  showInputContextMenu: () => ipcRenderer.send('show-input-context-menu'),

  /** Read clipboard image via Electron native API. Returns base64 PNG string or null. */
  readClipboardImage: () => ipcRenderer.invoke('read-clipboard-image'),

  /** Called when the context menu Paste triggers an image paste. */
  onPasteClipboardImage: (callback) => {
    ipcRenderer.on('paste-clipboard-image', (_event, b64) => callback(b64));
  },

  /** Fetch a single RC message by ID. @returns {Promise<object|null>} */
  getRoomEvent: (roomId, messageId) => ipcRenderer.invoke('get-room-event', roomId, messageId),

  /** Fetch pinned messages from RC. @returns {Promise<object[]>} */
  getPinnedEvents: (roomId) => ipcRenderer.invoke('get-pinned-events', roomId),

  /** Pin a message by ID. @returns {Promise<boolean>} */
  pinMessage: (messageId) => ipcRenderer.invoke('pin-message', messageId),

  /** Unpin a message by ID. @returns {Promise<boolean>} */
  unpinMessage: (messageId) => ipcRenderer.invoke('unpin-message', messageId),

  /** Legacy: set-pinned-events (kept for backward compat). */
  setPinnedEvents: (roomId, pinnedIds) => ipcRenderer.invoke('set-pinned-events', roomId, pinnedIds),

  // ── Window pin ─────────────────────────────────────────────────────────
  getPinState: () => ipcRenderer.invoke('get-pin-state'),
  setPinState: (pinned) => ipcRenderer.invoke('set-pin-state', pinned),

  // ── Events ─────────────────────────────────────────────────────────────
  /** Register a callback for new messages from DDP WebSocket. */
  onNewMessage: (callback) => {
    ipcRenderer.on('new-message', (_event, data) => callback(data));
  },

  offNewMessage: () => {
    ipcRenderer.removeAllListeners('new-message');
  },

  /** Called when the window is shown because a new message arrived. */
  onFocusMessage: (callback) => {
    ipcRenderer.on('focus-message', (_event, data) => callback(data));
  },

  /** Called when session room IDs are updated. */
  onSessionUpdate: (callback) => {
    ipcRenderer.on('session-update', (_event, data) => callback(data));
  },

  // ── Typing indicators ─────────────────────────────────────────────────
  sendTyping: (roomId, typing) => ipcRenderer.invoke('send-typing', roomId, typing),

  /** Register a callback for typing updates. Called with { roomId, usernames }. */
  onTypingUpdate: (callback) => {
    ipcRenderer.on('typing-update', (_event, data) => callback(data));
  },

  // ── Read receipts ─────────────────────────────────────────────────────
  /** Mark a room as read. */
  sendReadReceipt: (roomId) => ipcRenderer.invoke('send-read-receipt', roomId)
});
