/**
 * TP-Link Tapo Smart Device Service
 * Uses Python plugp100 library for proper KLAP protocol support
 *
 * Supports: P100, P105, P110, P115 smart plugs
 */

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('Tapo');
const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'tapo-control.py');
const PYTHON_CMD = process.platform === 'win32' ? 'python' : 'python3';
const PIP_CMD = process.platform === 'win32' ? 'pip' : 'pip3';

class TapoService {
  constructor() {
    this.email = null;
    this.password = null;
    this.pythonReady = null; // null = unchecked, true = ready, string = error message
  }

  /**
   * Check if Python and tapo library are available, auto-install if needed
   * @returns {boolean|string} true if ready, error message string if not
   */
  _ensurePythonReady() {
    if (this.pythonReady !== null) {
      return this.pythonReady;
    }

    // Check if Python is available
    try {
      execSync(`${PYTHON_CMD} --version`, { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      this.pythonReady = 'Python is not installed. Please install Python 3.8+ from python.org';
      log.error(this.pythonReady);
      return this.pythonReady;
    }

    // Check if tapo library is installed
    try {
      execSync(`${PYTHON_CMD} -c "from tapo import ApiClient"`, { encoding: 'utf8', stdio: 'pipe' });
      log.info('Python tapo library is ready');
      this.pythonReady = true;
      return true;
    } catch (error) {
      // Not installed, try to auto-install
      log.info('tapo library not found, attempting auto-install...');
      try {
        const pipFlags = process.platform === 'linux' ? '--break-system-packages' : '';
        execSync(`${PIP_CMD} install ${pipFlags} tapo`, {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 120000
        });
        log.info('Successfully installed tapo library');
        this.pythonReady = true;
        return true;
      } catch (installError) {
        this.pythonReady = `Failed to install tapo: ${installError.message}. Try manually: ${PIP_CMD} install tapo`;
        log.error(this.pythonReady);
        return this.pythonReady;
      }
    }
  }

  /**
   * Set credentials for Tapo/TP-Link account
   */
  setCredentials(email, password) {
    const masked = email ? email.substring(0, 4) + '***' : 'null';
    log.info(`Setting credentials for ${masked}`);
    this.email = email;
    this.password = password;
  }

  /**
   * Check if credentials are configured
   */
  isConnected() {
    return !!(this.email && this.password);
  }

  /**
   * Clear all credentials
   */
  clearCredentials() {
    log.info('Clearing credentials');
    this.email = null;
    this.password = null;
  }

  /**
   * Execute Python Tapo control script
   * @param {string} command - on, off, state, info
   * @param {string} ip - Device IP address
   * @returns {object} Result from Python script
   */
  _execPython(command, ip) {
    // Clean and validate IP address
    let cleanIp = ip;
    if (typeof ip === 'string') {
      // Strip common prefixes like "IP " or "ip:"
      cleanIp = ip.replace(/^(IP\s*:?\s*)/i, '').trim();
    }

    if (!cleanIp || typeof cleanIp !== 'string' || !cleanIp.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/)) {
      throw new Error(`Invalid IP address: "${ip}". Please enter a valid IP like 192.168.1.100`);
    }

    ip = cleanIp;

    // Check Python/plugp100 ready (auto-installs if needed)
    const ready = this._ensurePythonReady();
    if (ready !== true) {
      throw new Error(ready);
    }

    if (!this.email || !this.password) {
      throw new Error('Tapo credentials not configured');
    }

    try {
      // Use execFileSync to avoid shell interpretation of special characters in password
      // -B flag disables bytecode caching to ensure fresh script execution after updates
      const result = execFileSync(PYTHON_CMD, [
        '-B', SCRIPT_PATH, command, ip, this.email, this.password
      ], { encoding: 'utf8', timeout: 30000 });
      return JSON.parse(result.trim());
    } catch (error) {
      log.error(`Python script error for ${command} on ${ip}:`, error.message);
      // Try to parse any JSON in stdout
      if (error.stdout) {
        try {
          return JSON.parse(error.stdout.trim());
        } catch (e) {
          // Ignore parse error
        }
      }
      throw new Error(`Tapo command failed: ${error.message}`);
    }
  }

  /**
   * Test connection - just validates credentials are set
   * Actual device test requires a specific IP
   * @returns {Promise<boolean>}
   */
  async testConnection() {
    if (!this.email || !this.password) {
      log.warn('Cannot test connection - no credentials set');
      return false;
    }
    // Credentials are set, consider connected
    // Actual device communication happens when a device is added/tested
    log.info('Tapo credentials configured');
    return true;
  }

  /**
   * List devices - not available via local API, return empty
   * Use the TP-Link/Tapo app to find device IPs
   */
  async listDevices() {
    log.info('Cloud device listing not supported - use manual IP entry');
    return [];
  }

  /**
   * Turn device on
   * @param {string} ip - Device IP address
   */
  async turnOn(ip) {
    log.info(`Turning ON device at ${ip}`);
    const result = this._execPython('on', ip);
    if (!result.success) {
      throw new Error(result.error || 'Failed to turn on device');
    }
    return result;
  }

  /**
   * Turn device off
   * @param {string} ip - Device IP address
   */
  async turnOff(ip) {
    log.info(`Turning OFF device at ${ip}`);
    const result = this._execPython('off', ip);
    if (!result.success) {
      throw new Error(result.error || 'Failed to turn off device');
    }
    return result;
  }

  /**
   * Get device info
   * @param {string} ip - Device IP address
   * @returns {Promise<object>} Device info object
   */
  async getDeviceInfo(ip) {
    const result = this._execPython('info', ip);
    if (!result.success) {
      throw new Error(result.error || 'Failed to get device info');
    }
    return result.info;
  }

  /**
   * Get power state of device
   * @param {string} ip - Device IP address
   * @returns {Promise<string>} 'on' or 'off'
   */
  async getPowerState(ip) {
    const result = this._execPython('state', ip);
    if (!result.success) {
      throw new Error(result.error || 'Failed to get power state');
    }
    return result.state;
  }
}

module.exports = new TapoService();
