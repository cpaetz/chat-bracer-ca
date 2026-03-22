'use strict';

/**
 * media-cache.js
 * Encrypted local cache for Matrix media (images, files).
 *
 * Cache dir  : C:\ProgramData\BracerChat\MediaCache\
 * Key file   : C:\ProgramData\BracerChat\media-cache.key  (32 random bytes, generated once)
 * Encryption : AES-256-GCM
 * TTL        : 30 days (checked on read; bulk cleanup runs at startup)
 *
 * File format (binary):
 *   [2 bytes]  mime type length (uint16 LE)
 *   [N bytes]  mime type string (UTF-8)
 *   [12 bytes] IV / nonce
 *   [16 bytes] GCM auth tag
 *   [rest]     AES-256-GCM ciphertext
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const CACHE_DIR   = 'C:\\ProgramData\\BracerChat\\MediaCache';
const KEY_PATH    = 'C:\\ProgramData\\BracerChat\\media-cache.key';
const TTL_MS      = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Encryption key ──────────────────────────────────────────────────────────

let _key = null;

function getKey() {
  if (_key) return _key;
  if (fs.existsSync(KEY_PATH)) {
    _key = fs.readFileSync(KEY_PATH);
  } else {
    _key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(KEY_PATH), { recursive: true });
    fs.writeFileSync(KEY_PATH, _key, { mode: 0o600 });
  }
  return _key;
}

// ── Cache path ──────────────────────────────────────────────────────────────

function getCachePath(mxcUri) {
  const hash = crypto.createHash('sha256').update(mxcUri).digest('hex');
  return path.join(CACHE_DIR, hash);
}

// ── Read ────────────────────────────────────────────────────────────────────

/**
 * Returns { buffer, mimeType } if a valid non-expired cache entry exists, else null.
 */
function readCache(mxcUri) {
  const filePath = getCachePath(mxcUri);
  try {
    const stat = fs.statSync(filePath);
    if (Date.now() - stat.mtimeMs > TTL_MS) {
      fs.unlinkSync(filePath); // expired
      return null;
    }

    const data = fs.readFileSync(filePath);
    const key  = getKey();

    // Parse header
    const mimeLen  = data.readUInt16LE(0);
    const mimeType = data.slice(2, 2 + mimeLen).toString('utf8');
    const iv       = data.slice(2 + mimeLen, 2 + mimeLen + 12);
    const authTag  = data.slice(2 + mimeLen + 12, 2 + mimeLen + 28);
    const cipher   = data.slice(2 + mimeLen + 28);

    // Decrypt
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const decrypted = Buffer.concat([decipher.update(cipher), decipher.final()]);

    return { buffer: decrypted, mimeType };
  } catch {
    return null; // missing, corrupt, or auth failure — fetch fresh
  }
}

// ── Write ───────────────────────────────────────────────────────────────────

/**
 * Encrypts and writes media to the cache.
 */
function writeCache(mxcUri, buffer, mimeType) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });

    const key      = getKey();
    const iv       = crypto.randomBytes(12);
    const enc      = crypto.createCipheriv('aes-256-gcm', key, iv);
    const cipher   = Buffer.concat([enc.update(buffer), enc.final()]);
    const authTag  = enc.getAuthTag();

    const mimeBytes = Buffer.from(mimeType, 'utf8');
    const header    = Buffer.alloc(2);
    header.writeUInt16LE(mimeBytes.length, 0);

    const out = Buffer.concat([header, mimeBytes, iv, authTag, cipher]);
    fs.writeFileSync(getCachePath(mxcUri), out, { mode: 0o600 });
  } catch (err) {
    console.warn('[media-cache] Write failed:', err.message);
  }
}

// ── Startup cleanup ─────────────────────────────────────────────────────────

/**
 * Deletes cache files older than 30 days. Call once at app startup.
 */
function cleanupExpired() {
  try {
    if (!fs.existsSync(CACHE_DIR)) return;
    const now   = Date.now();
    const files = fs.readdirSync(CACHE_DIR);
    let removed = 0;
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > TTL_MS) {
          fs.unlinkSync(filePath);
          removed++;
        }
      } catch { /* skip locked/missing */ }
    }
    if (removed > 0) console.log(`[media-cache] Cleaned up ${removed} expired file(s)`);
  } catch (err) {
    console.warn('[media-cache] Cleanup failed:', err.message);
  }
}

module.exports = { readCache, writeCache, cleanupExpired };
