// Trigger data model (persistence + validation).
//
//   triggerActions      — named profiles. Each runs an ordered list of
//                         sub-actions when invoked. Sub-action kinds:
//                           text-overlay      (config TBD by owner)
//                           lottie-overlay    { path, durationMs }
//                           play-sound        { path, volume?, blocking? }
//                           device-control    on / on-cycle / off + deviceId
//                           wait              { durationMs }
//                           turn-off-host-cam {}
//                           end-session       {}
//
//   triggerActionGroups — named profiles. Ordered list of triggerAction IDs;
//                         when invoked, runs them sequentially.
//
//   triggerTemplates    — named profiles attached to a session profile. Hold
//                         a list of trigger rows: {type, value, target}. The
//                         runtime watches for the configured condition and
//                         fires the chosen action / group.
//
// All three persist in data/triggers.json so the templates.json layout stays
// focused on pump templates + wheels.

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Triggers');
const DATA_DIR = path.join(__dirname, '..', 'data');
const TRIGGERS_FILE = path.join(DATA_DIR, 'triggers.json');

const VALID_TRIGGER_TYPES = ['CAPACITY_REACHED'];

// Each entry advertises which config keys the editor surfaces and how to
// validate them. text-overlay is intentionally `enabled: false` — listed in
// the dropdown but the editor refuses to save it until the owner writes up
// the spec for what a text overlay actually looks like on-stage.
const SUB_ACTION_KINDS = {
  'text-overlay':      { enabled: true,  validate: _validateTextOverlay },
  'lottie-overlay':    { enabled: true,  validate: _validateLottieOverlay },
  'video-overlay':     { enabled: true,  validate: _validateVideoOverlay },
  'play-sound':        { enabled: true,  validate: _validatePlaySound },
  'cam-toast':         { enabled: true,  validate: _validateCamToast },
  'device-control':    { enabled: true,  validate: _validateDeviceControl },
  'wait':              { enabled: true,  validate: _validateWait },
  'turn-off-host-cam': { enabled: true,  validate: () => ({}) },
  'end-session':       { enabled: true,  validate: _validateEndSession },
};

function _validateCamToast(s) {
  if (typeof s.text !== 'string' || !s.text.trim()) throw new Error('cam-toast: text required');
  const hex6 = /^#[0-9a-fA-F]{6}$/;
  const out = { text: s.text.slice(0, 200) };
  if (typeof s.textColor === 'string' && hex6.test(s.textColor)) out.textColor = s.textColor;
  if (typeof s.bgColor   === 'string' && hex6.test(s.bgColor))   out.bgColor   = s.bgColor;
  return out;
}

function _validateEndSession(s) {
  const mode = s.mode === 'delayed' ? 'delayed' : 'instant';
  if (mode === 'instant') return { mode };
  const delayMs = Number(s.delayMs);
  if (!Number.isFinite(delayMs) || delayMs < 1000 || delayMs > 5 * 60_000) {
    throw new Error('end-session delayed: delayMs must be 1000–300000');
  }
  return { mode: 'delayed', delayMs };
}

const TEXT_OVERLAY_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
function _validateTextOverlay(s) {
  const mode = s.mode;
  if (mode !== 'add' && mode !== 'clear') throw new Error('text-overlay: mode must be add or clear');
  const out = { mode };
  if (mode === 'clear') {
    const a = s.anchor;
    if (a !== 'all' && !TEXT_OVERLAY_ANCHORS.includes(a)) throw new Error('text-overlay clear: anchor must be one of ' + TEXT_OVERLAY_ANCHORS.join(', ') + ' or all');
    out.anchor = a;
    return out;
  }
  // add
  if (!TEXT_OVERLAY_ANCHORS.includes(s.anchor)) throw new Error('text-overlay add: anchor must be one of ' + TEXT_OVERLAY_ANCHORS.join(', '));
  if (typeof s.text !== 'string' || !s.text.trim()) throw new Error('text-overlay add: text required');
  const fontColor = (typeof s.fontColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.fontColor)) ? s.fontColor : '#ffffff';
  const bgColor = s.bgColor === null || s.bgColor === undefined || s.bgColor === ''
    ? null
    : (typeof s.bgColor === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(s.bgColor)) ? s.bgColor : null;
  const fontSize = Math.max(8, Math.min(200, Number(s.fontSize) || 24));
  out.anchor = s.anchor;
  out.text = s.text;
  out.fontColor = fontColor;
  out.bgColor = bgColor;
  out.fontSize = fontSize;
  return out;
}
function _validateLottieOverlay(s) {
  if (typeof s.path !== 'string' || !s.path.trim()) throw new Error('lottie-overlay: path required');
  const durationMs = Number(s.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000) throw new Error('lottie-overlay: durationMs must be 1–60000');
  // Position + size are expressed as percentages of the host webcam tile so
  // the same trigger looks right across different cam resolutions.
  const xPct     = Math.max(0,   Math.min(100, Number(s.xPct     != null ? s.xPct     : 50)));
  const yPct     = Math.max(0,   Math.min(100, Number(s.yPct     != null ? s.yPct     : 50)));
  const widthPct = Math.max(5,   Math.min(100, Number(s.widthPct != null ? s.widthPct : 40)));
  return {
    path: s.path.trim(),
    durationMs,
    freezeLastFrame: !!s.freezeLastFrame,
    xPct, yPct, widthPct,
  };
}
const CORNER_SLIDE_DIRS = ['left', 'right', 'top', 'bottom'];
const CORNER_SLIDE_ANCHORS = ['TL', 'TR', 'BL', 'BR', 'C'];

function _validateVideoOverlay(s) {
  // mode='clear' wipes the trigger-fx-stage on every client. No other fields
  // are required for clear — it's a one-shot wipe event.
  const mode = s.mode === 'clear' ? 'clear' : 'add';
  if (mode === 'clear') return { mode };
  if (typeof s.path !== 'string' || !s.path.trim()) throw new Error('video-overlay: path required');
  // durationMs is the hard cap when neither loop nor freezeLastFrame is set.
  // For loop / freeze cases the chain falls through immediately and the
  // overlay sticks until cleared (next overlay, session end, etc.).
  const durationMs = Number(s.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 5 * 60_000) throw new Error('video-overlay: durationMs must be 1–300000');
  const xPct     = Math.max(0, Math.min(100, Number(s.xPct     != null ? s.xPct     : 50)));
  const yPct     = Math.max(0, Math.min(100, Number(s.yPct     != null ? s.yPct     : 50)));
  const widthPct = Math.max(5, Math.min(100, Number(s.widthPct != null ? s.widthPct : 40)));
  const out = {
    mode: 'add',
    path: s.path.trim(),
    durationMs,
    freezeLastFrame: !!s.freezeLastFrame,
    loop: !!s.loop,
    muted: !!s.muted,
    xPct, yPct, widthPct,
    circleCrop: !!s.circleCrop,
  };
  // Migrate legacy clearOnComplete → endBehavior:'clear' for any old configs.
  let endBehavior = s.endBehavior;
  if (!endBehavior && s.clearOnComplete) endBehavior = 'clear';
  if (endBehavior !== 'clear' && endBehavior !== 'intro-outro') endBehavior = 'default';
  out.endBehavior = endBehavior;
  if (endBehavior === 'clear') {
    out.clearMode = s.clearMode === 'fade' ? 'fade' : 'vanish';
    if (out.clearMode === 'fade') {
      const fadeMs = Number(s.fadeMs);
      if (!Number.isFinite(fadeMs) || fadeMs <= 0 || fadeMs > 60_000) throw new Error('video-overlay fade: fadeMs must be 1–60000');
      out.fadeMs = fadeMs;
    }
  } else if (endBehavior === 'intro-outro') {
    // Single style available today; the schema leaves room to add more later.
    out.introOutroStyle = 'corner-slide';
    const cs = s.cornerSlide || {};
    const anchor = CORNER_SLIDE_ANCHORS.includes(cs.anchor) ? cs.anchor : 'BR';
    const slideIn = CORNER_SLIDE_DIRS.includes(cs.slideIn) ? cs.slideIn : 'right';
    const slideOut = CORNER_SLIDE_DIRS.includes(cs.slideOut) ? cs.slideOut : 'right';
    const inMs = Number(cs.inMs);
    const outMs = Number(cs.outMs);
    if (!Number.isFinite(inMs) || inMs < 100 || inMs > 10_000) throw new Error('corner-slide: inMs must be 100–10000');
    if (!Number.isFinite(outMs) || outMs < 100 || outMs > 10_000) throw new Error('corner-slide: outMs must be 100–10000');
    out.cornerSlide = { anchor, slideIn, slideOut, inMs, outMs };
  }
  return out;
}
function _validatePlaySound(s) {
  if (typeof s.path !== 'string' || !s.path.trim()) throw new Error('play-sound: path required');
  const volume = s.volume == null ? 1 : Number(s.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new Error('play-sound: volume must be 0–1');
  // blocking=true holds the trigger sequence until the sound finishes (its
  // estimated duration), false plays + immediately moves on.
  const blocking = !!s.blocking;
  const estDurationMs = s.estDurationMs != null ? Number(s.estDurationMs) : 0;
  return { path: s.path.trim(), volume, blocking, estDurationMs: Math.max(0, estDurationMs) };
}
function _validateDeviceControl(s) {
  const mode = s.mode;
  if (mode !== 'on' && mode !== 'on-cycle' && mode !== 'off') throw new Error('device-control: mode must be on / on-cycle / off');
  const out = { mode };
  if (mode === 'off') {
    // 'all' means kill every configured device; otherwise specific deviceId.
    out.deviceId = (typeof s.deviceId === 'string' && s.deviceId.trim()) ? s.deviceId.trim() : 'all';
    return out;
  }
  out.deviceId = (typeof s.deviceId === 'string' && s.deviceId.trim()) ? s.deviceId.trim() : 'primary';
  if (mode === 'on') {
    if (s.infinite) { out.infinite = true; return out; }
    const durationMs = Number(s.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 24 * 3600_000) throw new Error('device-control on: durationMs required (or infinite=true)');
    out.durationMs = durationMs;
    return out;
  }
  // on-cycle
  const cycleOnMs = Number(s.cycleOnMs);
  const cycleOffMs = Number(s.cycleOffMs);
  if (!Number.isFinite(cycleOnMs) || cycleOnMs <= 0) throw new Error('device-control on-cycle: cycleOnMs required');
  if (!Number.isFinite(cycleOffMs) || cycleOffMs <= 0) throw new Error('device-control on-cycle: cycleOffMs required');
  out.cycleOnMs = cycleOnMs;
  out.cycleOffMs = cycleOffMs;
  if (s.cycleInfinite) { out.cycleInfinite = true; return out; }
  const times = parseInt(s.cycleTimes, 10);
  if (!Number.isInteger(times) || times <= 0) throw new Error('device-control on-cycle: cycleTimes required (or cycleInfinite=true)');
  out.cycleTimes = times;
  return out;
}
function _validateWait(s) {
  const durationMs = Number(s.durationMs);
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 5 * 60_000) throw new Error('wait: durationMs must be 1–300000');
  return { durationMs };
}

function _validateSubActions(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('a trigger action needs at least one sub-action');
  return steps.map((s, i) => {
    if (!s || typeof s !== 'object') throw new Error(`sub-action ${i + 1} invalid`);
    const kind = s.kind;
    const spec = SUB_ACTION_KINDS[kind];
    if (!spec) throw new Error(`sub-action ${i + 1}: unknown kind ${kind}`);
    if (!spec.enabled) throw new Error(`sub-action ${i + 1}: ${kind} is not implemented yet`);
    return { kind, ...spec.validate(s) };
  });
}

const SEED = { triggerActions: [], triggerActionGroups: [], triggerTemplates: [] };

function _ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }

function load() {
  _ensureDataDir();
  let data;
  try { data = JSON.parse(fs.readFileSync(TRIGGERS_FILE, 'utf8')); }
  catch { data = JSON.parse(JSON.stringify(SEED)); save(data); }
  if (!Array.isArray(data.triggerActions)) data.triggerActions = [];
  if (!Array.isArray(data.triggerActionGroups)) data.triggerActionGroups = [];
  if (!Array.isArray(data.triggerTemplates)) data.triggerTemplates = [];
  return data;
}
function save(data) {
  _ensureDataDir();
  fs.writeFileSync(TRIGGERS_FILE, JSON.stringify(data, null, 2));
  return data;
}

// --- triggerActions ---

function listActions()  { return load().triggerActions; }
function getAction(id)  { const a = load().triggerActions.find(x => x.id === id); if (!a) throw new Error('trigger action not found'); return a; }

function createAction({ name, steps }) {
  name = (name || '').trim();
  if (!name) throw new Error('name required');
  const validated = _validateSubActions(steps);
  const data = load();
  if (data.triggerActions.some(a => a.name === name)) throw new Error('trigger action with this name already exists');
  const action = { id: randomUUID(), name, steps: validated };
  data.triggerActions.push(action);
  save(data);
  return action;
}
function updateAction(id, patch) {
  const data = load();
  const idx = data.triggerActions.findIndex(a => a.id === id);
  if (idx < 0) throw new Error('trigger action not found');
  if (patch.name != null) {
    const n = patch.name.trim();
    if (!n) throw new Error('name cannot be empty');
    if (data.triggerActions.some((a, i) => i !== idx && a.name === n)) throw new Error('name already taken');
    data.triggerActions[idx].name = n;
  }
  if (patch.steps != null) data.triggerActions[idx].steps = _validateSubActions(patch.steps);
  save(data);
  return data.triggerActions[idx];
}
function deleteAction(id) {
  const data = load();
  const before = data.triggerActions.length;
  data.triggerActions = data.triggerActions.filter(a => a.id !== id);
  if (data.triggerActions.length === before) throw new Error('trigger action not found');
  // Strip references from groups + trigger rows.
  for (const g of data.triggerActionGroups) g.actionIds = (g.actionIds || []).filter(x => x !== id);
  for (const t of data.triggerTemplates) {
    t.triggers = (t.triggers || []).filter(tr => !(tr.target?.kind === 'action' && tr.target?.id === id));
  }
  save(data);
  return { ok: true };
}

// --- triggerActionGroups ---

function listGroups() { return load().triggerActionGroups; }
function getGroup(id) { const g = load().triggerActionGroups.find(x => x.id === id); if (!g) throw new Error('trigger group not found'); return g; }

function createGroup({ name, actionIds }) {
  name = (name || '').trim();
  if (!name) throw new Error('name required');
  if (!Array.isArray(actionIds) || !actionIds.length) throw new Error('group must reference at least one trigger action');
  const data = load();
  if (data.triggerActionGroups.some(g => g.name === name)) throw new Error('trigger group with this name already exists');
  const known = new Set(data.triggerActions.map(a => a.id));
  for (const id of actionIds) if (!known.has(id)) throw new Error('group references unknown trigger action: ' + id);
  const group = { id: randomUUID(), name, actionIds: actionIds.slice() };
  data.triggerActionGroups.push(group);
  save(data);
  return group;
}
function updateGroup(id, patch) {
  const data = load();
  const idx = data.triggerActionGroups.findIndex(g => g.id === id);
  if (idx < 0) throw new Error('trigger group not found');
  if (patch.name != null) {
    const n = patch.name.trim();
    if (!n) throw new Error('name cannot be empty');
    if (data.triggerActionGroups.some((g, i) => i !== idx && g.name === n)) throw new Error('name already taken');
    data.triggerActionGroups[idx].name = n;
  }
  if (patch.actionIds != null) {
    if (!Array.isArray(patch.actionIds) || !patch.actionIds.length) throw new Error('group must reference at least one trigger action');
    const known = new Set(data.triggerActions.map(a => a.id));
    for (const aid of patch.actionIds) if (!known.has(aid)) throw new Error('group references unknown trigger action: ' + aid);
    data.triggerActionGroups[idx].actionIds = patch.actionIds.slice();
  }
  save(data);
  return data.triggerActionGroups[idx];
}
function deleteGroup(id) {
  const data = load();
  const before = data.triggerActionGroups.length;
  data.triggerActionGroups = data.triggerActionGroups.filter(g => g.id !== id);
  if (data.triggerActionGroups.length === before) throw new Error('trigger group not found');
  // Strip references from trigger rows.
  for (const t of data.triggerTemplates) {
    t.triggers = (t.triggers || []).filter(tr => !(tr.target?.kind === 'group' && tr.target?.id === id));
  }
  save(data);
  return { ok: true };
}

// --- triggerTemplates ---

function listTemplates() { return load().triggerTemplates; }
function getTemplate(id) { const t = load().triggerTemplates.find(x => x.id === id); if (!t) throw new Error('trigger template not found'); return t; }

function createTemplate({ name }) {
  name = (name || '').trim();
  if (!name) throw new Error('name required');
  const data = load();
  if (data.triggerTemplates.some(t => t.name === name)) throw new Error('trigger template with this name already exists');
  const template = { id: randomUUID(), name, triggers: [] };
  data.triggerTemplates.push(template);
  save(data);
  return template;
}
function updateTemplate(id, patch) {
  const data = load();
  const idx = data.triggerTemplates.findIndex(t => t.id === id);
  if (idx < 0) throw new Error('trigger template not found');
  if (patch.name != null) {
    const n = patch.name.trim();
    if (!n) throw new Error('name cannot be empty');
    if (data.triggerTemplates.some((t, i) => i !== idx && t.name === n)) throw new Error('name already taken');
    data.triggerTemplates[idx].name = n;
  }
  save(data);
  return data.triggerTemplates[idx];
}
function deleteTemplate(id) {
  const data = load();
  const before = data.triggerTemplates.length;
  data.triggerTemplates = data.triggerTemplates.filter(t => t.id !== id);
  if (data.triggerTemplates.length === before) throw new Error('trigger template not found');
  save(data);
  return { ok: true };
}

function _validateTriggerRow(template, row, ignoreId = null) {
  if (!row || typeof row !== 'object') throw new Error('trigger row invalid');
  if (!VALID_TRIGGER_TYPES.includes(row.type)) throw new Error('unknown trigger type: ' + row.type);
  if (row.type === 'CAPACITY_REACHED') {
    const v = Number(row.value);
    if (!Number.isFinite(v) || v < 0 || v > 9999) throw new Error('value must be 0–9999');
    // Only ONE trigger may fire per capacity number.
    if ((template.triggers || []).some(t => t.id !== ignoreId && t.type === 'CAPACITY_REACHED' && Number(t.value) === v)) {
      throw new Error('another trigger already fires at capacity ' + v + '%');
    }
    row.value = v;
  }
  const target = row.target;
  if (!target || typeof target !== 'object') throw new Error('trigger target required');
  if (target.kind !== 'action' && target.kind !== 'group') throw new Error('trigger target.kind must be action or group');
  if (typeof target.id !== 'string' || !target.id) throw new Error('trigger target.id required');
  // Cross-check existence.
  const data = load();
  if (target.kind === 'action' && !data.triggerActions.some(a => a.id === target.id)) {
    throw new Error('trigger target action not found');
  }
  if (target.kind === 'group' && !data.triggerActionGroups.some(g => g.id === target.id)) {
    throw new Error('trigger target group not found');
  }
  return { type: row.type, value: row.value, target: { kind: target.kind, id: target.id } };
}

function addTrigger(templateId, row) {
  const data = load();
  const t = data.triggerTemplates.find(x => x.id === templateId);
  if (!t) throw new Error('trigger template not found');
  const validated = _validateTriggerRow(t, row);
  const trigger = { id: randomUUID(), ...validated };
  t.triggers.push(trigger);
  // Sort capacity-reached triggers by ascending value for predictable display.
  t.triggers.sort((a, b) => (a.value || 0) - (b.value || 0));
  save(data);
  return trigger;
}
function updateTrigger(templateId, triggerId, patch) {
  const data = load();
  const t = data.triggerTemplates.find(x => x.id === templateId);
  if (!t) throw new Error('trigger template not found');
  const idx = t.triggers.findIndex(x => x.id === triggerId);
  if (idx < 0) throw new Error('trigger row not found');
  const merged = { ...t.triggers[idx], ...patch };
  const validated = _validateTriggerRow(t, merged, triggerId);
  t.triggers[idx] = { id: triggerId, ...validated };
  t.triggers.sort((a, b) => (a.value || 0) - (b.value || 0));
  save(data);
  return t.triggers[idx];
}
function deleteTrigger(templateId, triggerId) {
  const data = load();
  const t = data.triggerTemplates.find(x => x.id === templateId);
  if (!t) throw new Error('trigger template not found');
  const before = t.triggers.length;
  t.triggers = t.triggers.filter(x => x.id !== triggerId);
  if (t.triggers.length === before) throw new Error('trigger row not found');
  save(data);
  return { ok: true };
}

// --- helpers used by the runtime + the editor ---

function listSubActionKinds() {
  return Object.entries(SUB_ACTION_KINDS).map(([kind, spec]) => ({ kind, enabled: spec.enabled }));
}

module.exports = {
  load,
  listSubActionKinds, VALID_TRIGGER_TYPES, TEXT_OVERLAY_ANCHORS,
  listActions, getAction, createAction, updateAction, deleteAction,
  listGroups, getGroup, createGroup, updateGroup, deleteGroup,
  listTemplates, getTemplate, createTemplate, updateTemplate, deleteTemplate,
  addTrigger, updateTrigger, deleteTrigger,
};
