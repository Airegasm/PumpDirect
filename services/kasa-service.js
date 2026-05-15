/**
 * Native Node.js TP-Link Kasa Smart Device Service
 * Replaces Python subprocess calls with direct TCP communication
 *
 * Protocol: XOR autokey cipher with initial key of 171
 * Port: 9999 (TCP for commands, UDP for discovery)
 */

const net = require('net');
const dgram = require('dgram');
const { createLogger } = require('../utils/logger');

const log = createLogger('Kasa');

const KASA_PORT = 9999;
const DEFAULT_TIMEOUT = 5000;
const STATE_CACHE_TTL = 2000; // Cache state responses for 2 seconds

// Cache for getInfo responses - prevents flooding when multiple outlets poll the same device
// Key: IP address, Value: { data: response, timestamp: ms, promise: pending promise }
const infoCache = new Map();

/**
 * Encrypt a string using TP-Link's XOR autokey cipher
 * @param {string} data - Plain text string to encrypt
 * @returns {Buffer} - Encrypted data with 4-byte length header
 */
function encrypt(data) {
  let key = 171;
  const payload = Buffer.alloc(data.length);

  for (let i = 0; i < data.length; i++) {
    const encrypted = key ^ data.charCodeAt(i);
    key = encrypted;
    payload[i] = encrypted;
  }

  // Prepend 4-byte big-endian length header
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length, 0);

  return Buffer.concat([header, payload]);
}

/**
 * Decrypt data using TP-Link's XOR autokey cipher
 * @param {Buffer} data - Encrypted data to decrypt (without length header)
 * @returns {string} - Decrypted plain text string
 */
function decrypt(data) {
  let key = 171;
  let result = '';

  for (let i = 0; i < data.length; i++) {
    const decrypted = key ^ data[i];
    key = data[i];
    result += String.fromCharCode(decrypted);
  }

  return result;
}

/**
 * Send a command to a Kasa device and return the response
 * @param {string} ip - Device IP address
 * @param {object} command - Command object to send
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<object>} - Response from device
 */
function sendCommand(ip, command, timeout = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const jsonCmd = JSON.stringify(command);
    const encrypted = encrypt(jsonCmd);
    log.debug(`[NATIVE NODE.JS] Sending command to ${ip}:`, Object.keys(command).join(', '));

    const socket = new net.Socket();
    let responseData = Buffer.alloc(0);
    let expectedLength = null;
    let headerReceived = false;

    const timeoutHandle = setTimeout(() => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    }, timeout);

    socket.connect(KASA_PORT, ip, () => {
      socket.write(encrypted);
    });

    socket.on('data', (chunk) => {
      responseData = Buffer.concat([responseData, chunk]);

      // Parse header to get expected length
      if (!headerReceived && responseData.length >= 4) {
        expectedLength = responseData.readUInt32BE(0);
        headerReceived = true;
      }

      // Check if we have the complete response
      if (headerReceived && responseData.length >= expectedLength + 4) {
        clearTimeout(timeoutHandle);
        socket.destroy();

        // Extract payload (skip 4-byte header)
        const payload = responseData.slice(4, expectedLength + 4);
        const decrypted = decrypt(payload);

        try {
          const response = JSON.parse(decrypted);
          resolve(response);
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Socket error: ${err.message}`));
    });

    socket.on('close', () => {
      clearTimeout(timeoutHandle);
    });
  });
}

/**
 * Discover Kasa devices on the local network via UDP broadcast
 * @param {number} timeout - Discovery timeout in seconds
 * @returns {Promise<string[]>} - Array of discovered device IPs
 */
function discover(timeout = 3) {
  return new Promise((resolve) => {
    log.info(`[NATIVE NODE.JS] Starting UDP discovery (${timeout}s timeout)...`);
    const discovered = new Set();
    const command = '{"system":{"get_sysinfo":{}}}';

    // Encrypt for UDP (no length header needed for broadcast)
    let key = 171;
    const encrypted = Buffer.alloc(command.length);
    for (let i = 0; i < command.length; i++) {
      const enc = key ^ command.charCodeAt(i);
      key = enc;
      encrypted[i] = enc;
    }

    const socket = dgram.createSocket('udp4');

    socket.on('message', (msg, rinfo) => {
      // Filter out echo responses - real device responses are much longer
      if (msg.length > 50) {
        discovered.add(rinfo.address);
      }
    });

    socket.on('error', (err) => {
      log.error('Discovery error:', err.message);
    });

    socket.bind(() => {
      socket.setBroadcast(true);

      // Broadcast addresses to try
      const broadcasts = [
        '255.255.255.255',
        '192.168.1.255',
        '192.168.0.255',
        '192.168.255.255',
        '10.0.255.255',
        '10.255.255.255'
      ];

      // Send discovery packets multiple times
      let sendCount = 0;
      const sendInterval = setInterval(() => {
        broadcasts.forEach(addr => {
          try {
            socket.send(encrypted, 0, encrypted.length, KASA_PORT, addr);
          } catch (e) {
            // Ignore send errors for specific addresses
          }
        });
        sendCount++;
        if (sendCount >= 5) {
          clearInterval(sendInterval);
        }
      }, 200);

      // Collect responses for the timeout period
      setTimeout(() => {
        clearInterval(sendInterval);
        socket.close();
        const devices = Array.from(discovered);
        log.info(`[NATIVE NODE.JS] Discovery complete, found ${devices.length} device(s):`, devices);
        resolve(devices);
      }, timeout * 1000);
    });
  });
}

/**
 * Kasa Device class - represents a TP-Link smart device
 */
class KasaDevice {
  constructor(ip, options = {}) {
    this.ip = ip;
    this.port = options.port || KASA_PORT;
    this.childId = options.childId || null;
    this.timeout = options.timeout || DEFAULT_TIMEOUT;
  }

  /**
   * Wrap command with context for multi-outlet devices (power strips)
   */
  _wrapCommand(command) {
    if (this.childId) {
      return { context: { child_ids: [this.childId] }, ...command };
    }
    return command;
  }

  /**
   * Send command to this device
   */
  async _send(command) {
    return sendCommand(this.ip, command, this.timeout);
  }

  /**
   * Turn the device on
   */
  async turnOn() {
    log.info(`[NATIVE NODE.JS] turnOn() called for ${this.ip}${this.childId ? ':' + this.childId : ''}`);
    const command = this._wrapCommand({
      system: { set_relay_state: { state: 1 } }
    });
    return this._send(command);
  }

  /**
   * Turn the device off
   */
  async turnOff() {
    log.info(`[NATIVE NODE.JS] turnOff() called for ${this.ip}${this.childId ? ':' + this.childId : ''}`);
    const command = this._wrapCommand({
      system: { set_relay_state: { state: 0 } }
    });
    return this._send(command);
  }

  /**
   * Get device system info (with caching to prevent flooding)
   */
  async getInfo() {
    const cacheKey = this.ip;
    const now = Date.now();
    const cached = infoCache.get(cacheKey);

    // Return cached response if still valid
    if (cached && cached.data && (now - cached.timestamp) < STATE_CACHE_TTL) {
      return cached.data;
    }

    // If there's a pending request for this IP, wait for it
    if (cached && cached.promise) {
      return cached.promise;
    }

    // Make the actual request
    const command = { system: { get_sysinfo: {} } };
    const promise = this._send(command);

    // Store the promise so concurrent requests can wait for it
    infoCache.set(cacheKey, { promise, timestamp: now });

    try {
      const data = await promise;
      // Cache the successful response
      infoCache.set(cacheKey, { data, timestamp: Date.now(), promise: null });
      return data;
    } catch (error) {
      // Clear cache on error so next request tries again
      infoCache.delete(cacheKey);
      throw error;
    }
  }

  /**
   * Get device power state
   * @returns {object} - { state: 'on'|'off', relay_state: 0|1, ... }
   */
  async getState() {
    // Note: getInfo() has caching, so this won't flood the device even with rapid calls
    const info = await this.getInfo();

    if (info.error) {
      return info;
    }

    try {
      const sysinfo = info.system.get_sysinfo;

      // Check if this is a multi-outlet device with children
      if (sysinfo.children) {
        const children = sysinfo.children;

        // If we have a specific child_id, return that outlet's state
        if (this.childId) {
          for (const child of children) {
            if (child.id === this.childId) {
              const state = child.state || 0;
              return {
                state: state === 1 ? 'on' : 'off',
                relay_state: state,
                outlet_id: this.childId,
                outlet_alias: child.alias || ''
              };
            }
          }
          return { error: `Child ID ${this.childId} not found` };
        }

        // No specific child_id - return all outlet states
        const outletStates = children.map((child, idx) => ({
          id: child.id,
          alias: child.alias || `Outlet ${idx + 1}`,
          state: child.state === 1 ? 'on' : 'off',
          relay_state: child.state || 0
        }));

        return {
          is_strip: true,
          outlet_count: children.length,
          outlets: outletStates,
          model: sysinfo.model || '',
          alias: sysinfo.alias || ''
        };
      }

      // Single outlet device
      const relayState = sysinfo.relay_state;
      return {
        state: relayState === 1 ? 'on' : 'off',
        relay_state: relayState
      };
    } catch (e) {
      return { error: `Could not parse state: ${e.message}` };
    }
  }

  /**
   * Get child outlets for multi-outlet devices (power strips)
   */
  async getChildren() {
    const info = await this.getInfo();

    if (info.error) {
      return info;
    }

    try {
      const sysinfo = info.system.get_sysinfo;

      if (!sysinfo.children) {
        return { is_strip: false, children: [] };
      }

      const children = sysinfo.children.map((child, idx) => ({
        id: child.id,
        index: idx,
        alias: child.alias || `Outlet ${idx + 1}`,
        state: child.state === 1 ? 'on' : 'off',
        relay_state: child.state || 0
      }));

      return {
        is_strip: true,
        model: sysinfo.model || '',
        alias: sysinfo.alias || '',
        child_num: sysinfo.child_num || children.length,
        children
      };
    } catch (e) {
      return { error: `Could not parse children: ${e.message}` };
    }
  }

  /**
   * Get real-time energy meter data (HS110/KP115 only)
   */
  async getEnergyMeter() {
    const command = { emeter: { get_realtime: {} } };
    return this._send(command);
  }

  /**
   * Set LED state (nightlight mode)
   * @param {boolean} on - True for on, false for off
   */
  async setLed(on) {
    const command = {
      system: { set_led_off: { off: on ? 0 : 1 } }
    };
    return this._send(command);
  }

  /**
   * Reboot the device
   * @param {number} delay - Delay in seconds before reboot
   */
  async reboot(delay = 1) {
    const command = {
      system: { reboot: { delay } }
    };
    return this._send(command);
  }
}

module.exports = {
  encrypt,
  decrypt,
  sendCommand,
  discover,
  KasaDevice,
  KASA_PORT,
  DEFAULT_TIMEOUT
};
