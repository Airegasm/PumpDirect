/**
 * Home Assistant device provider.
 *
 * Talks to a long-running Home Assistant install via its REST API
 * (https://developers.home-assistant.io/docs/api/rest/). Configured with:
 *   - baseUrl  e.g. https://homeassistant.local:8123
 *   - token    long-lived access token (Profile → Security)
 *
 * Devices are addressed by entity_id (e.g. switch.aquarium_pump, light.lamp).
 * turnOn/turnOff dispatch to the matching domain's `turn_on` / `turn_off`
 * service. Anything Home Assistant can switch — Zigbee, Z-Wave, Matter,
 * Shelly, MQTT, scripts, scenes — becomes addressable from PumpDirect
 * without writing a per-vendor adapter.
 */

const { createLogger } = require('../utils/logger');
const log = createLogger('HA');

const STATE_CACHE_TTL_MS = 5000;

class HomeAssistantService {
  constructor() {
    this.baseUrl = null;
    this.token = null;
    this.stateCache = new Map(); // entityId -> { state, ts }
  }

  setCredentials(baseUrl, token) {
    this.baseUrl = (baseUrl || '').trim().replace(/\/+$/, '') || null;
    this.token = (token || '').trim() || null;
    this.stateCache.clear();
    log.info(`configured for ${this.baseUrl || '(none)'}`);
  }

  isConnected() { return !!(this.baseUrl && this.token); }

  async _request(method, urlPath, body) {
    if (!this.isConnected()) throw new Error('Home Assistant not configured (set baseUrl + token)');
    let res;
    try {
      res = await fetch(`${this.baseUrl}${urlPath}`, {
        method,
        headers: {
          'Authorization': `Bearer ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      throw new Error(`HA fetch failed: ${e.message}`);
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HA ${res.status} ${res.statusText}: ${txt.slice(0, 200)}`);
    }
    return res.json().catch(() => null);
  }

  async testConnection() {
    try {
      const r = await this._request('GET', '/api/');
      return !!r;
    } catch (e) {
      log.error('test failed', e.message);
      return false;
    }
  }

  /** List switchable entities. Domain filter is optional (e.g. 'switch'). */
  async listEntities(domain = null) {
    const states = await this._request('GET', '/api/states');
    if (!Array.isArray(states)) return [];
    return states
      .filter(s => !domain || s.entity_id.startsWith(domain + '.'))
      .map(s => ({
        entity_id: s.entity_id,
        state: s.state,
        friendly_name: s.attributes?.friendly_name || s.entity_id,
        domain: s.entity_id.split('.')[0],
      }));
  }

  _domainOf(entityId) {
    if (!entityId || typeof entityId !== 'string' || !entityId.includes('.')) {
      throw new Error(`HA entityId must be of the form <domain>.<name>, got: ${entityId}`);
    }
    return entityId.split('.')[0];
  }

  async turnOn(entityId) {
    const domain = this._domainOf(entityId);
    log.info(`turn_on ${entityId}`);
    await this._request('POST', `/api/services/${domain}/turn_on`, { entity_id: entityId });
    this.stateCache.set(entityId, { state: 'on', ts: Date.now() });
    return { success: true };
  }

  async turnOff(entityId) {
    const domain = this._domainOf(entityId);
    log.info(`turn_off ${entityId}`);
    await this._request('POST', `/api/services/${domain}/turn_off`, { entity_id: entityId });
    this.stateCache.set(entityId, { state: 'off', ts: Date.now() });
    return { success: true };
  }

  async getPowerState(entityId) {
    const cached = this.stateCache.get(entityId);
    if (cached && Date.now() - cached.ts < STATE_CACHE_TTL_MS) return cached.state;
    const s = await this._request('GET', `/api/states/${encodeURIComponent(entityId)}`);
    const raw = (s?.state || 'unknown').toLowerCase();
    const norm = raw === 'on' ? 'on' : raw === 'off' ? 'off' : raw;
    this.stateCache.set(entityId, { state: norm, ts: Date.now() });
    return norm;
  }
}

module.exports = new HomeAssistantService();
