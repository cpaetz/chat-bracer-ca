#!/usr/bin/env node
'use strict';

/**
 * hash-update.js
 * Generates a SHA-256 hash file (.sha256) for an ASAR or EXE file.
 * Used by the SuperOps push script to verify download integrity.
 *
 * Usage:
 *   node scripts/hash-update.js <file-to-hash>
 *
 * Output:
 *   <file>.sha256 — contains the uppercase hex SHA-256 hash
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

function hashFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Hashing: ${filePath}`);

  const fileData = fs.readFileSync(filePath);
  const hash     = crypto.createHash('sha256').update(fileData).digest('hex').toUpperCase();
  const hashPath = filePath + '.sha256';

  fs.writeFileSync(hashPath, hash, 'utf8');

  const sizeMB = (fileData.length / 1024 / 1024).toFixed(1);
  console.log(`SHA-256: ${hash}`);
  console.log(`Written: ${hashPath} (${sizeMB} MB)`);
}

// ── Main ──
const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/hash-update.js <file-to-hash>');
  process.exit(1);
}

hashFile(path.resolve(target));
