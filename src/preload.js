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

  /** Captures the primary screen and sends as m.image. @returns {Promise<void>} */
  sendScreenshot: (roomId) => ipcRenderer.invoke('send-screenshot', roomId),

  // ── Media ──────────────────────────────────────────────────────────────
  /** Convert mxc:// URI → https:// download URL. @returns {string|null} */
  resolveMediaUrl: (mxcUri) => ipcRenderer.invoke('resolve-media-url', mxcUri),

  /** Open a URL in the system default browser (https:// only). */
  openExternal: (url) => ipcRenderer.invoke('open-external', url),

  /** Download a Matrix media file (with auth) and open it with the OS. */
  downloadFile: (mxcUri, fileName) => ipcRenderer.invoke('download-file', mxcUri, fileName),

  // ── Events ─────────────────────────────────────────────────────────────
  /** Register a callback for new messages pushed from the sync loop. */
  onNewMessage: (callback) => {
    ipcRenderer.on('new-message', (_event, data) => callback(data));
  },

  /** Remove all new-message listeners (call before re-registering). */
  offNewMessage: () => {
    ipcRenderer.removeAllListeners('new-message');
  }
});
