'use strict';

/**
 * machine-info.js
 * Collects Windows machine facts: hostname, serial, IP, MAC, logged-in user.
 * All WMI calls are batched into a single PowerShell subprocess to minimise
 * startup overhead (spawning PS repeatedly is slow).
 */

const { execFileSync, execFile } = require('child_process');
const { promisify }              = require('util');
const os                         = require('os');

const execFileAsync = promisify(execFile);
const path = require('path');
const fs   = require('fs');

/**
 * Write a PowerShell script to a temp file and execute it with -File.
 * This avoids Node 22's DEP0190 which expands $_ and other $ variables
 * in -Command arguments before they reach PowerShell.
 */
function runPsScript(scriptLines, opts = {}) {
  // Use mkdtempSync to create a unique directory — mitigates TOCTOU race
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'bracer-ps-'));
  const tmpFile = path.join(tmpDir, 'run.ps1');
  const content = '$ProgressPreference = "SilentlyContinue"\r\n' + scriptLines.join('\r\n');
  fs.writeFileSync(tmpFile, content, 'utf8');
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile
    ], { encoding: 'utf8', timeout: opts.timeout || 8_000 });
    return out;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

async function runPsScriptAsync(scriptLines, opts = {}) {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'bracer-ps-'));
  const tmpFile = path.join(tmpDir, 'run.ps1');
  const content = '$ProgressPreference = "SilentlyContinue"\r\n' + scriptLines.join('\r\n');
  fs.writeFileSync(tmpFile, content, 'utf8');
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tmpFile
    ], { encoding: 'utf8', timeout: opts.timeout || 15_000 });
    return result;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  }
}

/**
 * Runs a PowerShell expression, returning trimmed stdout or a fallback.
 * Progress output is suppressed to avoid CLIXML noise.
 */
function ps(expression, fallback = 'Unknown') {
  try {
    const out = runPsScript([expression]);
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
  const raw = ps('(Get-CimInstance -Class Win32_ComputerSystem).UserName');
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
    const out = runPsScript([
      "$u = (Get-CimInstance -Class Win32_ComputerSystem).UserName",
      "$s = (Get-CimInstance -Class Win32_BIOS).SerialNumber",
      "Write-Output $u",
      "Write-Output $s",
    ], { timeout: 10_000 });

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

/**
 * Async version of getWindowsUser — uses execFile (non-blocking) so the
 * main process event loop stays responsive while PowerShell runs.
 * Called by the 60-second display-name poll in main.js.
 */
async function getWindowsUserAsync() {
  try {
    const { stdout } = await runPsScriptAsync([
      "(Get-CimInstance -Class Win32_ComputerSystem).UserName",
    ], { timeout: 8_000 });
    const raw = stdout.trim();
    return raw.includes('\\') ? raw.split('\\').pop() : (raw || 'Unknown');
  } catch {
    return 'Unknown';
  }
}

/**
 * Returns CPU model, current usage %, and RAM used/total.
 */
async function getCpuAndMemory() {
  try {
    const { stdout } = await runPsScriptAsync([
      "$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1)",
      "$cpuLoad = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average",
      "$mem = Get-CimInstance Win32_OperatingSystem",
      "$totalGB = [math]::Round($mem.TotalVisibleMemorySize / 1MB, 1)",
      "$freeGB = [math]::Round($mem.FreePhysicalMemory / 1MB, 1)",
      "$usedGB = [math]::Round($totalGB - $freeGB, 1)",
      "$pct = [math]::Round(($usedGB / $totalGB) * 100, 0)",
      "Write-Output $cpu.Name",
      "Write-Output \"${cpuLoad}\"",
      "Write-Output \"${usedGB} / ${totalGB} GB (${pct}%)\"",
    ]);

    const lines = stdout.trim().split(/\r?\n/);
    return {
      cpuModel: (lines[0] || 'Unknown').trim(),
      cpuUsage: (lines[1] || '?').trim() + '%',
      memory:   (lines[2] || 'Unknown').trim(),
    };
  } catch {
    return { cpuModel: 'Unknown', cpuUsage: '?', memory: 'Unknown' };
  }
}

/**
 * Returns disk info: drive letter, label, used/total/%, brand, model, serial.
 */
async function getDiskInfo() {
  try {
    const { stdout } = await runPsScriptAsync([
      "# Physical disk info",
      "$disks = Get-PhysicalDisk | ForEach-Object {",
      "  $_.DeviceId + '|' + $_.FriendlyName + '|' + $_.SerialNumber.Trim() + '|' + [math]::Round($_.Size / 1GB, 0)",
      "}",
      "# Logical volumes",
      "$vols = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {",
      "  $totalGB = [math]::Round($_.Size / 1GB, 1)",
      "  $freeGB = [math]::Round($_.FreeSpace / 1GB, 1)",
      "  $usedGB = [math]::Round($totalGB - $freeGB, 1)",
      "  $pct = if ($totalGB -gt 0) { [math]::Round(($usedGB / $totalGB) * 100, 0) } else { 0 }",
      "  $_.DeviceID + '|' + $_.VolumeName + '|' + \"${usedGB}/${totalGB} GB (${pct}%)\"",
      "}",
      "Write-Output 'DISKS'",
      "$disks | ForEach-Object { Write-Output $_ }",
      "Write-Output 'VOLUMES'",
      "$vols | ForEach-Object { Write-Output $_ }",
    ]);

    const lines = stdout.trim().split(/\r?\n/);
    const disks = [];
    const volumes = [];
    let section = '';

    for (const line of lines) {
      if (line === 'DISKS') { section = 'disks'; continue; }
      if (line === 'VOLUMES') { section = 'volumes'; continue; }
      const parts = line.split('|');
      if (section === 'disks' && parts.length >= 4) {
        disks.push({ id: parts[0], model: parts[1], serial: parts[2], sizeGB: parts[3] });
      }
      if (section === 'volumes' && parts.length >= 3) {
        volumes.push({ drive: parts[0], label: parts[1], usage: parts[2] });
      }
    }

    return { disks, volumes };
  } catch (err) {
    console.error('[machine-info] getDiskInfo failed:', err.message, err.stderr || '');
    return { disks: [], volumes: [] };
  }
}

/**
 * Returns all network adapters with IPs.
 */
function getNetworkInfo() {
  const ifaces = os.networkInterfaces();
  const adapters = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs) {
      if (addr.family !== 'IPv4') continue;
      if (addr.mac === '00:00:00:00:00:00' && addr.internal) continue;
      adapters.push({
        name,
        ip: addr.address,
        mac: addr.mac,
        internal: addr.internal,
      });
    }
  }

  return adapters;
}

/**
 * Returns system uptime and last reboot time.
 */
async function getUptimeInfo() {
  try {
    const { stdout } = await runPsScriptAsync([
      "$os = Get-CimInstance Win32_OperatingSystem",
      "$boot = $os.LastBootUpTime",
      "$uptime = (Get-Date) - $boot",
      "$days = $uptime.Days",
      "$hrs = $uptime.Hours",
      "$mins = $uptime.Minutes",
      "Write-Output $boot.ToString('yyyy-MM-dd HH:mm:ss')",
      "Write-Output \"${days}d ${hrs}h ${mins}m\"",
    ], { timeout: 10_000 });

    const lines = stdout.trim().split(/\r?\n/);
    return {
      lastReboot: (lines[0] || 'Unknown').trim(),
      uptime: (lines[1] || 'Unknown').trim(),
    };
  } catch {
    return { lastReboot: 'Unknown', uptime: 'Unknown' };
  }
}

module.exports = { getMachineInfo, getWindowsUser, getWindowsUserAsync, getCpuAndMemory, getDiskInfo, getNetworkInfo, getUptimeInfo };
