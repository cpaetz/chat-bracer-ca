'use strict';

/**
 * prep-wincosesign.js
 *
 * Workaround for a known electron-builder issue on Windows without Developer Mode.
 *
 * Problem: electron-builder downloads winCodeSign-2.6.0.7z which contains macOS
 * symlinks (libcrypto.dylib, libssl.dylib). Windows requires the
 * "SeCreateSymbolicLinkPrivilege" to create symlinks, which non-admin users only
 * have if Windows Developer Mode is enabled. 7-Zip fails with exit code 2, and
 * electron-builder treats the whole extraction as failed — even though every
 * Windows-relevant file extracted correctly.
 *
 * Fix: pre-populate the expected permanent cache directory from any partially-
 * extracted temp directory, creating the two missing macOS dylib placeholders
 * as empty regular files (they are not used in Windows builds).
 *
 * This is a no-op if the cache is already correctly populated.
 * Safe to remove if Developer Mode or a code-signing certificate is in use.
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CACHE_BASE = path.join(
  os.homedir(),
  'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign'
);
const PERM_CACHE = path.join(CACHE_BASE, 'winCodeSign-2.6.0');

// Already populated — nothing to do
if (fs.existsSync(PERM_CACHE) && fs.readdirSync(PERM_CACHE).length > 0) {
  process.exit(0);
}

// Find a partial extraction temp dir (any numbered directory with content)
const entries = fs.existsSync(CACHE_BASE) ? fs.readdirSync(CACHE_BASE) : [];
const source = entries
  .filter(e => /^\d+$/.test(e))
  .map(e => path.join(CACHE_BASE, e))
  .find(d => {
    try { return fs.readdirSync(d).length > 0; } catch { return false; }
  });

if (!source) {
  // No partial extraction found — electron-builder will download fresh.
  // This will likely fail on Windows without Developer Mode; the user must
  // enable Developer Mode (Settings → System → For Developers) or run as Admin.
  console.warn('[prep-wincosesign] No partial extraction found. Build may fail without Developer Mode.');
  process.exit(0);
}

console.log('[prep-wincosesign] Pre-populating winCodeSign cache from', source);
fs.cpSync(source, PERM_CACHE, { recursive: true });

// Create the two macOS dylib placeholders (empty files — not used on Windows)
const dylibDir = path.join(PERM_CACHE, 'darwin', '10.12', 'lib');
fs.mkdirSync(dylibDir, { recursive: true });
for (const name of ['libcrypto.dylib', 'libssl.dylib']) {
  const p = path.join(dylibDir, name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

console.log('[prep-wincosesign] Cache ready:', PERM_CACHE);
