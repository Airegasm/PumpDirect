const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const localDevices = require('local-devices');
const { createLogger } = require('../utils/logger');
const { writeAtomicSync, ensureDirSync } = require('../utils/atomic-write');

const execFileP = promisify(execFile);

const logger = createLogger('Devices');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DEVICES_FILE = path.join(DATA_DIR, 'devices.json');

const SUPPORTED_VENDORS = ['tapo', 'kasa', 'kasa-klap', 'shelly', 'esphome', 'tasmota', 'wyze', 'govee', 'tuya', 'homeassistant', 'generic'];

function loadAll() {
  ensureDirSync(DATA_DIR);
  try {
    const data = JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8'));
    return Array.isArray(data.devices) ? data.devices : [];
  } catch {
    return [];
  }
}

function saveAll(devices) {
  writeAtomicSync(DEVICES_FILE, JSON.stringify({ devices }, null, 2));
  return devices;
}

function scanLinuxProcArp() {
  const raw = fs.readFileSync('/proc/net/arp', 'utf8');
  return raw.split('\n').slice(1)
    .map(l => l.trim().split(/\s+/))
    .filter(parts => parts.length >= 6 && /^\d+\.\d+\.\d+\.\d+$/.test(parts[0]))
    .filter(parts => parts[3] !== '00:00:00:00:00:00')
    .map(parts => ({ ip: parts[0], mac: parts[3], name: null, iface: parts[5] || null }));
}

async function tryIpNeigh() {
  try {
    const { stdout } = await execFileP('ip', ['neigh', 'show']);
    return stdout.split('\n')
      .map(l => l.trim())
      .filter(l => l && /^\d+\.\d+\.\d+\.\d+/.test(l))
      .map(l => {
        const m = l.match(/^(\d+\.\d+\.\d+\.\d+)\s+\S+\s+(\S+)\s+lladdr\s+([0-9a-f:]+)/i);
        if (!m) return null;
        return { ip: m[1], iface: m[2], mac: m[3], name: null };
      })
      .filter(Boolean);
  } catch {
    return null;
  }
}

async function scanLan() {
  try {
    if (process.platform === 'linux') {
      const fromNeigh = await tryIpNeigh();
      if (fromNeigh && fromNeigh.length) return fromNeigh;
      try {
        const fromProc = scanLinuxProcArp();
        if (fromProc.length) return fromProc;
      } catch {}
    }
    const found = await localDevices();
    return found.map(d => ({ ip: d.ip, mac: d.mac || null, name: d.name || null }));
  } catch (e) {
    logger.error('scanLan failed', e.message);
    throw new Error(`scan failed: ${e.message}`);
  }
}

async function scanKasa(timeoutSeconds = 3) {
  const kasa = require('./kasa-service');
  const ips = await kasa.discover(timeoutSeconds);
  const results = [];
  for (const ip of ips) {
    try {
      const raw = await new kasa.KasaDevice(ip, { timeout: 2000 }).getInfo();
      const info = raw?.system?.get_sysinfo || raw || {};
      const baseMac = (info.mac || info.mic_mac || '').toLowerCase();
      const baseModel = info.model || null;
      const baseAlias = info.alias || null;
      const hwVer = info.hw_ver || null;
      const swVer = info.sw_ver || null;

      if (Array.isArray(info.children) && info.children.length > 0) {
        info.children.forEach((child, idx) => {
          results.push({
            ip,
            mac: baseMac,
            childId: child.id,
            childIndex: idx + 1,
            alias: child.alias || `Outlet ${idx + 1}`,
            stripAlias: baseAlias,
            model: baseModel,
            isStrip: true,
            childState: child.state === 1 ? 'on' : 'off',
            deviceType: 'Smart Outlet',
            hwVer,
            swVer,
          });
        });
      } else {
        results.push({
          ip,
          mac: baseMac,
          childId: null,
          alias: baseAlias,
          stripAlias: null,
          model: baseModel,
          isStrip: false,
          deviceType: info.dev_name || info.mic_type || info.type || null,
          hwVer,
          swVer,
        });
      }
    } catch (e) {
      results.push({ ip, error: e.message });
    }
  }
  return results;
}

// mDNS discovery of local-only smart plugs (Shelly + ESPHome). Browses for a
// few seconds, then returns one entry per discovered IP. Tasmota is omitted —
// its mDNS advertising is unreliable, so Tasmota plugs are added by IP.
async function scanLocal(timeoutMs = 4000) {
  let Bonjour;
  try {
    ({ Bonjour } = require('bonjour-service'));
  } catch {
    logger.warn('bonjour-service not installed — local scan unavailable');
    return [];
  }
  return new Promise((resolve) => {
    const found = new Map();
    let bonjour;
    try {
      bonjour = new Bonjour();
    } catch (e) {
      logger.warn(`mDNS scan failed to start: ${e.message}`);
      return resolve([]);
    }
    const collect = (vendor) => (service) => {
      const ip = (service.addresses || []).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a));
      if (ip && !found.has(ip)) {
        found.set(ip, { ip, vendor, name: service.name || service.host || ip });
      }
    };
    const browsers = [];
    try {
      browsers.push(bonjour.find({ type: 'shelly' }, collect('shelly')));
      browsers.push(bonjour.find({ type: 'esphomelib' }, collect('esphome')));
    } catch (e) {
      logger.warn(`mDNS browse failed: ${e.message}`);
    }
    setTimeout(() => {
      try {
        for (const b of browsers) { if (b && b.stop) b.stop(); }
        bonjour.destroy();
      } catch {}
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

function add({ label, vendor, ip, mac, deviceId, sku, model, childId, entityId }) {
  label = (label || '').trim();
  vendor = (vendor || '').trim().toLowerCase();
  if (!label) throw new Error('label required');
  if (!SUPPORTED_VENDORS.includes(vendor)) throw new Error(`vendor must be one of: ${SUPPORTED_VENDORS.join(', ')}`);
  ip = (ip || '').trim() || null;
  mac = (mac || '').trim().toLowerCase() || null;
  deviceId = (deviceId || '').trim() || null;
  sku = (sku || '').trim() || null;
  model = (model || '').trim() || null;
  childId = (childId || '').trim() || null;
  entityId = (entityId || '').trim() || null;

  const need = {
    tapo:          ['ip'],
    kasa:          ['ip'],
    'kasa-klap':   ['ip'],
    shelly:        ['ip'],
    esphome:       ['ip'],
    tasmota:       ['ip'],
    wyze:          ['mac', 'model'],
    govee:         ['deviceId', 'sku'],
    tuya:          ['deviceId'],
    homeassistant: ['entityId'],
    generic:       [],
  }[vendor] || [];
  const fields = { ip, mac, deviceId, sku, model, entityId };
  const missing = need.filter(f => !fields[f]);
  if (missing.length) throw new Error(`${vendor} needs: ${missing.join(', ')}`);

  const devices = loadAll();
  const dupe = devices.find(d => {
    if (vendor === 'kasa') return d.ip === ip && (d.childId || null) === childId;
    if (vendor === 'homeassistant' && entityId && d.entityId === entityId) return true;
    if (ip && d.ip === ip && !d.childId && !childId) return true;
    if (mac && d.mac === mac) return true;
    if (deviceId && d.deviceId === deviceId) return true;
    return false;
  });
  if (dupe) throw new Error('this device (or this outlet) is already added');

  const isFirst = devices.length === 0;
  const dev = {
    id: randomUUID(),
    label, vendor,
    ip, mac, deviceId, sku, model, childId, entityId,
    isPrimary: isFirst,
    calibration: null,
    addedAt: new Date().toISOString(),
  };
  devices.push(dev);
  saveAll(devices);
  return dev;
}

function update(id, patch) {
  const devices = loadAll();
  const idx = devices.findIndex(d => d.id === id);
  if (idx < 0) throw new Error('not found');
  const allowed = ['label', 'isPrimary', 'vendor', 'ip'];
  for (const k of Object.keys(patch)) {
    if (allowed.includes(k)) devices[idx][k] = patch[k];
  }
  if (patch.isPrimary === true) {
    for (let i = 0; i < devices.length; i++) {
      if (i !== idx) devices[i].isPrimary = false;
    }
  }
  saveAll(devices);
  return devices[idx];
}

function remove(id) {
  const devices = loadAll();
  const next = devices.filter(d => d.id !== id);
  if (next.length === devices.length) throw new Error('not found');
  if (!next.some(d => d.isPrimary) && next.length > 0) next[0].isPrimary = true;
  saveAll(next);
  return next;
}

function saveCalibration(id, secondsTo100) {
  if (!Number.isFinite(secondsTo100) || secondsTo100 <= 0) throw new Error('secondsTo100 must be a positive number');
  const devices = loadAll();
  const idx = devices.findIndex(d => d.id === id);
  if (idx < 0) throw new Error('not found');
  devices[idx].calibration = {
    secondsTo100,
    calibrationTime: Math.round(secondsTo100 * 1000),
    calibratedAt: new Date().toISOString(),
  };
  saveAll(devices);
  return devices[idx];
}

function get(id) {
  return loadAll().find(d => d.id === id) || null;
}

function primary() {
  return loadAll().find(d => d.isPrimary) || null;
}

function isReadyForSession() {
  const p = primary();
  return !!(p && p.calibration && p.calibration.secondsTo100 > 0);
}

module.exports = {
  SUPPORTED_VENDORS,
  loadAll,
  scanLan,
  scanKasa,
  scanLocal,
  add,
  update,
  remove,
  saveCalibration,
  get,
  primary,
  isReadyForSession,
  DEVICES_FILE,
};
