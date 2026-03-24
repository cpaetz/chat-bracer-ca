'use strict';

/**
 * tray.js
 * Creates and manages the system tray icon.
 * Replace assets/tray.png with a real Bracer icon before production.
 */

const { Tray, Menu, nativeImage } = require('electron');
const fs   = require('fs');

let tray         = null;
let _onShow      = null;
let _onQuit      = null;
let _onRestart   = null;
let _onAbout     = null;
let _baseIcon    = null;  // nativeImage for the unmodified tray icon

/**
 * Creates the system tray icon.
 * @param {string}   iconPath   Path to tray.png (16x16 or 32x32)
 * @param {Function} onShow     Called when user clicks the tray icon or "Open"
 * @param {Function} onQuit     Called when user clicks "Quit"
 * @param {Function} onRestart  Called when user clicks "Restart"
 * @param {Function} onAbout    Called when user clicks "About Bracer Chat"
 */
function createTray(iconPath, onShow, onQuit, onRestart, onAbout) {
  _onShow    = onShow;
  _onQuit    = onQuit;
  _onRestart = onRestart;
  _onAbout   = onAbout;

  let icon;
  if (fs.existsSync(iconPath)) {
    icon = nativeImage.createFromPath(iconPath);
  } else {
    // Fallback: 1×1 Bracer-blue pixel scaled to 16×16
    icon = nativeImage
      .createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADklEQVQI12NgYGD4TwAAAgABAAi7eNkAAAAASUVORK5CYII=')
      .resize({ width: 16, height: 16 });
  }
  _baseIcon = icon;

  tray = new Tray(icon);
  tray.setToolTip('Bracer Chat');
  tray.on('click', () => _onShow && _onShow());
  _rebuildMenu();

  return tray;
}

function _rebuildMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Open Bracer Chat',   click: () => _onShow    && _onShow()    },
    { type: 'separator' },
    { label: 'About Bracer Chat',  click: () => _onAbout   && _onAbout()   },
    { type: 'separator' },
    { label: 'Restart',            click: () => _onRestart && _onRestart() },
  ]);
  tray.setContextMenu(menu);
}

function destroyTray() {
  if (tray) {
    tray.destroy();
    tray = null;
  }
}

/**
 * Update the tray icon to show a badge overlay.
 * @param {Electron.NativeImage} image  Badge image returned by renderTrayBadge()
 */
function setTrayBadge(image) {
  if (tray && image) tray.setImage(image);
}

/**
 * Restore the tray icon to its original (no-badge) state.
 */
function clearTrayBadge() {
  if (tray && _baseIcon) tray.setImage(_baseIcon);
}

module.exports = { createTray, destroyTray, setTrayBadge, clearTrayBadge };
