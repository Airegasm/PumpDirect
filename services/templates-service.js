const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Templates');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');

const FACTORY_PROFILE_ID = 'factory-default';

// Shipped defaults — the 18 standard action templates (Slow Stream, Pulse, Sip,
// Soft Ramp, Tease, Slow Drip, Steady Push, Throb, Bounce, Sustain, Long Push,
// Hammer, Hold, Rapid Fire, Burst, Inferno, Overdrive, Saturate) and the four
// escalating-intensity wheel templates (Easy Mode, Warm Up, Heat Up, Mercy is
// Dead). Personal session profiles, trigger templates, and pump-template
// profiles like "Basic Bloating" are intentionally NOT shipped — they're each
// owner's own taste and stay in their gitignored data/ folder.
const _DEFAULTS = require('./templates-defaults.json');
const SEED = {
  actionTemplates: JSON.parse(JSON.stringify(_DEFAULTS.actionTemplates)),
  wheelTemplates:  JSON.parse(JSON.stringify(_DEFAULTS.wheelTemplates)),
  templateProfiles: [
    {
      id: FACTORY_PROFILE_ID,
      name: 'Default',
      isFactory: true,
      milestones: [],
      defaultActionTemplateIds: ['seed-slow-stream', 'seed-pulse'],
      defaultMinigameIds: [],
      defaultMinigameConfig: {},
    },
  ],
};

// Palette used to auto-assign colors to wheel sections when the owner doesn't
// pick one — rotates through 10 distinct hues so up to 10 sections look distinct.
const WHEEL_PALETTE = ['#e74c3c', '#f39c12', '#f1c40f', '#27ae60', '#16a085', '#3498db', '#2980b9', '#7b3fd6', '#9b59b6', '#e84393'];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8'));
  } catch {
    data = JSON.parse(JSON.stringify(SEED));
    save(data);
  }
  // ensure factory profile always exists
  if (!data.templateProfiles?.some(p => p.id === FACTORY_PROFILE_ID)) {
    data.templateProfiles = [JSON.parse(JSON.stringify(SEED.templateProfiles[0])), ...(data.templateProfiles || [])];
    save(data);
  }
  if (!Array.isArray(data.wheelTemplates)) data.wheelTemplates = [];
  return data;
}

function save(data) {
  ensureDataDir();
  fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(data, null, 2));
  return data;
}

// --- validation ---

function validateSteps(steps, depth = 0) {
  if (!Array.isArray(steps)) throw new Error('steps must be an array');
  if (depth > 3) throw new Error('steps nested too deeply (max depth 3)');
  for (const s of steps) {
    if (!s || typeof s !== 'object') throw new Error('each step must be an object');
    if (s.type === 'on' || s.type === 'off') {
      if (!Number.isFinite(s.durationMs) || s.durationMs <= 0) {
        throw new Error(`${s.type} step needs positive durationMs`);
      }
      if (s.deviceId != null && typeof s.deviceId !== 'string') {
        throw new Error('deviceId must be a string or omitted (defaults to primary)');
      }
    } else if (s.type === 'repeat') {
      if (s.infinite !== true) {
        if (!Number.isInteger(s.times) || s.times <= 0) throw new Error('repeat needs positive integer "times" or infinite=true');
      }
      validateSteps(s.steps, depth + 1);
    } else {
      throw new Error(`unknown step type: ${s.type}`);
    }
  }
}

function normalizeSteps(steps) {
  return steps.map(s => {
    if (s.type === 'repeat') {
      const out = { type: 'repeat', steps: normalizeSteps(s.steps) };
      if (s.infinite) out.infinite = true;
      else out.times = s.times;
      return out;
    }
    const out = { type: s.type, durationMs: s.durationMs };
    if (s.deviceId && s.deviceId !== 'primary') out.deviceId = s.deviceId;
    return out;
  });
}

// --- action templates (the global pool) ---

function listActions() {
  return load().actionTemplates;
}

// Action templates now come in two modes:
//   * 'standard' — the historical shape; runs a sequence of on/off/repeat
//                  device steps via action-engine.
//   * 'trigger'  — fires a Trigger Action or Trigger Action Group instead;
//                  steps are ignored. The trigger target is validated lazily
//                  against triggers-service so cross-checks work without
//                  hard-importing that module here.
function _normalizeTriggerTarget(t) {
  if (!t || typeof t !== 'object') throw new Error('triggerTarget required');
  if (t.kind !== 'action' && t.kind !== 'group') throw new Error('triggerTarget.kind must be action or group');
  if (typeof t.id !== 'string' || !t.id) throw new Error('triggerTarget.id required');
  const triggers = require('./triggers-service');
  if (t.kind === 'action') triggers.getAction(t.id);    // throws if missing
  else                     triggers.getGroup(t.id);
  return { kind: t.kind, id: t.id };
}

function createAction({ name, description, mode, steps, triggerTarget }) {
  name = (name || '').trim();
  if (!name) throw new Error('name required');
  const data = load();
  if (data.actionTemplates.some(a => a.name === name)) throw new Error('action template with this name already exists');
  const action = { id: randomUUID(), name, description: (description || '').toString().trim() };
  if (mode === 'trigger') {
    action.mode = 'trigger';
    action.triggerTarget = _normalizeTriggerTarget(triggerTarget);
    action.steps = [];
  } else {
    action.mode = 'standard';
    validateSteps(steps);
    action.steps = normalizeSteps(steps);
  }
  data.actionTemplates.push(action);
  save(data);
  return action;
}

function updateAction(id, patch) {
  const data = load();
  const idx = data.actionTemplates.findIndex(a => a.id === id);
  if (idx < 0) throw new Error('action template not found');
  if (patch.name != null) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error('name cannot be empty');
    if (data.actionTemplates.some((a, i) => i !== idx && a.name === trimmed)) throw new Error('name already taken');
    data.actionTemplates[idx].name = trimmed;
  }
  if (patch.description != null) {
    data.actionTemplates[idx].description = patch.description.toString().trim();
  }
  if (patch.mode === 'trigger') {
    data.actionTemplates[idx].mode = 'trigger';
    data.actionTemplates[idx].triggerTarget = _normalizeTriggerTarget(patch.triggerTarget);
    data.actionTemplates[idx].steps = [];
  } else if (patch.mode === 'standard') {
    data.actionTemplates[idx].mode = 'standard';
    delete data.actionTemplates[idx].triggerTarget;
    if (patch.steps != null) {
      validateSteps(patch.steps);
      data.actionTemplates[idx].steps = normalizeSteps(patch.steps);
    }
  } else if (patch.steps != null) {
    validateSteps(patch.steps);
    data.actionTemplates[idx].steps = normalizeSteps(patch.steps);
  }
  save(data);
  return data.actionTemplates[idx];
}

function reorderActions(ids) {
  if (!Array.isArray(ids)) throw new Error('ids must be an array');
  const data = load();
  const byId = new Map(data.actionTemplates.map(a => [a.id, a]));
  if (ids.length !== data.actionTemplates.length || ids.some(id => !byId.has(id))) {
    throw new Error('reorder payload must contain every existing action id exactly once');
  }
  data.actionTemplates = ids.map(id => byId.get(id));
  save(data);
  return data.actionTemplates;
}

function deleteAction(id) {
  const data = load();
  const action = data.actionTemplates.find(a => a.id === id);
  if (!action) throw new Error('action template not found');
  if (id.startsWith('seed-')) {
    // seeded examples can be deleted; nothing special
  }
  data.actionTemplates = data.actionTemplates.filter(a => a.id !== id);
  // strip references from any profile/milestone
  for (const p of data.templateProfiles) {
    p.defaultActionTemplateIds = (p.defaultActionTemplateIds || []).filter(x => x !== id);
    for (const m of (p.milestones || [])) {
      m.actionTemplateIds = (m.actionTemplateIds || []).filter(x => x !== id);
    }
  }
  save(data);
  return { ok: true };
}

// --- wheel templates (prize-wheel minigame data) ---

const VALID_SECTION_TYPES = ['action', 'spin-again', 'no-prize'];

function _validateWheelSections(sections) {
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > 10) {
    throw new Error('wheel must have 1–10 sections');
  }
  for (const [i, s] of sections.entries()) {
    if (!s || typeof s !== 'object') throw new Error(`section ${i + 1} invalid`);
    if (typeof s.label !== 'string' || !s.label.trim()) throw new Error(`section ${i + 1} label required`);
    const type = s.type || 'action';
    if (!VALID_SECTION_TYPES.includes(type)) throw new Error(`section ${i + 1} type must be one of: ${VALID_SECTION_TYPES.join(', ')}`);
    if (type === 'action') validateSteps(s.steps);
  }
}

function _normalizeWheelSections(sections) {
  return sections.map((s, i) => {
    const type = s.type || 'action';
    const color = (typeof s.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(s.color))
      ? s.color
      : WHEEL_PALETTE[i % WHEEL_PALETTE.length];
    const base = { label: s.label.trim(), color, type };
    base.steps = type === 'action' ? normalizeSteps(s.steps) : [];
    return base;
  });
}

function listWheels() { return load().wheelTemplates || []; }

function getWheel(id) {
  const w = (load().wheelTemplates || []).find(x => x.id === id);
  if (!w) throw new Error('wheel template not found');
  return w;
}

function createWheel({ name, randomize, sections }) {
  name = (name || '').trim();
  if (!name) throw new Error('name required');
  _validateWheelSections(sections);
  const data = load();
  if ((data.wheelTemplates || []).some(w => w.name === name)) throw new Error('wheel name already exists');
  const wheel = {
    id: randomUUID(),
    name,
    randomize: !!randomize,
    sections: _normalizeWheelSections(sections),
  };
  data.wheelTemplates = [...(data.wheelTemplates || []), wheel];
  save(data);
  return wheel;
}

function updateWheel(id, patch) {
  const data = load();
  const idx = (data.wheelTemplates || []).findIndex(w => w.id === id);
  if (idx < 0) throw new Error('wheel template not found');
  const wheel = data.wheelTemplates[idx];
  if (patch.name != null) {
    const n = patch.name.trim();
    if (!n) throw new Error('name cannot be empty');
    if (data.wheelTemplates.some((w, i) => i !== idx && w.name === n)) throw new Error('name already taken');
    wheel.name = n;
  }
  if (patch.randomize != null) wheel.randomize = !!patch.randomize;
  if (patch.sections != null) {
    _validateWheelSections(patch.sections);
    wheel.sections = _normalizeWheelSections(patch.sections);
  }
  save(data);
  return wheel;
}

function deleteWheel(id) {
  const data = load();
  const before = (data.wheelTemplates || []).length;
  data.wheelTemplates = (data.wheelTemplates || []).filter(w => w.id !== id);
  if (data.wheelTemplates.length === before) throw new Error('wheel template not found');
  // Strip references from minigameConfig on every milestone + profile.
  for (const p of data.templateProfiles) {
    const dmc = p.defaultMinigameConfig || {};
    if (dmc['prize-wheel']?.wheelIds) {
      dmc['prize-wheel'].wheelIds = dmc['prize-wheel'].wheelIds.filter(x => x !== id);
    }
    for (const m of (p.milestones || [])) {
      const mc = m.minigameConfig || {};
      if (mc['prize-wheel']?.wheelIds) {
        mc['prize-wheel'].wheelIds = mc['prize-wheel'].wheelIds.filter(x => x !== id);
      }
    }
  }
  save(data);
  return { ok: true };
}

// --- template profiles ---

function listProfiles() {
  return load().templateProfiles;
}

function getProfile(id) {
  const p = load().templateProfiles.find(p => p.id === id);
  if (!p) throw new Error('template profile not found');
  return p;
}

function createProfile({ name }) {
  name = (name || '').trim();
  if (!name) throw new Error('name required');
  const data = load();
  if (data.templateProfiles.some(p => p.name === name)) throw new Error('profile with this name already exists');
  const profile = { id: randomUUID(), name, isFactory: false, milestones: [], defaultActionTemplateIds: [] };
  data.templateProfiles.push(profile);
  save(data);
  return profile;
}

function updateProfile(id, patch) {
  const data = load();
  const idx = data.templateProfiles.findIndex(p => p.id === id);
  if (idx < 0) throw new Error('profile not found');
  const profile = data.templateProfiles[idx];
  if (profile.isFactory) {
    // Allow defaultActionTemplateIds edit on factory (you might want to enable/disable seeded ones)
    if (patch.defaultActionTemplateIds != null) {
      profile.defaultActionTemplateIds = patch.defaultActionTemplateIds;
      save(data);
      return profile;
    }
    throw new Error('factory profile is immutable except for its always-available action list');
  }
  if (patch.name != null) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error('name cannot be empty');
    if (data.templateProfiles.some((p, i) => i !== idx && p.name === trimmed)) throw new Error('name already taken');
    profile.name = trimmed;
  }
  if (patch.defaultActionTemplateIds != null) {
    profile.defaultActionTemplateIds = patch.defaultActionTemplateIds;
  }
  if (patch.defaultMinigameIds != null) {
    profile.defaultMinigameIds = Array.isArray(patch.defaultMinigameIds) ? patch.defaultMinigameIds : [];
  }
  if (patch.defaultMinigameConfig != null && typeof patch.defaultMinigameConfig === 'object') {
    profile.defaultMinigameConfig = patch.defaultMinigameConfig;
  }
  save(data);
  return profile;
}

function deleteProfile(id) {
  if (id === FACTORY_PROFILE_ID) throw new Error('the Default profile cannot be deleted');
  const data = load();
  const before = data.templateProfiles.length;
  data.templateProfiles = data.templateProfiles.filter(p => p.id !== id);
  if (data.templateProfiles.length === before) throw new Error('profile not found');
  save(data);
  return { ok: true };
}

// --- milestones (nested inside a profile) ---

function _ensureMilestoneOK(profile, m) {
  if (m.is100Plus) return { min: 100, max: 999, is100Plus: true };
  const min = Number(m.capacityMin), max = Number(m.capacityMax);
  if (!Number.isFinite(min) || min < 0 || min > 99) throw new Error('capacityMin must be 0–99 (use the "100%+ milestone" toggle for 100 and above)');
  if (!Number.isFinite(max) || max <= min || max > 99) throw new Error('capacityMax must be > capacityMin and ≤ 99 (use the "100%+ milestone" toggle for 100 and above)');
  return { min, max, is100Plus: false };
}

function addMilestone(profileId, { name, capacityMin, capacityMax, announcement, actionTemplateIds, minigameIds, minigameConfig, is100Plus }) {
  const data = load();
  const profile = data.templateProfiles.find(p => p.id === profileId);
  if (!profile) throw new Error('profile not found');
  if (profile.isFactory) throw new Error('factory profile has no milestones');
  name = (name || '').trim();
  if (!name) throw new Error('milestone name required');
  const { min, max, is100Plus: top } = _ensureMilestoneOK(profile, { capacityMin, capacityMax, is100Plus });
  const milestone = {
    id: randomUUID(),
    name,
    capacityMin: min,
    capacityMax: max,
    is100Plus: top,
    announcement: (announcement || '').toString(),
    actionTemplateIds: Array.isArray(actionTemplateIds) ? actionTemplateIds : [],
    minigameIds: Array.isArray(minigameIds) ? minigameIds : [],
    minigameConfig: (minigameConfig && typeof minigameConfig === 'object') ? minigameConfig : {},
  };
  profile.milestones.push(milestone);
  profile.milestones.sort((a, b) => a.capacityMin - b.capacityMin);
  save(data);
  return milestone;
}

function updateMilestone(profileId, milestoneId, patch) {
  const data = load();
  const profile = data.templateProfiles.find(p => p.id === profileId);
  if (!profile) throw new Error('profile not found');
  if (profile.isFactory) throw new Error('factory profile has no milestones');
  const m = profile.milestones.find(x => x.id === milestoneId);
  if (!m) throw new Error('milestone not found');
  if (patch.name != null) m.name = patch.name.toString().trim() || m.name;
  const willBe100Plus = patch.is100Plus != null ? !!patch.is100Plus : !!m.is100Plus;
  if (patch.is100Plus != null || patch.capacityMin != null || patch.capacityMax != null) {
    const min = patch.capacityMin != null ? Number(patch.capacityMin) : m.capacityMin;
    const max = patch.capacityMax != null ? Number(patch.capacityMax) : m.capacityMax;
    const r = _ensureMilestoneOK(profile, { capacityMin: min, capacityMax: max, is100Plus: willBe100Plus });
    m.capacityMin = r.min;
    m.capacityMax = r.max;
    m.is100Plus = r.is100Plus;
  }
  if (patch.announcement != null) m.announcement = patch.announcement.toString();
  if (patch.actionTemplateIds != null) m.actionTemplateIds = patch.actionTemplateIds;
  if (patch.minigameIds != null) m.minigameIds = Array.isArray(patch.minigameIds) ? patch.minigameIds : [];
  if (patch.minigameConfig != null && typeof patch.minigameConfig === 'object') m.minigameConfig = patch.minigameConfig;
  profile.milestones.sort((a, b) => a.capacityMin - b.capacityMin);
  save(data);
  return m;
}

function deleteMilestone(profileId, milestoneId) {
  const data = load();
  const profile = data.templateProfiles.find(p => p.id === profileId);
  if (!profile) throw new Error('profile not found');
  if (profile.isFactory) throw new Error('factory profile has no milestones');
  profile.milestones = profile.milestones.filter(x => x.id !== milestoneId);
  save(data);
  return { ok: true };
}

module.exports = {
  FACTORY_PROFILE_ID,
  load,
  listActions, createAction, updateAction, deleteAction, reorderActions,
  listWheels, getWheel, createWheel, updateWheel, deleteWheel,
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  addMilestone, updateMilestone, deleteMilestone,
  validateSteps, normalizeSteps,
};
