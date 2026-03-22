'use strict';

/**
 * window.js
 * Creates and manages the single chat BrowserWindow.
 * - skipTaskbar: true  → no Windows taskbar entry
 * - alwaysOnTop is set temporarily when showing due to a new message,
 *   then released after 3 s so the user can move it behind other windows.
 */

const { BrowserWindow } = require('electron');
const path              = require('path');

let win = null;

/**
 * Creates the hidden chat window.
 * @param {string} preloadPath  Absolute path to preload.js
 * @param {string} htmlPath     Absolute path to renderer/index.html
 * @returns {BrowserWindow}
 */
function createWindow(preloadPath, htmlPath) {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');
  win = new BrowserWindow({
    width       : 460,
    height      : 640,
    show        : false,
    frame       : true,
    resizable   : true,
    skipTaskbar : true,   // No Windows taskbar entry
    title       : 'Bracer Chat',
    icon        : iconPath,
    webPreferences: {
      preload          : preloadPath,
      contextIsolation : true,
      nodeIntegration  : false,
      sandbox          : false   // Required so preload can use require/ipcRenderer
    }
  });

  win.loadFile(htmlPath);

  // Suppress the default menu bar (File, Edit, View…)
  win.setMenuBarVisibility(false);

  return win;
}

/**
 * Shows the chat window.
 * @param {boolean} alwaysOnTop  If true, window pops above everything for 5 s.
 */
function showWindow(alwaysOnTop = false) {
  if (!win || win.isDestroyed()) return;

  // Show and restore the window first, then apply alwaysOnTop
  win.show();
  win.restore(); // un-minimize if minimized
  win.focus();

  if (alwaysOnTop) {
    win.setAlwaysOnTop(true);
    win.moveTop();
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(false);
    }, 5_000);
  } else {
    win.setAlwaysOnTop(false);
  }
}

function hideWindow() {
  if (win && !win.isDestroyed()) win.hide();
}

/**
 * Send a message to the renderer via ipcRenderer.on / webContents.send.
 */
function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, ...args);
  }
}

function getWindow() { return win; }

module.exports = { createWindow, showWindow, hideWindow, getWindow, sendToRenderer };
