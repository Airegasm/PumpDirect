// Runtime for the Triggers system.
//
// Lifecycle:
//   * On session start (triggers.resetForSession) — load the session's trigger
//     template into in-memory state, mark every trigger as un-fired, reset the
//     capacity threshold-crossing detector.
//   * On every capacity tick from action-engine (triggers.onCapacityTick) —
//     check whether any un-fired CAPACITY_REACHED trigger had its `value`
//     crossed upward (last < value <= current). Enqueue matching ones, then
//     kick the executor if it's not already running.
//   * The executor is a single in-flight FIFO. While running, it sets a
//     session lock (currentActionTemplateId = 'trigger:<id>') so the existing
//     UI lock disables every action / minigame / pump-toggle button.
//
// Sub-action execution lives mostly here too — device-control is translated
// into action-engine inline-step format and run via a small bridge helper.
// Overlays / sound are emitted over the bus and rendered client-side.

const config = require('../config');
const session = require('./session-service');
const devices = require('./devices-service');
const control = require('./device-control');
const chat = require('./chat-service');
const triggers = require('./triggers-service');
const { bus, emitState, emitOverlay } = require('./event-bus');
const { createLogger } = require('../utils/logger');

const logger = createLogger('TriggerRT');

let runtime = _emptyRuntime();
let actionEngineRef = null;   // set lazily to avoid circular require

function _emptyRuntime() {
  return {
    templateId: null,
    triggers: [],                  // active session's trigger rows, copied
    fired: new Set(),              // trigger IDs already consumed
    lastCapacity: 0,
    queue: [],                     // pending trigger row IDs
    running: false,
    abortCtl: null,
  };
}

function _lazyActionEngine() {
  if (!actionEngineRef) actionEngineRef = require('./action-engine');
  return actionEngineRef;
}

// ---- session lifecycle hooks ----

function resetForSession() {
  if (runtime.abortCtl) { try { runtime.abortCtl.abort(); } catch {} }
  runtime = _emptyRuntime();
  const s = session.getState();
  if (!s.triggerTemplateId) return;
  let tpl;
  try { tpl = triggers.getTemplate(s.triggerTemplateId); }
  catch (e) { logger.warn('trigger template missing — running without triggers: ' + e.message); return; }
  runtime.templateId = tpl.id;
  runtime.triggers = (tpl.triggers || []).map(t => ({ ...t }));
  runtime.lastCapacity = s.capacity || 0;
  logger.info(`session loaded trigger template "${tpl.name}" with ${runtime.triggers.length} rows`);
}

function stopForSession() {
  if (runtime.abortCtl) { try { runtime.abortCtl.abort(); } catch {} }
  runtime = _emptyRuntime();
}

function onCapacityTick(capacity) {
  if (!runtime.templateId) { runtime.lastCapacity = capacity; return; }
  const prev = runtime.lastCapacity;
  runtime.lastCapacity = capacity;
  if (capacity <= prev) return;  // no upward crossing
  for (const row of runtime.triggers) {
    if (runtime.fired.has(row.id)) continue;
    if (row.type !== 'CAPACITY_REACHED') continue;
    const v = Number(row.value);
    if (!Number.isFinite(v)) continue;
    if (prev < v && capacity >= v) {
      runtime.fired.add(row.id);
      runtime.queue.push(row);
    }
  }
  if (runtime.queue.length && !runtime.running) _drainQueue();
}

// ---- queue processing + execution ----

async function _drainQueue() {
  if (runtime.running) return;
  runtime.running = true;
  while (runtime.queue.length) {
    const row = runtime.queue.shift();
    try { await _runTriggerRow(row); }
    catch (e) { logger.warn(`trigger row ${row.id} failed: ${e.message}`); }
  }
  runtime.running = false;
}

async function _runTriggerRow(row) {
  // Coordinate with the action engine before grabbing the lock:
  //   * If a normal (timed/cycled) action is running, wait for it to finish so
  //     this trigger queues behind it.
  //   * If a MANUAL Pump On is running (currentStep.indefinite) the user
  //     wanted us to preempt — abort the pump and proceed.
  //   * If idle, fall through immediately.
  await _waitForEngineIdle();

  const lockId = 'trigger:' + row.id;
  session._setLive && session._setLive({ currentActionTemplateId: lockId });
  emitState(session.getState());

  // Resolve the target to an ordered list of trigger-action profiles.
  let actionList = [];
  try {
    if (row.target?.kind === 'action') actionList = [triggers.getAction(row.target.id)];
    else if (row.target?.kind === 'group') {
      const g = triggers.getGroup(row.target.id);
      actionList = (g.actionIds || []).map(id => { try { return triggers.getAction(id); } catch { return null; } }).filter(Boolean);
    }
  } catch (e) {
    logger.warn(`trigger row ${row.id}: target lookup failed: ${e.message}`);
  }

  runtime.abortCtl = new AbortController();
  const sig = runtime.abortCtl.signal;

  chat.system(`Trigger fired: ${_labelForRow(row)}`);

  for (const action of actionList) {
    if (sig.aborted) break;
    try { await _runTriggerAction(action, sig); }
    catch (e) {
      if (e?.name === 'AbortError') break;
      logger.warn(`trigger action "${action.name}" failed: ${e.message}`);
    }
  }

  runtime.abortCtl = null;

  // Release the lock unless the action engine itself took over (e.g. an
  // end-session sub-action stopped the session entirely).
  if (session.getState().active && session.getState().currentActionTemplateId === lockId) {
    session._setLive && session._setLive({ currentActionTemplateId: null, currentStep: null, currentRepeat: null });
    emitState(session.getState());
  }
}

function _labelForRow(row) {
  if (row.type === 'CAPACITY_REACHED') return `@${row.value}% capacity`;
  return row.type;
}

async function _waitForEngineIdle() {
  while (true) {
    const s = session.getState();
    const cur = s.currentActionTemplateId;
    if (!cur) return;
    if (typeof cur === 'string' && cur.startsWith('trigger:')) return;
    // Manual pump-on (indefinite on-step) → preempt.
    if (s.currentStep && s.currentStep.indefinite) {
      try { _lazyActionEngine().abort('trigger preempted manual pump'); } catch {}
    }
    await new Promise(resolve => bus.once('state', resolve));
  }
}

async function _runTriggerAction(action, sig) {
  for (const step of (action.steps || [])) {
    if (sig.aborted) throw _abortError();
    await _runSubAction(step, sig);
  }
}

function _abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }

async function _runSubAction(step, sig) {
  switch (step.kind) {
    case 'wait':
      return _sleep(step.durationMs, sig);
    case 'text-overlay': {
      const s = session.getState();
      const current = s.textOverlays || {};
      let next;
      if (step.mode === 'clear') {
        if (step.anchor === 'all') next = {};
        else { next = { ...current }; delete next[step.anchor]; }
      } else {
        next = { ...current, [step.anchor]: {
          text: step.text, fontColor: step.fontColor, bgColor: step.bgColor || null, fontSize: step.fontSize,
        } };
      }
      session._setLive && session._setLive({ textOverlays: next });
      emitState(session.getState());
      return;
    }
    case 'lottie-overlay':
      emitOverlay({
        kind: 'lottie-overlay',
        path: step.path, durationMs: step.durationMs,
        freezeLastFrame: !!step.freezeLastFrame,
        xPct: step.xPct, yPct: step.yPct, widthPct: step.widthPct,
      });
      // When the Lottie is frozen on its last frame we don't block — the rest
      // of the trigger chain runs in parallel with the still-visible overlay.
      if (step.freezeLastFrame) return;
      return _sleep(step.durationMs, sig);
    case 'play-sound':
      emitOverlay({ kind: 'play-sound', path: step.path, volume: step.volume });
      if (step.blocking && step.estDurationMs > 0) return _sleep(step.estDurationMs, sig);
      return;
    case 'device-control':
      return _runDeviceControl(step, sig);
    case 'turn-off-host-cam':
      config.save({ owner: { camera: { mode: 'off' } } });
      emitState(session.getState());
      return;
    case 'end-session': {
      if (step.mode === 'delayed' && Number(step.delayMs) > 0) {
        emitOverlay({ kind: 'session-ending', durationMs: Number(step.delayMs) });
        try { await _sleep(Number(step.delayMs), sig); } catch (e) { if (e?.name === 'AbortError') return; throw e; }
      }
      try { session.stopSession(); } catch {}
      try { _lazyActionEngine().stopForSessionEnd(); } catch {}
      throw _abortError();  // halt the rest of the chain
    }
    default:
      logger.warn(`unknown sub-action kind: ${step.kind}`);
      return;
  }
}

function _sleep(ms, sig) {
  return new Promise((resolve, reject) => {
    if (sig?.aborted) return reject(_abortError());
    const t = setTimeout(() => { sig?.removeEventListener?.('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(_abortError()); };
    sig?.addEventListener?.('abort', onAbort);
  });
}

// Translate device-control sub-action into action-engine step shape and run it
// via a thin executor that runs the steps inline against the chosen device.
async function _runDeviceControl(step, sig) {
  const ae = _lazyActionEngine();
  if (step.mode === 'off') {
    if (step.deviceId === 'all') {
      const all = devices.loadAll ? devices.loadAll() : [];
      await Promise.all(all.map(d => control.turnOff(d).catch(() => {})));
    } else {
      const dev = step.deviceId === 'primary' ? devices.primary() : devices.get(step.deviceId);
      if (dev) await control.turnOff(dev).catch(() => {});
    }
    return;
  }
  const target = step.deviceId === 'primary' ? devices.primary() : devices.get(step.deviceId);
  if (!target) throw new Error('device not found for trigger sub-action: ' + step.deviceId);
  // Build the equivalent inline-step shape and feed it through the engine's
  // public _runSubAction* helpers. Since action-engine doesn't expose its
  // internals, we run our own minimal on/off loop against the resolved device.
  if (step.mode === 'on') {
    await control.turnOn(target).catch(() => {});
    if (step.infinite) {
      // Wait forever until abort.
      await new Promise((_, reject) => sig.addEventListener('abort', () => reject(_abortError())));
    } else {
      await _sleep(step.durationMs, sig);
    }
    await control.turnOff(target).catch(() => {});
    return;
  }
  if (step.mode === 'on-cycle') {
    const limit = step.cycleInfinite ? Infinity : Math.max(1, step.cycleTimes || 1);
    for (let i = 0; i < limit; i++) {
      if (sig.aborted) break;
      await control.turnOn(target).catch(() => {});
      await _sleep(step.cycleOnMs, sig);
      await control.turnOff(target).catch(() => {});
      if (sig.aborted) break;
      if (i + 1 < limit) await _sleep(step.cycleOffMs, sig);
    }
    return;
  }
}

// ---- external pokes ----

function abort() {
  if (runtime.abortCtl) { try { runtime.abortCtl.abort(); } catch {} }
  runtime.queue.length = 0;
}

function isBusy() { return runtime.running || runtime.queue.length > 0; }

module.exports = { resetForSession, stopForSession, onCapacityTick, abort, isBusy };
