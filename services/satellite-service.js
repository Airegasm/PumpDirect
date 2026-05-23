// In-memory pairing state for the Dual Target satellite. When THIS
// PumpDirect instance is acting as the Target (someone else's host is
// firing actions on us), this service holds the pairing token + identifying
// metadata so the localhost-only satellite endpoints can authenticate
// run-action / pump-off / state-subscription requests.
//
// Pairing is single-slot: each successful /claim replaces any prior pairing.
// Tokens never persist to disk; restart wipes them.

const crypto = require('crypto');
const { EventEmitter } = require('events');
const { createLogger } = require('../utils/logger');
const devices = require('./devices-service');
const control = require('./device-control');

const logger = createLogger('Satellite');

// Internal bus — satellite-service emits 'state' events as the run status
// changes. The SSE endpoint subscribes to forward them to the paired
// visitor browser, which relays to the host as 'target-state-update'.
const bus = new EventEmitter();
bus.setMaxListeners(20);

const TOKEN_BYTES = 64;
const DEFAULT_TTL_MS = 24 * 3600 * 1000; // 24h

let pairing = null;
// Shape: { token, hostUrl, hostEmail, sessionId, claimedAt, expiresAt }

function _genToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

function claim({ hostUrl, hostEmail, sessionId, ttlMs }) {
  if (pairing) logger.info(`satellite: replacing prior pairing (host ${pairing.hostEmail || '?'})`);
  const now = Date.now();
  const ttl = Math.max(60_000, Math.min(Number(ttlMs) || DEFAULT_TTL_MS, 7 * 24 * 3600 * 1000));
  pairing = {
    token: _genToken(),
    hostUrl: String(hostUrl || ''),
    hostEmail: String(hostEmail || ''),
    sessionId: String(sessionId || ''),
    claimedAt: now,
    expiresAt: now + ttl,
  };
  logger.info(`satellite: paired with host ${pairing.hostEmail} for session ${pairing.sessionId.slice(0, 8)}…`);
  return { token: pairing.token, expiresAt: pairing.expiresAt };
}

function release(token) {
  if (!pairing) return;
  if (token && pairing.token !== token) return;
  logger.info(`satellite: released pairing with host ${pairing.hostEmail}`);
  pairing = null;
}

function validateToken(token) {
  if (!pairing) return false;
  if (Date.now() > pairing.expiresAt) { pairing = null; return false; }
  if (!token) return false;
  // Pad the supplied token to the expected length so timingSafeEqual can't
  // short-circuit on length difference and leak the token size.
  const expected = Buffer.from(pairing.token);
  const supplied = Buffer.alloc(expected.length);
  Buffer.from(String(token)).copy(supplied, 0, 0, expected.length);
  try {
    const eq = crypto.timingSafeEqual(supplied, expected);
    // Also enforce the actual length is what we expect.
    return eq && String(token).length === expected.length;
  } catch { return false; }
}

function getPairing() {
  if (!pairing) return null;
  if (Date.now() > pairing.expiresAt) { pairing = null; return null; }
  return { ...pairing };
}

// ---- Step runner ----
// Walks an inline step list (same {type, durationMs, indefinite, steps}
// shape that triggers/action-engine use) directly against the primary
// device. No session-state involvement — the satellite has no active
// session of its own. Step 9 will broadcast progress events.

let _abortCtl = null;
let _runStatus = { busy: false, label: null, currentStep: null, startedAt: 0 };
// Capacity tracking — same shape as action-engine's: % accumulates while
// pump is on at rate (100 / secondsTo100) per second.
let _capacity = 0;
let _pumpOnSince = null;
let _pumpOn = false;
let _capacityTickHandle = null;

function _calcRatePerMs() {
  const prim = devices.primary ? devices.primary() : null;
  const s2 = prim?.calibration?.secondsTo100;
  if (!s2 || s2 <= 0) return 0;
  return 100 / (s2 * 1000);
}

function _startCapacityTicker() {
  if (_capacityTickHandle) return;
  _capacityTickHandle = setInterval(() => {
    if (!_pumpOn || !_pumpOnSince) return;
    const rate = _calcRatePerMs();
    if (!rate) return;
    const now = Date.now();
    _capacity = Math.max(0, _capacity + (now - _pumpOnSince) * rate);
    _pumpOnSince = now;
    _emitState();
  }, 250);
}
function _stopCapacityTicker() {
  if (_capacityTickHandle) { clearInterval(_capacityTickHandle); _capacityTickHandle = null; }
}

function _emitState() {
  bus.emit('state', {
    busy: _runStatus.busy,
    label: _runStatus.label,
    currentStep: _runStatus.currentStep,
    pumpOn: _pumpOn,
    capacity: _capacity,
    currentActionTemplateId: _runStatus.busy ? ('__satellite_' + (_runStatus.label || '')) : null,
    startedAt: _runStatus.startedAt,
    ts: Date.now(),
  });
}

function subscribeState(handler) {
  bus.on('state', handler);
  return () => bus.off('state', handler);
}

function getRunStatus() {
  return {
    busy: _runStatus.busy,
    label: _runStatus.label,
    currentStep: _runStatus.currentStep,
    pumpOn: _pumpOn,
    capacity: _capacity,
    currentActionTemplateId: _runStatus.busy ? ('__satellite_' + (_runStatus.label || '')) : null,
  };
}

function _sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    signal.addEventListener('abort', onAbort);
  });
}

async function _pumpOnInternal(device) {
  await control.turnOn(device);
  if (!_pumpOnSince) _pumpOnSince = Date.now();
  _pumpOn = true;
  _emitState();
}
async function _pumpOffInternal(device) {
  // Settle accrued capacity before flipping off.
  if (_pumpOn && _pumpOnSince) {
    const rate = _calcRatePerMs();
    if (rate) _capacity = Math.max(0, _capacity + (Date.now() - _pumpOnSince) * rate);
  }
  await control.turnOff(device);
  _pumpOn = false;
  _pumpOnSince = null;
  _emitState();
}

async function _runStepsInner(steps, device, signal) {
  for (const step of steps || []) {
    if (signal.aborted) return;
    if (step.type === 'on') {
      _runStatus.currentStep = { type: 'on', durationMs: step.durationMs, startedAt: Date.now(), indefinite: !!step.indefinite };
      _emitState();
      await _pumpOnInternal(device);
      // Indefinite on-step: leave the device on and let the chain proceed
      // (caller responsible for the off via a later step or abort).
      if (!step.indefinite) {
        await _sleep(step.durationMs, signal);
        await _pumpOffInternal(device);
      }
    } else if (step.type === 'off') {
      _runStatus.currentStep = { type: 'off', durationMs: step.durationMs, startedAt: Date.now(), indefinite: !!step.indefinite };
      _emitState();
      await _pumpOffInternal(device);
      await _sleep(step.durationMs, signal);
    } else if (step.type === 'repeat') {
      const limit = step.infinite ? Infinity : Math.max(1, step.times || 1);
      for (let i = 0; i < limit; i++) {
        if (signal.aborted) return;
        await _runStepsInner(step.steps, device, signal);
      }
    }
  }
}

async function runStepsOnPrimary(steps, label) {
  // Pre-empt any prior run — same "one action at a time" rule the
  // action-engine uses.
  if (_abortCtl) { try { _abortCtl.abort(); } catch {} }
  _abortCtl = new AbortController();
  const sig = _abortCtl.signal;
  const prim = devices.primary ? devices.primary() : null;
  if (!prim) throw new Error('no primary device configured');
  if (!prim.calibration?.secondsTo100) throw new Error('primary device not calibrated');
  _runStatus = { busy: true, label: label || null, currentStep: null, startedAt: Date.now() };
  _startCapacityTicker();
  _emitState();
  logger.info(`satellite: running "${label || '?'}" (${(steps || []).length} step(s)) on ${prim.label || prim.id}`);
  try {
    await _runStepsInner(steps, prim, sig);
  } catch (e) {
    if (e.message !== 'aborted') logger.warn(`satellite run failed: ${e.message}`);
  } finally {
    // Ensure device is off at end of chain (whether natural finish or abort).
    // Log failures loudly — silently swallowing a turnOff failure here means
    // the physical pump could stay on while the API claims it's off.
    try { await _pumpOffInternal(prim); }
    catch (e) { logger.error(`satellite: turnOff failed in finally: ${e.message}`); }
    _stopCapacityTicker();
    if (_abortCtl && _abortCtl.signal === sig) _abortCtl = null;
    _runStatus = { busy: false, label: null, currentStep: null, startedAt: 0 };
    _emitState();
    logger.info(`satellite: run "${label || '?'}" finished`);
  }
}

// Abort the in-flight chain (if any) AND explicitly turn off the primary
// device. The chain's finally would do this too, but doing it here makes
// the off explicit, immediate, and observable to callers who await this fn.
// Idempotent — turning off an already-off plug is harmless on every vendor.
async function abortRun() {
  if (_abortCtl) { try { _abortCtl.abort(); } catch {} _abortCtl = null; }
  _runStatus = { busy: false, label: null, currentStep: null, startedAt: 0 };
  _stopCapacityTicker();
  const prim = devices.primary ? devices.primary() : null;
  if (prim) {
    try { await _pumpOffInternal(prim); }
    catch (e) { logger.error(`satellite: abortRun turnOff failed: ${e.message}`); }
  } else {
    _pumpOn = false;
    _pumpOnSince = null;
  }
  _emitState();
}

module.exports = { claim, release, validateToken, getPairing, runStepsOnPrimary, abortRun, getRunStatus, subscribeState };
