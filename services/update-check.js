const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Update');
const execFileP = promisify(execFile);
const PROJECT_DIR = path.resolve(__dirname, '..');
const CACHE_TTL_MS = 60 * 60 * 1000;

let cache = null;
let cacheTime = 0;

async function checkForUpdates() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL_MS) return cache;

  const result = { isGitRepo: false, currentSha: null, behind: 0, branch: null, error: null };
  try {
    if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) {
      result.error = 'not a git checkout';
      cache = result; cacheTime = now;
      return result;
    }
    result.isGitRepo = true;
    const sha = (await execFileP('git', ['-C', PROJECT_DIR, 'rev-parse', 'HEAD'])).stdout.trim();
    result.currentSha = sha.slice(0, 7);
    try {
      result.branch = (await execFileP('git', ['-C', PROJECT_DIR, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    } catch {}
    try {
      await execFileP('git', ['-C', PROJECT_DIR, 'fetch', '--quiet'], { timeout: 12000 });
      const cnt = (await execFileP('git', ['-C', PROJECT_DIR, 'rev-list', '--count', 'HEAD..@{u}'])).stdout.trim();
      result.behind = parseInt(cnt, 10) || 0;
    } catch (e) {
      result.error = ('fetch: ' + (e.message || 'unknown')).slice(0, 120);
    }
  } catch (e) {
    result.error = e.message;
  }
  cache = result; cacheTime = now;
  return result;
}

function invalidate() { cache = null; cacheTime = 0; }

// Platform-aware copy/paste-able update commands. Branches on whether the
// OS-hardened service is installed (NSSM on Windows, systemd on Linux) since
// the launchers can't bind the same ports the service holds.
function getUpdateCommands(platform, serviceInstalled) {
  const dir = PROJECT_DIR;
  if (platform === 'win32') {
    return {
      scope: serviceInstalled ? 'Windows Service (NSSM)' : 'Windows',
      shell: 'PowerShell (run as Administrator)',
      cmd: `powershell -NoProfile -ExecutionPolicy Bypass -File "${dir}\\update.ps1"`,
      note: 'update.ps1 finds git/npm even if not on PATH (probes Git for Windows and GitHub Desktop install paths), stops the service if running, pulls, runs npm install only if dependencies changed, then restarts the service.',
    };
  }
  if (platform === 'linux') {
    if (serviceInstalled) {
      return {
        scope: 'systemd service',
        shell: 'terminal (sudo password)',
        cmd: `sudo systemctl stop pumpdirect && cd "${dir}" && git pull && npm install --no-audit --no-fund && sudo systemctl start pumpdirect`,
      };
    }
  }
  if (platform === 'darwin' || platform === 'linux') {
    return {
      scope: platform === 'darwin' ? 'macOS (launcher)' : 'Linux (launcher)',
      shell: 'terminal',
      cmd: `cd "${dir}" && ./start.sh`,
      note: 'start.sh auto-pulls on launch. Stop any running PumpDirect first.',
    };
  }
  return {
    scope: platform || 'unknown',
    shell: 'terminal',
    cmd: `cd "${dir}" && git pull && npm install --no-audit --no-fund`,
    note: 'Restart PumpDirect after running.',
  };
}

module.exports = { checkForUpdates, invalidate, getUpdateCommands };
