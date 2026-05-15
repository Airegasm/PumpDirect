const session = require('./session-service');
const devices = require('./devices-service');
const control = require('./device-control');
const templates = require('./templates-service');
const chat = require('./chat-service');
const config = require('../config');
const { emitState } = require('./event-bus');
const { createLogger } = require('../utils/logger');

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

async function _pumpOn(primary) {
  await control.turnOn(primary);
  if (!pumpOnSince) pumpOnSince = Date.now();
  _setPump(true);
  _publish();
}

async function _pumpOff(primary) {
  try { await control.turnOff(primary); } catch (e) { logger.error('turnOff failed', e.message); }
  pumpOnSince = null;
  _setPump(false);
  _publish();
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
    live.currentDisplayMessage = top.announcement || live.currentDisplayMessage;
    session._setLive && session._setLive(live);
    chat.system(`Milestone reached: ${top.name}`);
    _publish();
  }
}

function startCapacityLoop() {
  stopCapacityLoop();
  capacityTickHandle = setInterval(() => {
    const s = session.getState();
    if (!s.active || s.paused || s.emergencyStopped) return;
    if (!live.pumpOn || !pumpOnSince) return;
    const primary = devices.primary();
    if (!primary) return;
    const rate = _calcRatePerMs(primary);
    if (!rate) return;
    const now = Date.now();
    const elapsed = now - pumpOnSince;
    pumpOnSince = now;
    _setCapacity(live.capacity + elapsed * rate);
    _maybeAdvanceMilestone();
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
      _setStep({ type: 'on', durationMs: step.durationMs, startedAt: Date.now() });
      await _pumpOn(primary);
      await _sleep(step.durationMs, signal);
      await _pumpOff(primary);
    } else if (step.type === 'off') {
      _setStep({ type: 'off', durationMs: step.durationMs, startedAt: Date.now() });
      await _pumpOff(primary);
      await _sleep(step.durationMs, signal);
    } else if (step.type === 'repeat') {
      for (let i = 0; i < step.times; i++) {
        if (signal.aborted) return;
        await _runSteps(step.steps, primary, signal, { iteration: i + 1, times: step.times });
      }
      _setRepeat(null);
    }
  }
}

async function fireAction({ actionTemplateId, byEmail, byNickname }) {
  const s = session.getState();
  if (!s.active) throw new Error('no active session');
  if (s.emergencyStopped) throw new Error('E-STOP active — clear by stopping the session');
  if (s.paused) throw new Error('device control is paused');
  if (live.currentActionTemplateId) throw new Error('another action is already running');

  const tplData = templates.load();
  const action = tplData.actionTemplates.find(a => a.id === actionTemplateId);
  if (!action) throw new Error('action template not found');

  const primary = devices.primary();
  if (!primary || !primary.calibration?.secondsTo100) throw new Error('primary pump not calibrated');

  // Profile-level guard: disable at 100%
  const sessData = session.load();
  const profile = sessData.sessionProfiles.find(p => p.id === s.sessionProfileId);
  if (profile?.settings?.disableControlAt100 && live.capacity >= 100) {
    throw new Error('device control disabled at 100% (session profile setting)');
  }

  abortController = new AbortController();
  _setRunning(action.id);
  chat.system(`${byNickname || 'someone'} fired ${action.name}`);
  _publish();

  let wasAborted = false;
  try {
    await _runSteps(action.steps, primary, abortController.signal);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error('action run failed', e.message);
    else wasAborted = true;
  } finally {
    wasAborted = wasAborted || !!(abortController && abortController.signal.aborted);
    abortController = null;
    _setRunning(null);
    _setStep(null);
    _setRepeat(null);
    try { await control.turnOff(primary); } catch {}
    _setPump(false);
    chat.system(wasAborted ? `${action.name} aborted` : `${action.name} finished`);
    _publish();
  }

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
  _publish();
}

module.exports = { fireAction, abort, resetForNewSession, stopForSessionEnd, startCapacityLoop, stopCapacityLoop };
