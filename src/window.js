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
 * Shows the chat window with a short opacity fade-in.
 * Starting at opacity 0 suppresses the Windows animation (which looks wrong
 * for a skipTaskbar window that has no taskbar button to animate toward).
 * @param {boolean} alwaysOnTop  If true, window pops above everything for 5 s.
 */
function showWindow(alwaysOnTop = false) {
  if (!win || win.isDestroyed()) return;

  if (!win.isVisible()) {
    // Window is hidden — fade in from transparent
    win.setOpacity(0);
    win.show();
    win.restore();
    win.focus();

    // Fade in over ~150 ms (10 steps x 15 ms)
    let opacity = 0;
    const fadeIn = setInterval(() => {
      if (!win || win.isDestroyed()) { clearInterval(fadeIn); return; }
      opacity = Math.min(1, opacity + 0.1);
      win.setOpacity(opacity);
      if (opacity >= 1) clearInterval(fadeIn);
    }, 15);
  } else {
    // Window is already visible — just restore/focus, no opacity flash
    win.restore();
    win.focus();
  }

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

/**
 * Hides the chat window with a short opacity fade-out.
 */
function hideWindow() {
  if (!win || win.isDestroyed()) return;

  // Fade out over ~120 ms (8 steps x 15 ms), then hide and reset opacity
  let opacity = 1;
  const fadeOut = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(fadeOut); return; }
    opacity = Math.max(0, opacity - 0.125);
    win.setOpacity(opacity);
    if (opacity <= 0) {
      clearInterval(fadeOut);
      win.hide();
      win.setOpacity(1); // Reset for next show
    }
  }, 15);
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
