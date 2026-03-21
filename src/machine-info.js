'use strict';

/**
 * machine-info.js
 * Collects Windows machine facts: hostname, serial, IP, MAC, logged-in user.
 * All WMI calls are batched into a single PowerShell subprocess to minimise
 * startup overhead (spawning PS repeatedly is slow).
 */

const { execFileSync } = require('child_process');
const os               = require('os');

/**
 * Runs a PowerShell expression, returning trimmed stdout or a fallback.
 * Progress output is suppressed to avoid CLIXML noise.
 */
function ps(expression, fallback = 'Unknown') {
  try {
    const script = `$ProgressPreference = 'SilentlyContinue'; ${expression}`;
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { encoding: 'utf8', timeout: 8_000 });
    return out.trim() || fallback;
  } catch {
    return fallback;
  }
}

/**
 * Returns the currently logged-in interactive Windows user (username only,
 * no domain/hostname prefix). Win32_ComputerSystem.UserName reflects the
 * interactive session, correct even when the app runs as SYSTEM.
 */
function getWindowsUser() {
  const raw = ps('(Get-WmiObject -Class Win32_ComputerSystem).UserName');
  return raw.includes('\\') ? raw.split('\\').pop() : raw;
}

/**
 * Returns all machine facts in a single batched PowerShell call.
 * Falls back to os module / 'Unknown' on any error.
 */
function getMachineInfo() {
  const hostname = os.hostname();
  const { ip, mac } = _getIPAndMAC();

  // Batch serial + windows user into one PS call to keep startup fast
  let windowsUser = 'Unknown';
  let serial      = 'Unknown';
  try {
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      "$u = (Get-WmiObject -Class Win32_ComputerSystem).UserName",
      "$s = (Get-WmiObject -Class Win32_BIOS).SerialNumber",
      "Write-Output $u",
      "Write-Output $s"
    ].join('; ');

    const out   = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ], { encoding: 'utf8', timeout: 10_000 });

    const lines = out.trim().split(/\r?\n/);
    const rawUser = (lines[0] || '').trim();
    windowsUser   = rawUser.includes('\\') ? rawUser.split('\\').pop() : (rawUser || 'Unknown');
    serial        = (lines[1] || '').trim() || 'Unknown';
  } catch {
    // Non-fatal — fallback values used
  }

  return { hostname, windowsUser, serial, ip, mac };
}

function _getIPAndMAC() {
  const ifaces = os.networkInterfaces();
  const candidates = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (addr.mac === '00:00:00:00:00:00') continue; // skip VPN/virtual adapters
      candidates.push({ name, ip: addr.address, mac: addr.mac });
    }
  }

  if (!candidates.length) return { ip: 'Unknown', mac: 'Unknown' };

  // Prefer adapters whose name suggests a physical NIC (Ethernet/Wi-Fi/Local Area)
  // over VPN adapters (Tailscale, Hamachi, etc.)
  const physical = candidates.find(c =>
    /ethernet|wi-fi|wifi|wireless|local area/i.test(c.name) &&
    !/tailscale|hamachi|vpn|tunnel/i.test(c.name)
  );

  const chosen = physical || candidates[0];
  return { ip: chosen.ip, mac: chosen.mac };
}

module.exports = { getMachineInfo, getWindowsUser };
