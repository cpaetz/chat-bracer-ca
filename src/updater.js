'use strict';

/**
 * updater.js
 * Checks for a newer version of Bracer Chat on startup.
 * If a newer version is available, downloads the installer silently and
 * queues a batch script to install + relaunch after the app quits.
 *
 * Auth: uses the machine's Matrix access_token from session.dat.
 * No credentials stored separately — if the machine is registered, it can update.
 */

const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const { spawn } = require('child_process');
const { app, dialog } = require('electron');

const CHECK_URL    = 'https://chat.bracer.ca/api/update/check';
const DOWNLOAD_URL = 'https://chat.bracer.ca/api/update/download';
const APP_EXE      = 'C:\\Program Files\\Bracer Chat\\Bracer Chat.exe';

// ── Version comparison ──────────────────────────────────────────────────────

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// ── HTTP helpers ────────────────────────────────────────────────────────────

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      path    : opts.pathname + opts.search,
      headers : headers || {}
    };
    https.get(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

function downloadFile(url, accessToken, destPath) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const reqOpts = {
      hostname: opts.hostname,
      path    : opts.pathname,
      headers : { Authorization: `Bearer ${accessToken}` }
    };
    const file = fs.createWriteStream(destPath);
    https.get(reqOpts, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        fs.unlink(destPath, () => {});
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
    }).on('error', (err) => { fs.unlink(destPath, () => {}); reject(err); });
  });
}

// ── Main export ─────────────────────────────────────────────────────────────

/**
 * checkAndUpdate(accessToken)
 * Call once after app is ready. Runs asynchronously — does not block startup.
 * If an update is available: downloads installer, writes a batch script to
 * install + relaunch, spawns it detached, then quits the app.
 */
async function checkAndUpdate(accessToken) {
  try {
    // 1. Check latest version (public endpoint, no auth needed)
    const { status, body } = await httpsGet(CHECK_URL);
    if (status !== 200) {
      console.warn('[Updater] Version check returned', status);
      return;
    }

    const { version: latestVersion } = JSON.parse(body);
    const currentVersion = app.getVersion();

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      console.log(`[Updater] Up to date (v${currentVersion})`);
      return;
    }

    console.log(`[Updater] Update available: v${currentVersion} → v${latestVersion}. Downloading...`);

    // 2. Download installer to temp
    const tmpDir  = os.tmpdir();
    const exePath = path.join(tmpDir, 'BracerChatUpdate.exe');
    const batPath = path.join(tmpDir, 'BracerChatUpdate.bat');

    await downloadFile(DOWNLOAD_URL, accessToken, exePath);
    console.log('[Updater] Download complete. Queuing install...');

    // 3. Write a batch script that:
    //    - Waits for this process to exit
    //    - Runs the installer silently
    //    - Relaunches the app
    //    - Deletes itself
    const bat = [
      '@echo off',
      'timeout /t 4 /nobreak >nul',
      `"${exePath}" /S`,
      'timeout /t 60 /nobreak >nul',
      `if exist "${APP_EXE}" start "" "${APP_EXE}"`,
      `del /f /q "${exePath}"`,
      'del "%~f0"'
    ].join('\r\n');

    fs.writeFileSync(batPath, bat, 'ascii');

    // 4. Spawn batch detached (survives app exit), then quit
    spawn('cmd.exe', ['/c', batPath], {
      detached    : true,
      stdio       : 'ignore',
      windowsHide : true
    }).unref();

    console.log('[Updater] Install queued. Restarting...');
    setTimeout(() => app.quit(), 1500);

  } catch (err) {
    console.warn('[Updater] Update check failed:', err.message);
  }
}

/**
 * manualCheckForUpdate(accessToken)
 * Called from the About dialog "Check for Updates" button.
 * Shows dialogs to report status — never silently quits.
 */
async function manualCheckForUpdate(accessToken) {
  try {
    const { status, body } = await httpsGet(CHECK_URL);
    if (status !== 200) {
      dialog.showMessageBox({ type: 'warning', title: 'Update Check Failed',
        message: 'Could not reach the update server.', buttons: ['OK'] });
      return;
    }

    const { version: latestVersion } = JSON.parse(body);
    const currentVersion = app.getVersion();

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      dialog.showMessageBox({ type: 'info', title: 'Up to Date',
        message: `Bracer Chat v${currentVersion} is the latest version.`, buttons: ['OK'] });
      return;
    }

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'Update Available',
      message: `Bracer Chat v${latestVersion} is available`,
      detail: `You are running v${currentVersion}. The update will install and restart the app.`,
      buttons: ['Install Update', 'Later'],
      defaultId: 0,
      cancelId: 1
    });

    if (response === 0) {
      await downloadAndInstall(accessToken);
    }
  } catch (err) {
    dialog.showMessageBox({ type: 'warning', title: 'Update Check Failed',
      message: `Could not check for updates: ${err.message}`, buttons: ['OK'] });
  }
}

module.exports = { checkAndUpdate, manualCheckForUpdate };
