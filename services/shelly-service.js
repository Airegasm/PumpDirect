/**
 * Shelly smart-plug control — fully local, no cloud, no account.
 *
 * Commands hit the plug directly on the LAN over its HTTP API. Gen2+ devices
 * (Shelly Plug US Gen4, Plus Plug US) use the JSON-RPC endpoint at /rpc; if
 * that isn't present we fall back to the Gen1 relay API. Switch/relay 0 is
 * assumed — the single-outlet plugs only have one.
 */

const TIMEOUT_MS = 5000;

async function _fetchJson(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

class ShellyService {
  // Gen2+ JSON-RPC call.
  async _rpc(ip, method, params) {
    return _fetchJson(`http://${ip}/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 0, method, params }),
    });
  }

  async _set(ip, on) {
    try {
      await this._rpc(ip, 'Switch.Set', { id: 0, on });
    } catch {
      // Gen1 fallback — older Shelly devices have no /rpc endpoint.
      await _fetchJson(`http://${ip}/relay/0?turn=${on ? 'on' : 'off'}`, { method: 'GET' });
    }
  }

  async turnOn(ip) { return this._set(ip, true); }
  async turnOff(ip) { return this._set(ip, false); }

  async getPowerState(ip) {
    try {
      const r = await this._rpc(ip, 'Switch.GetStatus', { id: 0 });
      return r?.result?.output ? 'on' : 'off';
    } catch {
      const r = await _fetchJson(`http://${ip}/relay/0`, { method: 'GET' });
      return r?.ison ? 'on' : 'off';
    }
  }
}

module.exports = new ShellyService();
