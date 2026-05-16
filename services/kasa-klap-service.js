/**
 * Kasa 1.1.x+ Smart Device Service
 *
 * Handles TP-Link Kasa devices on firmware 1.1.x and newer, where TP-Link
 * disabled the legacy unauthenticated port-9999 protocol in favour of the
 * authenticated KLAP protocol. Uses the Python `python-kasa` library via the
 * helper script in scripts/kasa-klap-control.py.
 *
 * For older devices/firmware that still speak the legacy XOR protocol on
 * port 9999, use kasa-service.js (the "Kasa" vendor) instead.
 *
 * All shell-outs are async (execFile + promisify) so a slow or hung Python
 * call doesn't block the Node event loop.
 */

const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('KasaKlap');
const execFileP = promisify(execFile);

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'kasa-klap-control.py');
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const PIP_CMD = process.platform === 'win32' ? 'pip' : 'pip3';

class KasaKlapService {
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
      await execFileP(PYTHON_CMD, ['-c', 'from kasa import Discover'], { timeout: 5000 });
      log.info('Python python-kasa library is ready');
      return true;
    } catch {
      log.info('python-kasa library not found, attempting auto-install…');
      const args = process.platform === 'linux'
        ? ['install', '--break-system-packages', 'python-kasa']
        : ['install', 'python-kasa'];
      try {
        await execFileP(PIP_CMD, args, { timeout: 120000 });
        log.info('Successfully installed python-kasa library');
        return true;
      } catch (e) {
        const msg = `Failed to install python-kasa: ${e.message}. Try manually: ${PIP_CMD} install python-kasa`;
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

  /**
   * Run the Python KLAP control script.
   * @param {string} command - on | off | state | info | discover
   * @param {string|number} arg - device IP (or discovery timeout for `discover`)
   */
  async _execPython(command, arg) {
    // Validate IP for device-targeted commands; `discover` takes a timeout instead.
    if (command !== 'discover') {
      let cleanIp = arg;
      if (typeof arg === 'string') cleanIp = arg.replace(/^(IP\s*:?\s*)/i, '').trim();
      if (!cleanIp || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(cleanIp)) {
        throw new Error(`Invalid IP address: "${arg}". Please enter a valid IP like 192.168.1.100`);
      }
      arg = cleanIp;
    }

    const ready = await this._ensurePythonReady();
    if (ready !== true) throw new Error(ready);
    if (!this.email || !this.password) throw new Error('Kasa 1.1.x+ credentials not configured');

    try {
      const { stdout } = await execFileP(
        PYTHON_CMD,
        ['-B', SCRIPT_PATH, command, String(arg), this.email, this.password],
        { encoding: 'utf8', timeout: 30000 },
      );
      return JSON.parse(stdout.trim());
    } catch (error) {
      log.error(`Python script error for ${command} on ${arg}:`, error.message);
      if (error.stdout) {
        try { return JSON.parse(error.stdout.toString().trim()); } catch {}
      }
      throw new Error(`Kasa 1.1.x+ command failed: ${error.message}`);
    }
  }

  async testConnection() {
    if (!this.email || !this.password) {
      log.warn('Cannot test connection - no credentials set');
      return false;
    }
    log.info('Kasa 1.1.x+ credentials configured');
    return true;
  }

  /**
   * Discover KLAP-protocol Kasa devices on the local network.
   * @param {number} timeoutSeconds - discovery timeout
   * @returns {Promise<Array>} discovered devices
   */
  async listDevices(timeoutSeconds = 5) {
    const result = await this._execPython('discover', timeoutSeconds);
    if (!result.success) throw new Error(result.error || 'Discovery failed');
    return result.devices || [];
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

module.exports = new KasaKlapService();
