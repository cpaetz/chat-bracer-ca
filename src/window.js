'use strict';

/**
 * window.js
 * Creates and manages the single chat BrowserWindow.
 * - skipTaskbar: true  → no Windows taskbar entry
 * - alwaysOnTop is set temporarily when showing due to a new message,
 *   then released after 3 s so the user can move it behind other windows.
 */

const { BrowserWindow, screen } = require('electron');
const path                      = require('path');

let win = null;

/**
 * Creates the hidden chat window.
 * @param {string} preloadPath  Absolute path to preload.js
 * @param {string} htmlPath     Absolute path to renderer/index.html
 * @returns {BrowserWindow}
 */
function createWindow(preloadPath, htmlPath) {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.ico');

  // Position: narrow panel on the right edge, full work-area height.
  // workArea excludes the Windows taskbar so the window doesn't overlap it.
  const { workArea } = screen.getPrimaryDisplay();
  const WIN_WIDTH = 360;
  const winX      = workArea.x + workArea.width - WIN_WIDTH;
  const winY      = workArea.y;
  const winH      = workArea.height;

  win = new BrowserWindow({
    width       : WIN_WIDTH,
    height      : winH,
    x           : winX,
    y           : winY,
    show        : false,
    frame       : true,
    resizable   : true,
    skipTaskbar : false,  // Show in taskbar so icon is always visible
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
function showWindow(alwaysOnTop = false, bounds = null) {
  if (!win || win.isDestroyed()) return;

  if (!win.isVisible()) {
    // Window is hidden — fade in from transparent
    win.setOpacity(0);
    win.show();
    if (win.isMinimized()) win.restore(); // Only restore if actually minimized — unconditional restore resets rcNormalPosition on Windows
    // Apply bounds AFTER show() — Windows repositions the window during show,
    // so any setBounds called before show() gets overridden.
    if (bounds) win.setBounds(bounds);
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

/**
 * Flash (or stop flashing) the taskbar button to signal unread messages.
 * @param {boolean} flash  true = start flashing, false = stop
 */
function flashWindow(flash) {
  if (win && !win.isDestroyed()) win.flashFrame(flash);
}

module.exports = { createWindow, showWindow, hideWindow, getWindow, sendToRenderer, flashWindow };
