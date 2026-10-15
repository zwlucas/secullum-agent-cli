/**
 * daemon.js - Background Service & Process Daemon Manager.
 * Supports:
 *   1. Cross-platform detached background process (PID file + log file)
 *   2. Windows Autostart / Scheduled Task installation
 *   3. Linux systemd service unit installation
 * Zero external npm dependencies.
 */

'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const PID_FILE = path.join(os.homedir(), '.secullum-agent.pid');
const LOG_FILE = path.join(os.homedir(), '.secullum-agent.log');
const CLI_PATH = path.resolve(__dirname, '..', 'bin', 'cli.js');

/**
 * Check if a process ID is currently running.
 * @param {number} pid
 * @returns {boolean}
 */
function isPidRunning(pid) {
  if (!pid || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // Running under another user
  }
}

/**
 * Get current background daemon status.
 * @returns {{ isRunning: boolean, pid: number | null, startedAt?: string, logPath: string, pidPath: string }}
 */
function getDaemonStatus() {
  if (!fs.existsSync(PID_FILE)) {
    return { isRunning: false, pid: null, logPath: LOG_FILE, pidPath: PID_FILE };
  }

  try {
    const raw = fs.readFileSync(PID_FILE, 'utf-8').trim();
    const data = JSON.parse(raw);
    const pid = Number(data.pid);

    if (isPidRunning(pid)) {
      return {
        isRunning: true,
        pid,
        startedAt: data.startedAt,
        logPath: LOG_FILE,
        pidPath: PID_FILE,
      };
    } else {
      // Stale PID file
      fs.unlinkSync(PID_FILE);
      return { isRunning: false, pid: null, logPath: LOG_FILE, pidPath: PID_FILE };
    }
  } catch {
    return { isRunning: false, pid: null, logPath: LOG_FILE, pidPath: PID_FILE };
  }
}

/**
 * Start the standalone agent in detached background mode.
 * @returns {{ ok: boolean, pid: number, logPath: string }}
 */
function startDaemon() {
  const current = getDaemonStatus();
  if (current.isRunning) {
    throw new Error(`Daemon is already running with PID ${current.pid}. Run 'secullum-agent-cli daemon:stop' first.`);
  }

  // Log start banner
  const banner = `\n${'='.repeat(70)}\n[${new Date().toISOString()}] Secullum Agent Daemon STARTED\n${'='.repeat(70)}\n`;
  fs.appendFileSync(LOG_FILE, banner, 'utf-8');

  // Spawn detached process
  const child = spawn(process.execPath, [CLI_PATH, 'connect'], {
    detached: true,
    stdio: 'ignore',
    cwd: path.resolve(__dirname, '..'),
    windowsHide: true,
    env: { ...process.env, SECULLUM_DAEMON: '1' },
  });

  const pid = child.pid;
  child.unref();

  // Save PID file
  const pidData = {
    pid,
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    platform: process.platform,
  };
  fs.writeFileSync(PID_FILE, JSON.stringify(pidData, null, 2), 'utf-8');

  return { ok: true, pid, logPath: LOG_FILE };
}

/**
 * Stop the background daemon process.
 * @returns {{ ok: boolean, pid: number }}
 */
function stopDaemon() {
  const current = getDaemonStatus();
  if (!current.isRunning || !current.pid) {
    throw new Error('Daemon is not currently running.');
  }

  const pid = current.pid;

  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
      // Wait up to 3 seconds for exit
      let elapsed = 0;
      while (isPidRunning(pid) && elapsed < 3000) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        elapsed += 200;
      }
      if (isPidRunning(pid)) {
        process.kill(pid, 'SIGKILL');
      }
    }
  } catch (err) {
    // Process might have already exited
  }

  if (fs.existsSync(PID_FILE)) {
    try { fs.unlinkSync(PID_FILE); } catch {}
  }

  const banner = `\n[${new Date().toISOString()}] Secullum Agent Daemon STOPPED (PID: ${pid})\n`;
  fs.appendFileSync(LOG_FILE, banner, 'utf-8');

  return { ok: true, pid };
}

/**
 * Read the last N lines from the daemon log file.
 * @param {number} [linesCount=25]
 * @returns {string}
 */
function getRecentLogs(linesCount = 25) {
  if (!fs.existsSync(LOG_FILE)) {
    return 'No logs found.';
  }

  try {
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const lines = content.split('\n');
    return lines.slice(-linesCount).join('\n');
  } catch (err) {
    return `Error reading log file: ${err.message}`;
  }
}

/**
 * Generate Linux systemd service unit content.
 * @returns {string}
 */
function generateSystemdUnit() {
  const nodeBin = process.execPath;
  const workDir = path.resolve(__dirname, '..');

  return `[Unit]
Description=Secullum RH - Standalone Communication Agent
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${workDir}
ExecStart=${nodeBin} ${CLI_PATH} connect
Restart=always
RestartSec=10
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Install OS background service / autostart.
 * @returns {{ ok: boolean, platform: string, details: string }}
 */
function installOsService() {
  if (process.platform === 'win32') {
    // Windows: Register Scheduled Task running on startup / logon
    const nodeBin = process.execPath;
    const taskName = 'SecullumAgentCLI';
    const cmd = `schtasks /Create /TN "${taskName}" /TR "\\"${nodeBin}\\" \\"${CLI_PATH}\\" connect" /SC ONLOGON /F /RL HIGHEST`;

    try {
      execSync(cmd, { stdio: 'pipe' });
      return {
        ok: true,
        platform: 'windows',
        details: `Windows Scheduled Task '${taskName}' registered to run automatically on user logon.`,
      };
    } catch (err) {
      throw new Error(`Failed to create Windows Task (requires Administrator terminal): ${err.message}`);
    }
  } else {
    // Linux: Generate and install systemd unit file
    const unitContent = generateSystemdUnit();
    const servicePath = '/etc/systemd/system/secullum-agent.service';

    try {
      fs.writeFileSync(servicePath, unitContent, 'utf-8');
      execSync('systemctl daemon-reload', { stdio: 'pipe' });
      execSync('systemctl enable secullum-agent.service', { stdio: 'pipe' });

      return {
        ok: true,
        platform: 'linux',
        details: `systemd service unit installed at ${servicePath} and enabled. Start with 'systemctl start secullum-agent'.`,
      };
    } catch (err) {
      throw new Error(`Failed to install systemd unit (requires sudo/root permissions): ${err.message}`);
    }
  }
}

/**
 * Uninstall OS background service / autostart.
 * @returns {{ ok: boolean, platform: string, details: string }}
 */
function uninstallOsService() {
  if (process.platform === 'win32') {
    const taskName = 'SecullumAgentCLI';
    try {
      execSync(`schtasks /Delete /TN "${taskName}" /F`, { stdio: 'pipe' });
      return { ok: true, platform: 'windows', details: `Task '${taskName}' removed.` };
    } catch (err) {
      throw new Error(`Failed to remove Windows Task: ${err.message}`);
    }
  } else {
    const servicePath = '/etc/systemd/system/secullum-agent.service';
    try {
      execSync('systemctl disable --now secullum-agent.service', { stdio: 'pipe' });
      if (fs.existsSync(servicePath)) fs.unlinkSync(servicePath);
      execSync('systemctl daemon-reload', { stdio: 'pipe' });
      return { ok: true, platform: 'linux', details: 'systemd service disabled and removed.' };
    } catch (err) {
      throw new Error(`Failed to remove systemd unit: ${err.message}`);
    }
  }
}

module.exports = {
  PID_FILE,
  LOG_FILE,
  isPidRunning,
  getDaemonStatus,
  startDaemon,
  stopDaemon,
  getRecentLogs,
  generateSystemdUnit,
  installOsService,
  uninstallOsService,
};
