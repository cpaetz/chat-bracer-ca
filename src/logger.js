'use strict';

/**
 * logger.js
 * Writes timestamped log lines to C:\ProgramData\BracerChat\bracer-chat.log.
 * Rotates to bracer-chat.log.bak when the file exceeds MAX_SIZE.
 *
 * Call setupLogging() once at the very start of main.js to:
 *   - Mirror console.log / warn / error to the log file
 *   - Catch uncaughtException and unhandledRejection
 */

const fs = require('fs');

const LOG_PATH = 'C:\\ProgramData\\BracerChat\\bracer-chat.log';
const BAK_PATH = 'C:\\ProgramData\\BracerChat\\bracer-chat.log.bak';
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
    // Rotate if over size limit
    try {
      const stat = fs.statSync(LOG_PATH);
      if (stat.size > MAX_SIZE) {
        fs.renameSync(LOG_PATH, BAK_PATH);
      }
    } catch (_) {}
    fs.appendFileSync(LOG_PATH, line, 'utf8');
  } catch (_) {
    // Never throw from logger — swallow silently
  }
}

function setupLogging() {
  // Ensure log directory exists
  try {
    const dir = 'C:\\ProgramData\\BracerChat';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {}

  // Mirror console methods to log file
  const origLog   = console.log.bind(console);
  const origWarn  = console.warn.bind(console);
  const origError = console.error.bind(console);

  console.log = (...args) => {
    origLog(...args);
    writeLine('INFO', args);
  };
  console.warn = (...args) => {
    origWarn(...args);
    writeLine('WARN', args);
  };
  console.error = (...args) => {
    origError(...args);
    writeLine('ERROR', args);
  };

  // Catch unhandled errors in the main process
  process.on('uncaughtException', (err) => {
    writeLine('FATAL', [`uncaughtException: ${err.stack || err.message}`]);
  });

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error
      ? reason.stack || reason.message
      : String(reason);
    writeLine('FATAL', [`unhandledRejection: ${msg}`]);
  });

  writeLine('INFO', [`=== Bracer Chat v${require('../package.json').version} started ===`]);
}

module.exports = { setupLogging, writeLine };
