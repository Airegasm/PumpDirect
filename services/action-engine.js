const session = require('./session-service');
const devices = require('./devices-service');
const control = require('./device-control');
const templates = require('./templates-service');
const chat = require('./chat-service');
const rateLimit = require('./rate-limit-service');
const config = require('../config');
const { emitState, emitOverlay } = require('./event-bus');
const { createLogger } = require('../utils/logger');
// Lazy require to break a potential cycle (trigger-runtime requires this file too).
let _triggerRuntime = null;
function _triggers() { if (!_triggerRuntime) _triggerRuntime = require('./trigger-runtime'); return _triggerRuntime; }

const logger = createLogger('ActionEngine');

let abortController = null;
let capacityTickHandle = null;
let pumpOnSince = null;

function _state() { return session.getState(); }

function _publish() { emitState(session.getState()); }

function _sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); };
    signal?.addEventListener('abort', onAbort);
  });
}

// device may be primary or any other configured device. Only the primary
// toggles global pumpOn / capacity tracking + rate-limit duty cycling;
// other devices fire independently of the safety watchdog.
async function _pumpOn(device) {
  if (!device) return;
  const primary = devices.primary();
  const isPrimary = !!(primary && device.id === primary.id);
  if (isPrimary) {
    const verdict = rateLimit.checkPumpStart();
    if (!verdict.ok) {
      logger.warn(`pump start blocked: ${verdict.reason}`);
      chat.system(`Safety: ${verdict.reason}`);
      throw new Error(verdict.reason);
    }
  }
  await control.turnOn(device);
  if (isPrimary) {
    if (!pumpOnSince) pumpOnSince = Date.now();
    rateLimit.recordPumpOn();
    _setPump(true);
  }
  _publish();
}

async function _pumpOff(device) {
  if (!device) return;
  try { await control.turnOff(device); } catch (e) { logger.error('turnOff failed', e.message); }
  const primary = devices.primary();
  const isPrimary = !!(primary && device.id === primary.id);
  if (isPrimary) {
    pumpOnSince = null;
    rateLimit.recordPumpOff();
    _setPump(false);
  }
  _publish();
}

function _resolveStepDevice(step, fallbackPrimary) {
  if (!step.deviceId || step.deviceId === 'primary') return fallbackPrimary;
  return devices.get(step.deviceId) || fallbackPrimary;
}

const live = {
  capacity: 0,
  pumpOn: false,
  currentActionTemplateId: null,
  currentMilestoneId: null,
  currentDisplayMessage: '',
  currentStep: null,
  currentRepeat: null,
};

function _setPump(v) {
  live.pumpOn = v;
  session._setLive && session._setLive(live);
}
function _setRunning(id) {
  live.currentActionTemplateId = id;
  session._setLive && session._setLive(live);
}
function _setCapacity(c) {
  // No upper clamp here — the disableControlAt100 setting is enforced by the
  // capacity-tick loop (which aborts the running action) rather than by hiding
  // the number. Gauge UI handles the visual cap separately.
  live.capacity = Math.max(0, c);
  session._setLive && session._setLive(live);
}

// Public setter used by the Launchpad "Set capacity" button. Routes through
// the engine's internal `live.capacity` so the next capacity-tick doesn't
// stomp on the manually-set value (the tick uses live.capacity as its base).
// Also rebases pumpOnSince so any partial in-flight pump segment doesn't
// retroactively charge time against the new starting point.
function setCapacity(c) {
  _setCapacity(c);
  if (pumpOnSince) pumpOnSince = Date.now();
  _publish();
}

function _calcRatePerMs(primary) {
  // capacity grows from 0 to 100 over `secondsTo100` seconds while pump is on
  const sec = primary?.calibration?.secondsTo100;
  if (!sec || sec <= 0) return 0;
  return 100 / (sec * 1000);
}

function _maybeAdvanceMilestone() {
  const s = session.getState();
  const tplData = templates.load();
  const tpl = tplData.templateProfiles.find(p => p.id === s.templateProfileId);
  if (!tpl) return;
  let top = null;
  if (live.capacity >= 100) {
    top = (tpl.milestones || []).find(m => m.is100Plus) || null;
  }
  if (!top) {
    const candidates = (tpl.milestones || []).filter(m => !m.is100Plus && live.capacity >= m.capacityMin && live.capacity <= m.capacityMax);
    candidates.sort((a, b) => b.capacityMin - a.capacityMin);
    top = candidates[0] || null;
  }
  if (top && live.currentMilestoneId !== top.id) {
    live.currentMilestoneId = top.id;
    // The welcome message stays in currentDisplayMessage for the duration of a
    // session; the milestone announcement is rendered as a separate line below
    // it (client derives it from the milestone definition by currentMilestoneId).
    session._setLive && session._setLive(live);
    emitOverlay({ kind: 'action-flash', text: `Milestone: ${top.name}` });
    _publish();
  }
}

function startCapacityLoop() {
  stopCapacityLoop();
  capacityTickHandle = setInterval(() => {
    const s = session.getState();
    if (!s.active || s.paused || s.emergencyStopped) return;
    if (!live.pumpOn || !pumpOnSince) return;

    // Dead-man hard cap: if the pump has been continuously on for longer
    // than the configured limit, force it off and abort the current action.
    // This is the final safety net behind the per-action timing.
    if (rateLimit.shouldForceOff()) {
      const primary = devices.primary();
      logger.error(`HARD CAP reached — forcing pump off after ${(rateLimit.continuousRuntimeMs()/1000).toFixed(0)}s`);
      chat.system('Safety: pump hard cap reached — forced off');
      if (abortController) abortController.abort();
      if (primary) control.turnOff(primary).catch(e => logger.error('hardcap turnOff', e.message));
      pumpOnSince = null;
      rateLimit.recordPumpOff();
      _setPump(false);
      _setRunning(null);
      _publish();
      return;
    }

    const primary = devices.primary();
    if (!primary) return;
    const rate = _calcRatePerMs(primary);
    if (!rate) return;
    const now = Date.now();
    const elapsed = now - pumpOnSince;
    pumpOnSince = now;
    _setCapacity(live.capacity + elapsed * rate);
    _maybeAdvanceMilestone();
    try { _triggers().onCapacityTick(live.capacity); } catch (e) { logger.warn('trigger runtime tick failed: ' + e.message); }
    _publish();

    // Enforce disableControlAt100 mid-action: if capacity crossed 100 while a
    // session profile has that setting on, abort the running action.
    if (live.capacity >= 100 && live.currentActionTemplateId) {
      const sessData = session.load();
      const profile = sessData.sessionProfiles.find(p => p.id === s.sessionProfileId);
      if (profile?.settings?.disableControlAt100) {
        abort('100% reached — device control disabled by session setting');
      }
    }
  }, 200);
}

function stopCapacityLoop() {
  if (capacityTickHandle) { clearInterval(capacityTickHandle); capacityTickHandle = null; }
}

function _setStep(step) {
  live.currentStep = step;
  session._setLive({ currentStep: step });
  _publish();
}
function _setRepeat(rep) {
  live.currentRepeat = rep;
  session._setLive({ currentRepeat: rep });
  _publish();
}

async function _runSteps(steps, primary, signal, repeatContext = null) {
  if (repeatContext) _setRepeat(repeatContext);
  for (const step of steps) {
    if (signal.aborted) return;
    if (step.type === 'on') {
      const target = _resolveStepDevice(step, primary);
      _setStep({ type: 'on', durationMs: step.durationMs, startedAt: Date.now(), indefinite: !!step.indefinite });
      await _pumpOn(target);
      await _sleep(step.durationMs, signal);
      await _pumpOff(target);
    } else if (step.type === 'off') {
      const target = _resolveStepDevice(step, primary);
      _setStep({ type: 'off', durationMs: step.durationMs, startedAt: Date.now(), indefinite: !!step.indefinite });
      await _pumpOff(target);
      await _sleep(step.durationMs, signal);
    } else if (step.type === 'repeat') {
      if (step.infinite) {
        let i = 0;
        while (!signal.aborted) {
          i++;
          await _runSteps(step.steps, primary, signal, { iteration: i, times: '∞' });
        }
      } else {
        for (let i = 0; i < step.times; i++) {
          if (signal.aborted) return;
          await _runSteps(step.steps, primary, signal, { iteration: i + 1, times: step.times });
        }
      }
      _setRepeat(null);
    }
  }
}

async function fireAction({ actionTemplateId, inline, byEmail, byNickname, silentFlash }) {
  const s = session.getState();
  if (!s.active) throw new Error('no active session');
  if (s.emergencyStopped) throw new Error('E-STOP active — clear by stopping the session');
  if (s.paused) throw new Error('device control is paused');
  if (live.currentActionTemplateId) throw new Error('another action is already running');

  let action;
  if (inline) {
    templates.validateSteps(inline.steps);
    action = { id: '_inline_' + Date.now(), name: inline.name || 'Manual', mode: 'standard', steps: inline.steps };
  } else if (actionTemplateId) {
    const tplData = templates.load();
    action = tplData.actionTemplates.find(a => a.id === actionTemplateId);
    if (!action) throw new Error('action template not found');
  } else {
    throw new Error('actionTemplateId or inline required');
  }

  // Anti-spam: cap fires per (template, visitor) over a sliding window.
  const tplVerdict = rateLimit.checkTemplate(actionTemplateId, byEmail);
  if (!tplVerdict.ok) throw new Error(tplVerdict.reason);

  // Pump duty cycle pre-flight (the per-step _pumpOn re-checks too, but
  // failing here means we never claim currentActionTemplateId for nothing).
  const pumpVerdict = rateLimit.checkPumpStart();
  if (!pumpVerdict.ok) throw new Error(pumpVerdict.reason);


  const sessData = session.load();
  const profile = sessData.sessionProfiles.find(p => p.id === s.sessionProfileId);
  if (profile?.settings?.disableControlAt100 && live.capacity >= 100) {
    throw new Error('device control disabled at 100% (session profile setting)');
  }

  // Mode dispatch: trigger-mode action templates fire a Trigger Action / Group
  // instead of running pump steps. The action lock still ticks the same way
  // (currentActionTemplateId=action.id) so all the existing UI disables apply.
  if (action.mode === 'trigger' && action.triggerTarget) {
    abortController = new AbortController();
    _setRunning(action.id);
    if (!silentFlash) emitOverlay({ kind: 'action-flash', text: `${byNickname || 'someone'} fired ${action.name}` });
    _publish();
    (async () => {
      try {
        await _triggers().runActionTarget(action.triggerTarget, abortController.signal);
      } catch (e) {
        if (e?.name !== 'AbortError') logger.error('trigger-mode action run failed: ' + e.message);
      } finally {
        abortController = null;
        _setRunning(null);
        _setStep(null);
        _setRepeat(null);
        _publish();
      }
    })();
    return { ok: true };
  }

  const primary = devices.primary();
  if (!primary || !primary.calibration?.secondsTo100) throw new Error('primary pump not calibrated');

  abortController = new AbortController();
  _setRunning(action.id);
  if (!silentFlash) emitOverlay({ kind: 'action-flash', text: `${byNickname || 'someone'} fired ${action.name}` });
  _publish();

  // Run the sequence asynchronously — caller does NOT await. Long-running
  // actions (Pump On, infinite repeats, etc.) shouldn't hold the HTTP request.
  (async () => {
    try {
      await _runSteps(action.steps, primary, abortController.signal);
    } catch (e) {
      if (e.name !== 'AbortError') logger.error('action run failed', e.message);
    } finally {
      abortController = null;
      _setRunning(null);
      _setStep(null);
      _setRepeat(null);
      try { await control.turnOff(primary); } catch {}
      _setPump(false);
      _publish();
    }
  })();

  return { ok: true };
}

function abort(reason = 'aborted') {
  if (abortController) abortController.abort();
  const primary = devices.primary();
  if (primary) { control.turnOff(primary).catch(() => {}); }
  _setPump(false);
  _setRunning(null);
  if (reason) chat.system(reason);
  _publish();
}

function resetForNewSession(welcomeMessage) {
  live.capacity = 0;
  live.pumpOn = false;
  live.currentActionTemplateId = null;
  live.currentMilestoneId = null;
  live.currentDisplayMessage = welcomeMessage || '';
  session._setLive && session._setLive(live);
  chat.reset();
  chat.rotateKey();  // fresh AES key per session — old ciphertext stays undecryptable
  pumpOnSince = null;
  // Safety blast: fan an `off` to every configured device on session start.
  // Covers the case where a previous session crashed mid-cycle and left a
  // plug latched on (or a manual flip somewhere). Fire-and-forget so we
  // don't block start on device latency.
  try {
    const allDevs = devices.loadAll ? devices.loadAll() : [];
    for (const d of allDevs) { control.turnOff(d).catch(() => {}); }
    logger.info(`session start: cleared ${allDevs.length} device(s) to OFF`);
  } catch (e) { logger.warn('session-start off-all failed: ' + e.message); }
  try { _triggers().resetForSession(); } catch (e) { logger.warn('trigger reset failed: ' + e.message); }
  startCapacityLoop();
  _publish();
}

function stopForSessionEnd() {
  stopCapacityLoop();
  abort(null);
  live.capacity = 0;
  live.pumpOn = false;
  live.currentActionTemplateId = null;
  live.currentMilestoneId = null;
  session._setLive && session._setLive(live);
  try { _triggers().stopForSession(); } catch (e) { logger.warn('trigger stop failed: ' + e.message); }
  _publish();
}

module.exports = { fireAction, abort, setCapacity, resetForNewSession, stopForSessionEnd, startCapacityLoop, stopCapacityLoop };
