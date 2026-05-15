const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createLogger } = require('../utils/logger');
const templates = require('./templates-service');
const { emitState } = require('./event-bus');

const logger = createLogger('Session');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const FACTORY_SESSION_PROFILE_ID = 'factory-default-session';

const SEED = {
  sessionProfiles: [
    {
      id: FACTORY_SESSION_PROFILE_ID,
      name: 'Default',
      isFactory: true,
      welcomeMessage: 'Welcome to PumpDirect. The session has not started yet.',
      templateProfileId: templates.FACTORY_PROFILE_ID,
      settings: {
        chatroomEnabled: true,
        disableControlAt100: false,
      },
      allowedParticipants: [],  // populated when owner adds guests
    },
  ],
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {
    data = JSON.parse(JSON.stringify(SEED));
    save(data);
  }
  if (!data.sessionProfiles?.some(p => p.id === FACTORY_SESSION_PROFILE_ID)) {
    data.sessionProfiles = [JSON.parse(JSON.stringify(SEED.sessionProfiles[0])), ...(data.sessionProfiles || [])];
    save(data);
  }
  return data;
}

function save(data) {
  ensureDataDir();
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
  return data;
}

// --- session profiles CRUD ---

function listProfiles() { return load().sessionProfiles; }
function getProfile(id) {
  const p = load().sessionProfiles.find(x => x.id === id);
  if (!p) throw new Error('session profile not found');
  return p;
}
function createProfile({ name, templateProfileId }) {
  name = (name || '').trim();
  if (!name) throw new Error('name required');
  const data = load();
  if (data.sessionProfiles.some(p => p.name === name)) throw new Error('profile name already exists');
  const profile = {
    id: randomUUID(),
    name,
    isFactory: false,
    welcomeMessage: '',
    templateProfileId: templateProfileId || templates.FACTORY_PROFILE_ID,
    settings: { chatroomEnabled: true, disableControlAt100: false },
    allowedParticipants: [],
  };
  data.sessionProfiles.push(profile);
  save(data);
  return profile;
}
function updateProfile(id, patch) {
  const data = load();
  const idx = data.sessionProfiles.findIndex(p => p.id === id);
  if (idx < 0) throw new Error('profile not found');
  const profile = data.sessionProfiles[idx];
  if (profile.isFactory && patch.name) throw new Error('factory profile cannot be renamed');
  if (patch.name != null) {
    const n = patch.name.trim();
    if (data.sessionProfiles.some((p, i) => i !== idx && p.name === n)) throw new Error('name already taken');
    profile.name = n;
  }
  if (patch.welcomeMessage != null) profile.welcomeMessage = String(patch.welcomeMessage);
  if (patch.templateProfileId != null) profile.templateProfileId = patch.templateProfileId;
  if (patch.triggerTemplateId !== undefined) {
    // Allow null/'' to detach; otherwise persist the id.
    profile.triggerTemplateId = patch.triggerTemplateId || null;
  }
  if (patch.customEndButton !== undefined) {
    // Shape: { enabled:bool, text:string, target:{kind,id}|null }.
    // The Launchpad UI controls the inputs; the runtime validates the target
    // against triggers-service when the button is pressed (loose here).
    const ceb = patch.customEndButton || {};
    profile.customEndButton = {
      enabled: !!ceb.enabled,
      text: typeof ceb.text === 'string' ? ceb.text.slice(0, 80) : '',
      target: ceb.target && typeof ceb.target === 'object' && (ceb.target.kind === 'action' || ceb.target.kind === 'group') && ceb.target.id
        ? { kind: ceb.target.kind, id: String(ceb.target.id) }
        : null,
    };
  }
  if (patch.settings) {
    if (typeof patch.settings.chatroomEnabled === 'boolean') profile.settings.chatroomEnabled = patch.settings.chatroomEnabled;
    if (typeof patch.settings.disableControlAt100 === 'boolean') profile.settings.disableControlAt100 = patch.settings.disableControlAt100;
  }
  if (Array.isArray(patch.allowedParticipants)) profile.allowedParticipants = patch.allowedParticipants;
  save(data);
  return profile;
}
function deleteProfile(id) {
  if (id === FACTORY_SESSION_PROFILE_ID) throw new Error('the Default session profile cannot be deleted');
  const data = load();
  const before = data.sessionProfiles.length;
  data.sessionProfiles = data.sessionProfiles.filter(p => p.id !== id);
  if (data.sessionProfiles.length === before) throw new Error('profile not found');
  save(data);
  return { ok: true };
}

// --- live session state (in-memory) ---

const sessionState = {
  active: false,
  paused: false,
  emergencyStopped: false,
  startedAt: null,
  sessionProfileId: null,
  templateProfileId: null,
  triggerTemplateId: null,
  capacity: 0,
  pumpRuntimeMs: 0,
  pumpOn: false,
  currentActionTemplateId: null,
  currentMilestoneId: null,
  currentDisplayMessage: '',
  participants: [],
  // Live action-step telemetry — clients render countdown from these.
  currentStep: null,    // { type: 'on'|'off', durationMs, startedAt }
  currentRepeat: null,  // { iteration, times }
  // Active text overlays keyed by anchor — populated by trigger sub-actions.
  // Each value: { text, fontColor, bgColor|null, fontSize }.
  textOverlays: {},
};

function getState() { return { ...sessionState }; }

// Allow action-engine and other services to update live state fields.
function _setLive(patch) {
  for (const k of Object.keys(patch || {})) {
    if (k in sessionState) sessionState[k] = patch[k];
  }
}

function startSession(profileId) {
  if (sessionState.active) throw new Error('a session is already active — stop it first');
  const profile = getProfile(profileId || FACTORY_SESSION_PROFILE_ID);
  sessionState.active = true;
  sessionState.paused = true;  // sessions start in standby — owner clicks "Exit Standby" to go live.
  sessionState.emergencyStopped = false;
  sessionState.startedAt = new Date().toISOString();
  sessionState.sessionProfileId = profile.id;
  sessionState.templateProfileId = profile.templateProfileId;
  sessionState.triggerTemplateId = profile.triggerTemplateId || null;
  sessionState.capacity = 0;
  sessionState.pumpRuntimeMs = 0;
  sessionState.pumpOn = false;
  sessionState.currentActionTemplateId = null;
  sessionState.currentMilestoneId = null;
  sessionState.currentDisplayMessage = profile.welcomeMessage || '';
  sessionState.textOverlays = {};
  sessionState.participants = (profile.allowedParticipants || []).map(p => ({
    canConnect: true, canControl: false, canBroadcast: false, ...p,
    muted: false, connected: false,
  }));
  logger.info(`session started from profile "${profile.name}"`);
  emitState(getState());
  return getState();
}

function stopSession() {
  if (!sessionState.active) throw new Error('no active session');
  sessionState.active = false;
  sessionState.paused = false;
  sessionState.emergencyStopped = false;
  sessionState.pumpOn = false;
  sessionState.currentActionTemplateId = null;
  sessionState.textOverlays = {};
  logger.info('session stopped');
  emitState(getState());
  return getState();
}

function emergencyStop() {
  if (!sessionState.active) throw new Error('no active session');
  sessionState.emergencyStopped = true;
  sessionState.pumpOn = false;
  sessionState.currentActionTemplateId = null;
  logger.info('E-STOP triggered');
  emitState(getState());
  return getState();
}

function setPaused(paused) {
  if (!sessionState.active) throw new Error('no active session');
  sessionState.paused = !!paused;
  if (paused) {
    sessionState.pumpOn = false;
    sessionState.currentActionTemplateId = null;
  }
  emitState(getState());
  return getState();
}

function updateParticipantFlags(email, patch) {
  const p = sessionState.participants.find(x => x.email === email);
  if (!p) throw new Error('participant not in current session');
  if (typeof patch.canConnect === 'boolean') p.canConnect = patch.canConnect;
  if (typeof patch.canControl === 'boolean') p.canControl = patch.canControl;
  if (typeof patch.canBroadcast === 'boolean') p.canBroadcast = patch.canBroadcast;
  if (typeof patch.muted === 'boolean') p.muted = patch.muted;
  emitState(getState());
  return getState();
}

module.exports = {
  FACTORY_SESSION_PROFILE_ID,
  load,
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  getState, _setLive, startSession, stopSession, emergencyStop, setPaused, updateParticipantFlags,
};
