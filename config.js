const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULTS = {
  setupComplete: false,
  cloudflare: {
    tunnelId: null,
    tunnelName: null,
    subdomain: null,
    zoneName: null,
    hostname: null,
    accountId: null,
    apiToken: null,
    apiTokenValidated: false,
    accessProductEnabled: null,
    ownerEmail: null,
    accessPolicyConfirmed: false,
  },
  hardening: {
    installed: false,
    platform: null,
    method: null,
  },
  accounts: [],
  owner: {
    displayName: '',
    camera: {
      mode: 'off',                                     // 'off' | 'live' | 'snapshot'
      crop: { xPct: 25, yPct: 12.5, sizePct: 50 },     // 1:1 square crop of source video, % of width/height
      snapshotEveryPct: 5,                             // capacity %-points between snapshots
      allowControllerBroadcast: false,                 // controllers (canControl visitors) may publish their cam too
    },
  },
  vendors: {
    tapo:  { email: '', password: '' },
    kasa:  {},
    wyze:  { email: '', password: '', keyId: '', apiKey: '', totpKey: '' },
    govee: { apiKey: '' },
    tuya:  { accessId: '', accessSecret: '', region: 'us' },
  },
};

function load() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = deepMerge(load(), patch);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

function deepMerge(target, patch) {
  const out = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { load, save, CONFIG_PATH };
