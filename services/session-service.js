const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { createLogger } = require('../utils/logger');
const { writeAtomicSync, ensureDirSync } = require('../utils/atomic-write');
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
      aboutMe: '',
      templateProfileId: templates.FACTORY_PROFILE_ID,
      mode: 'single-target',
      settings: {
        chatroomEnabled: true,
        disableControlAt100: false,
        allowVisitorControllersInDual: false,
      },
      allowedParticipants: [],  // populated when owner adds guests
    },
  ],
};

function load() {
  ensureDirSync(DATA_DIR);
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
  writeAtomicSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
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
    aboutMe: '',
    templateProfileId: templateProfileId || templates.FACTORY_PROFILE_ID,
    mode: 'single-target',
    settings: { chatroomEnabled: true, disableControlAt100: false, allowVisitorControllersInDual: false },
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
  if (patch.aboutMe != null) profile.aboutMe = String(patch.aboutMe).slice(0, 4000);
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
  if (patch.introButton !== undefined) {
    // Same shape as customEndButton. When enabled with a valid target, the
    // session starts with introPending=true — every pump-action endpoint is
    // gated until the operator presses the intro button on Launchpad and the
    // trigger finishes.
    const ib = patch.introButton || {};
    profile.introButton = {
      enabled: !!ib.enabled,
      text: typeof ib.text === 'string' ? ib.text.slice(0, 80) : '',
      target: ib.target && typeof ib.target === 'object' && (ib.target.kind === 'action' || ib.target.kind === 'group') && ib.target.id
        ? { kind: ib.target.kind, id: String(ib.target.id) }
        : null,
    };
  }
  if (patch.settings) {
    if (typeof patch.settings.chatroomEnabled === 'boolean') profile.settings.chatroomEnabled = patch.settings.chatroomEnabled;
    if (typeof patch.settings.disableControlAt100 === 'boolean') profile.settings.disableControlAt100 = patch.settings.disableControlAt100;
    if (typeof patch.settings.allowVisitorControllersInDual === 'boolean') profile.settings.allowVisitorControllersInDual = patch.settings.allowVisitorControllersInDual;
  }
  if (patch.mode != null) {
    // Dual mode allows a second person's device to be operated alongside the host's.
    const nextMode = patch.mode === 'dual-target' ? 'dual-target' : 'single-target';
    const prevMode = profile.mode === 'dual-target' ? 'dual-target' : 'single-target';
    profile.mode = nextMode;
    // Mode swap cleanup: reset T flags on profile + live state, wipe token cache
    // and target state cache so the next session starts clean.
    if (prevMode !== nextMode) {
      // Swapping into dual mode also clears V (canBroadcast): mutual sessions
      // reserve both cam slots for host + target, so no guest cam broadcasts.
      const clearBroadcast = nextMode === 'dual-target';
      profile.allowedParticipants = (profile.allowedParticipants || []).map(p => ({
        ...p, canTarget: false, ...(clearBroadcast ? { canBroadcast: false } : {}),
      }));
      if (sessionState.active && sessionState.sessionProfileId === profile.id) {
        sessionState.mode = nextMode;
        for (const lp of sessionState.participants || []) {
          lp.canTarget = false;
          lp.targetDeviceLabel = null;
          if (clearBroadcast) lp.canBroadcast = false;
        }
        sessionState.targetState = null;
        _targetTokens.clear();
        // In dual→single swap, mutual-consent fields become irrelevant.
        if (nextMode === 'single-target') {
          sessionState.hostStartAccepted = true;
          sessionState.targetStartAccepted = true;
        }
      }
    }
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
  // Mode mirror (set on startSession). 'single-target' or 'dual-target'.
  mode: 'single-target',
  allowVisitorControllersInDual: false,
  // Latest snapshot of the target pump's state, populated by the
  // target's browser via 'target-state-update' WS. Null in single mode
  // or before a target is paired.
  targetState: null,
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
  // When the active session profile has an intro button configured, this is
  // set true on session start and cleared when the intro trigger completes.
  // While true, every pump-action endpoint refuses to fire; the action grid
  // renders disabled on both owner and visitor sides.
  introPending: false,
  // Mutual session-start consent (dual-target mode only). Both must be true
  // before pump actions can fire. Auto-true on startSession in single mode.
  // Cleared on stopSession.
  hostStartAccepted: false,
  targetStartAccepted: false,
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
  sessionState.introPending = !!(profile.introButton?.enabled && profile.introButton?.target?.id);
  // Live mode mirror so endpoints can branch without re-loading the profile.
  sessionState.mode = profile.mode === 'dual-target' ? 'dual-target' : 'single-target';
  sessionState.allowVisitorControllersInDual = !!profile.settings?.allowVisitorControllersInDual;
  // Enforce mutex on profile.canTarget at start time too: pick the first
  // profile-T-flagged participant and clear the rest.
  let claimedTarget = false;
  sessionState.participants = (profile.allowedParticipants || []).map(p => {
    const wantsT = sessionState.mode === 'dual-target' && !!p.canTarget;
    let canTarget = false;
    if (wantsT && !claimedTarget) { canTarget = 'pending'; claimedTarget = true; }
    return {
      canConnect: true, canControl: false, canBroadcast: false, ...p,
      muted: false, connected: false,
      // canTarget: false | 'pending' | true — only meaningful in dual-target mode.
      // 'pending' on start means the host pre-set T; handshake will follow
      // once the target's visitor connects.
      canTarget,
      // deviceLabel + paired flag set after a successful satellite handshake.
      targetDeviceLabel: null,
    };
  });
  // Single-target mode is implicitly mutually accepted. Dual-target needs
  // both host and target to tap Confirm Start.
  sessionState.hostStartAccepted = sessionState.mode === 'single-target';
  sessionState.targetStartAccepted = sessionState.mode === 'single-target';
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
  sessionState.introPending = false;
  // Clear dual-target state. canTarget is on the participant array which
  // gets rebuilt on the next startSession; targetState is a separate slot.
  sessionState.targetState = null;
  sessionState.hostStartAccepted = false;
  sessionState.targetStartAccepted = false;
  _targetTokens.clear();
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

// Per-email satellite pairing tokens for the active dual-target session.
// Stored side-band (NOT in sessionState.participants so tokens don't get
// serialized + broadcast to viewers). Wiped on session stop or target swap.
const _targetTokens = new Map();
function setParticipantTargetToken(email, token) {
  if (token) _targetTokens.set(email, token);
  else _targetTokens.delete(email);
}
function getTargetToken(email) { return _targetTokens.get(email) || null; }
function getActiveTargetPair() {
  const t = (sessionState.participants || []).find(p => p.canTarget === true);
  if (!t) return null;
  return { email: t.email, token: _targetTokens.get(t.email) || null, deviceLabel: t.targetDeviceLabel || null };
}

// Set / clear / pending-flip the T (canTarget) flag for one participant.
// Enforces the "at most one with non-false canTarget" invariant by clearing
// any other holder when value is truthy ('pending' or true).
function setParticipantTarget(email, value, deviceLabel) {
  if (sessionState.mode !== 'dual-target') throw new Error('T flag only valid in dual-target mode');
  const p = sessionState.participants.find(x => x.email === email);
  if (!p) throw new Error('participant not in current session');
  const next = (value === 'pending' || value === true) ? value : false;
  if (next) {
    for (const other of sessionState.participants) {
      if (other !== p && other.canTarget) { other.canTarget = false; other.targetDeviceLabel = null; }
    }
  }
  p.canTarget = next;
  if (next === true && deviceLabel) p.targetDeviceLabel = deviceLabel;
  if (!next) {
    p.targetDeviceLabel = null;
    _targetTokens.delete(email);
  }
  // Wipe the target state cache when the active target changes / clears.
  if (!next || next === 'pending') sessionState.targetState = null;
  emitState(getState());
  return getState();
}

// Apply a target-state snapshot from the paired visitor's relay.
function setTargetState(snapshot) {
  sessionState.targetState = snapshot || null;
  emitState(getState());
}

// Dual-mode mutual session-start consent. side is 'host' or 'target'.
// In single mode these are no-ops (consent is implicit on startSession).
function acceptStart(side) {
  if (sessionState.mode !== 'dual-target') return getState();
  if (side === 'host')   sessionState.hostStartAccepted = true;
  if (side === 'target') sessionState.targetStartAccepted = true;
  emitState(getState());
  return getState();
}

// Single predicate every pump-action endpoint checks. A dual-mode session
// isn't "fully started" until a target is paired AND both parties have
// accepted. Single-mode sessions pass through.
function isSessionFullyStarted() {
  if (!sessionState.active) return false;
  if (sessionState.mode !== 'dual-target') return true;
  if (!sessionState.hostStartAccepted || !sessionState.targetStartAccepted) return false;
  const t = (sessionState.participants || []).find(p => p.canTarget === true);
  return !!t;
}

module.exports = {
  FACTORY_SESSION_PROFILE_ID,
  load,
  listProfiles, getProfile, createProfile, updateProfile, deleteProfile,
  getState, _setLive, startSession, stopSession, emergencyStop, setPaused,
  updateParticipantFlags, setParticipantTarget, setTargetState,
  acceptStart, isSessionFullyStarted,
  setParticipantTargetToken, getTargetToken, getActiveTargetPair,
};
