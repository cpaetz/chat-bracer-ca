'use strict';

/**
 * updater.js
 * Checks for a newer version of Bracer Chat on startup and every 4 hours.
 * Supports two update types returned by the version check endpoint:
 *
 *   "asar"      — downloads only app.asar (~3 MB) and replaces it in-place.
 *                 Used for all normal code/UI changes. No UAC, no full install.
 *
 *   "installer" — downloads the full NSIS installer (~92 MB) and runs it as
 *                 SYSTEM. Used only when the Electron binary or native deps
 *                 (koffi) change version.
 *
 * Auth: uses the machine's Matrix access_token from session.dat.
 */

const https    = require('https');
const crypto   = require('crypto');
const fs       = require('fs');
const origFs   = require('original-fs');  // Bypass Electron ASAR interception for raw file I/O
const path     = require('path');
const os     = require('os');
const { spawn } = require('child_process');
const { app, dialog } = require('electron');

const CHECK_URL    = 'https://chat.bracer.ca/api/update/check';
const DOWNLOAD_URL = 'https://chat.bracer.ca/api/update/download';
const ASAR_URL     = 'https://chat.bracer.ca/api/update/asar';

// Ed25519 public key for verifying update signatures.
// Private key is stored offline in 1Password — never on the server.
const SIGNING_PUBLIC_KEY = (() => {
  const rawPub    = Buffer.from('4PYHU8mjh0VHqlgzRDubeo18athzya6Zbb/qTEvZ0pM=', 'base64');
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');  // SPKI wrapper for Ed25519
  return crypto.createPublicKey({ key: Buffer.concat([spkiPrefix, rawPub]), format: 'der', type: 'spki' });
})();
const APP_EXE      = 'C:\\Program Files\\Bracer Chat\\Bracer Chat.exe';
const ASAR_DST     = 'C:\\Program Files\\Bracer Chat\\resources\\app.asar';

// ── Signature verification ───────────────────────────────────────────────────

/**
 * Verifies an Ed25519 signature against a file's contents.
 * Returns true if the signature is valid, false otherwise.
 */
function verifySignature(filePath, signatureBase64) {
  const fileData  = origFs.readFileSync(filePath);
  const signature = Buffer.from(signatureBase64, 'base64');
  return crypto.verify(null, fileData, SIGNING_PUBLIC_KEY, signature);
}

/**
 * Downloads the .sig file for a given update URL.
 * The server serves signatures at the same URL with ?sig=1 appended.
 */
async function downloadSignature(url, accessToken) {
  const sigUrl = url + (url.includes('?') ? '&' : '?') + 'sig=1';
  const { status, body } = await httpsGet(sigUrl, { Authorization: `Bearer ${accessToken}` });
  if (status !== 200) throw new Error(`Signature download failed: HTTP ${status}`);
  const sig = JSON.parse(body).signature;
  if (!sig) throw new Error('Signature missing from server response');
  return sig;
}

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
    // Use original-fs to bypass Electron's ASAR virtual filesystem —
    // without this, writing to a .asar path triggers "Invalid package" errors.
    const file = origFs.createWriteStream(destPath);
    https.get(reqOpts, (res) => {
      if (res.statusCode !== 200) {
        file.close();
        origFs.unlink(destPath, () => {});
        reject(new Error(`Download failed: HTTP ${res.statusCode}`));
        return;
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', (err) => { origFs.unlink(destPath, () => {}); reject(err); });
    }).on('error', (err) => { origFs.unlink(destPath, () => {}); reject(err); });
  });
}

// ── Shared relaunch PS1 block ───────────────────────────────────────────────
// Used by both update paths. Registers a one-shot interactive scheduled task
// for the logged-in user. DO NOT call Start-ScheduledTask — force-starting an
// Interactive task from SYSTEM (Session 0) silently fails on Windows.
// The Task Scheduler service correctly injects into the user session when the
// trigger fires naturally.

function relaunchPs1Block(taskName) {
  const appExeEsc = APP_EXE.replace(/'/g, "''");
  return [
    `$appExe = '${appExeEsc}'`,
    '$u = (Get-WmiObject Win32_ComputerSystem).UserName',
    'if ($u -and (Test-Path $appExe)) {',
    '    $action    = New-ScheduledTaskAction -Execute $appExe -Argument \'--startup\'',
    '    $trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5)',
    '    $settings  = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)',
    '    $principal = New-ScheduledTaskPrincipal -UserId $u -LogonType Interactive -RunLevel Limited',
    `    Register-ScheduledTask -TaskName '${taskName}' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null`,
    '    Start-Sleep -Seconds 30',
    `    Unregister-ScheduledTask -TaskName '${taskName}' -Confirm:$false -ErrorAction SilentlyContinue`,
    '}',
  ];
}

// ── Shared schtasks registration ────────────────────────────────────────────

function registerSystemTask(taskName, ps1Path, onSuccess) {
  const startTime = new Date(Date.now() + 10_000);
  const timeStr   = [
    String(startTime.getHours()).padStart(2, '0'),
    String(startTime.getMinutes()).padStart(2, '0'),
    String(startTime.getSeconds()).padStart(2, '0')
  ].join(':');

  spawn('schtasks', ['/delete', '/tn', taskName, '/f'], { stdio: 'ignore', windowsHide: true });

  spawn('schtasks', [
    '/create',
    '/tn', taskName,
    '/tr', `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1Path}"`,
    '/sc', 'once',
    '/sd', `${String(startTime.getMonth() + 1).padStart(2, '0')}/${String(startTime.getDate()).padStart(2, '0')}/${startTime.getFullYear()}`,
    '/st', timeStr,
    '/ru', 'SYSTEM',
    '/f'
  ], { stdio: 'ignore', windowsHide: true }).on('close', (code) => {
    if (code === 0) {
      console.log(`[Updater] SYSTEM task '${taskName}' registered. Quitting...`);
      onSuccess();
    } else {
      console.warn(`[Updater] schtasks failed (code ${code}). Falling back to direct PowerShell spawn...`);
      spawn('powershell.exe', [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1Path
      ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      onSuccess();
    }
  });
}

// ── ASAR update ─────────────────────────────────────────────────────────────

/**
 * Downloads only app.asar and replaces it in-place as the current user.
 * No SYSTEM task or UAC required — installer.nsh grants BUILTIN\Users
 * modify rights on app.asar so the logged-in user can write it directly.
 * The app exits, a detached PS1 waits for the file handle to release,
 * copies the new asar, then relaunches the app via Start-Process.
 */
async function downloadAndInstallAsar(accessToken) {
  const tmpDir  = os.tmpdir();
  const asarTmp = path.join(tmpDir, 'BracerChatUpdate.asar');
  const ps1Path = path.join(tmpDir, 'BracerChatUpdate.ps1');

  // Download ASAR and its signature, then verify before proceeding
  const signature = await downloadSignature(ASAR_URL, accessToken);
  await downloadFile(ASAR_URL, accessToken, asarTmp);
  console.log('[Updater] ASAR download complete (~' +
    Math.round(origFs.statSync(asarTmp).size / 1024 / 1024) + ' MB). Verifying signature...');

  if (!verifySignature(asarTmp, signature)) {
    origFs.unlinkSync(asarTmp);
    throw new Error('ASAR signature verification failed — update rejected');
  }
  console.log('[Updater] Signature verified. Queuing replace...');

  const srcEsc    = asarTmp.replace(/'/g, "''");
  const dstEsc    = ASAR_DST.replace(/'/g, "''");
  const appExeEsc = APP_EXE.replace(/'/g, "''");

  const logEsc = 'C:\\ProgramData\\BracerChat\\bracer-update.log'.replace(/'/g, "''");

  const ps1Lines = [
    `$log = '${logEsc}'`,
    `$src = '${srcEsc}'`,
    `$dst = '${dstEsc}'`,
    `$app = '${appExeEsc}'`,
    `$ts  = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`,
    `Add-Content -Path $log -Value "$ts [Updater] PS1 started. Waiting for Bracer Chat to exit..."`,
    // Wait up to 30 s for the Electron process to fully exit and release app.asar
    'for ($w = 0; $w -lt 30; $w++) {',
    '    if (-not (Get-Process -Name "Bracer Chat" -ErrorAction SilentlyContinue)) { break }',
    '    Start-Sleep -Seconds 1',
    '}',
    `$ts = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`,
    `Add-Content -Path $log -Value "$ts [Updater] Process gone. Attempting copy..."`,
    // Retry copy up to 10 times in case the file handle takes a moment to release
    '$copied = $false',
    'for ($i = 0; $i -lt 10; $i++) {',
    '    try {',
    '        Copy-Item -Path $src -Destination $dst -Force -ErrorAction Stop',
    '        $copied = $true',
    `        $ts = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`,
    `        Add-Content -Path $log -Value "$ts [Updater] Copy succeeded on attempt $($i+1)."`,
    '        break',
    '    } catch {',
    `        $ts = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`,
    `        Add-Content -Path $log -Value "$ts [Updater] Copy attempt $($i+1) failed: $($_.Exception.Message)"`,
    '        Start-Sleep -Seconds 2',
    '    }',
    '}',
    'Remove-Item -Path $src -Force -ErrorAction SilentlyContinue',
    'if (-not $copied) {',
    `    $ts = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`,
    `    Add-Content -Path $log -Value "$ts [Updater] All copy attempts failed. Aborting relaunch."`,
    '} else {',
    '    if (Test-Path $app) { Start-Process -FilePath $app -ArgumentList \'--startup\' }',
    '}',
    'Remove-Item -Force $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue',
  ];

  fs.writeFileSync(ps1Path, ps1Lines.join('\r\n'), 'utf8');

  // Use Start-Process to launch the PS1 as a fully independent OS process.
  // The outer PowerShell calls Start-Process (which returns immediately) and
  // exits. The inner PowerShell is parented to the OS, not Electron, so it
  // survives app.quit(). No admin / scheduled task required.
  const ps1PathEsc = ps1Path.replace(/\\/g, '\\\\').replace(/'/g, "''");
  spawn('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${ps1PathEsc}""' -WindowStyle Hidden`
  ], { stdio: 'ignore', windowsHide: true }).on('close', (code) => {
    console.log(`[Updater] ASAR update process launched (exit ${code}). Quitting in 1.5 s...`);
    setTimeout(() => app.quit(), 1500);
  });
}

// ── Full installer update ────────────────────────────────────────────────────

/**
 * Downloads the full NSIS installer and queues a SYSTEM task to run it.
 * Used only when Electron binary or native deps change version.
 */
async function downloadAndInstallFull(accessToken) {
  const tmpDir  = os.tmpdir();
  const exePath = path.join(tmpDir, 'BracerChatUpdate.exe');
  const ps1Path = path.join(tmpDir, 'BracerChatUpdate.ps1');
  const TASK    = 'BracerChatUpdate';

  // Download installer and its signature, then verify before proceeding
  const signature = await downloadSignature(DOWNLOAD_URL, accessToken);
  await downloadFile(DOWNLOAD_URL, accessToken, exePath);
  console.log('[Updater] Full installer download complete. Verifying signature...');

  if (!verifySignature(exePath, signature)) {
    origFs.unlinkSync(exePath);
    throw new Error('Installer signature verification failed — update rejected');
  }
  console.log('[Updater] Signature verified. Queuing SYSTEM install task...');

  const exeEsc = exePath.replace(/'/g, "''");
  const ps1Lines = [
    'Start-Sleep -Seconds 4',
    `Start-Process -FilePath '${exeEsc}' -ArgumentList '/S' -Wait -NoNewWindow -WindowStyle Hidden`,
    'Start-Sleep -Seconds 5',
    ...relaunchPs1Block('BracerChatRelaunch'),
    `Remove-Item -Force '${exeEsc}' -ErrorAction SilentlyContinue`,
    `schtasks /delete /tn '${TASK}' /f 2>&1 | Out-Null`,
    'Start-Sleep -Seconds 1',
    'Remove-Item -Force $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue',
  ];

  fs.writeFileSync(ps1Path, ps1Lines.join('\r\n'), 'utf8');
  registerSystemTask(TASK, ps1Path, () => setTimeout(() => app.quit(), 1500));
}

// ── Public API ───────────────────────────────────────────────────────────────

async function checkAndUpdate(accessToken) {
  try {
    const { status, body } = await httpsGet(CHECK_URL, { Authorization: `Bearer ${accessToken}` });
    if (status === 429) {
      // Rate limited — parse retry_after and schedule next check
      try {
        const { retry_after } = JSON.parse(body);
        const retryMs = (retry_after || 1800) * 1000;
        console.warn(`[Updater] Rate limited. Retrying in ${Math.round(retryMs / 60000)} min.`);
        setTimeout(() => checkAndUpdate(accessToken), retryMs);
      } catch { /* ignore parse error */ }
      return;
    }
    if (status !== 200) {
      console.warn('[Updater] Version check returned', status);
      return;
    }

    const { version: latestVersion, update_type: updateType = 'installer' } = JSON.parse(body);
    const currentVersion = app.getVersion();

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      console.log(`[Updater] Up to date (v${currentVersion})`);
      return;
    }

    console.log(`[Updater] Update available: v${currentVersion} → v${latestVersion} (type: ${updateType}). Downloading...`);

    if (updateType === 'asar') {
      await downloadAndInstallAsar(accessToken);
    } else {
      await downloadAndInstallFull(accessToken);
    }

  } catch (err) {
    console.warn('[Updater] Update check failed:', err.message);
  }
}

async function manualCheckForUpdate(accessToken) {
  try {
    const { status, body } = await httpsGet(CHECK_URL, { Authorization: `Bearer ${accessToken}` });
    if (status === 429) {
      let retryMin = 30;
      try { retryMin = Math.round((JSON.parse(body).retry_after || 1800) / 60); } catch {}
      dialog.showMessageBox({ type: 'warning', title: 'Rate Limited',
        message: `Too many requests. Please try again in ${retryMin} minutes.`, buttons: ['OK'] });
      return;
    }
    if (status !== 200) {
      dialog.showMessageBox({ type: 'warning', title: 'Update Check Failed',
        message: 'Could not reach the update server.', buttons: ['OK'] });
      return;
    }

    const { version: latestVersion, update_type: updateType = 'installer' } = JSON.parse(body);
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
      if (updateType === 'asar') {
        await downloadAndInstallAsar(accessToken);
      } else {
        await downloadAndInstallFull(accessToken);
      }
    }
  } catch (err) {
    dialog.showMessageBox({ type: 'warning', title: 'Update Check Failed',
      message: `Could not check for updates: ${err.message}`, buttons: ['OK'] });
  }
}

module.exports = { checkAndUpdate, manualCheckForUpdate };
