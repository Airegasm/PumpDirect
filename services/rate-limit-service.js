/**
 * Multi-layer rate limiting for device and action safety.
 *
 *   1. Per-device token bucket — prevents vendor cloud APIs (Govee/Tuya/Wyze)
 *      from blacklisting the IP, and prevents LAN devices (Kasa/Tapo) from
 *      being hammered by runaway templates.
 *   2. Per-template anti-spam — caps how many times a visitor can re-fire the
 *      same action template within a sliding window.
 *   3. Pump duty cycle + hard cap — guards the physical hardware. The pump is
 *      not allowed to be on more than `dutyPct`% of any rolling `windowMs`,
 *      and a single uninterrupted on-time can never exceed `hardCapMs`.
 *
 * All limits are overridable per-device and per-template via config:
 *   cfg.rateLimits.perDevice[<deviceId>]   = { tokens, refillMs }
 *   cfg.rateLimits.perTemplate[<templateId>] = { fires, windowMs }
 * and the global defaults via cfg.rateLimits.{cloud,lan,template,pump}.
 */

const config = require('../config');
const { createLogger } = require('../utils/logger');

const log = createLogger('RateLimit');

const CLOUD_VENDORS = new Set(['govee', 'tuya', 'wyze', 'homeassistant']);
const LAN_VENDORS   = new Set(['kasa', 'tapo', 'generic']);

const DEFAULTS = {
  cloud:    { tokens: 1, refillMs: 2000 },          // 1 op / 2s per device
  lan:      { tokens: 2, refillMs: 1000 },          // 2 ops / 1s per device
  template: { fires:  5, windowMs: 60_000 },        // 5 fires / 60s per (template, visitor)
  pump:     { dutyPct: 70, windowMs: 5 * 60_000, hardCapMs: 5 * 60_000 }, // 70% of 5min, max 5min continuous
};

function _cfg() {
  const c = config.load();
  const rl = c.rateLimits || {};
  return {
    cloud:    { ...DEFAULTS.cloud,    ...(rl.cloud    || {}) },
    lan:      { ...DEFAULTS.lan,      ...(rl.lan      || {}) },
    template: { ...DEFAULTS.template, ...(rl.template || {}) },
    pump:     { ...DEFAULTS.pump,     ...(rl.pump     || {}) },
    perDevice:   rl.perDevice   || {},
    perTemplate: rl.perTemplate || {},
  };
}

// --- per-device bucket -----------------------------------------------------

const buckets = new Map(); // key -> { tokens, max, refillMs, lastRefill }

function _bucket(key, max, refillMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: max, max, refillMs, lastRefill: now };
    buckets.set(key, b);
    return b;
  }
  // If config changed the rule, re-cap.
  if (b.max !== max || b.refillMs !== refillMs) {
    b.max = max; b.refillMs = refillMs;
    if (b.tokens > max) b.tokens = max;
  }
  const elapsed = now - b.lastRefill;
  if (elapsed >= b.refillMs) {
    const refills = Math.floor(elapsed / b.refillMs);
    b.tokens = Math.min(b.max, b.tokens + refills);
    b.lastRefill += refills * b.refillMs;
  }
  return b;
}

function _classify(device) {
  if (CLOUD_VENDORS.has(device.vendor)) return 'cloud';
  if (LAN_VENDORS.has(device.vendor))   return 'lan';
  return 'lan';
}

/** Returns { ok: true } or { ok: false, reason }. Consumes 1 token on success. */
function checkDevice(device) {
  if (!device || !device.id) return { ok: true };
  const c = _cfg();
  const kind = _classify(device);
  const rule = kind === 'cloud' ? c.cloud : c.lan;
  const override = c.perDevice[device.id] || {};
  const tokens = override.tokens ?? rule.tokens;
  const refillMs = override.refillMs ?? rule.refillMs;
  const key = `dev:${device.id}`;
  const b = _bucket(key, tokens, refillMs);
  if (b.tokens > 0) {
    b.tokens -= 1;
    return { ok: true };
  }
  const retryMs = Math.max(0, b.refillMs - (Date.now() - b.lastRefill));
  return { ok: false, reason: `device rate limit (${tokens}/${(refillMs/1000).toFixed(1)}s) — retry in ${(retryMs/1000).toFixed(1)}s` };
}

// --- per-template anti-spam ------------------------------------------------

const templateLog = new Map(); // key -> [timestamps]

function checkTemplate(templateId, byEmail) {
  if (!templateId) return { ok: true };
  const c = _cfg();
  const override = c.perTemplate[templateId] || {};
  const fires = override.fires ?? c.template.fires;
  const windowMs = override.windowMs ?? c.template.windowMs;
  const key = `tpl:${templateId}:${byEmail || 'anon'}`;
  const now = Date.now();
  const fresh = (templateLog.get(key) || []).filter(t => t > now - windowMs);
  if (fresh.length >= fires) {
    return { ok: false, reason: `template fire limit (${fires} per ${(windowMs/1000).toFixed(0)}s)` };
  }
  fresh.push(now);
  templateLog.set(key, fresh);
  return { ok: true };
}

// --- pump duty cycle / hard cap -------------------------------------------

const pumpHistory = []; // [{ start, end }] in chronological order
let pumpOnSince = null;

function _prunePumpHistory() {
  const c = _cfg();
  const cutoff = Date.now() - c.pump.windowMs;
  while (pumpHistory.length && pumpHistory[0].end < cutoff) pumpHistory.shift();
}

function recordPumpOn() {
  if (pumpOnSince) return; // already recorded
  pumpOnSince = Date.now();
}

function recordPumpOff() {
  if (!pumpOnSince) return;
  pumpHistory.push({ start: pumpOnSince, end: Date.now() });
  pumpOnSince = null;
  _prunePumpHistory();
}

/**
 * Pre-flight check before turning the pump on. Returns ok or refuses with
 * a reason + code (so the caller can distinguish hard-cap vs duty).
 */
function checkPumpStart() {
  const c = _cfg();
  const now = Date.now();

  if (pumpOnSince && now - pumpOnSince >= c.pump.hardCapMs) {
    return { ok: false, code: 'HARD_CAP', reason: `pump continuous-on cap (${(c.pump.hardCapMs/60000).toFixed(1)}min) reached` };
  }
  _prunePumpHistory();
  let totalOn = 0;
  for (const r of pumpHistory) totalOn += r.end - r.start;
  if (pumpOnSince) totalOn += now - pumpOnSince;
  const dutyPct = (totalOn / c.pump.windowMs) * 100;
  if (dutyPct >= c.pump.dutyPct) {
    return { ok: false, code: 'DUTY', reason: `pump duty cycle ${dutyPct.toFixed(0)}% >= ${c.pump.dutyPct}% over ${(c.pump.windowMs/60000).toFixed(1)}min — let it cool` };
  }
  return { ok: true };
}

/** Continuous on-time in ms (0 if the pump is off). */
function continuousRuntimeMs() {
  return pumpOnSince ? Date.now() - pumpOnSince : 0;
}

/** Used by the safety watchdog: should we force-off right now? */
function shouldForceOff() {
  const c = _cfg();
  return pumpOnSince ? (Date.now() - pumpOnSince) >= c.pump.hardCapMs : false;
}

function snapshot() {
  const c = _cfg();
  _prunePumpHistory();
  let totalOn = 0;
  for (const r of pumpHistory) totalOn += r.end - r.start;
  if (pumpOnSince) totalOn += Date.now() - pumpOnSince;
  return {
    pumpOnSince,
    continuousRuntimeMs: continuousRuntimeMs(),
    windowMs: c.pump.windowMs,
    hardCapMs: c.pump.hardCapMs,
    dutyPctLimit: c.pump.dutyPct,
    dutyPctNow: c.pump.windowMs ? (totalOn / c.pump.windowMs) * 100 : 0,
  };
}

// On shutdown, abandon the open interval — caller is expected to actually
// turn the pump off, not just clear our bookkeeping.
function reset() {
  pumpHistory.length = 0;
  pumpOnSince = null;
  buckets.clear();
  templateLog.clear();
}

module.exports = {
  DEFAULTS,
  checkDevice,
  checkTemplate,
  checkPumpStart,
  recordPumpOn,
  recordPumpOff,
  continuousRuntimeMs,
  shouldForceOff,
  snapshot,
  reset,
};
