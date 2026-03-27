#!/usr/bin/env node
'use strict';

/**
 * sign-update.js
 * Signs an ASAR or EXE file with the Ed25519 private key from 1Password.
 * Produces a .sig file containing the base64-encoded signature.
 *
 * Usage:
 *   node scripts/sign-update.js <file-to-sign>
 *
 * The private key is fetched from 1Password via the OP CLI.
 * Requires OP_SERVICE_ACCOUNT_TOKEN in the environment (or DPAPI-encrypted token).
 */

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const OP_ITEM  = 'Bracer Chat Code Signing Key';
const OP_VAULT = 'Claude';
const OP_FIELD = 'Section_codesigning.Private Key';

function getPrivateKey() {
  // Try to get the OP token from DPAPI-encrypted file (Windows dev machine)
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) {
    try {
      const psCmd = `
        Add-Type -AssemblyName System.Security
        $enc = [System.IO.File]::ReadAllBytes('C:\\Users\\Chris.Paetz\\.claude\\op-claude-token.dpapi')
        $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
        [System.Text.Encoding]::UTF8.GetString($bytes)
      `;
      const token = execSync(`powershell.exe -NoProfile -Command "${psCmd}"`, { encoding: 'utf8' }).trim();
      process.env.OP_SERVICE_ACCOUNT_TOKEN = token;
    } catch (e) {
      console.error('Failed to get OP token from DPAPI. Set OP_SERVICE_ACCOUNT_TOKEN manually.');
      process.exit(1);
    }
  }

  // Fetch the private key from 1Password
  const raw = execSync(
    `op item get "${OP_ITEM}" --vault "${OP_VAULT}" --fields "${OP_FIELD}" --reveal`,
    { encoding: 'utf8' }
  ).trim();

  return Buffer.from(raw, 'base64');
}

function signFile(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`Signing: ${filePath}`);

  const rawPrivate = getPrivateKey();

  // Wrap raw Ed25519 private key in PKCS8 DER format
  // PKCS8 prefix for Ed25519: 302e020100300506032b657004220420
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pkcs8Der    = Buffer.concat([pkcs8Prefix, rawPrivate]);

  const privateKey = crypto.createPrivateKey({
    key:    pkcs8Der,
    format: 'der',
    type:   'pkcs8'
  });

  const fileData  = fs.readFileSync(filePath);
  const signature = crypto.sign(null, fileData, privateKey);
  const sigBase64 = signature.toString('base64');

  const sigPath = filePath + '.sig';
  fs.writeFileSync(sigPath, sigBase64, 'utf8');

  console.log(`Signature written: ${sigPath}`);
  console.log(`Signature (base64): ${sigBase64}`);

  // Derive public key from private key for self-verification
  const pubFromPriv = crypto.createPublicKey(privateKey);
  const valid = crypto.verify(null, fileData, pubFromPriv, signature);
  console.log(`Self-verification: ${valid ? 'PASSED' : 'FAILED'}`);

  if (!valid) {
    console.error('CRITICAL: Signature failed self-verification!');
    fs.unlinkSync(sigPath);
    process.exit(1);
  }
}

// ── Main ──
const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/sign-update.js <file-to-sign>');
  process.exit(1);
}

signFile(path.resolve(target));
