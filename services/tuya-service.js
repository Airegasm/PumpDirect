/**
 * Tuya Smart Device Service - V2 API Implementation
 * Based on official tuya-connector-nodejs SDK
 */

const crypto = require('crypto');

const TUYA_REGIONS = {
  us: 'https://openapi.tuyaus.com',
  eu: 'https://openapi.tuyaeu.com',
  cn: 'https://openapi.tuyacn.com',
  in: 'https://openapi.tuyain.com'
};

class TuyaService {
  constructor() {
    this.accessId = null;
    this.accessSecret = null;
    this.region = 'us';
    this.accessToken = null;
    this.refreshToken = null;
    this.uid = null;
    this.tokenExpiry = null;
    this.knownDeviceIds = [];  // Store known device IDs
    this.stateCache = new Map(); // { deviceId: { state, timestamp } }
    this.CACHE_TTL_MS = 5000; // Cache device state for 5 seconds
  }

  setCredentials(accessId, accessSecret, region = 'us') {
    console.log(`[Tuya] Setting credentials - Access ID: ${accessId ? accessId.substring(0, 8) + '...' : 'null'}, Region: ${region}`);
    this.accessId = accessId;
    this.accessSecret = accessSecret;
    this.region = region;
    this.accessToken = null;
    this.refreshToken = null;
    this.uid = null;
    this.tokenExpiry = null;
  }

  isConnected() {
    return !!(this.accessId && this.accessSecret);
  }

  clearTokenCache() {
    console.log('[Tuya] Clearing token cache');
    this.accessToken = null;
    this.refreshToken = null;
    this.uid = null;
    this.tokenExpiry = null;
  }

  getBaseUrl() {
    return TUYA_REGIONS[this.region] || TUYA_REGIONS.us;
  }

  /**
   * HMAC-SHA256 signature
   */
  sign(str) {
    return crypto
      .createHmac('sha256', this.accessSecret)
      .update(str, 'utf8')
      .digest('hex')
      .toUpperCase();
  }

  /**
   * Get access token
   * Sign: accessKey + timestamp + stringToSign (per SO example)
   */
  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry && Date.now() < this.tokenExpiry) {
      console.log('[Tuya] Using cached token');
      return this.accessToken;
    }

    console.log('[Tuya] Requesting new access token...');
    const t = Date.now().toString();
    const method = 'GET';
    const signUrl = '/v1.0/token?grant_type=1';

    const contentHash = crypto.createHash('sha256').update('').digest('hex');
    const stringToSign = [method, contentHash, '', signUrl].join('\n');
    const signStr = this.accessId + t + stringToSign;
    const signature = this.sign(signStr);

    console.log(`[Tuya] Sign: accessId + ${t} + stringToSign`);
    console.log(`[Tuya] Signature: ${signature.substring(0, 16)}...`);

    const url = `${this.getBaseUrl()}${signUrl}`;
    console.log(`[Tuya] Fetching: ${url}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        't': t,
        'sign': signature,
        'client_id': this.accessId,
        'sign_method': 'HMAC-SHA256',
      },
    });

    const data = await response.json();
    console.log(`[Tuya] Response: success=${data.success}, code=${data.code}, msg=${data.msg || 'none'}`);

    if (!data.success) {
      throw new Error(`Tuya auth error: ${data.msg} (code: ${data.code})`);
    }

    this.accessToken = data.result.access_token;
    this.refreshToken = data.result.refresh_token;
    this.uid = data.result.uid;  // Store UID from token response
    this.tokenExpiry = Date.now() + (data.result.expire_time - 300) * 1000;

    console.log(`[Tuya] Token obtained, expires in ${data.result.expire_time}s, uid=${this.uid}`);
    return this.accessToken;
  }

  /**
   * Make authenticated request - V2 format
   * Based on official tuya-connector-nodejs SDK getSignHeaders method
   */
  async request(method, path, body = {}) {
    if (!this.accessId || !this.accessSecret) {
      throw new Error('Tuya credentials not configured');
    }

    console.log(`[Tuya] ---- API Request: ${method} ${path} ----`);

    const token = await this.getAccessToken();
    const t = Date.now().toString();

    // Per StackOverflow example:
    // - GET requests: hash empty string
    // - POST/PUT/DELETE: hash JSON.stringify(body)
    const isGet = method === 'GET';
    const bodyStr = isGet ? '' : JSON.stringify(body);
    const contentHash = crypto.createHash('sha256').update(bodyStr).digest('hex');
    const stringToSign = [method, contentHash, '', path].join('\n');
    // NO nonce! Just: accessKey + token + t + stringToSign
    const signStr = this.accessId + token + t + stringToSign;
    const signature = this.sign(signStr);

    const headers = {
      't': t,
      'sign': signature,
      'client_id': this.accessId,
      'sign_method': 'HMAC-SHA256',
      'access_token': token,
      'Content-Type': 'application/json',
      'mode': 'cors',
    };

    const options = { method, headers };

    // Only send body for non-GET requests
    if (!isGet) {
      options.body = bodyStr;
    }

    const url = `${this.getBaseUrl()}${path}`;
    console.log(`[Tuya] Full URL: ${url}`);

    const response = await fetch(url, options);
    const data = await response.json();

    console.log(`[Tuya] Response: success=${data.success}, code=${data.code}, msg=${data.msg || 'none'}`);

    if (!data.success) {
      throw new Error(`Tuya API error: ${data.msg} (code: ${data.code})`);
    }

    return data.result;
  }

  addDeviceIds(deviceIds) {
    const ids = Array.isArray(deviceIds) ? deviceIds : [deviceIds];
    for (const id of ids) {
      if (id && !this.knownDeviceIds.includes(id)) {
        this.knownDeviceIds.push(id);
      }
    }
    console.log(`[Tuya] Known device IDs: ${this.knownDeviceIds.join(', ')}`);
  }

  async listDevices(deviceIds = null) {
    // Use provided IDs, or fall back to known IDs
    let ids = deviceIds;
    if (!ids || (Array.isArray(ids) && ids.length === 0)) {
      ids = this.knownDeviceIds;
    }
    if (!ids || ids.length === 0) {
      console.log('[Tuya] No device IDs configured. Add devices via /api/tuya/devices/add');
      return [];
    }
    const idStr = Array.isArray(ids) ? ids.join(',') : ids;
    const path = `/v1.0/iot-03/devices?device_ids=${idStr}`;
    console.log(`[Tuya] Listing devices: ${path}`);
    const result = await this.request('GET', path);
    return result?.list || [];
  }

  async getDeviceInfo(deviceId) {
    console.log(`[Tuya] Getting device info: ${deviceId}`);
    return await this.request('GET', `/v1.0/devices/${deviceId}`);
  }

  async getDeviceStatus(deviceId) {
    return await this.request('GET', `/v1.0/devices/${deviceId}/status`);
  }

  async sendCommand(deviceId, commands) {
    // Use iot-03 endpoint for Cloud Authorization projects
    return await this.request('POST', `/v1.0/iot-03/devices/${deviceId}/commands`, { commands });
  }

  async turnOn(deviceId) {
    console.log(`[Tuya] Turning ON device ${deviceId}`);
    const result = await this.sendCommand(deviceId, [
      { code: 'switch_1', value: true },
      { code: 'switch', value: true }
    ]);
    // Update cache immediately with new state
    this.stateCache.set(deviceId, { state: 'on', timestamp: Date.now() });
    return result;
  }

  async turnOff(deviceId) {
    console.log(`[Tuya] Turning OFF device ${deviceId}`);
    const result = await this.sendCommand(deviceId, [
      { code: 'switch_1', value: false },
      { code: 'switch', value: false }
    ]);
    // Update cache immediately with new state
    this.stateCache.set(deviceId, { state: 'off', timestamp: Date.now() });
    return result;
  }

  async getPowerState(deviceId) {
    // Check cache first
    const cached = this.stateCache.get(deviceId);
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL_MS) {
      console.log(`[Tuya] Using cached state for ${deviceId}: ${cached.state}`);
      return cached.state;
    }

    const status = await this.getDeviceStatus(deviceId);
    const switchStatus = status.find(s => s.code === 'switch_1' || s.code === 'switch');
    const state = switchStatus ? (switchStatus.value ? 'on' : 'off') : 'unknown';

    // Cache the result
    this.stateCache.set(deviceId, { state, timestamp: Date.now() });
    console.log(`[Tuya] Cached state for ${deviceId}: ${state}`);

    return state;
  }

  async testConnection() {
    console.log('[Tuya] ========== CONNECTION TEST ==========');
    try {
      await this.getAccessToken();
      console.log('[Tuya] ========== SUCCESS ==========');
      return true;
    } catch (error) {
      console.error('[Tuya] ========== FAILED ==========');
      console.error('[Tuya] Error:', error.message);
      return false;
    }
  }
}

module.exports = new TuyaService();
