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
  live.capacity = Math.max(0, Math.min(100, c));
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
  const candidates = (tpl.milestones || []).filter(m => live.capacity >= m.capacityMin && live.capacity <= m.capacityMax);
  if (!candidates.length) return;
  // pick most-specific (highest min)
  candidates.sort((a, b) => b.capacityMin - a.capacityMin);
  const top = candidates[0];
  if (live.currentMilestoneId !== top.id) {
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
  }, 200);
}

function stopCapacityLoop() {
  if (capacityTickHandle) { clearInterval(capacityTickHandle); capacityTickHandle = null; }
}

async function _runSteps(steps, primary, signal) {
  for (const step of steps) {
    if (signal.aborted) return;
    if (step.type === 'on') {
      await _pumpOn(primary);
      await _sleep(step.durationMs, signal);
      await _pumpOff(primary);
    } else if (step.type === 'off') {
      await _pumpOff(primary);
      await _sleep(step.durationMs, signal);
    } else if (step.type === 'repeat') {
      for (let i = 0; i < step.times; i++) {
        if (signal.aborted) return;
        await _runSteps(step.steps, primary, signal);
      }
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

  try {
    await _runSteps(action.steps, primary, abortController.signal);
  } catch (e) {
    if (e.name !== 'AbortError') logger.error('action run failed', e.message);
  } finally {
    abortController = null;
    _setRunning(null);
    // ensure pump is off at end
    try { await control.turnOff(primary); } catch {}
    _setPump(false);
    chat.system(`${action.name} finished`);
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
