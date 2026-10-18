// Run the daemon in the background at login: launchd on macOS, a systemd user unit on Linux.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from './config.js';
import { resolveWacliBin } from './wacli.js';

const LABEL = 'com.wadigest.daemon';
const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'wadigest.js');

function envPath(cfg) {
  const dirs = new Set([path.dirname(process.execPath), path.join(paths().home, 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', path.join(os.homedir(), '.local', 'bin')]);
  const w = resolveWacliBin(cfg);
  if (w.includes('/')) dirs.add(path.dirname(w));
  for (const p of String(process.env.PATH || '').split(':')) if (p) dirs.add(p);
  return [...dirs].join(':');
}

function xml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function launchdPlist(cfg) {
  const p = paths();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(cliPath)}</string>
    <string>daemon</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xml(envPath(cfg))}</string>
    <key>WADIGEST_HOME</key><string>${xml(p.home)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(p.logs, 'daemon.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(p.logs, 'daemon.err.log'))}</string>
</dict>
</plist>
`;
}

export function systemdUnit(cfg) {
  const p = paths();
  return `[Unit]
Description=wadigest weekly WhatsApp digest
After=network-online.target

[Service]
ExecStart=${process.execPath} ${cliPath} daemon
Environment=PATH=${envPath(cfg)}
Environment=WADIGEST_HOME=${p.home}
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
}

// Windows: a hidden launcher in the user's Startup folder (no admin rights needed).
const winStartupFile = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'wadigest.vbs');
const daemonPidFile = () => path.join(paths().home, 'daemon.pid');

function winVbs() {
  const q = (s) => String(s).replace(/"/g, '""');
  const lines = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Environment("PROCESS")("WADIGEST_HOME") = "${q(paths().home)}"`,
    `sh.Environment("PROCESS")("PATH") = "${q(path.join(paths().home, 'bin'))};" & sh.Environment("PROCESS")("PATH")`,
    `sh.Run """${q(process.execPath)}"" ""${q(cliPath)}"" daemon", 0, False`,
  ];
  return lines.join('\r\n') + '\r\n';
}

function pidAlive() {
  try {
    const pid = Number(fs.readFileSync(daemonPidFile(), 'utf8'));
    if (!pid) return 0;
    process.kill(pid, 0);
    return pid;
  } catch { return 0; }
}

const plistFile = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const unitFile = () => path.join(os.homedir(), '.config', 'systemd', 'user', 'wadigest.service');

function sh(cmd, args, { ignore = false } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
  } catch (err) {
    if (ignore) return '';
    throw new Error(`${cmd} ${args.join(' ')}: ${String(err.stderr || err.message).trim()}`);
  }
}

export function installService(cfg) {
  fs.mkdirSync(paths().logs, { recursive: true });
  if (process.env.WADIGEST_FAKE_SERVICE) { fs.writeFileSync(path.join(paths().home, '.fake-service'), 'running'); return 'test service'; }
  if (process.platform === 'darwin') {
    const file = plistFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const domain = `gui/${process.getuid()}`;
    sh('launchctl', ['bootout', `${domain}/${LABEL}`], { ignore: true });
    fs.writeFileSync(file, launchdPlist(cfg));
    try { sh('launchctl', ['bootstrap', domain, file]); } catch {
      // Right after bootout, launchd can still be tearing the old job down.
      execFileSync('sleep', ['2']);
      sh('launchctl', ['bootstrap', domain, file]);
    }
    sh('launchctl', ['enable', `${domain}/${LABEL}`], { ignore: true });
    sh('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`], { ignore: true });
    return `launchd agent ${file}`;
  }
  if (process.platform === 'linux') {
    const file = unitFile();
    try { sh('systemctl', ['--user', 'show-environment']); } catch {
      throw new Error('this computer has no background services for your user (systemd). Run `wadigest daemon` inside tmux or screen to keep it going');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, systemdUnit(cfg));
    try {
      sh('systemctl', ['--user', 'daemon-reload']);
      sh('systemctl', ['--user', 'enable', '--now', 'wadigest.service']);
    } catch (err) {
      fs.rmSync(file, { force: true });
      throw err;
    }
    sh('systemctl', ['--user', 'restart', 'wadigest.service'], { ignore: true });
    // Keeps the service running after logout (servers). Usually allowed for your own user.
    sh('loginctl', ['enable-linger', os.userInfo().username], { ignore: true });
    const lingering = /Linger=yes/.test(sh('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'], { ignore: true }));
    return `systemd user unit ${file}${lingering ? '' : ' (run `sudo loginctl enable-linger $USER` to keep it running while logged out)'}`;
  }
  if (process.platform === 'win32') {
    const file = winStartupFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, winVbs());
    const old = pidAlive();
    if (old) { try { process.kill(old); } catch { /* ignore */ } }
    sh('wscript', [file], { ignore: true });
    return `Startup item ${file}`;
  }
  throw new Error('Background service is supported on macOS, Linux and Windows.');
}

export function uninstallService() {
  if (process.platform === 'darwin') {
    sh('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { ignore: true });
    fs.rmSync(plistFile(), { force: true });
    return true;
  }
  if (process.platform === 'linux') {
    sh('systemctl', ['--user', 'disable', '--now', 'wadigest.service'], { ignore: true });
    fs.rmSync(unitFile(), { force: true });
    sh('systemctl', ['--user', 'daemon-reload'], { ignore: true });
    return true;
  }
  if (process.platform === 'win32') {
    const pid = pidAlive();
    if (pid) { try { process.kill(pid); } catch { /* ignore */ } }
    fs.rmSync(winStartupFile(), { force: true });
    return true;
  }
  return false;
}

/** 'running' | 'stopped' | 'not installed' | 'unsupported' */
export function serviceStatus() {
  if (process.env.WADIGEST_FAKE_SERVICE) return fs.existsSync(path.join(paths().home, '.fake-service')) ? 'running' : 'not installed';
  if (process.platform === 'darwin') {
    if (!fs.existsSync(plistFile())) return 'not installed';
    const out = sh('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { ignore: true });
    if (!out) return 'stopped';
    return /state = running/.test(out) ? 'running' : 'stopped';
  }
  if (process.platform === 'linux') {
    if (!fs.existsSync(unitFile())) return 'not installed';
    return sh('systemctl', ['--user', 'is-active', 'wadigest.service'], { ignore: true }).trim() === 'active' ? 'running' : 'stopped';
  }
  if (process.platform === 'win32') {
    if (!fs.existsSync(winStartupFile())) return 'not installed';
    return pidAlive() ? 'running' : 'stopped';
  }
  return 'unsupported';
}

export function stopServiceIfRunning() {
  const was = serviceStatus() === 'running';
  if (!was) return false;
  if (process.platform === 'darwin') sh('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { ignore: true });
  if (process.platform === 'linux') sh('systemctl', ['--user', 'stop', 'wadigest.service'], { ignore: true });
  if (process.platform === 'win32') { const pid = pidAlive(); if (pid) { try { process.kill(pid); } catch { /* ignore */ } } }
  return true;
}
