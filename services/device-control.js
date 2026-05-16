const config = require('../config');
const tapo = require('./tapo-service');
const kasa = require('./kasa-service');
const kasaKlap = require('./kasa-klap-service');
const wyze = require('./wyze-service');
const govee = require('./govee-service');
const tuya = require('./tuya-service');
const ha = require('./homeassistant-service');
const shelly = require('./shelly-service');
const esphome = require('./esphome-service');
const tasmota = require('./tasmota-service');
const rateLimit = require('./rate-limit-service');
const { createLogger } = require('../utils/logger');

const logger = createLogger('DeviceControl');

const VENDOR_INFO = {
  tapo:          { name: 'TP-Link Tapo',  credFields: ['email', 'password'],                    idFields: ['ip'] },
  kasa:          { name: 'TP-Link Kasa',  credFields: [],                                        idFields: ['ip'] },
  'kasa-klap':   { name: 'TP-Link Kasa 1.1.x+', credFields: ['email', 'password'],               idFields: ['ip'] },
  wyze:          { name: 'Wyze',          credFields: ['email', 'password', 'keyId', 'apiKey'], idFields: ['mac', 'model'] },
  govee:         { name: 'Govee',         credFields: ['apiKey'],                                idFields: ['deviceId', 'sku'] },
  tuya:          { name: 'Tuya',          credFields: ['accessId', 'accessSecret', 'region'],   idFields: ['deviceId'] },
  homeassistant: { name: 'Home Assistant',credFields: ['baseUrl', 'token'],                      idFields: ['entityId'] },
  shelly:        { name: 'Shelly',        credFields: [],                                        idFields: ['ip'] },
  esphome:       { name: 'ESPHome (KAUF)',credFields: [],                                        idFields: ['ip'] },
  tasmota:       { name: 'Tasmota (Athom)',credFields: [],                                       idFields: ['ip'] },
};

// MAC OUI prefixes for vendor hinting. Not exhaustive — meant for "you scanned and
// we see this MAC, probably from <vendor>". Owner confirms the actual vendor.
const OUI_HINTS = {
  // TP-Link (covers both Tapo and Kasa — owner picks which)
  '9c:53:22': 'tplink', '10:27:f5': 'tplink', '40:ed:00': 'tplink', '60:32:b1': 'tplink',
  '94:e6:86': 'tplink', '14:eb:b6': 'tplink', '50:c7:bf': 'tplink', '98:da:c4': 'tplink',
  'b0:be:76': 'tplink', 'b0:c5:54': 'tplink', 'c0:c9:e3': 'tplink', '30:de:4b': 'tplink',
  'c4:e9:0a': 'tplink', 'c0:25:e9': 'tplink',
  // Wyze
  '2c:aa:8e': 'wyze', '7c:78:b2': 'wyze', 'd0:3f:27': 'wyze',
  // Govee (most-common ESP-based plugs / strips)
  'a4:c1:38': 'govee', '34:85:18': 'govee', '78:21:84': 'govee',
};

function ouiOf(mac) {
  return (mac || '').toLowerCase().split(':').slice(0, 3).join(':');
}

function hintVendorFromMac(mac) {
  return OUI_HINTS[ouiOf(mac)] || null;
}

function getCreds(vendor) {
  const cfg = config.load();
  return (cfg.vendors && cfg.vendors[vendor]) || {};
}

function credsComplete(vendor) {
  const info = VENDOR_INFO[vendor];
  if (!info) return false;
  if (info.credFields.length === 0) return true;
  const creds = getCreds(vendor);
  return info.credFields.every(f => creds[f] && String(creds[f]).trim().length > 0);
}

function deviceIdComplete(device) {
  const info = VENDOR_INFO[device.vendor];
  if (!info) return false;
  return info.idFields.every(f => device[f] && String(device[f]).trim().length > 0);
}

function applyCredsIfNeeded(vendor) {
  if (vendor === 'tapo') {
    const { email, password } = getCreds('tapo');
    if (!email || !password) throw new Error('Tapo credentials not set — fill them in the Vendor Credentials section');
    tapo.setCredentials(email, password);
  } else if (vendor === 'kasa-klap') {
    const { email, password } = getCreds('kasa-klap');
    if (!email || !password) throw new Error('Kasa 1.1.x+ credentials not set — fill them in the Vendor Credentials section');
    kasaKlap.setCredentials(email, password);
  } else if (vendor === 'wyze') {
    if (wyze.isConfigured && wyze.isConfigured()) return;
    const c = getCreds('wyze');
    if (!c.email || !c.password || !c.keyId || !c.apiKey) throw new Error('Wyze credentials incomplete');
    wyze.setCredentials(c.email, c.password, c.keyId, c.apiKey, c.totpKey || null);
  } else if (vendor === 'govee') {
    const { apiKey } = getCreds('govee');
    if (!apiKey) throw new Error('Govee API key not set');
    govee.setApiKey(apiKey);
  } else if (vendor === 'tuya') {
    const c = getCreds('tuya');
    if (!c.accessId || !c.accessSecret) throw new Error('Tuya credentials incomplete');
    tuya.setCredentials(c.accessId, c.accessSecret, c.region || 'us');
  } else if (vendor === 'homeassistant') {
    const c = getCreds('homeassistant');
    if (!c.baseUrl || !c.token) throw new Error('Home Assistant not configured (baseUrl + token required)');
    ha.setCredentials(c.baseUrl, c.token);
  }
}

function _enforceRateLimit(device, op) {
  const verdict = rateLimit.checkDevice(device);
  if (!verdict.ok) {
    logger.warn(`${op} blocked on ${device.label || device.id}: ${verdict.reason}`);
    throw new Error(verdict.reason);
  }
}

async function turnOn(device) {
  if (!deviceIdComplete(device)) throw new Error(`device missing required fields for ${device.vendor}`);
  _enforceRateLimit(device, 'turnOn');
  applyCredsIfNeeded(device.vendor);
  switch (device.vendor) {
    case 'tapo':          return tapo.turnOn(device.ip);
    case 'kasa':          return new kasa.KasaDevice(device.ip, device.childId ? { childId: device.childId } : {}).turnOn();
    case 'kasa-klap':     return kasaKlap.turnOn(device.ip);
    case 'wyze':          return wyze.turnOn(device.mac, device.model);
    case 'govee':         return govee.turnOn(device.deviceId, device.sku);
    case 'tuya':          return tuya.turnOn(device.deviceId);
    case 'homeassistant': return ha.turnOn(device.entityId);
    case 'shelly':        return shelly.turnOn(device.ip);
    case 'esphome':       return esphome.turnOn(device.ip, device.entityId);
    case 'tasmota':       return tasmota.turnOn(device.ip);
    default: throw new Error(`unsupported vendor: ${device.vendor}`);
  }
}

async function turnOff(device) {
  if (!deviceIdComplete(device)) throw new Error(`device missing required fields for ${device.vendor}`);
  // Note: turnOff intentionally does NOT enforce rate limit — it's a safety
  // operation and must always be allowed through.
  applyCredsIfNeeded(device.vendor);
  switch (device.vendor) {
    case 'tapo':          return tapo.turnOff(device.ip);
    case 'kasa':          return new kasa.KasaDevice(device.ip, device.childId ? { childId: device.childId } : {}).turnOff();
    case 'kasa-klap':     return kasaKlap.turnOff(device.ip);
    case 'wyze':          return wyze.turnOff(device.mac, device.model);
    case 'govee':         return govee.turnOff(device.deviceId, device.sku);
    case 'tuya':          return tuya.turnOff(device.deviceId);
    case 'homeassistant': return ha.turnOff(device.entityId);
    case 'shelly':        return shelly.turnOff(device.ip);
    case 'esphome':       return esphome.turnOff(device.ip, device.entityId);
    case 'tasmota':       return tasmota.turnOff(device.ip);
    default: throw new Error(`unsupported vendor: ${device.vendor}`);
  }
}

async function getState(device) {
  if (!deviceIdComplete(device)) return null;
  applyCredsIfNeeded(device.vendor);
  switch (device.vendor) {
    case 'tapo':          return tapo.getPowerState(device.ip);
    case 'kasa':          return new kasa.KasaDevice(device.ip, device.childId ? { childId: device.childId } : {}).getState();
    case 'kasa-klap':     return kasaKlap.getPowerState(device.ip);
    case 'wyze':          return wyze.getPowerState(device.mac);
    case 'govee':         return govee.getPowerState(device.deviceId, device.sku);
    case 'tuya':          return tuya.getPowerState(device.deviceId);
    case 'homeassistant': return ha.getPowerState(device.entityId);
    case 'shelly':        return shelly.getPowerState(device.ip);
    case 'esphome':       return esphome.getPowerState(device.ip, device.entityId);
    case 'tasmota':       return tasmota.getPowerState(device.ip);
    default: return null;
  }
}

module.exports = {
  VENDOR_INFO,
  hintVendorFromMac,
  credsComplete,
  deviceIdComplete,
  turnOn,
  turnOff,
  getState,
};
