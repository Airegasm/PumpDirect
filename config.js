const fs = require('fs');
const path = require('path');
const { writeAtomicSync, repairModeSync } = require('./utils/atomic-write');

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
    teamDomain: null,   // e.g. "myteam.cloudflareaccess.com" — used for JWT verification
    accessAud: null,    // Cloudflare Access Application AUD — captured from the API
  },
  hardening: {
    installed: false,
    platform: null,
    method: null,
  },
  accounts: [],
  owner: {
    displayName: '',
    tosAcceptedVersion: 0,                             // bumps on TOS revision force re-accept
    camera: {
      mode: 'off',                                     // 'off' | 'live' | 'snapshot'
      resolution: { width: 1280, height: 720 },        // owner's chosen capture resolution; constraints hint
      crop: { xPct: 25, yPct: 12.5, sizePct: 50 },     // pre-publish crop applied to the local cam tile
      snapshotEveryPct: 5,                             // capacity %-points between snapshots
      allowControllerBroadcast: false,                 // controllers (canControl visitors) may publish their cam too
    },
  },
  chat: {
    // Global master switch (Chat/Webcam → top). When false, ALL visitor chat
    // is blocked regardless of per-profile chatroomEnabled or per-participant
    // canChat. Host chat (loopback via /api/launchpad/chat) is unaffected.
    enabled: true,
    // Name colors per role - the chat UI on host and visitor sides reads
    // these to color the strong-tag wrapping each speaker's nickname.
    nameColors: {
      host:       '#6ddc9b', // green
      controller: '#6db4ff', // blue
      voyeur:     '#f08484', // red/coral
    },
  },
  vendors: {
    tapo:  { email: '', password: '' },
    kasa:  {},
    'kasa-klap': { email: '', password: '' },
    wyze:  { email: '', password: '', keyId: '', apiKey: '', totpKey: '' },
    govee: { apiKey: '' },
    tuya:  { accessId: '', accessSecret: '', region: 'us' },
    homeassistant: { baseUrl: '', token: '' },
    shelly: {},
    esphome: {},
    tasmota: {},
  },
  rateLimits: {
    // null here means "use code defaults" — see services/rate-limit-service.js
    cloud:    null,    // { tokens, refillMs }
    lan:      null,    // { tokens, refillMs }
    template: null,    // { fires, windowMs }
    pump:     null,    // { dutyPct, windowMs, hardCapMs }
    perDevice:   {},   // { [deviceId]: { tokens, refillMs } }
    perTemplate: {},   // { [templateId]: { fires, windowMs } }
  },
};

let _cache = null;
let _cacheMtimeMs = 0;

function _read() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const merged = deepMerge(DEFAULTS, JSON.parse(raw));
    _cache = merged;
    _cacheMtimeMs = stat.mtimeMs;
    return merged;
  } catch {
    _cache = JSON.parse(JSON.stringify(DEFAULTS));
    _cacheMtimeMs = 0;
    return _cache;
  }
}

function load() {
  if (_cache !== null) {
    // Cheap freshness check; avoids re-reading + parsing on every call.
    try {
      const stat = fs.statSync(CONFIG_PATH);
      if (stat.mtimeMs === _cacheMtimeMs) return _cache;
    } catch {
      return _cache;
    }
  }
  return _read();
}

function save(patch) {
  const next = deepMerge(load(), patch);
  writeAtomicSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  _cache = next;
  try { _cacheMtimeMs = fs.statSync(CONFIG_PATH).mtimeMs; } catch {}
  return next;
}

function invalidate() { _cache = null; _cacheMtimeMs = 0; }

function repairMode() { repairModeSync(CONFIG_PATH); }

function deepMerge(target, patch) {
  const out = Array.isArray(target) ? target.slice() : { ...target };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

module.exports = { load, save, invalidate, repairMode, CONFIG_PATH, DEFAULTS };
