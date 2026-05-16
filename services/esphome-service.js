/**
 * ESPHome smart-plug control — fully local, no cloud, no account.
 *
 * Talks to the device's built-in `web_server` HTTP API. Used for KAUF plugs
 * (PLF10/PLF12), whose stock firmware ships with web_server enabled, and any
 * other ESPHome device with web_server on.
 *
 * `entity` is the ESPHome switch name. KAUF plugs expose it as `relay`, which
 * is the default when none is supplied.
 */

const TIMEOUT_MS = 5000;
const DEFAULT_ENTITY = 'relay';

async function _fetch(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function _entity(entity) {
  return encodeURIComponent((entity || '').trim() || DEFAULT_ENTITY);
}

class ESPHomeService {
  async turnOn(ip, entity) {
    await _fetch(`http://${ip}/switch/${_entity(entity)}/turn_on`, { method: 'POST' });
  }

  async turnOff(ip, entity) {
    await _fetch(`http://${ip}/switch/${_entity(entity)}/turn_off`, { method: 'POST' });
  }

  async getPowerState(ip, entity) {
    const res = await _fetch(`http://${ip}/switch/${_entity(entity)}`, { method: 'GET' });
    const d = await res.json();
    // web_server returns { id, state: "ON"|"OFF", value: boolean }.
    if (typeof d.value === 'boolean') return d.value ? 'on' : 'off';
    return String(d.state || '').toUpperCase() === 'ON' ? 'on' : 'off';
  }
}

module.exports = new ESPHomeService();
