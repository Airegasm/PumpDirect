/**
 * TP-Link Tapo Smart Device Service
 * Uses the Python `tapo` library via the helper script in scripts/tapo-control.py.
 *
 * All shell-outs are async (execFile + promisify) so a slow or hung Python
 * call doesn't block the Node event loop — earlier sync versions could lock
 * up the entire server (and all WebSocket pings) for up to 30 s per call.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('Tapo');
const execFileP = promisify(execFile);

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'tapo-control.py');
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const PIP_CMD = process.platform === 'win32' ? 'pip' : 'pip3';

class TapoService {
  constructor() {
    this.email = null;
    this.password = null;
    this.pythonReady = null; // null | true | string-error
    this._readyPromise = null;
  }

  async _checkPythonReady() {
    try {
      await execFileP(PYTHON_CMD, ['--version'], { timeout: 5000 });
    } catch {
      const msg = 'Python is not installed. Please install Python 3.8+ from python.org';
      log.error(msg);
      return msg;
    }
    try {
      await execFileP(PYTHON_CMD, ['-c', 'from tapo import ApiClient'], { timeout: 5000 });
      log.info('Python tapo library is ready');
      return true;
    } catch {
      log.info('tapo library not found, attempting auto-install…');
      const args = process.platform === 'linux'
        ? ['install', '--break-system-packages', 'tapo']
        : ['install', 'tapo'];
      try {
        await execFileP(PIP_CMD, args, { timeout: 120000 });
        log.info('Successfully installed tapo library');
        return true;
      } catch (e) {
        const msg = `Failed to install tapo: ${e.message}. Try manually: ${PIP_CMD} install tapo`;
        log.error(msg);
        return msg;
      }
    }
  }

  _ensurePythonReady() {
    if (this.pythonReady === true) return Promise.resolve(true);
    if (typeof this.pythonReady === 'string') return Promise.resolve(this.pythonReady);
    if (!this._readyPromise) {
      this._readyPromise = this._checkPythonReady().then(r => {
        this.pythonReady = r;
        this._readyPromise = null;
        return r;
      });
    }
    return this._readyPromise;
  }

  setCredentials(email, password) {
    const masked = email ? email.substring(0, 4) + '***' : 'null';
    log.info(`Setting credentials for ${masked}`);
    this.email = email;
    this.password = password;
  }

  isConnected() { return !!(this.email && this.password); }

  clearCredentials() {
    log.info('Clearing credentials');
    this.email = null;
    this.password = null;
  }

  async _execPython(command, ip) {
    let cleanIp = ip;
    if (typeof ip === 'string') cleanIp = ip.replace(/^(IP\s*:?\s*)/i, '').trim();
    if (!cleanIp || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanIp)) {
      throw new Error(`Invalid IP address: "${ip}". Please enter a valid IP like 192.168.1.100`);
    }
    ip = cleanIp;

    const ready = await this._ensurePythonReady();
    if (ready !== true) throw new Error(ready);
    if (!this.email || !this.password) throw new Error('Tapo credentials not configured');

    try {
      const { stdout } = await execFileP(
        PYTHON_CMD,
        ['-B', SCRIPT_PATH, command, ip, this.email, this.password],
        { encoding: 'utf8', timeout: 30000 },
      );
      return JSON.parse(stdout.trim());
    } catch (error) {
      log.error(`Python script error for ${command} on ${ip}:`, error.message);
      if (error.stdout) {
        try { return JSON.parse(error.stdout.toString().trim()); } catch {}
      }
      throw new Error(`Tapo command failed: ${error.message}`);
    }
  }

  async testConnection() {
    if (!this.email || !this.password) {
      log.warn('Cannot test connection - no credentials set');
      return false;
    }
    log.info('Tapo credentials configured');
    return true;
  }

  async listDevices() {
    log.info('Cloud device listing not supported - use manual IP entry');
    return [];
  }

  async turnOn(ip) {
    log.info(`Turning ON device at ${ip}`);
    const result = await this._execPython('on', ip);
    if (!result.success) throw new Error(result.error || 'Failed to turn on device');
    return result;
  }

  async turnOff(ip) {
    log.info(`Turning OFF device at ${ip}`);
    const result = await this._execPython('off', ip);
    if (!result.success) throw new Error(result.error || 'Failed to turn off device');
    return result;
  }

  async getDeviceInfo(ip) {
    const result = await this._execPython('info', ip);
    if (!result.success) throw new Error(result.error || 'Failed to get device info');
    return result.info;
  }

  async getPowerState(ip) {
    const result = await this._execPython('state', ip);
    if (!result.success) throw new Error(result.error || 'Failed to get power state');
    return result.state;
  }
}

module.exports = new TapoService();
