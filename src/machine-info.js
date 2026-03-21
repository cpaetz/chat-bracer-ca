'use strict';

/**
 * machine-info.js
 * Collects Windows machine facts: hostname, serial, IP, MAC, logged-in user.
 * Uses PowerShell for data that os module cannot provide (serial, interactive user).
 */

const { execFileSync } = require('child_process');
const os               = require('os');

/**
 * Runs a short PowerShell expression and returns trimmed stdout.
 * Returns fallback string on any error.
 */
function ps(expression, fallback = 'Unknown') {
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', expression
    ], { encoding: 'utf8', timeout: 8_000 });
    return out.trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Returns the currently logged-in interactive Windows user (just the username,
 * without the domain/hostname prefix). Uses Win32_ComputerSystem.UserName which
 * reflects the interactive session — correct even when the app runs as SYSTEM.
 */
function getWindowsUser() {
  const raw = ps('(Get-WmiObject -Class Win32_ComputerSystem).UserName');
  // UserName format: "DOMAIN\\username" or "HOSTNAME\\username"
  return raw.includes('\\') ? raw.split('\\').pop() : raw;
}

/**
 * Returns the BIOS serial number. May be "To Be Filled By O.E.M." on some
 * consumer boards — returned as-is.
 */
function getSerial() {
  return ps('(Get-WmiObject -Class Win32_BIOS).SerialNumber');
}

/**
 * Returns the first non-loopback IPv4 address and its MAC.
 */
function getIPAndMAC() {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return { ip: addr.address, mac: addr.mac };
      }
    }
  }
  return { ip: 'Unknown', mac: 'Unknown' };
}

/**
 * Returns all machine facts as a single object.
 */
function getMachineInfo() {
  const hostname    = os.hostname();
  const windowsUser = getWindowsUser();
  const serial      = getSerial();
  const { ip, mac } = getIPAndMAC();
  return { hostname, windowsUser, serial, ip, mac };
}

module.exports = { getMachineInfo, getWindowsUser };
