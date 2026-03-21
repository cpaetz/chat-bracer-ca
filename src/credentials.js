'use strict';

/**
 * credentials.js
 * Reads and DPAPI-decrypts C:\ProgramData\BracerChat\session.dat.
 * The file is encrypted with DataProtectionScope.LocalMachine so any
 * process running on the machine can decrypt it — no user login required.
 * Decryption is done via a PowerShell subprocess to avoid native addon
 * rebuild issues across Electron versions.
 */

const { execFileSync } = require('child_process');
const fs               = require('fs');

const SESSION_PATH = 'C:\\ProgramData\\BracerChat\\session.dat';

/**
 * Reads and decrypts session.dat.
 * Returns the parsed JSON object, or null if the file is missing or invalid.
 *
 * Expected session.dat fields:
 *   user_id, access_token, device_id, elevated,
 *   room_id_machine, room_id_broadcast, room_id_company
 */
function readSession() {
  if (!fs.existsSync(SESSION_PATH)) {
    console.error('[credentials] session.dat not found at', SESSION_PATH);
    return null;
  }

  // PowerShell script passed via -EncodedCommand to avoid shell quoting issues.
  // Reads the file as raw bytes and decrypts with LocalMachine scope.
  const psScript = [
    '$ProgressPreference = "SilentlyContinue"',   // suppress CLIXML progress noise
    'Add-Type -AssemblyName System.Security',
    `$bytes  = [System.IO.File]::ReadAllBytes('${SESSION_PATH}')`,
    '$scope  = [System.Security.Cryptography.DataProtectionScope]::LocalMachine',
    '$plain  = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
    '[System.Text.Encoding]::UTF8.GetString($plain)'
  ].join('; ');

  // Encode as UTF-16LE base64 (PowerShell's -EncodedCommand format)
  const encoded = Buffer.from(psScript, 'utf16le').toString('base64');

  try {
    const raw = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand', encoded
    ], { encoding: 'utf8', timeout: 15_000 });

    return JSON.parse(raw.trim());
  } catch (err) {
    console.error('[credentials] DPAPI decrypt failed:', err.message);
    return null;
  }
}

module.exports = { readSession, SESSION_PATH };
