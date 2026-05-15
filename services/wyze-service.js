/**
 * Wyze Smart Device Service
 * Uses Python wyze-sdk via subprocess calls
 */

const { spawn } = require('child_process');
const path = require('path');
const { createLogger } = require('../utils/logger');

const log = createLogger('Wyze');
const PYTHON_SCRIPT = path.join(__dirname, '..', 'python', 'wyze_api.py');

class WyzeService {
  constructor() {
    this.accessToken = null;
    this.refreshToken = null;
    this.userId = null;
    this.credentials = null; // { email, password, keyId, apiKey, totpKey }
    this.devices = []; // Cached device list
  }

  /**
   * Execute Python script and return JSON result
   */
  _executePython(args, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      log.info(`[PYTHON] Executing: wyze_api.py ${args[0]}`);

      const proc = spawn('python3', [PYTHON_SCRIPT, ...args]);

      let stdout = '';
      let stderr = '';

      const timeout = setTimeout(() => {
        try {
          if (proc && proc.pid && !proc.killed && proc.exitCode === null) {
            proc.kill(); // Use default signal for Windows compatibility
          }
        } catch (e) {
          // Ignore EPIPE errors
          if (e.code !== 'EPIPE' && e.errno !== -4047) {
            log.error('Failed to kill timed-out Wyze process:', e.message);
          }
        }
        reject(new Error(`Wyze API timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        clearTimeout(timeout);

        if (code !== 0 && !stdout) {
          reject(new Error(stderr || `Python exited with code ${code}`));
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          if (result.error) {
            log.error('Wyze API error:', result.error);
          }
          resolve(result);
        } catch (e) {
          log.error('JSON parse error:', e.message);
          reject(new Error(`Invalid JSON: ${stdout.substring(0, 200)}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /**
   * Set credentials for Wyze connection
   */
  setCredentials(email, password, keyId, apiKey, totpKey = null) {
    log.info(`Setting credentials for ${email}`);
    this.credentials = { email, password, keyId, apiKey, totpKey };
    this.accessToken = null;
    this.refreshToken = null;
    this.userId = null;
  }

  /**
   * Check if credentials are configured
   */
  isConfigured() {
    return !!(this.credentials?.email && this.credentials?.password &&
              this.credentials?.keyId && this.credentials?.apiKey);
  }

  /**
   * Check if connected (has valid token)
   */
  isConnected() {
    return !!(this.accessToken);
  }

  /**
   * Login to Wyze and get access token
   */
  async connect() {
    if (!this.isConfigured()) {
      throw new Error('Wyze credentials not configured');
    }

    log.info('Connecting to Wyze...');

    const args = [
      'login',
      this.credentials.email,
      this.credentials.password,
      this.credentials.keyId,
      this.credentials.apiKey
    ];

    if (this.credentials.totpKey) {
      args.push(this.credentials.totpKey);
    }

    const result = await this._executePython(args, 60000); // 60s timeout for login

    if (result.error) {
      throw new Error(result.error);
    }

    this.accessToken = result.access_token;
    this.refreshToken = result.refresh_token;
    this.userId = result.user_id;

    log.info(`Connected to Wyze as user ${this.userId}`);
    return { success: true, userId: this.userId };
  }

  /**
   * Disconnect / clear tokens
   */
  disconnect() {
    log.info('Disconnecting from Wyze');
    this.accessToken = null;
    this.refreshToken = null;
    this.userId = null;
    this.devices = [];
  }

  /**
   * List all Wyze plugs
   */
  async listPlugs() {
    if (!this.accessToken) {
      throw new Error('Not connected to Wyze');
    }

    log.info('Listing Wyze plugs...');
    const result = await this._executePython(['list', this.accessToken]);

    if (result.error) {
      throw new Error(result.error);
    }

    this.devices = result.devices || [];
    log.info(`Found ${this.devices.length} Wyze plug(s)`);
    return this.devices;
  }

  /**
   * Get plug info
   */
  async getPlugInfo(deviceMac) {
    if (!this.accessToken) {
      throw new Error('Not connected to Wyze');
    }

    log.info(`Getting info for plug ${deviceMac}`);
    const result = await this._executePython(['info', this.accessToken, deviceMac]);

    if (result.error) {
      throw new Error(result.error);
    }

    return result;
  }

  /**
   * Get plug power state
   */
  async getPowerState(deviceMac) {
    if (!this.accessToken) {
      throw new Error('Not connected to Wyze');
    }

    log.info(`Getting state for plug ${deviceMac}`);
    const result = await this._executePython(['state', this.accessToken, deviceMac]);

    if (result.error) {
      throw new Error(result.error);
    }

    return result.state; // 'on' or 'off'
  }

  /**
   * Turn plug on
   */
  async turnOn(deviceMac, deviceModel) {
    if (!this.accessToken) {
      throw new Error('Not connected to Wyze');
    }

    log.info(`Turning ON Wyze plug ${deviceMac} (${deviceModel})`);
    const result = await this._executePython(['on', this.accessToken, deviceMac, deviceModel]);

    if (result.error) {
      throw new Error(result.error);
    }

    return result;
  }

  /**
   * Turn plug off
   */
  async turnOff(deviceMac, deviceModel) {
    if (!this.accessToken) {
      throw new Error('Not connected to Wyze');
    }

    log.info(`Turning OFF Wyze plug ${deviceMac} (${deviceModel})`);
    const result = await this._executePython(['off', this.accessToken, deviceMac, deviceModel]);

    if (result.error) {
      throw new Error(result.error);
    }

    return result;
  }

  /**
   * Get status object for API response
   */
  getStatus() {
    return {
      configured: this.isConfigured(),
      connected: this.isConnected(),
      userId: this.userId,
      deviceCount: this.devices.length
    };
  }
}

module.exports = new WyzeService();
