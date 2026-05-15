const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Templates');

const DATA_DIR = path.join(__dirname, '..', 'data');
const TEMPLATES_FILE = path.join(DATA_DIR, 'templates.json');

const FACTORY_PROFILE_ID = 'factory-default';

const SEED = {
  actionTemplates: [
    { id: 'seed-slow-stream', name: 'Slow Stream', steps: [{ type: 'on', durationMs: 10000 }] },
    {
      id: 'seed-pulse', name: 'Pulse',
      steps: [{ type: 'repeat', times: 10, steps: [{ type: 'on', durationMs: 2000 }, { type: 'off', durationMs: 1000 }] }]
    },
  ],
  templateProfiles: [
    {
      id: FACTORY_PROFILE_ID,
      name: 'Default',
      isFactory: true,
      milestones: [],
      defaultActionTemplateIds: ['seed-slow-stream', 'seed-pulse'],
    },
  ],
};

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

function createAction({ name, steps }) {
  name = (name || '').trim();
  if (!name) throw new Error('name required');
  validateSteps(steps);
  const data = load();
  if (data.actionTemplates.some(a => a.name === name)) throw new Error('action template with this name already exists');
  const action = { id: randomUUID(), name, steps: normalizeSteps(steps) };
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
  if (patch.steps != null) {
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

function addMilestone(profileId, { name, capacityMin, capacityMax, announcement, actionTemplateIds, is100Plus }) {
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
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  addMilestone, updateMilestone, deleteMilestone,
  validateSteps, normalizeSteps,
};
