'use strict';

/**
 * credentials.js
 * Reads and DPAPI-decrypts C:\ProgramData\BracerChat\session.dat.
 * Encrypted with DataProtectionScope.CurrentUser — only the logged-in
 * user can decrypt. If a different user logs in, the app calls the
 * server's /api/machine/reauth endpoint to get fresh credentials.
 * Decryption is done via a PowerShell subprocess to avoid native addon
 * rebuild issues across Electron versions.
 */

const { execFileSync } = require('child_process');
const fs               = require('fs');
const path             = require('path');
const os               = require('os');

const SESSION_PATH = 'C:\\ProgramData\\BracerChat\\session.dat';

/**
 * Build a PS1 temp file and run it with -File to avoid Node 22 $ expansion.
 */
function runPsSync(lines, timeout = 15_000) {
  // Use mkdtempSync to create a unique directory — mitigates TOCTOU race
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'bracer-cred-'));
  const tmpFile = path.join(tmpDir, 'run.ps1');
  fs.writeFileSync(tmpFile, lines.join('\r\n'), 'utf8');
  try {
    return execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile
    ], { encoding: 'utf8', timeout });
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

/**
 * Reads and decrypts session.dat using CurrentUser DPAPI scope.
 * Falls back to LocalMachine scope for pre-v1.0.67 installs.
 * Returns the parsed JSON object, or null if the file is missing or invalid.
 */
function readSession() {
  if (!fs.existsSync(SESSION_PATH)) {
    console.error('[credentials] session.dat not found at', SESSION_PATH);
    return null;
  }

  // Try CurrentUser first, then fall back to LocalMachine (migration)
  for (const scope of ['CurrentUser', 'LocalMachine']) {
    try {
      const raw = runPsSync([
        '$ProgressPreference = "SilentlyContinue"',
        'Add-Type -AssemblyName System.Security',
        `$bytes  = [System.IO.File]::ReadAllBytes('${SESSION_PATH}')`,
        `$scope  = [System.Security.Cryptography.DataProtectionScope]::${scope}`,
        '$plain  = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
        '[System.Text.Encoding]::UTF8.GetString($plain)',
      ]);
      const session = JSON.parse(raw.trim());
      console.log(`[credentials] Decrypted session.dat with ${scope} scope`);

      // If we decrypted with LocalMachine, re-encrypt with CurrentUser (one-time migration)
      if (scope === 'LocalMachine') {
        console.log('[credentials] Migrating session.dat from LocalMachine to CurrentUser scope...');
        writeSession(session);
      }
      return session;
    } catch {
      console.warn(`[credentials] ${scope} decrypt failed, trying next...`);
    }
  }

  console.error('[credentials] All DPAPI scopes failed — session.dat unreadable');
  return null;
}

/**
 * Encrypts and writes session data to session.dat using CurrentUser DPAPI scope.
 */
function writeSession(sessionObj) {
  try {
    const json = JSON.stringify(sessionObj);
    const jsonB64 = Buffer.from(json, 'utf8').toString('base64');
    runPsSync([
      '$ProgressPreference = "SilentlyContinue"',
      'Add-Type -AssemblyName System.Security',
      `$plain  = [System.Convert]::FromBase64String('${jsonB64}')`,
      '$scope  = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
      '$enc    = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, $scope)',
      `[System.IO.File]::WriteAllBytes('${SESSION_PATH}', $enc)`,
    ]);
    console.log('[credentials] session.dat written with CurrentUser scope');
  } catch (err) {
    console.error('[credentials] Failed to write session.dat:', err.message);
  }
}

module.exports = { readSession, writeSession, SESSION_PATH };
