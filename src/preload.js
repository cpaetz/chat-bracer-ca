'use strict';

/**
 * preload.js
 * Exposes a narrow, typed API to the renderer via contextBridge.
 * The renderer has no direct access to Node.js or Electron internals.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bracerChat', {

  // ── Session ────────────────────────────────────────────────────────────
  /** @returns {Promise<{userId, machineRoomId, broadcastRoomId, companyRoomId, hostname, windowsUser}>} */
  getSessionInfo: () => ipcRenderer.invoke('get-session-info'),

  // ── Chat ───────────────────────────────────────────────────────────────
  /** @returns {Promise<object[]>} Array of Matrix timeline events (chronological) */
  getRoomHistory: (roomId) => ipcRenderer.invoke('get-room-history', roomId),

  /** @returns {Promise<void>} */
  sendMessage: (roomId, text) => ipcRenderer.invoke('send-message', roomId, text),

  /**
   * @param {string}      roomId
   * @param {ArrayBuffer} fileData
   * @param {string}      fileName
   * @param {string}      mimeType
   * @returns {Promise<void>}
   */
  sendFile: (roomId, fileData, fileName, mimeType) =>
    ipcRenderer.invoke('send-file', roomId, fileData, fileName, mimeType),

  /**
   * Opens a native file picker dialog and returns the file data.
   * @returns {Promise<{data: ArrayBuffer, name: string, mimeType: string}|null>} null if cancelled
   */
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),

  /** Returns all connected displays with bounds and thumbnails for the screen picker. */
  getScreens: () => ipcRenderer.invoke('get-screens'),

  /** Captures the selected screen (by sourceId) and sends as m.image. @returns {Promise<void>} */
  sendScreenshot: (roomId, sourceId) => ipcRenderer.invoke('send-screenshot', roomId, sourceId),

  // ── Media ──────────────────────────────────────────────────────────────
  /** Convert mxc:// URI → https:// download URL. @returns {string|null} */
  resolveMediaUrl: (mxcUri) => ipcRenderer.invoke('resolve-media-url', mxcUri),

  /** Open a URL in the system default browser (https:// only). */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /** Download a Matrix media file (with auth) and open it with the OS. */
  downloadFile: (mxcUri, fileName) => ipcRenderer.invoke('download-file', mxcUri, fileName),

  /** Open an image in the default OS photo app (temp file, no Save As). */
  openImageInApp: (mxcUri, fileName) => ipcRenderer.invoke('open-image-in-app', mxcUri, fileName),

  /** Write text to the system clipboard. */
  clipboardWrite: (text) => ipcRenderer.invoke('clipboard-write', text),

  /** Write an image (data URL) to the system clipboard. */
  clipboardWriteImage: (dataUrl) => ipcRenderer.invoke('clipboard-write-image', dataUrl),

  /** Show a Save As dialog and write text content to the chosen file. */
  saveTextFile: (opts) => ipcRenderer.invoke('save-text-file', opts),

  // ── Events ─────────────────────────────────────────────────────────────
  /** Register a callback for new messages pushed from the sync loop. */
  onNewMessage: (callback) => {
    ipcRenderer.on('new-message', (_event, data) => callback(data));
  },

  /** Remove all new-message listeners (call before re-registering). */
  offNewMessage: () => {
    ipcRenderer.removeAllListeners('new-message');
  },

  /**
   * Called when the window is shown because a new message arrived.
   * Renderer should expand pinned panel and scroll to the message.
   */
  onFocusMessage: (callback) => {
    ipcRenderer.on('focus-message', (_event, data) => callback(data));
  }
});
