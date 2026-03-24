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
 * downloadAndInstall(accessToken)
 * Downloads the latest installer then registers a one-shot scheduled task
 * running as SYSTEM to perform the silent install + relaunch.
 * Using SYSTEM ensures the NSIS perMachine installer never triggers a UAC
 * prompt regardless of the privileges of the currently logged-in user.
 */
async function downloadAndInstall(accessToken) {
  const tmpDir  = os.tmpdir();
  const exePath = path.join(tmpDir, 'BracerChatUpdate.exe');
  const ps1Path = path.join(tmpDir, 'BracerChatUpdate.ps1');
  const TASK    = 'BracerChatUpdate';

  await downloadFile(DOWNLOAD_URL, accessToken, exePath);
  console.log('[Updater] Download complete. Queuing install via SYSTEM task...');

  // PowerShell script run as SYSTEM:
  //   1. Wait for the user-session app to exit
  //   2. Install silently (perMachine — no UAC needed from SYSTEM)
  //   3. Wait for install to complete
  //   4. Detect the logged-in user via WMI and create a one-shot interactive
  //      scheduled task to relaunch the app in their session (with --startup
  //      so the window stays hidden on auto-relaunch, same as boot behaviour)
  //   5. Clean up installer + self + the SYSTEM update task
  const exeEsc = exePath.replace(/'/g, "''");  // PS single-quote escape
  const ps1Lines = [
    'Start-Sleep -Seconds 4',
    `Start-Process -FilePath '${exeEsc}' -ArgumentList '/S' -Wait -NoNewWindow -WindowStyle Hidden`,
    'Start-Sleep -Seconds 5',
    `$appExe = '${APP_EXE.replace(/'/g, "''")}'`,
    '$u = (Get-WmiObject Win32_ComputerSystem).UserName',
    'if ($u -and (Test-Path $appExe)) {',
    '    $action    = New-ScheduledTaskAction -Execute $appExe -Argument \'--startup\'',
    '    $trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(3)',
    '    $settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2)',
    '    $principal = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited',
    '    Register-ScheduledTask -TaskName \'BracerChatRelaunch\' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null',
    '    Start-Sleep -Seconds 2',
    '    Start-ScheduledTask -TaskName \'BracerChatRelaunch\'',
    '    Start-Sleep -Seconds 5',
    '    Unregister-ScheduledTask -TaskName \'BracerChatRelaunch\' -Confirm:$false -ErrorAction SilentlyContinue',
    '}',
    `Remove-Item -Force '${exeEsc}' -ErrorAction SilentlyContinue`,
    `schtasks /delete /tn '${TASK}' /f 2>&1 | Out-Null`,
    'Start-Sleep -Seconds 1',
    'Remove-Item -Force $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue',
  ];

  fs.writeFileSync(ps1Path, ps1Lines.join('\r\n'), 'utf8');

  // Register a one-shot SYSTEM scheduled task to run the PS1 script,
  // starting 5 seconds from now (gives the app time to quit cleanly).
  const startTime = new Date(Date.now() + 10_000); // 10 s — enough for schtasks to register before trigger fires
  const timeStr   = [
    String(startTime.getHours()).padStart(2,'0'),
    String(startTime.getMinutes()).padStart(2,'0'),
    String(startTime.getSeconds()).padStart(2,'0')
  ].join(':');

  // Delete any leftover task from a previous failed update
  spawn('schtasks', ['/delete', '/tn', TASK, '/f'], { stdio: 'ignore', windowsHide: true });

  spawn('schtasks', [
    '/create',
    '/tn', TASK,
    '/tr', `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`,
    '/sc', 'once',
    '/sd', `${String(startTime.getMonth() + 1).padStart(2,'0')}/${String(startTime.getDate()).padStart(2,'0')}/${startTime.getFullYear()}`,
    '/st', timeStr,
    '/ru', 'SYSTEM',
    '/f'
  ], {
    stdio      : 'ignore',
    windowsHide: true
  }).on('close', (code) => {
    if (code === 0) {
      console.log('[Updater] SYSTEM install task registered. Quitting...');
      setTimeout(() => app.quit(), 1500);
    } else {
      console.warn('[Updater] schtasks failed (code', code, '). Falling back to direct PowerShell spawn...');
      spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1Path], {
        detached    : true,
        stdio       : 'ignore',
        windowsHide : true
      }).unref();
      setTimeout(() => app.quit(), 1500);
    }
  });
}

/**
 * checkAndUpdate(accessToken)
 * Called on startup with a random jitter delay of 30s–60min so machines don't
 * all hit the update server simultaneously.
 * If a newer version is available: downloads installer, writes batch script,
 * spawns detached, then quits.
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
    await downloadAndInstall(accessToken);

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
