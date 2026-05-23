const express = require('express');
const session = require('../services/session-service');
const templatesSvc = require('../services/templates-service');
const devicesSvc = require('../services/devices-service');
const actionEngine = require('../services/action-engine');
const minigames = require('../services/minigames-service');
const triggersSvc = require('../services/triggers-service');
const chat = require('../services/chat-service');
const config = require('../config');
const { ownerLayout, escape } = require('../views/layout');
const { rtcClientJs } = require('../views/rtc-client');
const { chatCryptoJs } = require('../views/chat-crypto');
const { camPipelineJs } = require('../views/cam-pipeline');
const { overlayJs, overlayCss } = require('../views/overlay');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Launchpad');
const router = express.Router();

function pill(state, label) {
  const cls = state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${escape(label)}</span>`;
}

function gauge(pct) {
  const r = 80, c = 2 * Math.PI * r;
  const cap = Math.max(0, Number(pct) || 0);
  const needle = Math.min(100, cap);
  const dash = (needle / 100) * c;
  const over = cap > 100;
  return `<svg viewBox="0 0 200 200" style="width:240px;height:240px">
    <circle cx="100" cy="100" r="${r}" stroke="#2a2f3a" stroke-width="22" fill="none"/>
    <circle cx="100" cy="100" r="${r}" stroke="${over ? '#f0c674' : '#2a6df4'}" stroke-width="22" fill="none"
            stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}"
            stroke-linecap="round"
            transform="rotate(-90 100 100)"
            style="transition:stroke-dasharray 0.4s ease"/>
    <text x="100" y="108" text-anchor="middle" font-size="42" font-weight="700" fill="${over ? '#f0c674' : '#e8e8e8'}">${cap.toFixed(0)}%</text>
    <text x="100" y="138" text-anchor="middle" font-size="14" fill="#7a8597">${over ? 'over capacity' : 'capacity'}</text>
  </svg>`;
}

router.get('/', (req, res) => {
  const sessionData = session.load();
  const profiles = sessionData.sessionProfiles;
  const state = session.getState();
  // Remember the last-used session profile across reloads: prefer ?profile=
  // from URL, then the in-memory session.sessionProfileId (persists across
  // session-stop until the next start), then fall back to the first profile.
  const activeProfileId = req.query.profile || state.sessionProfileId || profiles[0].id;
  const profile = profiles.find(p => p.id === activeProfileId) || profiles[0];
  const templates = templatesSvc.load();
  const templateProfile = templates.templateProfiles.find(p => p.id === profile.templateProfileId) || templates.templateProfiles[0];
  const actionsById = Object.fromEntries(templates.actionTemplates.map(a => [a.id, a]));
  const primaryDevice = devicesSvc.primary();
  const cfg = config.load();
  const allAllowedEmails = (cfg.accounts || []).map(a => a.email);

  // Determine active milestone (if session running and template has milestones).
  // At ≥100% capacity, the special is100Plus milestone wins. Otherwise normal-range matching.
  let activeMilestone = null;
  if (state.active && templateProfile && templateProfile.milestones?.length) {
    if (state.capacity >= 100) {
      activeMilestone = templateProfile.milestones.find(m => m.is100Plus) || null;
    }
    if (!activeMilestone) {
      activeMilestone = templateProfile.milestones
        .filter(m => !m.is100Plus && state.capacity >= m.capacityMin && state.capacity <= m.capacityMax)
        .sort((a, b) => b.capacityMin - a.capacityMin)[0] || null;
    }
  }

  const profileOptions = profiles
    .map(p => `<option value="${escape(p.id)}" ${p.id === profile.id ? 'selected' : ''}>${escape(p.name)}${p.isFactory ? ' (factory)' : ''}</option>`)
    .join('');

  const templateOptions = templates.templateProfiles
    .map(p => `<option value="${escape(p.id)}" ${p.id === profile.templateProfileId ? 'selected' : ''}>${escape(p.name)}</option>`)
    .join('');

  // Trigger-template options for the Launchpad dashboard dropdown (assignable
  // without diving into Settings). Empty value = no trigger template attached.
  const triggerTemplatesList = triggersSvc.listTemplates();
  const triggerTemplateOptions = '<option value=""' + (!profile.triggerTemplateId ? ' selected' : '') + '>(none)</option>'
    + triggerTemplatesList
      .map(t => `<option value="${escape(t.id)}" ${t.id === profile.triggerTemplateId ? 'selected' : ''}>${escape(t.name)}</option>`)
      .join('');

  // Owner is implicitly the Host — exclude from the manageable participants list
  // and from the "add from accounts" dropdown so they can't be added as a guest.
  const ownerEmailLp = cfg.cloudflare?.ownerEmail || '';
  const candidateEmails = allAllowedEmails.filter(e => e !== ownerEmailLp);
  const ineligible = candidateEmails.filter(e => !profile.allowedParticipants.some(p => p.email === e));
  const addParticipantOptions = ineligible.map(e => `<option value="${escape(e)}">${escape(e)}</option>`).join('');

  // Action buttons (milestone-specific + always-available)
  const milestoneActionIds = activeMilestone ? (activeMilestone.actionTemplateIds || []) : [];
  const alwaysActionIds = templateProfile?.defaultActionTemplateIds || [];
  const visibleActionIds = state.active
    ? Array.from(new Set([...milestoneActionIds, ...alwaysActionIds]))
    : [];
  // Minigames — same union of milestone-attached + always-available pools.
  const milestoneMinigameIds = activeMilestone ? (activeMilestone.minigameIds || []) : [];
  const alwaysMinigameIds = templateProfile?.defaultMinigameIds || [];
  const visibleMinigameIds = state.active
    ? Array.from(new Set([...milestoneMinigameIds, ...alwaysMinigameIds]))
    : [];
  const minigamesById = Object.fromEntries(minigames.list().map(m => [m.id, m]));
  const isRunning = !!state.currentActionTemplateId;
  const introGated = !!state.introPending;
  const lockBtns = isRunning || introGated;
  const alwaysBtns = state.active ? `
    <button class="action-btn pump-toggle" onclick="lpPumpToggle()" style="background:${isRunning ? '#a13030' : '#1a8a4d'};color:#fff" ${introGated ? 'disabled' : ''}>${isRunning ? '⏻ Pump Off' : '⏵ Pump On'}</button>
    <button class="action-btn misc-action-btn" onclick="lpTimed()" style="background:#1a8a4d;color:#fff" ${lockBtns ? 'disabled' : ''}>⏱ Timed</button>
    <button class="action-btn misc-action-btn" onclick="lpCycle()" style="background:#1a8a4d;color:#fff" ${lockBtns ? 'disabled' : ''}>↻ Cycle</button>
  ` : '';
  const actionCells = visibleActionIds.map(id => {
    const a = actionsById[id];
    return `<div class="action-cell">
      <button class="action-btn" data-action-id="${escape(id)}" onclick="lpFireAction('${escape(id)}')" ${introGated ? 'disabled' : ''}>${escape(a?.name || '?')}</button>
      <button class="action-help-btn" type="button" title="What does this do?" onclick="lpActionHelp('${escape(id)}')">?</button>
    </div>`;
  }).join('');
  const minigameCells = visibleMinigameIds.map(id => {
    const mg = minigamesById[id];
    if (!mg) return '';
    return `<div class="action-cell">
      <button class="action-btn minigame-btn" data-minigame-id="${escape(id)}" onclick="lpOpenMinigame('${escape(id)}')" style="background:${escape(mg.color)};color:#fff" ${introGated ? 'disabled' : ''}>🎲 ${escape(mg.name)}</button>
      <button class="action-help-btn" type="button" title="What does this do?" onclick="lpMinigameHelp('${escape(id)}')">?</button>
    </div>`;
  }).join('');
  const hasAnyButtons = visibleActionIds.length || visibleMinigameIds.length;
  const actionButtonsCore = hasAnyButtons
    ? actionCells + minigameCells
    : (state.active ? '<p class="muted" style="grid-column:1/-1">No template actions or minigames for this milestone — use Pump On / Timed / Cycle above.</p>' : '<p class="muted">Start a session to enable actions.</p>');
  const actionButtons = alwaysBtns + actionButtonsCore;

  const calibratedReady = primaryDevice && primaryDevice.calibration?.secondsTo100 > 0;
  const sessionReady = calibratedReady && allAllowedEmails.length > 0;
  const ownerDisplayName = cfg.owner?.displayName || '';
  const ownerNameForTitle = ownerDisplayName || (cfg.cloudflare?.ownerEmail?.split('@')[0]) || 'owner';
  // Offline cam placeholder sizing: render the empty host cam slot at the
  // configured camera's actual aspect ratio (16:9 for 1280x720, etc.) so it
  // doesn't appear as a big 1:1 square that snaps narrower when the stream
  // lands. Falls back to 16:9 for 'native'/non-numeric values.
  const _camRes = cfg.owner?.camera?.resolution || { width: 1280, height: 720 };
  const _camAspect = (_camRes.width === 'native' || !Number.isFinite(Number(_camRes.width)) || !Number.isFinite(Number(_camRes.height)))
    ? (16 / 9)
    : (Number(_camRes.width) / Number(_camRes.height));
  const ownerCamAspectStr = _camAspect.toFixed(4);

  const body = `
    <style>
      /* Launchpad goes edge-to-edge - the 3-column grid is meant to fill the
         viewport, not float inside a 1400px-capped, padded container like the
         other pages do. Overrides views/layout.js main {max-width:1400; padding:22px 28px}.
         Top/bottom padding stays so tabs/header don't clip; sides go to zero. */
      main { max-width: none !important; padding-left: 0 !important; padding-right: 0 !important; }
    </style>
    <script>
      // Persist the active session-profile selection across tab navigation.
      // Without this, switching to Pump Templates / Triggers and back drops
      // back to the factory default because the URL no longer carries
      // ?profile= and no session is active to remember it server-side.
      (function() {
        try {
          const params = new URLSearchParams(location.search);
          if (!params.has('profile')) {
            const saved = localStorage.getItem('pd-last-profile');
            if (saved) location.replace(location.pathname + '?profile=' + encodeURIComponent(saved));
          }
        } catch {}
      })();
    </script>
    <h2>Launchpad <span class="muted" style="font-size:1rem">— <span id="lp-owner-name">${escape(ownerNameForTitle)}</span></span></h2>
    <script>document.title = 'PumpDirect — ' + ${JSON.stringify(ownerNameForTitle)};</script>

    ${state.active ? '' : `<div class="card">
      <h3>Session profile</h3>
      <p>
        <select id="sp-select" onchange="location.search='?profile=' + encodeURIComponent(this.value)" style="min-width:280px">
          ${profileOptions}
        </select>
        <button onclick="lpOpenSettings()">⚙ Settings</button>
        <button onclick="lpNewProfile()">+ New</button>
        ${profile.isFactory
          ? '<span class="pill warn">factory — cannot rename/delete</span>'
          : `<button onclick="lpRenameProfile()">Rename</button> <button onclick="lpDeleteProfile()">Delete</button>`}
      </p>
      <p style="display:flex;gap:18px;align-items:center;flex-wrap:wrap;margin-top:6px">
        <label style="display:flex;align-items:center;gap:6px">
          <strong>Pump template:</strong>
          <select id="lp-tpl-select" onchange="lpSetPumpTemplate(this.value)" style="min-width:200px">${templateOptions}</select>
        </label>
        <label style="display:flex;align-items:center;gap:6px">
          <strong>Trigger template:</strong>
          <select id="lp-trig-select" onchange="lpSetTriggerTemplate(this.value)" style="min-width:200px">${triggerTemplateOptions}</select>
        </label>
      </p>
    </div>`}

    <div id="session-stage" data-mode="${escape(profile.mode || 'single-target')}">
    ${profile.mode === 'dual-target' ? `
      <!-- ====== DUAL-TARGET LAYOUT ====== -->
      <!-- Session controls: one row, full width, applies to whole session. -->
      <div class="dual-controls-row">
        ${state.active
          ? `<button onclick="lpStop()" style="background:#7a3a3a">Stop</button>
             <button onclick="lpEstop()" style="background:#a13030;font-weight:700">E-STOP</button>
             <button onclick="lpTogglePause()" style="background:${state.paused ? '#2a6df4' : '#7a8597'};min-width:140px">${state.paused ? 'Exit Standby' : 'Enter Standby'}</button>`
          : `<button onclick="lpStart()" ${sessionReady ? '' : 'disabled'}>Start Session</button>`}
        ${state.active && state.introPending && profile.introButton?.enabled && profile.introButton?.target ? `
          <button id="lp-intro-btn" onclick="lpIntro()" style="background:#2a8a6d;color:#fff;font-weight:700">${escape(profile.introButton.text || 'Start Intro')}</button>` : ''}
        ${state.active && profile.customEndButton?.enabled && profile.customEndButton?.target ? `
          <button onclick="lpCustomEnd()" style="background:#7b3fd6;color:#fff;font-weight:700">${escape(profile.customEndButton.text || 'Custom End')}</button>` : ''}
        ${!state.active && !sessionReady ? `<span class="muted" style="font-size:0.85rem;align-self:center">${!calibratedReady ? 'Primary pump must be calibrated.' : 'Add at least one allowed user.'}</span>` : ''}
      </div>
      ${state.active && state.introPending ? `<p id="lp-intro-lock-note" class="muted" style="text-align:center;font-size:0.85rem;margin:6px 0 10px">Pump action panel locked until intro completes.</p>` : ''}

      ${state.active && state.mode === 'dual-target' && !((() => {
        const t = (state.participants || []).find(p => p.canTarget === true);
        return state.hostStartAccepted && state.targetStartAccepted && !!t;
      })()) ? `
        <div id="lp-consent-bar" class="dual-consent-bar">
          ${(() => {
            const t = (state.participants || []).find(p => p.canTarget === true);
            if (!t) return '<span class="status">⏳ Waiting for a target to pair…</span>';
            if (!state.hostStartAccepted && !state.targetStartAccepted) return '<span class="status">🤝 Both parties must confirm to begin</span>';
            if (!state.hostStartAccepted) return '<span class="status">🤝 Your turn — confirm to begin</span>';
            if (!state.targetStartAccepted) return '<span class="status">⏳ Waiting for target to confirm…</span>';
            return '';
          })()}
          ${!state.hostStartAccepted && (state.participants || []).some(p => p.canTarget === true) ? `<button onclick="lpConfirmStart()" class="consent-btn">✓ Confirm Start</button>` : ''}
          ${state.hostStartAccepted && !state.targetStartAccepted ? '<span class="muted">✓ You confirmed</span>' : ''}
        </div>` : ''}

      <!-- Cam-pair stack: each pair = wide cam tile + floating bare gauge on the right -->
      <div class="dual-cam-stack">
        <div class="cam-pair">
          <div class="cam-slot wide" id="cam-owner-slot">
            <div id="local-tile" class="cam-tile" style="display:grid;place-items:center;color:#7a8597;font-size:0.95rem">
              <button class="placeholder-cam-btn" onclick="lpToggleCam()">📹 Start camera</button>
            </div>
          </div>
          <div class="gauge-float gauge-host">
            <div class="gauge-name">🔵 ${escape(ownerNameForTitle)}</div>
            ${gauge(state.capacity)}
            <p class="pump-status ${state.pumpOn ? '' : 'idle'}" id="pump-status" style="margin:2px 0 0">
              <span class="pump-state">${state.pumpOn ? 'Running' : 'Idle'}</span><span class="pump-count" id="pump-count"></span>
            </p>
            <p class="cycle-status" id="cycle-status" style="margin:2px 0 0"></p>
            <button onclick="lpEditCapacity()" ${state.active ? '' : 'disabled'} class="set-cap-btn" title="Set host capacity">✎</button>
          </div>
        </div>
        <div class="cam-pair">
          <div class="cam-slot wide" id="cam-controller-slot"></div>
          <div class="gauge-float gauge-target" id="gauge-target">
            <div class="gauge-name">⚪ <span id="target-nickname">${(() => {
              const t = (state.participants || []).find(p => p.canTarget === true);
              const acct = t ? cfg.accounts.find(a => a.email === t.email) : null;
              return escape(acct?.nickname || (t ? t.email.split('@')[0] : 'Waiting…'));
            })()}</span></div>
            ${gauge(state.targetState?.capacity || 0)}
            <p class="pump-status ${state.targetState?.pumpOn ? '' : 'idle'}" id="target-pump-status" style="margin:2px 0 0">
              <span class="pump-state">${state.targetState?.pumpOn ? 'Running' : 'Idle'}</span>
            </p>
          </div>
        </div>
      </div>

      <!-- Compact milestone strip + A/B toggle + action grid -->
      <div class="card milestone-pane mini">
        <p class="milestone-welcome">${escape(profile.welcomeMessage || '(no welcome message)')}</p>
        <p class="milestone-title">${activeMilestone ? escape(activeMilestone.name) : (state.active ? escape(templateProfile?.name || 'Default') : 'Idle')}</p>
        <p class="milestone-announcement">${activeMilestone ? escape(activeMilestone.announcement || '') : ''}</p>
        <p class="muted" id="milestone-meta" style="font-size:0.88rem;margin:0 0 10px">
          ${state.active
            ? (activeMilestone ? `${activeMilestone.capacityMin}–${activeMilestone.capacityMax}% · milestone announcement live` : 'Welcome message — replaced when first milestone is reached')
            : 'Welcome message (visitors see this when no session is running)'}
          · <a href="#" onclick="lpEditWelcome();return false" style="color:#9aa4b2">edit welcome</a>
        </p>
        <!-- A/B toggle: picks which pump the next button press fires on. -->
        <div class="ab-toggle" id="ab-toggle" role="group" aria-label="Pump target">
          <button type="button" class="ab-btn ab-host active" data-ab="host" onclick="_setAbTarget('host')">🔵 ${escape(ownerNameForTitle)}</button>
          <button type="button" class="ab-btn ab-target" data-ab="target" onclick="_setAbTarget('target')" id="ab-btn-target">⚪ <span id="ab-target-label">${(() => {
            const t = (state.participants || []).find(p => p.canTarget === true);
            const acct = t ? cfg.accounts.find(a => a.email === t.email) : null;
            return escape(acct?.nickname || (t ? t.email.split('@')[0] : 'Waiting…'));
          })()}</span></button>
        </div>
        <div class="action-grid">${actionButtons}</div>
      </div>

      <div id="trigger-fx-stage"></div>
      <div id="action-flash-stage"></div>
    ` : `
      <!-- ====== SINGLE-TARGET LAYOUT — 3-COLUMN ====== -->
      <!-- Top card: session name / welcome / current milestone announcement only -->
      <div class="card milestone-pane" id="lp-top-card">
        <p class="milestone-welcome">${escape(profile.welcomeMessage || '(no welcome message)')}</p>
        <p class="milestone-announcement">${activeMilestone ? escape(activeMilestone.announcement || '') : ''}</p>
        <p class="muted" id="milestone-meta" style="font-size:0.9rem;margin:0">
          ${state.active
            ? (activeMilestone ? `${activeMilestone.capacityMin}–${activeMilestone.capacityMax}% · milestone announcement live` : 'Welcome message — replaced when first milestone is reached')
            : 'Welcome message (visitors see this when no session is running)'}
          · <a href="#" onclick="lpEditWelcome();return false" style="color:#9aa4b2">edit welcome</a>
        </p>
      </div>

      <div class="lp-grid">
        <!-- LEFT: session controls (stacked) then gauge cluster -->
        <div class="card lp-col-left">
          <div class="session-controls" id="lp-session-controls">
            ${state.active
              ? `<button onclick="lpTogglePause()" style="background:${state.paused ? '#2a6df4' : '#7a8597'}">${state.paused ? '▶ Exit Standby' : '⏸ Enter Standby'}</button>
                 <button onclick="lpStop()" style="background:#7a3a3a">⏹ Stop Session</button>
                 <button onclick="lpEstop()" style="background:#a13030;font-weight:700">⛔ E-STOP</button>`
              : `<button onclick="lpStart()" ${sessionReady ? '' : 'disabled'}>▶ Start Session</button>`}
            ${state.active && state.introPending && profile.introButton?.enabled && profile.introButton?.target ? `
              <button id="lp-intro-row" onclick="lpIntro()" style="background:#2a8a6d;color:#fff;font-weight:700">${escape(profile.introButton.text || 'Start Intro')}</button>` : ''}
            ${state.active && profile.customEndButton?.enabled && profile.customEndButton?.target ? `
              <button onclick="lpCustomEnd()" style="background:#7b3fd6;color:#fff;font-weight:700">${escape(profile.customEndButton.text || 'Custom End')}</button>` : ''}
          </div>
          ${state.active && state.introPending ? `
            <p id="lp-intro-lock-note" class="muted" style="margin:8px 0 0;font-size:0.82rem;text-align:center;line-height:1.3">Pump action panel locked until intro completes.</p>` : ''}
          ${!state.active && !sessionReady ? `<p class="muted" style="font-size:0.85rem;margin:8px 0 0">${!calibratedReady ? 'Primary pump must be calibrated.' : 'Add at least one allowed user.'}</p>` : ''}

          <div class="session-divider"></div>

          <div class="lp-gauge-wrap">
            <h3 style="margin:0 0 2px;font-size:1rem;text-align:center">Capacity</h3>
            <p class="muted" style="margin:0 0 6px;font-size:0.78rem;text-align:center;line-height:1.3"><strong>${escape(ownerNameForTitle)}</strong>'s fullness</p>
            ${gauge(state.capacity)}
            <p style="margin:4px 0 0">
              <button onclick="lpEditCapacity()" ${state.active ? '' : 'disabled'} style="background:#2a2f3a;padding:4px 10px;font-size:0.82rem">✎ Set capacity</button>
            </p>
            <p class="pump-status ${state.pumpOn ? '' : 'idle'}" id="pump-status" style="margin:6px 0 0;font-size:0.95rem;text-align:center">
              Pump: <span class="pump-state">${state.pumpOn ? 'Running' : 'Idle'}</span><span class="pump-count" id="pump-count"></span>
            </p>
            <p class="cycle-status" id="cycle-status" style="margin:2px 0 0;text-align:center"></p>
          </div>
        </div>

        <!-- CENTER: cam grid (chat-row sits below the whole lp-grid) -->
        <div class="lp-col-center">
          <div class="cam-grid">
            <div class="cam-slot" id="cam-controller-slot"></div>
            <div class="cam-slot" id="cam-owner-slot" style="--cam-aspect:${ownerCamAspectStr}">
              <div id="local-tile" class="cam-tile" style="--cam-aspect:${ownerCamAspectStr};display:grid;place-items:center;color:#7a8597;font-size:0.95rem">
                <button class="placeholder-cam-btn" onclick="lpToggleCam()">📹 Start camera</button>
              </div>
            </div>
            <div id="trigger-fx-stage"></div>
            <div id="action-flash-stage"></div>
          </div>
        </div>

        <!-- RIGHT: milestone name + range + action buttons (stacked vertically) -->
        <div class="card lp-col-right milestone-pane">
          <p class="lp-milestone-title" id="lp-milestone-title">${activeMilestone ? escape(activeMilestone.name) : (state.active ? escape(templateProfile?.name || 'Default') : 'Idle')}</p>
          <p class="lp-milestone-range" id="lp-milestone-range">${state.active
            ? (activeMilestone
                ? (activeMilestone.is100Plus ? '100%+' : `${activeMilestone.capacityMin}%–${activeMilestone.capacityMax}%`)
                : '(no active milestone)')
            : '(idle)'}</p>
          <div class="action-list action-grid">${actionButtons}</div>
        </div>
      </div>
    `}
    <div id="overlay-stage"></div>
    <div id="countdown-stage"></div>
    </div><!-- /session-stage -->

    <div class="chat-row">
      <div class="card chat-pane">
        <h3 style="margin:0 0 12px;display:flex;align-items:center;gap:10px">
          <span>Chat ${profile.settings.chatroomEnabled ? '' : '<span class="muted" style="font-size:0.9rem;font-weight:normal">(disabled for visitors in this profile)</span>'}</span>
          <span id="chat-presence-line" class="muted" style="margin-left:auto;font-size:0.85rem;font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px"></span>
        </h3>
        <div id="chat-log" class="chat-log"></div>
        <div class="chat-input-row">
          <input id="chat-input" type="text" placeholder="say something…" onkeydown="if(event.key==='Enter') lpSendChat()">
          <button onclick="lpSendChat()">Send</button>
        </div>
      </div>
      <div class="card participants-pane">
        <h3 style="margin:0 0 12px;display:flex;align-items:center;gap:8px">
          <span>Participants <span class="muted" style="font-size:0.85rem;font-weight:normal">(${profile.allowedParticipants.filter(p => p.email !== ownerEmailLp).length})</span></span>
          <button onclick="lpOpenAddParticipantModal()" title="${ineligible.length ? 'Add participant from accounts' : 'All accounts already added'}" ${ineligible.length ? '' : 'disabled'} style="margin-left:auto;background:#2a6df4;color:#fff;border:0;border-radius:6px;width:28px;height:28px;padding:0;font-size:1.1rem;line-height:1;cursor:pointer">+</button>
        </h3>
        <div class="p-list">
          ${profile.allowedParticipants.filter(p => p.email !== ownerEmailLp).length
            ? profile.allowedParticipants.filter(p => p.email !== ownerEmailLp).map(p => {
                const nick = cfg.accounts.find(a => a.email === p.email)?.nickname || p.email.split('@')[0];
                const icons =
                  (p.canControl ? '<span title="action control">🔧</span>' : '') +
                  (p.canBroadcast ? '<span title="video broadcast">🎥</span>' : '') +
                  (p.canChat !== false ? '<span title="chat">💬</span>' : '') +
                  (p.canTarget ? '<span title="target (dual mode)">🎯</span>' : '');
                return `
              <div class="p-item" data-email="${escape(p.email)}">
                <span class="presence-dot"></span>
                <span class="p-name">${escape(nick)}</span>
                <span class="p-perm-icons" data-perm-icons="${escape(p.email)}">${icons}</span>
                <span class="p-flags" style="margin-left:auto">
                  <button title="permissions" onclick="lpOpenPermsMenu('${escape(p.email)}', this)" style="background:#2a2f3a;padding:2px 10px;font-size:1rem;line-height:1">≡</button>
                  <button title="remove" onclick="lpRemoveParticipant('${escape(p.email)}')" style="background:#4a1b1b;padding:2px 8px;font-size:0.85rem">×</button>
                </span>
              </div>`;
              }).join('')
            : '<p class="muted" style="font-size:0.95rem">No participants yet.</p>'}
        </div>
        ${ineligible.length ? '' : '<p class="muted" style="font-size:0.85rem;margin-top:12px">All accounts already added. Manage on Users tab.</p>'}
        <div class="p-legend" style="padding-top:12px;border-top:1px solid var(--border);margin-top:12px">
          <p class="muted" style="font-size:0.75rem">🔧 action control · 🎥 video broadcast · 💬 chat${profile.mode === 'dual-target' ? ' · 🎯 target' : ''}</p>
          <p class="muted" style="font-size:0.75rem"><span class="presence-dot" style="display:inline-block;vertical-align:middle"></span> invited &nbsp;<span class="presence-dot online" style="display:inline-block;vertical-align:middle"></span> in session &nbsp;<span class="presence-dot afk" style="display:inline-block;vertical-align:middle"></span> afk</p>
        </div>
      </div>
    </div>

    <!-- modal -->
    <div id="modal-bg" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center">
      <div id="modal" style="background:#161922;border:1px solid #2a2f3a;border-radius:10px;padding:32px;max-width:640px;width:90%;max-height:90vh;overflow:auto">
        <h2 id="modal-title">Edit</h2>
        <div id="modal-body"></div>
        <p style="margin-top:24px;text-align:right">
          <button onclick="modalClose()" style="background:#2a2f3a">Cancel</button>
          <button id="modal-save" onclick="modalSave()">Save</button>
        </p>
      </div>
    </div>

    <div id="lp-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px;z-index:1100"></div>

    <style>${overlayCss()}</style>
    <script src="/assets/vendor/lottie.min.js"></script>
    <script>
      ${rtcClientJs({ myEmail: cfg.cloudflare?.ownerEmail || 'owner@local' })}
      ${chatCryptoJs()}
      ${camPipelineJs()}
      ${overlayJs()}
    </script>
    <script>
      const OWNER_CAM_MODE = ${JSON.stringify(cfg.owner?.camera?.mode || 'off')};
      // Globals consumed by views/overlay.js for Spin-button visibility + the
      // POST endpoint when the trigger user confirms the spin.
      window.__MY_EMAIL = ${JSON.stringify(cfg.cloudflare?.ownerEmail || 'owner@local')};
      window.__OWNER_EMAIL = ${JSON.stringify(cfg.cloudflare?.ownerEmail || 'owner@local')};
      window.__CHAT_COLORS = ${JSON.stringify(Object.assign({ host: '#6ddc9b', controller: '#6db4ff', voyeur: '#f08484' }, cfg.chat?.nameColors || {}))};
      function __chatNameColorFor(fromEmail) {
        const c = window.__CHAT_COLORS;
        if (fromEmail === window.__OWNER_EMAIL) return c.host;
        const s = window.__lastState || {};
        const p = (s.participants || []).find(x => x.email === fromEmail);
        if (p && p.canControl) return c.controller;
        return c.voyeur;
      }
      // Where the text-overlay stage gets hung. On Launchpad it's the owner's
      // own local cam tile — the same element that visitors see streamed.
      window.__textOverlayTarget = () => document.getElementById('local-tile');
      const PROFILE_ID = ${JSON.stringify(profile.id)};
      // In single-target mode the layout is a 3-column grid (left sidebar /
      // center cams+chat / right sidebar). The chat-row HTML is rendered once
      // below the session-stage; move it into the center column so the side
      // columns visually extend from top-of-cams down to bottom-of-chat.
      (function () {
        const center = document.querySelector('.lp-col-center');
        const chat = document.querySelector('main > .chat-row');
        if (center && chat) center.appendChild(chat);
      })();
      const PROFILE_IS_FACTORY = ${JSON.stringify(!!profile.isFactory)};
      // Persist the actual rendered profile id so a stale ?profile= or a
      // deleted profile in localStorage gets corrected to what the server
      // landed on. Tab nav reads this back via the redirect script above.
      try { localStorage.setItem('pd-last-profile', PROFILE_ID); } catch {}
      const TEMPLATE_OPTIONS = ${JSON.stringify(templates.templateProfiles.map(p => ({ id: p.id, name: p.name })))};
      const ACTIONS_INFO = ${JSON.stringify(Object.fromEntries(templates.actionTemplates.map(a => [a.id, { name: a.name, description: a.description || '' }])))};
      const MINIGAMES_INFO = ${JSON.stringify(Object.fromEntries(minigames.list().map(m => [m.id, { name: m.name, kind: m.kind, color: m.color, description: m.description || '' }])))};
      const MILESTONES_BY_ID = ${JSON.stringify(Object.fromEntries((templateProfile?.milestones || []).map(m => [m.id, { name: m.name, announcement: m.announcement || '', actionTemplateIds: m.actionTemplateIds || [], minigameIds: m.minigameIds || [], minigameConfig: m.minigameConfig || {}, capacityMin: m.capacityMin, capacityMax: m.capacityMax, is100Plus: !!m.is100Plus }])))};
      const ALWAYS_ACTION_IDS = ${JSON.stringify(templateProfile?.defaultActionTemplateIds || [])};
      const ALWAYS_MINIGAME_IDS = ${JSON.stringify(templateProfile?.defaultMinigameIds || [])};
      const ALWAYS_MINIGAME_CONFIG = ${JSON.stringify(templateProfile?.defaultMinigameConfig || {})};
      const WHEELS_BY_ID = ${JSON.stringify(Object.fromEntries(templates.wheelTemplates?.map(w => [w.id, { name: w.name, sectionCount: (w.sections || []).length }]) || []))};
      function _mergedWheelIdsForActive() {
        // Wheel IDs available at the currently-active milestone's Prize Wheel
        // button = union of always-available + active-milestone wheelIds.
        const m = _activeMilestone((window.__lastState && window.__lastState.capacity) || 0, !!(window.__lastState && window.__lastState.active));
        const ms = m ? (m.minigameConfig?.['prize-wheel']?.wheelIds || []) : [];
        const al = ALWAYS_MINIGAME_CONFIG['prize-wheel']?.wheelIds || [];
        return Array.from(new Set([...ms, ...al]));
      }
      const TPL_NAME = ${JSON.stringify(templateProfile?.name || 'Default')};
      const WELCOME_MSG = ${JSON.stringify(profile.welcomeMessage || '')};
      let __lastRenderedMilestoneId = '__init__';
      function _safeAttr(s) { return String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
      function _activeMilestone(capacity, active) {
        if (!active) return null;
        const ms = Object.entries(MILESTONES_BY_ID).map(([id, m]) => ({ id, ...m }));
        if (capacity >= 100) { const top = ms.find(m => m.is100Plus); if (top) return top; }
        const cands = ms.filter(m => !m.is100Plus && capacity >= m.capacityMin && capacity <= m.capacityMax)
                        .sort((a, b) => b.capacityMin - a.capacityMin);
        return cands[0] || null;
      }
      function renderMilestonePane(s) {
        // Re-render milestone-pane (title + announcement + meta + action grid) when the
        // active milestone changes. Computed client-side from capacity so this stays in
        // sync even before the server's first capacity-tick of a new session.
        const m = _activeMilestone(s.capacity || 0, !!s.active);
        const mid = m ? m.id : (s.active ? '__no_milestone__' : '__idle__');
        if (__lastRenderedMilestoneId === mid) return;
        __lastRenderedMilestoneId = mid;
        // Single-target layout splits things across the new 3-column lp-grid:
        // milestone TITLE + range live in the right column (.lp-milestone-title /
        // .lp-milestone-range), the welcome + announcement + meta live in the
        // top card (.milestone-welcome / .milestone-announcement / #milestone-meta).
        // Dual-target falls back to the legacy single .milestone-title selector.
        const titleEl = document.getElementById('lp-milestone-title')
          || document.querySelector('.milestone-pane .milestone-title');
        const rangeEl = document.getElementById('lp-milestone-range');
        const wmEl = document.querySelector('.milestone-pane .milestone-welcome');
        const annEl = document.querySelector('.milestone-pane .milestone-announcement');
        const metaEl = document.getElementById('milestone-meta');
        if (titleEl) titleEl.textContent = m ? m.name : (s.active ? TPL_NAME : 'Idle');
        if (rangeEl) rangeEl.textContent = s.active
          ? (m ? (m.is100Plus ? '100%+' : (m.capacityMin + '%–' + m.capacityMax + '%')) : '(no active milestone)')
          : '(idle)';
        if (wmEl) wmEl.textContent = WELCOME_MSG || '(no welcome message)';
        if (annEl) annEl.textContent = (m && m.announcement) ? m.announcement : '';
        if (metaEl) {
          const inner = s.active
            ? (m ? (m.is100Plus ? '100%+ · milestone announcement live' : (m.capacityMin + '–' + m.capacityMax + '% · milestone announcement live')) : 'Welcome message — replaced when first milestone is reached')
            : 'Welcome message (visitors see this when no session is running)';
          metaEl.innerHTML = _safeAttr(inner) + ' · <a href="#" onclick="lpEditWelcome();return false" style="color:#9aa4b2">edit welcome</a>';
        }
        const grid = document.querySelector('.lp-col-right .action-list')
          || document.querySelector('.milestone-pane .action-grid');
        if (!grid) return;
        if (!s.active) { grid.innerHTML = '<p class="muted">Start a session to enable actions.</p>'; return; }
        const ids = Array.from(new Set([...((m && m.actionTemplateIds) || []), ...ALWAYS_ACTION_IDS]));
        const running = !!s.currentActionTemplateId;
        const alwaysBtns =
          '<button class="action-btn pump-toggle" onclick="lpPumpToggle()" style="background:' + (running ? '#a13030' : '#1a8a4d') + ';color:#fff">' + (running ? '⏻ Pump Off' : '⏵ Pump On') + '</button>'
        + '<button class="action-btn misc-action-btn" onclick="lpTimed()" style="background:#1a8a4d;color:#fff"' + (running ? ' disabled' : '') + '>⏱ Timed</button>'
        + '<button class="action-btn misc-action-btn" onclick="lpCycle()" style="background:#1a8a4d;color:#fff"' + (running ? ' disabled' : '') + '>↻ Cycle</button>';
        const actionCells = ids.map(id => {
          const a = ACTIONS_INFO[id];
          return '<div class="action-cell">'
            + '<button class="action-btn" data-action-id="' + _safeAttr(id) + '" onclick="lpFireAction(\\'' + _safeAttr(id) + '\\')">' + _safeAttr(a && a.name || '?') + '</button>'
            + '<button class="action-help-btn" type="button" title="What does this do?" onclick="lpActionHelp(\\'' + _safeAttr(id) + '\\')">?</button>'
          + '</div>';
        }).join('');
        const mgIds = Array.from(new Set([...((m && m.minigameIds) || []), ...ALWAYS_MINIGAME_IDS]));
        const mgCells = mgIds.map(id => {
          const mg = MINIGAMES_INFO[id];
          if (!mg) return '';
          return '<div class="action-cell">'
            + '<button class="action-btn minigame-btn" data-minigame-id="' + _safeAttr(id) + '" onclick="lpOpenMinigame(\\'' + _safeAttr(id) + '\\')" style="background:' + _safeAttr(mg.color) + ';color:#fff">🎲 ' + _safeAttr(mg.name) + '</button>'
            + '<button class="action-help-btn" type="button" title="What does this do?" onclick="lpMinigameHelp(\\'' + _safeAttr(id) + '\\')">?</button>'
          + '</div>';
        }).join('');
        grid.innerHTML = alwaysBtns + (actionCells || mgCells
          ? actionCells + mgCells
          : '<p class="muted" style="grid-column:1/-1">No template actions or minigames for this milestone — use Pump On / Timed / Cycle above.</p>');
      }
      function lpMinigameHelp(id) {
        const mg = MINIGAMES_INFO[id]; if (!mg) return;
        modalOpen(mg.name, '<p style="font-size:1.05rem;line-height:1.5;margin:0">' + _safeAttr(mg.description || 'No description set for this minigame yet.') + '</p>', null);
      }
      function lpOpenMinigame(id) {
        const mg = MINIGAMES_INFO[id]; if (!mg) return;
        if (mg.kind === 'dice-roll') return lpOpenDiceRoll();
        if (mg.kind === 'prize-wheel') return lpOpenPrizeWheel();
        flash('Unsupported minigame: ' + mg.name, 'bad');
      }
      async function lpOpenPrizeWheel() {
        // The server picks ONE wheel at random from the candidate list — the
        // spinner never gets to choose which wheel comes up.
        const ids = _mergedWheelIdsForActive().filter(id => WHEELS_BY_ID[id]);
        if (!ids.length) return flash('No wheels assigned to this button — set them on the milestone.', 'bad');
        const r = await fetch('/api/minigame/prize-wheel', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ wheelIds: ids }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
      }
      function lpOpenDiceRoll() {
        modalOpen('🎲 Dice Roll',
          '<p style="margin:0 0 14px">Roll d6 dice. The total pips drive the pump.</p>'
          + '<p><label>Number of dice (1–6): <input id="m-dice-count" type="number" min="1" max="6" value="2" style="width:80px"></label></p>'
          + '<p style="margin-top:14px"><label style="display:block;margin-bottom:6px">Result mode</label>'
          + '  <label style="display:block;padding:4px 0"><input type="radio" name="m-mode" value="continuous" checked> Continuous — pump on for <em>total pips</em> seconds</label>'
          + '  <label style="display:block;padding:4px 0"><input type="radio" name="m-mode" value="cycle"> Cycle — <em>total pips</em> × (1 sec on / 1 sec off)</label>'
          + '</p>',
          async () => {
            const count = parseInt(document.getElementById('m-dice-count').value, 10);
            const mode = (document.querySelector('input[name="m-mode"]:checked') || {}).value || 'continuous';
            const r = await fetch('/api/minigame/dice-roll', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ count, mode }) });
            const d = await r.json();
            if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
            modalClose();
          });
      }
      function lpActionHelp(id) {
        const a = ACTIONS_INFO[id];
        if (!a) return;
        const safe = (s) => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
        const body = a.description
          ? '<p style="font-size:1.05rem;line-height:1.5;margin:0">' + safe(a.description) + '</p>'
          : '<p class="muted" style="margin:0">No description set for this action yet. Edit it on the Templates page.</p>';
        modalOpen(a.name, body, null);
      }
      let modalSaveFn = null;
      function flash(msg, cls) {
        const el = document.getElementById('lp-msg');
        el.innerHTML = '<div class="card" style="margin:0;border-color:' + (cls === 'bad' ? '#f08484' : cls === 'ok' ? '#6ddc9b' : '#f0c674') + '">' + msg + '</div>';
        setTimeout(() => { el.innerHTML = ''; }, 4000);
      }
      function modalOpen(title, html, onSave) {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = html;
        modalSaveFn = onSave;
        const save = document.getElementById('modal-save');
        if (save) save.style.display = onSave ? '' : 'none';
        document.getElementById('modal-bg').style.display = 'flex';
      }
      function modalClose() { document.getElementById('modal-bg').style.display = 'none'; modalSaveFn = null; }
      async function modalSave() { if (modalSaveFn) { try { await modalSaveFn(); } catch (e) { flash(e.message, 'bad'); } } }

      // ---- profile CRUD ----
      function lpNewProfile() {
        modalOpen('New session profile', '<p><label>Name <input id="m-name" type="text" placeholder="e.g. Friday Night"></label></p>', async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/launchpad/profiles', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ name }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.search = '?profile=' + encodeURIComponent(d.profile.id);
        });
      }
      function lpRenameProfile() {
        if (PROFILE_IS_FACTORY) return flash('factory profile cannot be renamed', 'bad');
        modalOpen('Rename profile', '<p><label>Name <input id="m-name" type="text"></label></p>', async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ name }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
      }
      async function lpDeleteProfile() {
        if (PROFILE_IS_FACTORY) return flash('factory profile cannot be deleted', 'bad');
        if (!confirm('Delete this session profile?')) return;
        const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.search = '';
      }

      function lpOpenSettings() {
        Promise.all([
          fetch('/api/launchpad/profiles/' + PROFILE_ID).then(r => r.json()),
          fetch('/api/triggers/templates').then(r => r.json()).catch(() => ({ templates: [] })),
          fetch('/api/triggers/actions').then(r => r.json()).catch(() => ({ actions: [] })),
          fetch('/api/triggers/groups').then(r => r.json()).catch(() => ({ groups: [] })),
        ]).then(([d, trigData, taData, tgData]) => {
          const p = d.profile;
          const tplOptions = TEMPLATE_OPTIONS.map(o => '<option value="' + o.id + '"' + (o.id === p.templateProfileId ? ' selected' : '') + '>' + o.name + '</option>').join('');
          const triggerOptions = '<option value=""' + (!p.triggerTemplateId ? ' selected' : '') + '>(none)</option>'
            + (trigData.templates || []).map(t => '<option value="' + t.id + '"' + (t.id === p.triggerTemplateId ? ' selected' : '') + '>' + t.name + '</option>').join('');
          const ceb = p.customEndButton || { enabled: false, text: '', target: null };
          const ib  = p.introButton    || { enabled: false, text: '', target: null };
          const buildTargetOpts = (sel) => '<optgroup label="Trigger Actions">'
            + (taData.actions || []).map(a => '<option value="action:' + a.id + '"' + (sel?.kind === 'action' && sel?.id === a.id ? ' selected' : '') + '>🎯 ' + a.name + '</option>').join('')
            + '</optgroup><optgroup label="Trigger Action Groups">'
            + (tgData.groups || []).map(g => '<option value="group:' + g.id + '"' + (sel?.kind === 'group' && sel?.id === g.id ? ' selected' : '') + '>📦 ' + g.name + '</option>').join('')
            + '</optgroup>';
          const cebTargetOpts = buildTargetOpts(ceb.target);
          const ibTargetOpts  = buildTargetOpts(ib.target);
          const mode = p.mode === 'dual-target' ? 'dual-target' : 'single-target';
          const allowControllersInDual = !!p.settings?.allowVisitorControllersInDual;
          modalOpen('Settings — ' + p.name, ''
            + '<p><label>Pump template <select id="m-tpl">' + tplOptions + '</select></label></p>'
            + '<p><label>Trigger template <select id="m-trig">' + triggerOptions + '</select></label></p>'
            + '<div style="margin:10px 0;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-3)">'
            +   '<div style="font-weight:600;margin-bottom:4px">Session mode</div>'
            +   '<label style="display:block;margin-bottom:4px"><input type="radio" name="m-mode" value="single-target"' + (mode === 'single-target' ? ' checked' : '') + ' onchange="document.getElementById(\\'m-mode-allow-row\\').style.display = this.checked ? \\'none\\' : \\'block\\'"> <strong>Single Target</strong> — Host (you) + up to 5 guests. Controllers fire on your pump.</label>'
            +   '<label style="display:block"><input type="radio" name="m-mode" value="dual-target"' + (mode === 'dual-target' ? ' checked' : '') + ' onchange="document.getElementById(\\'m-mode-allow-row\\').style.display = this.checked ? \\'block\\' : \\'none\\'"> <strong>Dual Target</strong> — Host + 1 target guest + 4 guests. Target runs PumpDirect locally; A/B toggle picks which pump to fire on.</label>'
            +   '<div id="m-mode-allow-row" style="display:' + (mode === 'dual-target' ? 'block' : 'none') + ';margin-top:8px;margin-left:22px">'
            +     '<label><input type="checkbox" id="m-allow-vc-dual"' + (allowControllersInDual ? ' checked' : '') + '> Allow visitor controllers in dual mode</label>'
            +     '<div class="muted" style="font-size:0.85rem;margin-top:2px">When ticked, any visitor with the <strong>A</strong> flag also gets the A/B toggle and can fire on either pump.</div>'
            +   '</div>'
            + '</div>'
            + '<p><label><input type="checkbox" id="m-chat"' + (p.settings.chatroomEnabled ? ' checked' : '') + '> Enable chatroom</label></p>'
            + '<p><label><input type="checkbox" id="m-d100"' + (p.settings.disableControlAt100 ? ' checked' : '') + '> Disable device control at 100% capacity</label></p>'
            + '<p style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
            +   '<label><input type="checkbox" id="m-ib-en"' + (ib.enabled ? ' checked' : '') + ' onchange="document.getElementById(\\'m-ib-rows\\').style.display = this.checked ? \\'block\\' : \\'none\\'"> Enable Session Intro Button</label>'
            +   '<span class="muted" style="font-size:0.85rem">(Pump Action Control Panel is disabled on Session start and enabled as soon as the intro trigger completes.)</span>'
            + '</p>'
            + '<div id="m-ib-rows" style="display:' + (ib.enabled ? 'block' : 'none') + ';margin-left:22px;padding-left:10px;border-left:2px solid var(--border)">'
            +   '<p><label>Button Text <input type="text" id="m-ib-text" value="' + (ib.text || '').replace(/"/g, '&quot;') + '" placeholder="e.g. Start Intro" style="width:100%"></label></p>'
            +   '<p><label>Trigger or Group <select id="m-ib-target" style="min-width:280px">' + ibTargetOpts + '</select></label></p>'
            +   '<p class="muted" style="font-size:0.85rem;margin:4px 0 0">Appears above the Custom End button on Launchpad. Fires the chosen trigger sequence; the action grid unlocks once it completes.</p>'
            + '</div>'
            + '<p><label><input type="checkbox" id="m-ceb-en"' + (ceb.enabled ? ' checked' : '') + ' onchange="document.getElementById(\\'m-ceb-rows\\').style.display = this.checked ? \\'block\\' : \\'none\\'"> Enable Custom Session End Button</label></p>'
            + '<div id="m-ceb-rows" style="display:' + (ceb.enabled ? 'block' : 'none') + ';margin-left:22px;padding-left:10px;border-left:2px solid var(--border)">'
            +   '<p><label>Button Text <input type="text" id="m-ceb-text" value="' + (ceb.text || '').replace(/"/g, '&quot;') + '" placeholder="e.g. Burst &amp; Wrap" style="width:100%"></label></p>'
            +   '<p><label>Trigger or Group <select id="m-ceb-target" style="min-width:280px">' + cebTargetOpts + '</select></label></p>'
            +   '<p class="muted" style="font-size:0.85rem;margin:4px 0 0">Appears below the Stop / E-STOP / Standby cluster on Launchpad. Fires the chosen trigger sequence — include an <code>end-session</code> sub-action in it if you want it to also end the session.</p>'
            + '</div>'
            + '<div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border)">'
            +   '<label style="display:block;margin-bottom:4px;font-weight:600">About me / Rules</label>'
            +   '<p class="muted" style="font-size:0.85rem;margin:0 0 6px">Shown on the mobile visitor screen below the chat input — use for your bio, session rules, safe-words, anything they should keep visible.</p>'
            +   '<textarea id="m-aboutme" rows="6" style="width:100%;font-family:inherit;resize:vertical" placeholder="e.g. 18+ adults only. Yellow flag = ease up. Red flag = full stop. ...">' + (p.aboutMe || '').replace(/</g, '&lt;') + '</textarea>'
            + '</div>',
            async () => {
              const ibEnabled = document.getElementById('m-ib-en').checked;
              let ibTarget = null;
              if (ibEnabled) {
                const t = document.getElementById('m-ib-target').value || '';
                const [kind, id] = t.split(':');
                if (id) ibTarget = { kind, id };
              }
              const cebEnabled = document.getElementById('m-ceb-en').checked;
              let cebTarget = null;
              if (cebEnabled) {
                const t = document.getElementById('m-ceb-target').value || '';
                const [kind, id] = t.split(':');
                if (id) cebTarget = { kind, id };
              }
              const modeSel = document.querySelector('input[name="m-mode"]:checked');
              const newMode = modeSel ? modeSel.value : 'single-target';
              const body = {
                templateProfileId: document.getElementById('m-tpl').value,
                triggerTemplateId: document.getElementById('m-trig').value || null,
                mode: newMode,
                settings: {
                  chatroomEnabled: document.getElementById('m-chat').checked,
                  disableControlAt100: document.getElementById('m-d100').checked,
                  allowVisitorControllersInDual: document.getElementById('m-allow-vc-dual').checked,
                },
                introButton: {
                  enabled: ibEnabled,
                  text: document.getElementById('m-ib-text').value || '',
                  target: ibTarget,
                },
                customEndButton: {
                  enabled: cebEnabled,
                  text: document.getElementById('m-ceb-text').value || '',
                  target: cebTarget,
                },
                aboutMe: document.getElementById('m-aboutme').value || '',
              };
              const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
              const d2 = await r.json();
              if (!r.ok || d2.error) return flash(d2.error || 'failed', 'bad');
              location.reload();
            });
        });
      }
      function lpEditWelcome() {
        fetch('/api/launchpad/profiles/' + PROFILE_ID).then(r => r.json()).then(d => {
          modalOpen('Welcome message', '<p><label>Shown on visitor screens when no session is running, and before the first milestone announcement during a session.</label></p>'
            + '<p><textarea id="m-wm" rows="6" style="width:100%;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:6px;padding:10px">' + (d.profile.welcomeMessage || '') + '</textarea></p>',
            async () => {
              const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ welcomeMessage: document.getElementById('m-wm').value }) });
              const d2 = await r.json();
              if (!r.ok || d2.error) return flash(d2.error || 'failed', 'bad');
              location.reload();
            });
        });
      }

      // ---- session controls ----
      async function lpStart() {
        const r = await fetch('/api/launchpad/session/start', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ profileId: PROFILE_ID }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('session started', 'ok');
        setTimeout(() => location.reload(), 400);
      }
      async function lpStop() {
        if (!confirm('Stop the current session?')) return;
        const r = await fetch('/api/launchpad/session/stop', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('session stopped', 'ok');
        setTimeout(() => location.reload(), 400);
      }
      async function lpEstop() {
        if (!confirm('E-STOP: cuts all pumps, freezes capacity, blocks actions. Visitors stay connected. You then click Stop to end. Continue?')) return;
        const r = await fetch('/api/launchpad/session/estop', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('E-STOP triggered', 'ok');
        setTimeout(() => location.reload(), 400);
      }
      async function lpTogglePause() {
        const r = await fetch('/api/launchpad/session/pause', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.reload();
      }
      async function lpCustomEnd() {
        if (!confirm('Fire the custom end-session button?')) return;
        const r = await fetch('/api/launchpad/session/custom-end', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
      }
      async function lpSetPumpTemplate(id) {
        const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID, {
          method: 'PATCH', headers: {'content-type':'application/json'},
          body: JSON.stringify({ templateProfileId: id }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('pump template updated', 'ok');
        setTimeout(() => location.reload(), 300);
      }
      async function lpSetTriggerTemplate(id) {
        const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID, {
          method: 'PATCH', headers: {'content-type':'application/json'},
          body: JSON.stringify({ triggerTemplateId: id || null }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('trigger template updated', 'ok');
        setTimeout(() => location.reload(), 300);
      }
      async function lpConfirmStart() {
        const r = await fetch('/api/launchpad/session/accept-start', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('confirmed', 'ok');
      }
      async function lpIntro() {
        const r = await fetch('/api/launchpad/session/intro', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('intro running…', 'ok');
      }
      // A/B toggle state — picks which pump the next button press fires on.
      // Per-tab via sessionStorage so the host's view and a 2nd tab don't
      // share the same selection. Default to 'host'.
      function _abTarget() {
        try { return sessionStorage.getItem('pd-ab-target') === 'target' ? 'target' : 'host'; } catch { return 'host'; }
      }
      function _setAbTarget(v) {
        const next = v === 'target' ? 'target' : 'host';
        try { sessionStorage.setItem('pd-ab-target', next); } catch {}
        document.querySelectorAll('.ab-toggle .ab-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.ab === next);
        });
      }
      // Init: paint the saved selection on every load.
      window.addEventListener('DOMContentLoaded', () => _setAbTarget(_abTarget()));

      async function lpFireAction(actionId) {
        const r = await fetch('/api/launchpad/session/fire-action', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ actionTemplateId: actionId, target: _abTarget() }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
      }
      async function lpPumpOff() {
        const r = await fetch('/api/launchpad/session/pump-off', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ target: _abTarget() }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
      }
      async function lpPumpOn() {
        const r = await fetch('/api/launchpad/session/pump-on', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ target: _abTarget() }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
      }
      function lpPumpToggle() {
        // In dual mode, the "running" flag we check has to reflect the chosen
        // pump. For host pump: state.currentActionTemplateId. For target pump:
        // state.targetState.currentActionTemplateId once step 9 wires relay.
        const s = window.__lastState || {};
        const ab = _abTarget();
        const running = ab === 'target'
          ? !!(s.targetState && s.targetState.currentActionTemplateId)
          : !!s.currentActionTemplateId;
        if (running) lpPumpOff(); else lpPumpOn();
      }
      function lpTimed() {
        modalOpen('Timed pump on', '<p><label>Duration (seconds) <input id="m-sec" type="number" min="0.1" step="0.1" value="10" autofocus></label></p>',
          async () => {
            const seconds = parseFloat(document.getElementById('m-sec').value);
            const r = await fetch('/api/launchpad/session/timed', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ seconds, target: _abTarget() }) });
            const d = await r.json();
            if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
            modalClose();
          });
      }
      function lpCycle() {
        modalOpen('Cycle', '<p>'
          + '<label>On (s) <input id="m-on" type="number" min="0.1" step="0.1" value="2" style="width:90px"></label> '
          + '<label>Off (s) <input id="m-off" type="number" min="0.1" step="0.1" value="1" style="width:90px"></label> '
          + '<label>Repeat <input id="m-rep" type="number" min="1" value="5" style="width:90px"></label>'
          + '</p>',
          async () => {
            const onSec = parseFloat(document.getElementById('m-on').value);
            const offSec = parseFloat(document.getElementById('m-off').value);
            const times = parseInt(document.getElementById('m-rep').value, 10);
            const r = await fetch('/api/launchpad/session/cycle', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ onSec, offSec, times, target: _abTarget() }) });
            const d = await r.json();
            if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
            modalClose();
          });
      }
      async function lpSendChat() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        const r = await fetch('/api/launchpad/chat', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ text }) });
        if (!r.ok) { const d = await r.json(); flash(d.error || 'failed', 'bad'); }
      }
      async function renderChatMessage(m) {
        const log = document.getElementById('chat-log');
        if (!log) return;
        // Both text and image payloads are AES-256-GCM ciphertext under the per-session key.
        // Buffer until the key arrives over the WS (it lands before chat-history, but be defensive).
        let text = m.text || '';
        if (m.encrypted) {
          if (!window.__chat.ready()) { window.__chat.bufferIfNotReady(m); return; }
          text = (await window.__chat.decrypt(m.encrypted)) || '[encrypted — key mismatch]';
        }
        let imageDataUrl = null;
        if (m.type === 'image' && m.image) {
          if (m.image.encrypted) {
            if (!window.__chat.ready()) { window.__chat.bufferIfNotReady(m); return; }
            imageDataUrl = await window.__chat.decrypt(m.image.encrypted);
          } else if (m.image.dataUrl) {
            imageDataUrl = m.image.dataUrl;  // legacy plaintext path
          }
        }
        const row = document.createElement('div');
        const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (m.type === 'system') {
          row.innerHTML = '<span class="muted" style="font-style:italic;font-size:0.95rem">' + escapeHtml(text) + ' <span style="opacity:0.6">· ' + time + '</span></span>';
        } else if (m.type === 'image' && imageDataUrl) {
          row.innerHTML = '<strong style="color:' + __chatNameColorFor(m.fromEmail) + '">' + escapeHtml(m.fromNickname) + '</strong> <span class="muted" style="font-size:0.8rem">' + time + '</span><br>' +
            '<img src="' + imageDataUrl + '" alt="snapshot" style="max-width:100%;width:320px;height:auto;border-radius:8px;display:block;margin-top:6px">';
        } else {
          row.innerHTML = '<strong style="color:' + __chatNameColorFor(m.fromEmail) + '">' + escapeHtml(m.fromNickname) + '</strong> <span class="muted" style="font-size:0.8rem">' + time + '</span><br>' + escapeHtml(text);
        }
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
      function escapeHtml(s) { return String(s||'').replace(/[<>&"']/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
      // Owner-cam STARTING is manual only. Auto-STOP fires only when the
      // mode TRANSITIONS into 'off' from a different value — not on every
      // state event that happens to carry mode='off'. Without the transition
      // check, a stale persisted 'off' (set by a previous turn-off-host-cam)
      // would kill the local stream the moment any state event arrived.
      let __lastCamMode;
      function maybeAutoToggleCam(s) {
        const mode = s?.ownerCamera?.mode;
        if (__lastCamMode === undefined) { __lastCamMode = mode; return; }
        if (__lastCamMode !== 'off' && mode === 'off' && localStream) {
          lpStopCam();
        }
        __lastCamMode = mode;
      }
      let __stepState = null, __repeatState = null, __pumpOnState = false;
      function renderPumpLine() {
        const el = document.getElementById('pump-status');
        const count = document.getElementById('pump-count');
        const cycEl = document.getElementById('cycle-status');
        if (!el || !count || !cycEl) return;
        const stateLabel = __pumpOnState ? 'Running' : 'Idle';
        el.classList.toggle('idle', !__pumpOnState);
        el.querySelector('.pump-state').textContent = stateLabel;
        if (__stepState && __stepState.indefinite) {
          count.textContent = '(manual)';
        } else if (__stepState && __stepState.durationMs > 0) {
          const elapsed = Date.now() - __stepState.startedAt;
          const remaining = Math.max(0, Math.ceil((__stepState.durationMs - elapsed) / 1000));
          count.textContent = '(' + remaining + 's)';
        } else {
          count.textContent = '';
        }
        cycEl.textContent = __repeatState ? 'Cycles: ' + __repeatState.iteration + '/' + __repeatState.times : '';
      }
      setInterval(renderPumpLine, 250);

      let __isStandby = false;
      const __peerTrackState = new Map(); // remote email -> { videoMuted, audioMuted }
      function broadcastTrackState() {
        if (!wsSig || wsSig.readyState !== 1 || !localStream) return;
        const v = localStream.getVideoTracks()[0];
        const a = localStream.getAudioTracks()[0];
        wsSig.send(JSON.stringify({
          type: 'track-state',
          videoMuted: !!(v && v._userMuted),
          audioMuted: !!(a && a._userMuted),
        }));
      }
      function applyPeerTrackState(email, videoMuted, audioMuted) {
        __peerTrackState.set(email, { videoMuted: !!videoMuted, audioMuted: !!audioMuted });
        const tile = document.getElementById('remote-' + cssId(email));
        if (tile) {
          tile.classList.toggle('peer-video-muted', !!videoMuted);
          tile.classList.toggle('peer-audio-muted', !!audioMuted);
        }
      }
      function applyOutgoingTrackState() {
        if (!localStream) return;
        for (const track of localStream.getTracks()) {
          const userMuted = !!track._userMuted;
          track.enabled = !__isStandby && !userMuted;
        }
      }
      function applyStandby(s) {
        __isStandby = !!(s.active && (s.paused || s.emergencyStopped));
        // Owner has no big "Please Stand By" overlay — but every cam tile
        // (local + remote) blacks out so neither owner nor visitors see frames.
        document.querySelectorAll('.cam-tile').forEach(t => t.classList.toggle('standby-blackout', __isStandby));
        // Disable outgoing local tracks so peers receive no frames at all,
        // combined with whatever the user manually muted via the buttons.
        applyOutgoingTrackState();
      }
      function applyState(s) {
        window.__lastState = s;
        // Session active-toggle: reload so the server-rendered controls
        // (Stop/E-STOP/Standby ↔ Start Session) refresh to the right shape.
        // Same model the visitor uses for its idle/active layout swap.
        const nowActive = !!s.active;
        if (window.__lpActive !== undefined && window.__lpActive !== nowActive) {
          setTimeout(() => location.reload(), 250);
          return;
        }
        window.__lpActive = nowActive;
        // Intro-pending: when the gate clears, just hide the intro button +
        // lock notice in place rather than reloading (a reload would tear
        // down the WebRTC mesh and kill the host cam stream mid-session).
        const nowIntro = !!s.introPending;
        const introRow  = document.getElementById('lp-intro-row');
        const introNote = document.getElementById('lp-intro-lock-note');
        if (introRow)  introRow.style.display  = nowIntro ? '' : 'none';
        if (introNote) introNote.style.display = nowIntro ? '' : 'none';
        window.__lpIntro = nowIntro;
        applyStandby(s);
        maybeAutoToggleCam(s);
        renderMilestonePane(s);
        renderTextOverlays(s);
        __pumpOnState = !!s.pumpOn;
        __stepState = s.currentStep || null;
        __repeatState = s.currentRepeat || null;
        renderPumpLine();
        // gauge: needle is capped at 100, displayed % is the raw capacity (can exceed 100)
        const cap = Math.max(0, s.capacity || 0);
        const needle = Math.min(100, cap);
        const over = cap > 100;
        const r = 80, c = 2 * Math.PI * r, dash = (needle / 100) * c;
        const ring = document.querySelector('.gauge-card svg circle:nth-child(2)');
        if (ring) {
          ring.setAttribute('stroke-dasharray', dash.toFixed(1) + ' ' + (c - dash).toFixed(1));
          ring.setAttribute('stroke', over ? '#f0c674' : '#2a6df4');
        }
        const texts = document.querySelectorAll('.gauge-card svg text');
        if (texts[0]) { texts[0].textContent = Math.round(cap) + '%'; texts[0].setAttribute('fill', over ? '#f0c674' : '#e8e8e8'); }
        if (texts[1]) texts[1].textContent = over ? 'over capacity' : 'capacity';
        // Template action buttons lock during run; the always-on (pump toggle / timed / cycle)
        // buttons get their own treatment below. Intro-gate overrides both.
        const running = s.currentActionTemplateId;
        const introGate = !!s.introPending;
        document.querySelectorAll('.action-btn[data-action-id]').forEach(btn => {
          const id = btn.dataset.actionId;
          if (introGate) {
            btn.disabled = true;
            btn.style.background = '';
            btn.style.color = '';
            btn.innerHTML = btn.innerHTML.replace(/ ●$/, '');
          } else if (running) {
            btn.disabled = running !== id;
            if (running === id) { btn.style.background = '#6ddc9b'; btn.style.color = '#0f1115'; btn.innerHTML = btn.innerHTML.replace(/ ●$/, '') + ' ●'; }
          } else {
            btn.disabled = false;
            btn.style.background = '';
            btn.style.color = '';
            btn.innerHTML = btn.innerHTML.replace(/ ●$/, '');
          }
        });
        const toggle = document.querySelector('.pump-toggle');
        if (toggle) {
          toggle.textContent = running ? '⏻ Pump Off' : '⏵ Pump On';
          toggle.style.background = running ? '#a13030' : '#1a8a4d';
          toggle.style.color = '#fff';
          toggle.disabled = introGate;
        }
        document.querySelectorAll('.misc-action-btn').forEach(b => { b.disabled = !!running || introGate; });
        document.querySelectorAll('.minigame-btn').forEach(b => { b.disabled = !!running || introGate; });
        // Presence: paint the dot + italicize AFK names in the participant list.
        // Also refresh the permission-icon strip so a permission change from
        // the hamburger menu lights up the icon immediately on every browser.
        const byEmail = Object.fromEntries((s.participants || []).map(p => [p.email, p]));
        const isDual = (s.mode === 'dual-target');
        document.querySelectorAll('.participants-pane .p-item[data-email]').forEach(item => {
          const p = byEmail[item.dataset.email] || {};
          const dot = item.querySelector('.presence-dot');
          if (dot) dot.classList.remove('online', 'afk');
          item.classList.remove('afk');
          if (p.presence === 'connected' && dot) dot.classList.add('online');
          if (p.presence === 'afk') { if (dot) dot.classList.add('afk'); item.classList.add('afk'); }
          const icons = item.querySelector('.p-perm-icons');
          if (icons) {
            icons.innerHTML =
              (p.canControl ? '<span title="action control">🔧</span>' : '') +
              (p.canBroadcast ? '<span title="video broadcast">🎥</span>' : '') +
              (p.canChat !== false ? '<span title="chat">💬</span>' : '') +
              (p.canTarget && isDual ? '<span title="target (dual mode)">🎯</span>' : '');
          }
        });
      }
      // ---- Webcam (local publish) ----
      let localStream = null;
      const OWNER_CAM_RES = ${JSON.stringify(cfg.owner?.camera?.resolution || { width: 1280, height: 720 })};
      function _setTileAspect(tile, w, h) {
        if (!(w > 0 && h > 0)) return;
        const ar = (w / h).toFixed(4);
        tile.style.setProperty('--cam-aspect', ar);
        // Also set on the .cam-slot ancestor so flex-grow widens landscape
        // tiles proportionally (see .cam-grid .cam-slot in views/layout.js).
        const slot = tile.closest('.cam-slot');
        if (slot) slot.style.setProperty('--cam-aspect', ar);
      }
      function setLocalTileFromStream(stream) {
        const tile = document.getElementById('local-tile');
        tile.style.display = 'block';
        // Overlay icon controls in the upper-right corner — same .rt-ctrls
        // pattern remote tiles use, so the host's tile looks consistent with
        // every visitor cam tile already on screen. Replaces the previous
        // big button block that lived in a flexbox below the tile.
        tile.innerHTML =
          '<video autoplay muted playsinline></video>' +
          '<div class="rt-label">you</div>' +
          '<div class="rt-ctrls local-ctrls">' +
            '<button class="stop" id="btn-cam" title="Stop camera" onclick="lpToggleCam()">⏻</button>' +
            '<button id="btn-vid" title="Mute video" onclick="lpToggleVideo()">🎥</button>' +
            '<button id="btn-aud" title="Mute audio" onclick="lpToggleAudio()">🎤</button>' +
          '</div>';
        const v = tile.querySelector('video');
        v.srcObject = stream;
        v.onloadedmetadata = () => _setTileAspect(tile, v.videoWidth, v.videoHeight);
        renderTextOverlays(window.__lastState);  // re-mount stage after innerHTML wipe
      }
      function resetLocalTile() {
        const tile = document.getElementById('local-tile');
        tile.style.display = 'grid';
        // Placeholder Start button takes the full tile so the affordance is
        // obvious without any text-button row below.
        tile.innerHTML = '<button class="placeholder-cam-btn" onclick="lpToggleCam()">📹 Start camera</button>';
        renderTextOverlays(window.__lastState);
      }
      async function lpStartCam() {
        // Diagnostic: nothing should call this except the Start camera button.
        // If you see this fire from anywhere else, the stack tells you who.
        console.warn('[lpStartCam] called — stack:', new Error().stack);
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          flash('Browser has no getUserMedia. Use Chrome/Firefox/Edge over http://localhost or https://.', 'bad');
          return;
        }
        try {
          // Honour owner's resolution + device choices from the Chat/Webcam tab.
          let vc = (OWNER_CAM_RES && OWNER_CAM_RES.width !== 'native')
            ? { width: { ideal: OWNER_CAM_RES.width }, height: { ideal: OWNER_CAM_RES.height } }
            : true;
          const savedCamId = localStorage.getItem('pd-cam-device-id');
          const savedMicId = localStorage.getItem('pd-host-mic-id');
          if (savedCamId) {
            if (vc === true) vc = { deviceId: { exact: savedCamId } };
            else vc.deviceId = { exact: savedCamId };
          }
          const ac = savedMicId ? { deviceId: { exact: savedMicId } } : true;
          let rawLocal;
          try {
            rawLocal = await navigator.mediaDevices.getUserMedia({ video: vc, audio: ac });
          } catch (e1) {
            console.warn('AV failed, retrying video-only:', e1);
            rawLocal = await navigator.mediaDevices.getUserMedia({ video: vc });
            flash('Mic unavailable — broadcasting video only', 'warn');
          }
          // If the host enabled the software pipeline on Chat/Webcam, route
          // the raw cam through canvas processing before publishing. The raw
          // stream is stashed on the processed stream so lpStopCam can clean both up.
          if (window.PDCam && window.PDCam.isEnabled()) {
            try {
              const wrapped = window.PDCam.startPipeline(rawLocal);
              wrapped.stream.__pdRaw = rawLocal;
              wrapped.stream.__pdPipeline = wrapped;
              localStream = wrapped.stream;
              flash('software camera pipeline active', 'ok');
            } catch (e) {
              console.error('cam pipeline failed, falling back to raw:', e);
              localStream = rawLocal;
            }
          } else {
            localStream = rawLocal;
          }
          setLocalTileFromStream(localStream);
          // setLocalTileFromStream just (re)rendered the tile - the icon
          // buttons exist now. Just disable the mic icon if there's no audio.
          const audioTrack = localStream.getAudioTracks()[0];
          const audBtn = document.getElementById('btn-aud');
          if (audBtn) audBtn.disabled = !audioTrack;
          applyOutgoingTrackState();   // honour standby + any pre-existing user-mute
          if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: true }));
          broadcastTrackState();
          if (window.__rtc) await window.__rtc.publishToAll();
        } catch (e) {
          console.error('camera failed', e);
          let hint = '';
          if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') hint = ' — no camera device detected (check OS-level cam access / privacy settings)';
          else if (e.name === 'NotAllowedError') hint = ' — browser permission denied (click the camera icon in the address bar)';
          else if (e.name === 'NotReadableError') hint = ' — camera busy (Zoom/Meet/etc. holding it?)';
          else if (e.name === 'SecurityError') hint = ' — page must be served over https:// or http://localhost';
          flash('camera failed: ' + e.name + ': ' + e.message + hint, 'bad');
        }
      }
      async function lpStopCam() {
        // Tell every peer we're done BEFORE pulling the rug — the visitor's
        // broadcast-state:false handler removes the owner's tile immediately,
        // and an unpublish() renegotiation lands the empty-sender SDP on each
        // PC so the video element's track ends cleanly (no lingering last
        // frame). tearDownAll() used to be called here, which closed the PCs
        // synchronously on this side — the remote side's PC stays in
        // 'connected' long enough to keep showing the last decoded frame,
        // which is exactly what visitors were reporting.
        if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: false }));
        if (window.__rtc && window.__rtc.unpublish) {
          try { await window.__rtc.unpublish(); } catch {}
        }
        if (localStream) {
          // If we wrapped through the canvas pipeline, stop the pipeline first
          // (cancels rAF + ends canvas tracks), then stop the raw cam tracks.
          if (localStream.__pdPipeline) { try { localStream.__pdPipeline.stop(); } catch {} }
          if (localStream.__pdRaw) { try { localStream.__pdRaw.getTracks().forEach(t => t.stop()); } catch {} }
          localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
        }
        localStream = null;
        // resetLocalTile rebuilds the tile contents - the icon buttons
        // (btn-cam, btn-vid, btn-aud) no longer exist. lpToggleCam/Video/Audio
        // already bail when localStream is null, so no extra cleanup needed.
        resetLocalTile();
      }
      function lpToggleCam() { localStream ? lpStopCam() : lpStartCam(); }
      function lpToggleVideo() {
        if (!localStream) return;
        const t = localStream.getVideoTracks()[0]; if (!t) return;
        t._userMuted = !t._userMuted;
        applyOutgoingTrackState();
        broadcastTrackState();
        const btn = document.getElementById('btn-vid');
        if (btn) {
          btn.classList.toggle('muted', !!t._userMuted);
          btn.textContent = t._userMuted ? '🚫' : '🎥';
          btn.title = t._userMuted ? 'Unmute video' : 'Mute video';
        }
      }
      function lpToggleAudio() {
        if (!localStream) return;
        const t = localStream.getAudioTracks()[0]; if (!t) return;
        t._userMuted = !t._userMuted;
        applyOutgoingTrackState();
        broadcastTrackState();
        const btn = document.getElementById('btn-aud');
        if (btn) {
          btn.classList.toggle('muted', !!t._userMuted);
          btn.textContent = t._userMuted ? '🔇' : '🎤';
          btn.title = t._userMuted ? 'Unmute audio' : 'Mute audio';
        }
      }
      function attachRemoteTile(email, stream, nickname, isOwner) {
        const label = nickname || email;
        let tile = document.getElementById('remote-' + cssId(email));
        if (!tile) {
          tile = document.createElement('div');
          tile.id = 'remote-' + cssId(email);
          tile.className = 'cam-tile';
          tile.innerHTML =
            '<video autoplay playsinline></video>' +
            '<div class="rt-label"></div>' +
            '<div class="rt-ctrls">' +
              '<button data-act="hide" title="hide video">👁</button>' +
              '<button data-act="mute" title="mute audio">🔊</button>' +
            '</div>' +
            '<div class="audio-muted-badge" title="audio muted by publisher">🔇</div>';
          // Owner Launchpad: remote tiles are controllers (never the owner themselves).
          document.getElementById('cam-controller-slot').appendChild(tile);
          const v = tile.querySelector('video');
          const hideBtn = tile.querySelector('button[data-act="hide"]');
          const muteBtn = tile.querySelector('button[data-act="mute"]');
          hideBtn.onclick = () => { const hidden = tile.classList.toggle('muted-video'); hideBtn.textContent = hidden ? '🚫' : '👁'; };
          muteBtn.onclick = () => { v.muted = !v.muted; muteBtn.textContent = v.muted ? '🔇' : '🔊'; };
        }
        tile.querySelector('.rt-label').textContent = label;
        const v = tile.querySelector('video');
        v.srcObject = stream;
        v.onloadedmetadata = () => _setTileAspect(tile, v.videoWidth, v.videoHeight);
        // re-apply any known peer mute state to the freshly-created tile
        const ps = __peerTrackState.get(email);
        if (ps) {
          tile.classList.toggle('peer-video-muted', !!ps.videoMuted);
          tile.classList.toggle('peer-audio-muted', !!ps.audioMuted);
        }
      }
      function removeRemoteTile(email) {
        const tile = document.getElementById('remote-' + cssId(email));
        if (tile) {
          // Null the srcObject before detaching so the browser doesn't keep
          // showing the last decoded frame in any lingering reference.
          const v = tile.querySelector('video');
          if (v) { try { v.srcObject = null; } catch {} }
          tile.remove();
        }
      }
      function cssId(s) { return String(s).replace(/[^a-z0-9_-]/gi, '_'); }

      // ---- WebSocket ----
      let wsSig = null;
      let wsBackoff = 0;
      function _sendVisibility() {
        if (wsSig && wsSig.readyState === 1) wsSig.send(JSON.stringify({ type: 'visibility', hidden: !!document.hidden }));
      }
      document.addEventListener('visibilitychange', _sendVisibility);
      function connectWs() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(proto + '://' + location.host + '/ws/owner');
        wsSig = ws;
        ws.addEventListener('open', () => { wsBackoff = 0; });
        if (window.__rtc) {
          window.__rtc.init({
            sendSig: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
            getLocalStream: () => localStream,
            onRemoteStream: attachRemoteTile,
            onRemoteGone: removeRemoteTile,
          });
        }
        ws.onopen = () => { _sendVisibility(); };
        ws.onmessage = async (e) => {
          const m = JSON.parse(e.data);
          if (m.type === 'state') applyState(m.state);
          else if (m.type === 'chat-key') {
            const buffered = await window.__chat.setKey(m.key);
            if (buffered && buffered.length) buffered.forEach(renderChatMessage);
          }
          else if (m.type === 'chat') renderChatMessage(m.message);
          else if (m.type === 'chat-history') {
            const log = document.getElementById('chat-log');
            log.innerHTML = '';
            (m.messages || []).forEach(renderChatMessage);
          } else if (m.type === 'track-state') {
            applyPeerTrackState(m.email, !!m.videoMuted, !!m.audioMuted);
          } else if (m.type === 'broadcast-state' && m.broadcasting === false) {
            // Visitor stopped broadcasting — drop their tile but keep the PC alive
            // for owner→visitor streaming.
            removeRemoteTile(m.email);
            if (window.__rtc) window.__rtc.onSignalingMsg(m);
          } else if (m.type === 'overlay') {
            renderOverlay(m);
          } else if (m.type === 'presence-msg') {
            const el = document.getElementById('chat-presence-line');
            if (el) el.textContent = m.text || '';
          } else {
            if (window.__rtc) window.__rtc.onSignalingMsg(m);
            // When a new peer connects, re-send our mute state so their tile renders correctly.
            if (m.type === 'peer-joined' && localStream) setTimeout(broadcastTrackState, 800);
          }
        };
        ws.onclose = () => {
          wsSig = null;
          const delay = Math.min(30000, 500 * Math.pow(2, wsBackoff)) + Math.floor(Math.random() * 500);
          wsBackoff = Math.min(wsBackoff + 1, 6);
          setTimeout(connectWs, delay);
        };
      }
      connectWs();

      // ---- participants ----
      // Permissions context menu (opened by the ≡ hamburger on each row). Lists
      // the toggleable per-participant flags as checkboxes and pipes them
      // through the existing lpSetFlag → PATCH endpoint. canConnect is gone
      // from the UI entirely - being on the list means you can connect.
      function lpOpenPermsMenu(email, anchorBtn) {
        document.querySelectorAll('.perms-menu').forEach(m => m.remove());
        const s = window.__lastState || {};
        const p = (s.participants || []).find(x => x.email === email) || {};
        const isDual = (s.mode === 'dual-target');
        const menu = document.createElement('div');
        menu.className = 'perms-menu';
        const safeEmail = email.replace(/'/g, "\\\\'");
        menu.innerHTML =
          '<label><input type="checkbox" ' + (p.canControl ? 'checked' : '') +
            ' onchange="lpSetFlag(\\'' + safeEmail + '\\',\\'canControl\\',this.checked)"> 🔧 Action control</label>' +
          '<label' + (isDual ? ' style="opacity:0.5"' : '') + '><input type="checkbox" ' + (p.canBroadcast ? 'checked' : '') +
            (isDual ? ' disabled title="disabled in dual-target mode"' : '') +
            ' onchange="lpSetFlag(\\'' + safeEmail + '\\',\\'canBroadcast\\',this.checked)"> 🎥 Video broadcast</label>' +
          '<label><input type="checkbox" ' + (p.canChat !== false ? 'checked' : '') +
            ' onchange="lpSetFlag(\\'' + safeEmail + '\\',\\'canChat\\',this.checked)"> 💬 Chat</label>' +
          (isDual ? '<label><input type="checkbox" ' + (p.canTarget ? 'checked' : '') +
            ' onchange="lpSetFlag(\\'' + safeEmail + '\\',\\'canTarget\\',this.checked)"> 🎯 Target (dual mode)</label>' : '');
        const rect = anchorBtn.getBoundingClientRect();
        menu.style.top = (rect.bottom + 4) + 'px';
        menu.style.right = (window.innerWidth - rect.right) + 'px';
        document.body.appendChild(menu);
        // Defer the close-on-outside-click so the originating click doesn't
        // immediately tear it back down.
        setTimeout(() => {
          const off = (e) => {
            if (menu.contains(e.target) || e.target === anchorBtn) return;
            menu.remove();
            document.removeEventListener('mousedown', off);
          };
          document.addEventListener('mousedown', off);
        }, 0);
      }
      // The "Add from accounts" dropdown is no longer rendered inline at the
      // bottom of the participants pane; the + button next to the title opens
      // this modal instead. Server-side option list is baked into the HTML
      // attribute below to avoid an extra fetch.
      const __ADD_PARTICIPANT_OPTIONS = ${JSON.stringify(ineligible.map(e => ({ email: e, nickname: cfg.accounts.find(a => a.email === e)?.nickname || e.split('@')[0] })))};
      function lpOpenAddParticipantModal() {
        if (!__ADD_PARTICIPANT_OPTIONS.length) {
          flash('All accounts are already in this session. Add more on the Users tab.', 'warn');
          return;
        }
        const opts = __ADD_PARTICIPANT_OPTIONS
          .map(o => '<option value="' + escapeHtml(o.email) + '">' + escapeHtml(o.nickname + ' — ' + o.email) + '</option>')
          .join('');
        modalOpen('Add participant', '<p><label>Pick an account to add to this session:</label></p>' +
          '<p><select id="m-add-participant" style="width:100%;font-size:1rem;padding:8px">' + opts + '</select></p>',
          async () => {
            const email = document.getElementById('m-add-participant').value;
            if (!email) return flash('pick an account', 'bad');
            const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID + '/participants', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ email }) });
            const d = await r.json();
            if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
            modalClose();
            location.reload();
          });
      }
      async function lpRemoveParticipant(email) {
        const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID + '/participants/' + encodeURIComponent(email), { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.reload();
      }
      async function lpSetFlag(email, flag, value) {
        const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID + '/participants/' + encodeURIComponent(email), { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ [flag]: value }) });
        if (!r.ok) { const d = await r.json(); flash(d.error || 'failed', 'bad'); }
      }
      function lpEditCapacity() {
        const curState = window.__lastState || { capacity: 0 };
        modalOpen('Set capacity', '<p>Override the current session capacity. Needle pins at 100% visually; numbers above 100 are allowed when "Disable device control at 100%" is off.</p>' +
          '<p><label>Capacity (%) <input id="m-cap" type="number" min="0" step="0.1" value="' + (curState.capacity || 0).toFixed(1) + '" style="width:100px"></label></p>',
          async () => {
            const v = parseFloat(document.getElementById('m-cap').value);
            const r = await fetch('/api/launchpad/session/capacity', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ value: v }) });
            const d = await r.json();
            if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
            modalClose();
            flash('capacity set to ' + v.toFixed(0) + '%', 'ok');
          });
      }
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'Launchpad', active: 'launchpad', body }));
});

// --- API ---

router.get('/api/launchpad/state', (_req, res) => res.json({ state: session.getState() }));

router.get('/api/launchpad/profiles', (_req, res) => res.json({ profiles: session.listProfiles() }));
router.get('/api/launchpad/profiles/:id', (req, res) => {
  try { res.json({ profile: session.getProfile(req.params.id) }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
router.post('/api/launchpad/profiles', (req, res) => {
  try { res.json({ profile: session.createProfile(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/launchpad/profiles/:id', (req, res) => {
  try { res.json({ profile: session.updateProfile(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/launchpad/profiles/:id', (req, res) => {
  try { session.deleteProfile(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

function syncLiveParticipantsFromProfile(profileId) {
  // If a session is active AND it was started from this profile, mirror the
  // profile's allowedParticipants into the live state so add/remove/patch
  // takes effect immediately without restarting the session.
  const state = session.getState();
  if (!state.active || state.sessionProfileId !== profileId) return;
  const profile = session.getProfile(profileId);
  const existingByEmail = new Map(state.participants.map(p => [p.email, p]));
  const nextLive = profile.allowedParticipants.map(p => {
    const prev = existingByEmail.get(p.email);
    // Preserve live-only fields. Before, only muted+connected were carried
    // forward, so any C/A/V toggle while a target was paired (canTarget
    // 'pending' / true + targetDeviceLabel) clobbered the in-flight T slot.
    return prev
      ? {
          ...p,
          muted: prev.muted || false,
          connected: prev.connected || false,
          canTarget: prev.canTarget !== undefined ? prev.canTarget : p.canTarget,
          targetDeviceLabel: prev.targetDeviceLabel || null,
        }
      : { ...p, muted: false, connected: false };
  });
  session._setLive({ participants: nextLive });
  require('../services/event-bus').emitState(session.getState());
}

router.post('/api/launchpad/profiles/:id/participants', (req, res) => {
  try {
    const profile = session.getProfile(req.params.id);
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) throw new Error('email required');
    if (profile.allowedParticipants.some(p => p.email === email)) throw new Error('already added');
    const next = [...profile.allowedParticipants, { email, canConnect: true, canControl: false, canChat: true }];
    session.updateProfile(req.params.id, { allowedParticipants: next });
    syncLiveParticipantsFromProfile(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/launchpad/profiles/:id/participants/:email', (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const profile = session.getProfile(req.params.id);
    const next = profile.allowedParticipants.filter(p => p.email !== email);
    session.updateProfile(req.params.id, { allowedParticipants: next });
    syncLiveParticipantsFromProfile(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/launchpad/profiles/:id/participants/:email', (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const body = req.body || {};
    // canTarget gets special treatment: only valid in dual-target mode,
    // mutex with other participants, triggers pending-handshake live.
    if ('canTarget' in body) {
      const profile = session.getProfile(req.params.id);
      if (profile.mode !== 'dual-target') throw new Error('T flag only valid in dual-target session profiles');
      const want = !!body.canTarget;
      // Profile-side mutex: setting one clears the rest.
      const next = profile.allowedParticipants.map(p => {
        if (p.email === email) return { ...p, canTarget: want };
        return want ? { ...p, canTarget: false } : p;
      });
      session.updateProfile(req.params.id, { allowedParticipants: next });
      // Live-side: if session is active, flip to 'pending' (or false), which
      // makes the target's visitor JS fire the satellite handshake.
      if (session.getState().active && session.getState().sessionProfileId === req.params.id) {
        try { session.setParticipantTarget(email, want ? 'pending' : false); } catch (e) { logger.warn('setParticipantTarget failed: ' + e.message); }
      }
      return res.json({ ok: true });
    }
    // Standard C/A/V flag path.
    const profile = session.getProfile(req.params.id);
    const prev = profile.allowedParticipants.find(p => p.email === email) || {};
    // V (canBroadcast) is mutex — only one guest cam slot alongside the host.
    // Granting it to one participant clears it from everyone else.
    const grantsBroadcast = body.canBroadcast === true;
    const next = profile.allowedParticipants.map(p => {
      if (p.email === email) return { ...p, ...body };
      if (grantsBroadcast && p.canBroadcast) return { ...p, canBroadcast: false };
      return p;
    });
    session.updateProfile(req.params.id, { allowedParticipants: next });
    if (session.getState().active && session.getState().sessionProfileId === req.params.id) {
      try { session.updateParticipantFlags(email, body); } catch {}
      if (grantsBroadcast) {
        for (const lp of session.getState().participants || []) {
          if (lp.email !== email && lp.canBroadcast) {
            try { session.updateParticipantFlags(lp.email, { canBroadcast: false }); } catch {}
          }
        }
      }
      require('../services/event-bus').emitState(session.getState());
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/start', (req, res) => {
  try {
    const state = session.startSession(req.body?.profileId);
    const profile = session.getProfile(state.sessionProfileId);
    actionEngine.resetForNewSession(profile.welcomeMessage);
    chat.system(`Session started: ${profile.name} — in standby`);
    res.json({ state });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/launchpad/session/stop', (_req, res) => {
  try {
    const state = session.stopSession();
    actionEngine.stopForSessionEnd();
    chat.system('Session stopped');
    res.json({ state });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/launchpad/session/estop', (_req, res) => {
  try {
    // Pass null reason so abort() doesn't chat-narrate; session-control button
    // presses shouldn't pollute the chat with system messages.
    actionEngine.abort(null);
    const state = session.emergencyStop();
    res.json({ state });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/launchpad/session/pause', (_req, res) => {
  try {
    const wasPaused = session.getState().paused;
    if (!wasPaused) actionEngine.abort(null);
    const state = session.setPaused(!wasPaused);
    res.json({ state });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/custom-end', async (_req, res) => {
  try {
    const s = session.getState();
    if (!s.active) throw new Error('no active session');
    const profile = session.getProfile(s.sessionProfileId);
    const ceb = profile.customEndButton;
    if (!ceb?.enabled || !ceb.target?.id) throw new Error('custom end button not configured');
    // Preempt anything running on the gauge, then fire the trigger target.
    // The target's contents decide whether the session also ends (via the
    // end-session sub-action). Pass null reason so abort() doesn't chat.
    actionEngine.abort(null);
    const triggerRuntime = require('../services/trigger-runtime');
    logger.info(`custom-end button: firing ${ceb.target.kind}:${ceb.target.id.slice(0,8)}…`);
    // Fire-and-forget; the target may include long waits or end-session itself.
    Promise.resolve(triggerRuntime.runActionTarget(ceb.target, new AbortController().signal))
      .catch(e => logger.error('custom-end target run failed: ' + (e?.message || e)));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Host accepts the dual-mode session start. No-op in single mode (consent
// is implicit on startSession there). Returns 400 if the session isn't
// active or isn't dual-target.
router.post('/api/launchpad/session/accept-start', (_req, res) => {
  try {
    const s = session.getState();
    if (!s.active) throw new Error('no active session');
    if (s.mode !== 'dual-target') throw new Error('mutual consent only applies in dual-target mode');
    session.acceptStart('host');
    logger.info('host accepted dual-target session start');
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/intro', async (_req, res) => {
  try {
    const s = session.getState();
    if (!s.active) throw new Error('no active session');
    if (!s.introPending) throw new Error('intro already completed or not configured');
    const profile = session.getProfile(s.sessionProfileId);
    const ib = profile.introButton;
    if (!ib?.enabled || !ib.target?.id) throw new Error('intro button not configured');
    const triggerRuntime = require('../services/trigger-runtime');
    logger.info(`intro button: firing ${ib.target.kind}:${ib.target.id.slice(0,8)}…`);
    // Fire-and-forget. When the target's chain settles, clear introPending so
    // the action grid unlocks on the next state emit. If the target included
    // an end-session sub-action the session is already inactive — guard the
    // clear with active check so we don't resurrect introPending on an idle
    // session.
    res.json({ ok: true });
    Promise.resolve(triggerRuntime.runActionTarget(ib.target, new AbortController().signal))
      .catch(e => logger.error('intro target run failed: ' + (e?.message || e)))
      .finally(() => {
        const cur = session.getState();
        if (cur.active && cur.introPending) {
          session._setLive({ introPending: false });
          require('../services/event-bus').emitState(session.getState());
          logger.info('intro complete → action grid unlocked');
        }
      });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/pump-off', (req, res) => {
  try {
    const s = session.getState();
    if (!s.active) throw new Error('no active session');
    if (s.introPending) throw new Error('intro in progress — action panel locked');
    if (s.mode === 'dual-target' && !session.isSessionFullyStarted()) throw new Error('session not started — both parties must confirm');
    const cfg = config.load();
    const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';
    const ownerName = cfg.owner?.displayName?.trim() || ownerEmail.split('@')[0] || 'owner';
    const target = _resolveTarget(req);
    if (target === 'target') {
      const pair = session.getActiveTargetPair();
      if (!pair || !pair.token) throw new Error('no paired target with token');
      const signaling = require('../services/signaling-service');
      const delivered = signaling.deliver(pair.email, { type: 'remote-pump-off', token: pair.token });
      if (!delivered) throw new Error('target not connected');
      require('../services/event-bus').emitOverlay({ kind: 'action-flash', text: `${ownerName} stopped ${pair.deviceLabel || 'target'}` });
      return res.json({ ok: true, target: 'target' });
    }
    actionEngine.abort(null);
    require('../services/event-bus').emitOverlay({ kind: 'action-flash', text: `${ownerName} stopped the pump` });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/capacity', (req, res) => {
  try {
    if (!session.getState().active) throw new Error('no active session');
    const v = parseFloat(req.body?.value);
    if (!Number.isFinite(v) || v < 0) throw new Error('value must be a non-negative number');
    // Route through action-engine so its internal live.capacity (the base
    // for the capacity-tick loop) stays in sync — otherwise the next pump
    // tick would re-overwrite session.capacity with the stale internal value.
    actionEngine.setCapacity(v);
    chat.system(`Capacity manually set to ${Math.round(v)}%`);
    res.json({ ok: true, capacity: v });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

function _ownerInfo() {
  const cfg = config.load();
  const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';
  const ownerName = cfg.owner?.displayName?.trim() || ownerEmail.split('@')[0] || 'owner';
  return { ownerEmail, ownerName };
}

// Resolves req.body.target into 'host' or 'target'. Single-target sessions
// always return 'host' regardless of what the body says.
function _resolveTarget(req) {
  const t = req.body?.target;
  const s = session.getState();
  if (s.mode !== 'dual-target') return 'host';
  return t === 'target' ? 'target' : 'host';
}

// Look up the paired target + token, then push a remote-action WS message
// to that visitor only (signaling-service.deliver is per-email). Logs the
// chain length + label so server logs reflect what was dispatched.
function _emitRemoteAction(label, steps) {
  const pair = session.getActiveTargetPair();
  if (!pair || !pair.token) {
    logger.warn(`remote-action "${label}" dropped — no paired target with token`);
    return false;
  }
  const signaling = require('../services/signaling-service');
  const delivered = signaling.deliver(pair.email, { type: 'remote-action', token: pair.token, label, steps });
  if (!delivered) {
    logger.warn(`remote-action "${label}" — no WS connection for target ${pair.email}`);
    return false;
  }
  logger.info(`remote-action → ${pair.email} — "${label}" (${(steps || []).length} step(s))`);
  // Echo the fire as an action-flash so all clients (including the host's
  // own Launchpad) see what was dispatched against the target's pump.
  try {
    const { emitOverlay } = require('../services/event-bus');
    emitOverlay({ kind: 'action-flash', text: `→ ${pair.deviceLabel || 'target'}: ${label}` });
  } catch {}
  return true;
}

router.post('/api/launchpad/session/fire-action', async (req, res) => {
  try {
    if (session.getState().introPending) throw new Error('intro in progress — action panel locked');
    if (session.getState().mode === 'dual-target' && !session.isSessionFullyStarted()) throw new Error('session not started — both parties must confirm');
    const target = _resolveTarget(req);
    if (target === 'target') {
      const tplData = require('../services/templates-service').load();
      const action = tplData.actionTemplates.find(a => a.id === req.body?.actionTemplateId);
      if (!action) throw new Error('action template not found');
      _emitRemoteAction(action.name, action.steps);
      return res.json({ ok: true, target: 'target', stubbed: true });
    }
    const { ownerEmail, ownerName } = _ownerInfo();
    await actionEngine.fireAction({
      actionTemplateId: req.body?.actionTemplateId,
      byEmail: ownerEmail, byNickname: ownerName,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/pump-on', async (req, res) => {
  try {
    if (session.getState().introPending) throw new Error('intro in progress — action panel locked');
    if (session.getState().mode === 'dual-target' && !session.isSessionFullyStarted()) throw new Error('session not started — both parties must confirm');
    const target = _resolveTarget(req);
    if (target === 'target') {
      _emitRemoteAction('Pump On', [{ type: 'on', durationMs: 24 * 3600 * 1000, indefinite: true }]);
      return res.json({ ok: true, target: 'target', stubbed: true });
    }
    const { ownerEmail, ownerName } = _ownerInfo();
    await actionEngine.fireAction({
      inline: { name: 'Pump On', steps: [{ type: 'on', durationMs: 24 * 3600 * 1000, indefinite: true }] },
      byEmail: ownerEmail, byNickname: ownerName,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/timed', async (req, res) => {
  try {
    if (session.getState().introPending) throw new Error('intro in progress — action panel locked');
    if (session.getState().mode === 'dual-target' && !session.isSessionFullyStarted()) throw new Error('session not started — both parties must confirm');
    const sec = parseFloat(req.body?.seconds);
    if (!Number.isFinite(sec) || sec <= 0) throw new Error('positive seconds required');
    const target = _resolveTarget(req);
    const steps = [{ type: 'on', durationMs: Math.round(sec * 1000) }];
    if (target === 'target') {
      _emitRemoteAction(`Timed ${sec}s`, steps);
      return res.json({ ok: true, target: 'target', stubbed: true });
    }
    const { ownerEmail, ownerName } = _ownerInfo();
    await actionEngine.fireAction({
      inline: { name: `Timed ${sec}s`, steps },
      byEmail: ownerEmail, byNickname: ownerName,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/cycle', async (req, res) => {
  try {
    if (session.getState().introPending) throw new Error('intro in progress — action panel locked');
    if (session.getState().mode === 'dual-target' && !session.isSessionFullyStarted()) throw new Error('session not started — both parties must confirm');
    const onSec = parseFloat(req.body?.onSec);
    const offSec = parseFloat(req.body?.offSec);
    const times = parseInt(req.body?.times, 10);
    if (!Number.isFinite(onSec) || onSec <= 0) throw new Error('on seconds required');
    if (!Number.isFinite(offSec) || offSec <= 0) throw new Error('off seconds required');
    if (!Number.isInteger(times) || times <= 0) throw new Error('repeat times required');
    const target = _resolveTarget(req);
    const steps = [{ type: 'repeat', times, steps: [
      { type: 'on', durationMs: Math.round(onSec * 1000) },
      { type: 'off', durationMs: Math.round(offSec * 1000) },
    ]}];
    if (target === 'target') {
      _emitRemoteAction(`Cycle ${onSec}/${offSec} ×${times}`, steps);
      return res.json({ ok: true, target: 'target', stubbed: true });
    }
    const { ownerEmail, ownerName } = _ownerInfo();
    await actionEngine.fireAction({
      inline: { name: `Cycle ${onSec}/${offSec} ×${times}`, steps },
      byEmail: ownerEmail, byNickname: ownerName,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/chat', (req, res) => {
  try {
    const cfg = config.load();
    const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';
    const ownerName = cfg.owner?.displayName?.trim() || ownerEmail.split('@')[0] || 'owner';
    const text = (req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'empty message' });
    chat.push({ fromEmail: ownerEmail, fromNickname: ownerName, text });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/api/launchpad/chat/history', (_req, res) => res.json({ messages: chat.snapshot() }));

router.patch('/api/launchpad/owner', (req, res) => {
  try {
    const displayName = (req.body?.displayName || '').toString().slice(0, 40);
    config.save({ owner: { displayName } });
    res.json({ owner: { displayName } });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
