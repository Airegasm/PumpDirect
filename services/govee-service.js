/**
 * Govee Smart Device Service
 * Communicates with Govee cloud API for device discovery and control
 */

const GOVEE_API_BASE = 'https://openapi.api.govee.com';

class GoveeService {
  constructor() {
    this.apiKey = null;
  }

  /**
   * Set the API key for Govee API calls
   */
  setApiKey(apiKey) {
    this.apiKey = apiKey;
  }

  /**
   * Get the current API key
   */
  getApiKey() {
    return this.apiKey;
  }

  /**
   * Check if API key is configured
   */
  isConnected() {
    return !!this.apiKey;
  }

  /**
   * Make a request to the Govee API
   */
  async request(method, endpoint, body = null) {
    if (!this.apiKey) {
      throw new Error('Govee API key not configured');
    }

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Govee-API-Key': this.apiKey,
      },
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(`${GOVEE_API_BASE}${endpoint}`, options);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Govee API error: ${response.status} - ${error}`);
    }

    return response.json();
  }

  /**
   * List all devices associated with the API key
   * @returns {Promise<Array>} Array of Govee devices
   */
  async listDevices() {
    const response = await this.request('GET', '/router/api/v1/user/devices');

    if (response.code !== 200) {
      throw new Error(`Govee API error: ${response.message}`);
    }

    return response.data || [];
  }

  /**
   * Get the current state of a device
   * @param {string} deviceId - The device identifier
   * @param {string} sku - The device SKU/model
   * @returns {Promise<Object>} Device state including capabilities
   */
  async getDeviceState(deviceId, sku) {
    const response = await this.request('POST', '/router/api/v1/device/state', {
      requestId: this.generateUUID(),
      payload: { sku, device: deviceId },
    });

    if (response.code !== 200) {
      throw new Error(`Govee API error: ${response.message}`);
    }

    return response.payload;
  }

  /**
   * Send a control command to a device
   * @param {string} deviceId - The device identifier
   * @param {string} sku - The device SKU/model
   * @param {Object} capability - The capability command {type, instance, value}
   */
  async controlDevice(deviceId, sku, capability) {
    const response = await this.request('POST', '/router/api/v1/device/control', {
      requestId: this.generateUUID(),
      payload: {
        sku,
        device: deviceId,
        capability,
      },
    });

    if (response.code !== 200) {
      throw new Error(`Govee API error: ${response.message}`);
    }

    return response;
  }

  /**
   * Turn a device ON
   * @param {string} deviceId - The device identifier
   * @param {string} sku - The device SKU/model
   */
  async turnOn(deviceId, sku) {
    console.log(`[GoveeService] Turning ON device ${deviceId} (${sku})`);
    return await this.controlDevice(deviceId, sku, {
      type: 'devices.capabilities.on_off',
      instance: 'powerSwitch',
      value: 1,
    });
  }

  /**
   * Turn a device OFF
   * @param {string} deviceId - The device identifier
   * @param {string} sku - The device SKU/model
   */
  async turnOff(deviceId, sku) {
    console.log(`[GoveeService] Turning OFF device ${deviceId} (${sku})`);
    return await this.controlDevice(deviceId, sku, {
      type: 'devices.capabilities.on_off',
      instance: 'powerSwitch',
      value: 0,
    });
  }

  /**
   * Get the power state of a device (on/off)
   * @param {string} deviceId - The device identifier
   * @param {string} sku - The device SKU/model
   * @returns {Promise<string>} 'on' or 'off'
   */
  async getPowerState(deviceId, sku) {
    const state = await this.getDeviceState(deviceId, sku);

    // Find the on_off capability in the response
    const powerCap = state.capabilities?.find(
      cap => cap.type === 'devices.capabilities.on_off' && cap.instance === 'powerSwitch'
    );

    if (powerCap) {
      return powerCap.state?.value === 1 ? 'on' : 'off';
    }

    return 'unknown';
  }

  /**
   * Generate a UUID for request IDs
   */
  generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Test the API connection with the current key
   * @returns {Promise<boolean>} True if connection successful
   */
  async testConnection() {
    try {
      await this.listDevices();
      return true;
    } catch (error) {
      console.error('[GoveeService] Connection test failed:', error.message);
      return false;
    }
  }
}

// Export singleton instance
const goveeService = new GoveeService();
module.exports = goveeService;
