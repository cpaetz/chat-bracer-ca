'use strict';

/**
 * logger.js
 * Writes WARN/ERROR/FATAL lines to C:\ProgramData\BracerChat\bracer-chat-error.log.
 * Normal console.log (INFO) is NOT written to the file — only problems.
 * Rotates to bracer-chat-error.log.bak when the file exceeds MAX_SIZE.
 *
 * Call setupLogging() once at the very start of main.js to:
 *   - Mirror console.warn / console.error to the log file
 *   - Catch uncaughtException and unhandledRejection
 *   - Catch renderer/child process crashes
 */

const fs = require('fs');

const LOG_PATH = 'C:\\ProgramData\\BracerChat\\bracer-chat-error.log';
const BAK_PATH = 'C:\\ProgramData\\BracerChat\\bracer-chat-error.log.bak';
const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function formatArgs(args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    }
    return String(a);
  }).join(' ');
}

function writeLine(level, args) {
  const line = `${timestamp()} [${level}] ${formatArgs(args)}\n`;
  try {
    try {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size > MAX_SIZE) fs.renameSync(LOG_PATH, BAK_PATH);
    } catch (_) {}
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (_) {
    // Never throw from logger
  }
}

function pruneOldLines() {
  try {
    if (!fs.existsSync(LOG_PATH)) return;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const lines = fs.readFileSync(LOG_PATH, 'utf8').split('\n');
    const kept = lines.filter(line => {
      const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
      if (!m) return true; // keep lines without a recognised timestamp
      return new Date(m[1]).getTime() >= cutoff;
    });
    fs.writeFileSync(LOG_PATH, kept.join('\n'), 'utf8');
  } catch (_) {}
}

function setupLogging() {
  // Ensure log directory exists
  try {
    const dir = 'C:\\ProgramData\\BracerChat';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}

  // Prune lines older than 7 days on startup
  pruneOldLines();

  // Only mirror console.warn and console.error — not console.log
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.warn = (...args) => {
    origWarn(...args);
    writeLine('WARN', args);
  };
  console.error = (...args) => {
    origError(...args);
    writeLine('ERROR', args);
  };

  // Catch unhandled crashes in the main process
  process.on('uncaughtException', (err) => {
    writeLine('FATAL', [`uncaughtException: ${err.stack || err.message}`]);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error
      ? reason.stack || reason.message
      : String(reason);
    writeLine('FATAL', [`unhandledRejection: ${msg}`]);
  });

  // Write a start marker so we can see when the app launched
  writeLine('INFO', [`=== Bracer Chat v${require('electron').app.getVersion()} started ===`]);
}

module.exports = { setupLogging, writeLine };
