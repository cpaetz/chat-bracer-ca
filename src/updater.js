'use strict';

/**
 * updater.js
 * Minimal version helper for Bracer Chat.
 *
 * Updates are pushed exclusively via SuperOps RMM (BracerChatUpdateAsar.ps1).
 * The in-app self-updater was removed to reduce attack surface — no SYSTEM
 * scheduled tasks, no user-writable staging directories, no UAC prompts.
 *
 * This module only exposes the app version for the About dialog.
 */

const { app } = require('electron');

function getAppVersion() {
  return app.getVersion();
}

module.exports = { getAppVersion };
