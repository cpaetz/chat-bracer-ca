'use strict';

/**
 * logUploader.js
 * Uploads the local Bracer Chat error log to the server for remote diagnostics.
 *
 * - Uploads on startup if the log file has changed since last upload
 * - Uploads every hour if the log has changed
 * - Tracks last-uploaded mtime in C:\ProgramData\BracerChat\.log_upload_mtime
 * - Auth: machine's Matrix access_token (same as session.dat)
 * - Server keeps 7 days of log history; older lines are purged server-side
 * - Silent — never throws or surfaces errors to the user
 */

const https = require('https');
const fs    = require('fs');

const LOG_PATH        = 'C:\\ProgramData\\BracerChat\\bracer-chat-error.log';
const MTIME_PATH      = 'C:\\ProgramData\\BracerChat\\.log_upload_mtime';
const UPLOAD_URL      = 'https://chat.bracer.ca/api/logs/upload';
const UPLOAD_INTERVAL = 60 * 60 * 1000; // 1 hour

// ── Helpers ─────────────────────────────────────────────────────────────────

function getLogMtime() {
  try {
    return fs.statSync(LOG_PATH).mtimeMs;
  } catch (_) {
    return null;
  }
}

function getLastUploadedMtime() {
  try {
    return parseFloat(fs.readFileSync(MTIME_PATH, 'utf8').trim());
  } catch (_) {
    return null;
  }
}

function saveLastUploadedMtime(mtime) {
  try {
    fs.writeFileSync(MTIME_PATH, String(mtime), 'utf8');
  } catch (_) {}
}

function uploadLog(accessToken) {
  try {
    const currentMtime = getLogMtime();
    if (!currentMtime) return; // log file doesn't exist yet

    const lastMtime = getLastUploadedMtime();
    if (lastMtime && Math.abs(currentMtime - lastMtime) < 1000) {
      // File hasn't changed since last upload — skip
      return;
    }

    const data = fs.readFileSync(LOG_PATH);
    if (!data.length) return;

    const opts = {
      hostname: 'chat.bracer.ca',
      path    : '/api/logs/upload',
      method  : 'POST',
      headers : {
        Authorization    : `Bearer ${accessToken}`,
        'Content-Type'   : 'application/octet-stream',
        'Content-Length' : data.length
      }
    };

    const req = https.request(opts, (res) => {
      if (res.statusCode === 200) {
        saveLastUploadedMtime(currentMtime);
        console.log('[LogUploader] Log uploaded successfully');
      } else {
        console.warn('[LogUploader] Upload returned', res.statusCode);
      }
      res.resume(); // drain response
    });

    req.on('error', (err) => {
      console.warn('[LogUploader] Upload failed:', err.message);
    });

    req.write(data);
    req.end();

  } catch (err) {
    console.warn('[LogUploader] Unexpected error:', err.message);
  }
}

// ── Main export ─────────────────────────────────────────────────────────────

/**
 * startLogUploader(accessToken)
 * Call once after app is ready. Uploads on startup (if changed), then hourly.
 */
function startLogUploader(accessToken) {
  // Small delay on startup so the initial log write is complete before we read it
  setTimeout(() => uploadLog(accessToken), 15_000);

  setInterval(() => uploadLog(accessToken), UPLOAD_INTERVAL);
}

module.exports = { startLogUploader };
