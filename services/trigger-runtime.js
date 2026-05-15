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
  // Resolve the target up-front so we can peek at the leading sub-action.
  let actionList = [];
  try { actionList = _resolveActionList(row.target); }
  catch (e) { logger.warn(`trigger row ${row.id}: target lookup failed: ${e.message}`); }

  // A trigger whose very first sub-action is `device-control: off` is the
  // operator's explicit "stop everything and do this" signal — preempt any
  // running pump action (timed, cycled, OR manual on). Non-leading device-off
  // sub-actions queue normally; they're part of a planned chain.
  if (_firstSubActionIsDeviceOff(actionList)) {
    try { _lazyActionEngine().abort('trigger preempted by leading device-off'); } catch {}
  }

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

function _resolveActionList(target) {
  if (!target) return [];
  if (target.kind === 'action') return [triggers.getAction(target.id)];
  if (target.kind === 'group') {
    const g = triggers.getGroup(target.id);
    return (g.actionIds || [])
      .map(id => { try { return triggers.getAction(id); } catch { return null; } })
      .filter(Boolean);
  }
  return [];
}

function _firstSubActionIsDeviceOff(actionList) {
  const firstStep = actionList[0]?.steps?.[0];
  return firstStep?.kind === 'device-control' && firstStep?.mode === 'off';
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
  const steps = action.steps || [];
  logger.info(`▶ trigger action "${action.name}" — ${steps.length} sub-action${steps.length === 1 ? '' : 's'}`);
  for (const step of steps) {
    if (sig.aborted) throw _abortError();
    logger.info(`  · ${step.kind}${step.mode ? ' [' + step.mode + ']' : ''}`);
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
    case 'video-overlay':
      emitOverlay({
        kind: 'video-overlay',
        path: step.path, durationMs: step.durationMs,
        freezeLastFrame: !!step.freezeLastFrame,
        loop: !!step.loop,
        muted: !!step.muted,
        xPct: step.xPct, yPct: step.yPct, widthPct: step.widthPct,
      });
      // Loop or freeze-last-frame: don't block. Otherwise hold the chain for
      // the configured duration (or until clearOverlay swaps it out).
      if (step.loop || step.freezeLastFrame) return;
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
  const allDevices = devices.loadAll ? devices.loadAll() : [];
  // Resolve the target list. 'all' is now legal for every mode (off / on /
  // on-cycle) — the user's intent in a BurstEnd is usually "kick every plug".
  let targets;
  if (step.deviceId === 'all') {
    targets = allDevices.filter(Boolean);
  } else if (step.deviceId === 'primary') {
    const p = devices.primary();
    targets = p ? [p] : [];
  } else {
    const d = devices.get(step.deviceId);
    targets = d ? [d] : [];
  }
  if (!targets.length) {
    logger.warn(`device-control: no target resolved for "${step.deviceId}"`);
    return;
  }

  if (step.mode === 'off') {
    await Promise.all(targets.map(d => control.turnOff(d).catch(() => {})));
    return;
  }

  if (step.mode === 'on') {
    if (step.infinite) {
      // Fire-and-leave-on: kick the devices on and continue the chain. The
      // device stays on until another sub-action (or the session ending)
      // turns it off — same semantics as the manual Pump On button.
      targets.forEach(d => { control.turnOn(d).catch(() => {}); });
      return;
    }
    await Promise.all(targets.map(d => control.turnOn(d).catch(() => {})));
    await _sleep(step.durationMs, sig);
    await Promise.all(targets.map(d => control.turnOff(d).catch(() => {})));
    return;
  }

  if (step.mode === 'on-cycle') {
    const limit = step.cycleInfinite ? Infinity : Math.max(1, step.cycleTimes || 1);
    for (let i = 0; i < limit; i++) {
      if (sig.aborted) break;
      await Promise.all(targets.map(d => control.turnOn(d).catch(() => {})));
      await _sleep(step.cycleOnMs, sig);
      await Promise.all(targets.map(d => control.turnOff(d).catch(() => {})));
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

// Executes a {kind, id} target as if a trigger row pointed at it, but WITHOUT
// the capacity-tick queueing layer. Called by action-engine when a pump-action
// template is in trigger mode — the action engine owns the lock + chat
// narration; we just walk the sub-actions against the provided abort signal.
async function runActionTarget(target, signal) {
  if (!target) { logger.warn('runActionTarget: no target'); return; }
  let actionList = [];
  let targetLabel = target.kind + ':' + String(target.id || '').slice(0, 8);
  try {
    if (target.kind === 'action') {
      actionList = [triggers.getAction(target.id)];
    } else if (target.kind === 'group') {
      const g = triggers.getGroup(target.id);
      targetLabel = 'group "' + g.name + '"';
      actionList = (g.actionIds || []).map(id => { try { return triggers.getAction(id); } catch (e) { logger.warn('group references missing action ' + id.slice(0,8)); return null; } }).filter(Boolean);
    }
  } catch (e) {
    logger.warn(`runActionTarget lookup failed (${targetLabel}): ${e.message}`);
    return;
  }
  logger.info(`runActionTarget → ${targetLabel} (${actionList.length} action${actionList.length === 1 ? '' : 's'})`);
  for (const action of actionList) {
    if (signal?.aborted) { logger.info('runActionTarget aborted before "' + action.name + '"'); break; }
    try { await _runTriggerAction(action, signal); }
    catch (e) {
      if (e?.name === 'AbortError') { logger.info('runActionTarget chain aborted (likely end-session)'); break; }
      logger.warn(`trigger action "${action.name}" failed: ${e.message}`);
    }
  }
}

module.exports = { resetForSession, stopForSession, onCapacityTick, abort, isBusy, runActionTarget };
