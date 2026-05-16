/**
 * Tasmota smart-plug control — fully local, no cloud, no account.
 *
 * Uses the Tasmota HTTP command API (`/cm?cmnd=...`). Used for Athom plugs
 * sold pre-flashed with Tasmota, and any other Tasmota device. Relay 1 (the
 * `Power` command) is assumed — the single-outlet plugs only have one.
 */

const TIMEOUT_MS = 5000;

async function _cmd(ip, cmnd) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`http://${ip}/cm?cmnd=${encodeURIComponent(cmnd)}`, { signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

class TasmotaService {
  async turnOn(ip) { await _cmd(ip, 'Power ON'); }
  async turnOff(ip) { await _cmd(ip, 'Power OFF'); }

  async getPowerState(ip) {
    const d = await _cmd(ip, 'Power');
    // Single-relay devices answer { "POWER": "ON" }; multi-relay use POWER1.
    const v = d.POWER != null ? d.POWER : d.POWER1;
    return String(v).toUpperCase() === 'ON' ? 'on' : 'off';
  }
}

module.exports = new TasmotaService();
