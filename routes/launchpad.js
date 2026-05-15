const express = require('express');
const session = require('../services/session-service');
const templatesSvc = require('../services/templates-service');
const devicesSvc = require('../services/devices-service');
const actionEngine = require('../services/action-engine');
const chat = require('../services/chat-service');
const config = require('../config');
const { ownerLayout, escape } = require('../views/layout');
const { rtcClientJs } = require('../views/rtc-client');
const { chatCryptoJs } = require('../views/chat-crypto');
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
  const activeProfileId = req.query.profile || profiles[0].id;
  const profile = profiles.find(p => p.id === activeProfileId) || profiles[0];
  const state = session.getState();
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
  const isRunning = !!state.currentActionTemplateId;
  const alwaysBtns = state.active ? `
    <button class="action-btn pump-toggle" onclick="lpPumpToggle()" style="background:${isRunning ? '#a13030' : '#1a8a4d'};color:#fff">${isRunning ? '⏻ Pump Off' : '⏵ Pump On'}</button>
    <button class="action-btn misc-action-btn" onclick="lpTimed()" style="background:#1a8a4d;color:#fff" ${isRunning ? 'disabled' : ''}>⏱ Timed</button>
    <button class="action-btn misc-action-btn" onclick="lpCycle()" style="background:#1a8a4d;color:#fff" ${isRunning ? 'disabled' : ''}>↻ Cycle</button>
  ` : '';
  const actionButtonsCore = visibleActionIds.length
    ? visibleActionIds.map(id => {
        const a = actionsById[id];
        return `<div class="action-cell">
          <button class="action-btn" data-action-id="${escape(id)}" onclick="lpFireAction('${escape(id)}')">${escape(a?.name || '?')}</button>
          <button class="action-help-btn" type="button" title="What does this do?" onclick="lpActionHelp('${escape(id)}')">?</button>
        </div>`;
      }).join('')
    : (state.active ? '<p class="muted" style="grid-column:1/-1">No template actions for this milestone — use Pump On / Timed / Cycle above.</p>' : '<p class="muted">Start a session to enable actions.</p>');
  const actionButtons = alwaysBtns + actionButtonsCore;

  const calibratedReady = primaryDevice && primaryDevice.calibration?.secondsTo100 > 0;
  const sessionReady = calibratedReady && allAllowedEmails.length > 0;
  const ownerDisplayName = cfg.owner?.displayName || '';
  const ownerNameForTitle = ownerDisplayName || (cfg.cloudflare?.ownerEmail?.split('@')[0]) || 'owner';

  const body = `
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
      <p class="muted">Template profile: <strong>${escape(templateProfile?.name || '?')}</strong></p>
    </div>`}

    <div id="session-stage">
    <div class="top-row">
      <div class="card gauge-card">
        <h3 style="margin:0 0 2px;font-size:1.1rem;text-align:center">Inflation Capacity</h3>
        <p class="muted" style="margin:0 0 8px;font-size:0.82rem;text-align:center;line-height:1.35">Real, calibrated and calculated display of <strong>${escape(ownerNameForTitle)}</strong>'s current fullness.</p>
        ${gauge(state.capacity)}
        <p style="margin:6px 0 0">
          <button onclick="lpEditCapacity()" ${state.active ? '' : 'disabled'} style="background:#2a2f3a;padding:4px 10px;font-size:0.85rem">✎ Set capacity</button>
        </p>
        <p class="pump-status ${state.pumpOn ? '' : 'idle'}" id="pump-status">
          Pump: <span class="pump-state">${state.pumpOn ? 'Running' : 'Idle'}</span><span class="pump-count" id="pump-count"></span>
        </p>
        <p class="cycle-status" id="cycle-status"></p>
        <p style="margin-top:10px">
          ${state.active
            ? `<button onclick="lpStop()" style="background:#7a3a3a">Stop</button>
               <button onclick="lpEstop()" style="background:#a13030;font-weight:700">E-STOP</button>
               <button onclick="lpTogglePause()" style="background:${state.paused ? '#2a6df4' : '#7a8597'};min-width:140px">${state.paused ? 'Exit Standby' : 'Enter Standby'}</button>`
            : `<button onclick="lpStart()" ${sessionReady ? '' : 'disabled'}>Start Session</button>`}
        </p>
        ${!state.active && !sessionReady ? `<p class="muted" style="font-size:0.85rem;margin-top:6px">${!calibratedReady ? 'Primary pump must be calibrated.' : 'Add at least one allowed user.'}</p>` : ''}
      </div>
      <div class="card milestone-pane">
        <p class="milestone-title">${activeMilestone ? escape(activeMilestone.name) : (state.active ? escape(templateProfile?.name || 'Default') : 'Idle')}</p>
        <p class="milestone-announcement">${state.active ? escape(state.currentDisplayMessage || '(no message)') : escape(profile.welcomeMessage || '(no welcome message)')}</p>
        <p class="muted" id="milestone-meta" style="font-size:0.9rem;margin:0 0 14px">
          ${state.active
            ? (activeMilestone ? `${activeMilestone.capacityMin}–${activeMilestone.capacityMax}% · milestone announcement live` : 'Welcome message — replaced when first milestone is reached')
            : 'Welcome message (visitors see this when no session is running)'}
          · <a href="#" onclick="lpEditWelcome();return false" style="color:#9aa4b2">edit welcome</a>
        </p>
        <div class="action-grid">${actionButtons}</div>
      </div>
    </div>

    <div class="cam-grid">
      <div class="cam-slot" id="cam-controller-slot"></div>
      <div class="cam-slot" id="cam-owner-slot">
        <div id="local-tile" class="cam-tile" style="display:grid;place-items:center;color:#7a8597;font-size:0.95rem">Local cam off</div>
        <div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
          <button id="btn-cam" onclick="lpToggleCam()">${cfg.owner?.camera?.mode === 'live' ? 'Stop camera' : 'Start camera'}</button>
          <button id="btn-vid" onclick="lpToggleVideo()" disabled>Mute video</button>
          <button id="btn-aud" onclick="lpToggleAudio()" disabled>Mute audio</button>
        </div>
      </div>
    </div>
    </div><!-- /session-stage -->

    <div class="chat-row">
      <div class="card chat-pane">
        <h3 style="margin:0 0 12px">Chat ${profile.settings.chatroomEnabled ? '' : '<span class="muted" style="font-size:0.9rem;font-weight:normal">(disabled for visitors in this profile)</span>'}</h3>
        <div id="chat-log" class="chat-log"></div>
        <div class="chat-input-row">
          <input id="chat-input" type="text" placeholder="say something…" onkeydown="if(event.key==='Enter') lpSendChat()">
          <button onclick="lpSendChat()">Send</button>
        </div>
      </div>
      <div class="card participants-pane">
        <h3 style="margin:0 0 12px">Participants <span class="muted" style="font-size:0.85rem;font-weight:normal">(${profile.allowedParticipants.filter(p => p.email !== ownerEmailLp).length})</span></h3>
        <div class="p-list">
          ${profile.allowedParticipants.filter(p => p.email !== ownerEmailLp).length
            ? profile.allowedParticipants.filter(p => p.email !== ownerEmailLp).map(p => `
              <div class="p-item" data-email="${escape(p.email)}">
                <span class="presence-dot"></span>
                <span>${escape(cfg.accounts.find(a => a.email === p.email)?.nickname || p.email.split('@')[0])}</span>
                <span class="p-flags">
                  <button title="make sole controller (revokes others)" onclick="lpMakeSoleController('${escape(p.email)}')" style="background:${p.canControl ? '#6ddc9b' : '#2a6df4'};color:${p.canControl ? '#0f1115' : '#fff'};padding:2px 8px;font-size:0.85rem">▶</button>
                  <label title="can connect"><input type="checkbox" ${p.canConnect ? 'checked' : ''} onchange="lpSetFlag('${escape(p.email)}','canConnect',this.checked)">C</label>
                  <label title="can control"><input type="checkbox" ${p.canControl ? 'checked' : ''} onchange="lpSetFlag('${escape(p.email)}','canControl',this.checked)">A</label>
                  <label title="can broadcast cam"><input type="checkbox" ${p.canBroadcast ? 'checked' : ''} onchange="lpSetFlag('${escape(p.email)}','canBroadcast',this.checked)">V</label>
                  <button title="remove" onclick="lpRemoveParticipant('${escape(p.email)}')" style="background:#4a1b1b;padding:2px 8px;font-size:0.85rem">×</button>
                </span>
              </div>`).join('')
            : '<p class="muted" style="font-size:0.95rem">No participants yet.</p>'}
        </div>
        ${ineligible.length ? `
          <p style="margin-top:14px">
            <select id="lp-add-pick" style="width:100%;margin-bottom:6px">${addParticipantOptions}</select>
            <button onclick="lpAddParticipant()" style="width:100%">Add from accounts</button>
          </p>
        ` : '<p class="muted" style="font-size:0.85rem;margin-top:12px">All accounts already added. Manage on Users tab.</p>'}
        <p class="muted" style="font-size:0.75rem;margin-top:12px">C = connect · A = action control · V = video broadcast</p>
        <p class="muted" style="font-size:0.75rem;margin-top:4px"><span class="presence-dot" style="display:inline-block;vertical-align:middle"></span> invited &nbsp;<span class="presence-dot online" style="display:inline-block;vertical-align:middle"></span> in session &nbsp;<span class="presence-dot afk" style="display:inline-block;vertical-align:middle"></span> afk</p>
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

    <script>
      ${rtcClientJs({ myEmail: cfg.cloudflare?.ownerEmail || 'owner@local' })}
      ${chatCryptoJs()}
    </script>
    <script>
      const OWNER_CAM_MODE = ${JSON.stringify(cfg.owner?.camera?.mode || 'off')};
      const PROFILE_ID = ${JSON.stringify(profile.id)};
      const PROFILE_IS_FACTORY = ${JSON.stringify(!!profile.isFactory)};
      const TEMPLATE_OPTIONS = ${JSON.stringify(templates.templateProfiles.map(p => ({ id: p.id, name: p.name })))};
      const ACTIONS_INFO = ${JSON.stringify(Object.fromEntries(templates.actionTemplates.map(a => [a.id, { name: a.name, description: a.description || '' }])))};
      const MILESTONES_BY_ID = ${JSON.stringify(Object.fromEntries((templateProfile?.milestones || []).map(m => [m.id, { name: m.name, announcement: m.announcement || '', actionTemplateIds: m.actionTemplateIds || [], capacityMin: m.capacityMin, capacityMax: m.capacityMax, is100Plus: !!m.is100Plus }])))};
      const ALWAYS_ACTION_IDS = ${JSON.stringify(templateProfile?.defaultActionTemplateIds || [])};
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
        const titleEl = document.querySelector('.milestone-pane .milestone-title');
        const annEl = document.querySelector('.milestone-pane .milestone-announcement');
        const metaEl = document.getElementById('milestone-meta');
        if (titleEl) titleEl.textContent = m ? m.name : (s.active ? TPL_NAME : 'Idle');
        if (annEl) annEl.textContent = s.active ? (s.currentDisplayMessage || '(no message)') : (WELCOME_MSG || '(no welcome message)');
        if (metaEl) {
          const inner = s.active
            ? (m ? (m.is100Plus ? '100%+ · milestone announcement live' : (m.capacityMin + '–' + m.capacityMax + '% · milestone announcement live')) : 'Welcome message — replaced when first milestone is reached')
            : 'Welcome message (visitors see this when no session is running)';
          metaEl.innerHTML = _safeAttr(inner) + ' · <a href="#" onclick="lpEditWelcome();return false" style="color:#9aa4b2">edit welcome</a>';
        }
        const grid = document.querySelector('.milestone-pane .action-grid');
        if (!grid) return;
        if (!s.active) { grid.innerHTML = '<p class="muted">Start a session to enable actions.</p>'; return; }
        const ids = Array.from(new Set([...((m && m.actionTemplateIds) || []), ...ALWAYS_ACTION_IDS]));
        const running = !!s.currentActionTemplateId;
        const alwaysBtns =
          '<button class="action-btn pump-toggle" onclick="lpPumpToggle()" style="background:' + (running ? '#a13030' : '#1a8a4d') + ';color:#fff">' + (running ? '⏻ Pump Off' : '⏵ Pump On') + '</button>'
        + '<button class="action-btn misc-action-btn" onclick="lpTimed()" style="background:#1a8a4d;color:#fff"' + (running ? ' disabled' : '') + '>⏱ Timed</button>'
        + '<button class="action-btn misc-action-btn" onclick="lpCycle()" style="background:#1a8a4d;color:#fff"' + (running ? ' disabled' : '') + '>↻ Cycle</button>';
        const cells = ids.length
          ? ids.map(id => {
              const a = ACTIONS_INFO[id];
              return '<div class="action-cell">'
                + '<button class="action-btn" data-action-id="' + _safeAttr(id) + '" onclick="lpFireAction(\\'' + _safeAttr(id) + '\\')">' + _safeAttr(a && a.name || '?') + '</button>'
                + '<button class="action-help-btn" type="button" title="What does this do?" onclick="lpActionHelp(\\'' + _safeAttr(id) + '\\')">?</button>'
              + '</div>';
            }).join('')
          : '<p class="muted" style="grid-column:1/-1">No template actions for this milestone — use Pump On / Timed / Cycle above.</p>';
        grid.innerHTML = alwaysBtns + cells;
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
        const profileResp = fetch('/api/launchpad/profiles/' + PROFILE_ID).then(r => r.json()).then(d => {
          const p = d.profile;
          const tplOptions = TEMPLATE_OPTIONS.map(o => '<option value="' + o.id + '"' + (o.id === p.templateProfileId ? ' selected' : '') + '>' + o.name + '</option>').join('');
          modalOpen('Settings — ' + p.name, ''
            + '<p><label>Template profile <select id="m-tpl">' + tplOptions + '</select></label></p>'
            + '<p><label><input type="checkbox" id="m-chat"' + (p.settings.chatroomEnabled ? ' checked' : '') + '> Enable chatroom</label></p>'
            + '<p><label><input type="checkbox" id="m-d100"' + (p.settings.disableControlAt100 ? ' checked' : '') + '> Disable device control at 100% capacity</label></p>',
            async () => {
              const body = {
                templateProfileId: document.getElementById('m-tpl').value,
                settings: {
                  chatroomEnabled: document.getElementById('m-chat').checked,
                  disableControlAt100: document.getElementById('m-d100').checked,
                },
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
      async function lpFireAction(actionId) {
        const r = await fetch('/api/launchpad/session/fire-action', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ actionTemplateId: actionId }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
      }
      async function lpPumpOff() {
        const r = await fetch('/api/launchpad/session/pump-off', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
      }
      async function lpPumpOn() {
        const r = await fetch('/api/launchpad/session/pump-on', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
      }
      function lpPumpToggle() {
        const running = !!(window.__lastState && window.__lastState.currentActionTemplateId);
        if (running) lpPumpOff(); else lpPumpOn();
      }
      function lpTimed() {
        modalOpen('Timed pump on', '<p><label>Duration (seconds) <input id="m-sec" type="number" min="0.1" step="0.1" value="10" autofocus></label></p>',
          async () => {
            const seconds = parseFloat(document.getElementById('m-sec').value);
            const r = await fetch('/api/launchpad/session/timed', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ seconds }) });
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
            const r = await fetch('/api/launchpad/session/cycle', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ onSec, offSec, times }) });
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
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span class="muted" style="font-size:0.8rem">' + time + '</span><br>' +
            '<img src="' + imageDataUrl + '" alt="snapshot" style="max-width:100%;width:320px;height:auto;border-radius:8px;display:block;margin-top:6px">';
        } else {
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span class="muted" style="font-size:0.8rem">' + time + '</span><br>' + escapeHtml(text);
        }
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
      function escapeHtml(s) { return String(s||'').replace(/[<>&"']/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
      let wasActive = null;
      function maybeAutoToggleCam(s) {
        if (OWNER_CAM_MODE !== 'live') return;
        const active = !!s.active;
        if (wasActive === active) return;
        if (active && !localStream) lpStartCam();
        else if (!active && localStream) lpStopCam();
        wasActive = active;
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
        applyStandby(s);
        maybeAutoToggleCam(s);
        renderMilestonePane(s);
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
        // buttons get their own treatment below.
        const running = s.currentActionTemplateId;
        document.querySelectorAll('.action-btn[data-action-id]').forEach(btn => {
          const id = btn.dataset.actionId;
          if (running) {
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
        }
        document.querySelectorAll('.misc-action-btn').forEach(b => { b.disabled = !!running; });
        // Presence: paint the dot + italicize AFK names in the participant list.
        const presenceByEmail = Object.fromEntries((s.participants || []).map(p => [p.email, p.presence || null]));
        document.querySelectorAll('.participants-pane .p-item[data-email]').forEach(item => {
          const presence = presenceByEmail[item.dataset.email] || null;
          const dot = item.querySelector('.presence-dot');
          if (dot) dot.classList.remove('online', 'afk');
          item.classList.remove('afk');
          if (presence === 'connected' && dot) dot.classList.add('online');
          if (presence === 'afk') { if (dot) dot.classList.add('afk'); item.classList.add('afk'); }
        });
      }
      // ---- Webcam (local publish) ----
      let localStream = null;
      const OWNER_CAM_RES = ${JSON.stringify(cfg.owner?.camera?.resolution || { width: 1280, height: 720 })};
      function _setTileAspect(tile, w, h) {
        if (w > 0 && h > 0) tile.style.setProperty('--cam-aspect', (w / h).toFixed(4));
      }
      function setLocalTileFromStream(stream) {
        const tile = document.getElementById('local-tile');
        tile.style.display = 'block';
        tile.innerHTML =
          '<video autoplay muted playsinline></video>' +
          '<div class="rt-label">you</div>';
        const v = tile.querySelector('video');
        v.srcObject = stream;
        v.onloadedmetadata = () => _setTileAspect(tile, v.videoWidth, v.videoHeight);
      }
      function resetLocalTile() {
        const tile = document.getElementById('local-tile');
        tile.style.display = 'grid';
        tile.innerHTML = 'Local cam off';
      }
      async function lpStartCam() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          flash('Browser has no getUserMedia. Use Chrome/Firefox/Edge over http://localhost or https://.', 'bad');
          return;
        }
        try {
          // Honour owner's resolution choice from the Chat/Webcam tab.
          const vc = (OWNER_CAM_RES && OWNER_CAM_RES.width !== 'native')
            ? { width: { ideal: OWNER_CAM_RES.width }, height: { ideal: OWNER_CAM_RES.height } }
            : true;
          try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: vc, audio: true });
          } catch (e1) {
            console.warn('AV failed, retrying video-only:', e1);
            localStream = await navigator.mediaDevices.getUserMedia({ video: vc });
            flash('Mic unavailable — broadcasting video only', 'warn');
          }
          setLocalTileFromStream(localStream);
          document.getElementById('btn-cam').textContent = 'Stop camera';
          document.getElementById('btn-vid').disabled = false;
          const audioTrack = localStream.getAudioTracks()[0];
          document.getElementById('btn-aud').disabled = !audioTrack;
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
      function lpStopCam() {
        if (localStream) localStream.getTracks().forEach(t => t.stop());
        localStream = null;
        resetLocalTile();
        document.getElementById('btn-cam').textContent = 'Start camera';
        document.getElementById('btn-vid').disabled = true;
        document.getElementById('btn-aud').disabled = true;
        if (window.__rtc) {
          wsSig?.send(JSON.stringify({ type: 'broadcast-state', broadcasting: false }));
          window.__rtc.tearDownAll();
        }
      }
      function lpToggleCam() { localStream ? lpStopCam() : lpStartCam(); }
      function lpToggleVideo() {
        if (!localStream) return;
        const t = localStream.getVideoTracks()[0]; if (!t) return;
        t._userMuted = !t._userMuted;
        applyOutgoingTrackState();
        broadcastTrackState();
        document.getElementById('btn-vid').textContent = t._userMuted ? 'Unmute video' : 'Mute video';
      }
      function lpToggleAudio() {
        if (!localStream) return;
        const t = localStream.getAudioTracks()[0]; if (!t) return;
        t._userMuted = !t._userMuted;
        applyOutgoingTrackState();
        broadcastTrackState();
        document.getElementById('btn-aud').textContent = t._userMuted ? 'Unmute audio' : 'Mute audio';
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
        if (tile) tile.remove();
      }
      function cssId(s) { return String(s).replace(/[^a-z0-9_-]/gi, '_'); }

      // ---- WebSocket ----
      let wsSig = null;
      function _sendVisibility() {
        if (wsSig && wsSig.readyState === 1) wsSig.send(JSON.stringify({ type: 'visibility', hidden: !!document.hidden }));
      }
      document.addEventListener('visibilitychange', _sendVisibility);
      function connectWs() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(proto + '://' + location.host + '/ws/owner');
        wsSig = ws;
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
          } else {
            if (window.__rtc) window.__rtc.onSignalingMsg(m);
            // When a new peer connects, re-send our mute state so their tile renders correctly.
            if (m.type === 'peer-joined' && localStream) setTimeout(broadcastTrackState, 800);
          }
        };
        ws.onclose = () => { wsSig = null; setTimeout(connectWs, 1500); };
      }
      connectWs();

      // ---- participants ----
      async function lpAddParticipant() {
        const email = document.getElementById('lp-add-pick').value;
        const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID + '/participants', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ email }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.reload();
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
      async function lpMakeSoleController(email) {
        const r = await fetch('/api/launchpad/profiles/' + PROFILE_ID + '/sole-controller', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ email }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('controller reassigned', 'ok');
        setTimeout(() => location.reload(), 400);
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
    return prev
      ? { ...p, muted: prev.muted || false, connected: prev.connected || false }
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
    const next = [...profile.allowedParticipants, { email, canConnect: true, canControl: false }];
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
    const profile = session.getProfile(req.params.id);
    const prev = profile.allowedParticipants.find(p => p.email === email) || {};
    const next = profile.allowedParticipants.map(p => p.email === email ? { ...p, ...req.body } : p);
    session.updateProfile(req.params.id, { allowedParticipants: next });
    if (session.getState().active && session.getState().sessionProfileId === req.params.id) {
      try { session.updateParticipantFlags(email, req.body); } catch {}
      require('../services/event-bus').emitState(session.getState());
    }
    // Narrate meaningful changes in chat so visitors see the role shift live.
    const acct = (config.load().accounts || []).find(a => a.email === email);
    const nick = acct?.nickname || email.split('@')[0];
    if ('canControl' in req.body && !!req.body.canControl !== !!prev.canControl) {
      chat.system(req.body.canControl ? `${nick} can now control actions` : `${nick} no longer controls actions`);
    }
    if ('canBroadcast' in req.body && !!req.body.canBroadcast !== !!prev.canBroadcast) {
      chat.system(req.body.canBroadcast ? `${nick} can now broadcast their cam` : `${nick} can no longer broadcast their cam`);
    }
    if ('canConnect' in req.body && !!req.body.canConnect !== !!prev.canConnect) {
      chat.system(req.body.canConnect ? `${nick} can now join` : `${nick} removed from the session`);
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/profiles/:id/sole-controller', (req, res) => {
  try {
    const target = (req.body?.email || '').trim().toLowerCase();
    if (!target) throw new Error('email required');
    const profile = session.getProfile(req.params.id);
    if (!profile.allowedParticipants.some(p => p.email === target)) {
      throw new Error('email not in this profile\'s participants');
    }
    const next = profile.allowedParticipants.map(p => ({ ...p, canControl: p.email === target }));
    session.updateProfile(req.params.id, { allowedParticipants: next });
    syncLiveParticipantsFromProfile(req.params.id);
    const acct = (config.load().accounts || []).find(a => a.email === target);
    const nick = acct?.nickname || target.split('@')[0];
    chat.system(`Controller is now ${nick}`);
    res.json({ ok: true, controller: target });
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
    actionEngine.abort('E-STOP — pump cut, capacity frozen');
    const state = session.emergencyStop();
    res.json({ state });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/launchpad/session/pause', (_req, res) => {
  try {
    const wasPaused = session.getState().paused;
    if (!wasPaused) actionEngine.abort('entering standby');
    const state = session.setPaused(!wasPaused);
    chat.system(state.paused ? 'Entered standby' : 'Standby exited — session is live');
    res.json({ state });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/pump-off', (_req, res) => {
  try {
    if (!session.getState().active) throw new Error('no active session');
    const cfg = config.load();
    const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';
    const ownerName = cfg.owner?.displayName?.trim() || ownerEmail.split('@')[0] || 'owner';
    actionEngine.abort(`${ownerName} hit Pump Off`);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/capacity', (req, res) => {
  try {
    if (!session.getState().active) throw new Error('no active session');
    const v = parseFloat(req.body?.value);
    if (!Number.isFinite(v) || v < 0) throw new Error('value must be a non-negative number');
    session._setLive({ capacity: v });
    require('../services/event-bus').emitState(session.getState());
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

router.post('/api/launchpad/session/fire-action', async (req, res) => {
  try {
    const { ownerEmail, ownerName } = _ownerInfo();
    await actionEngine.fireAction({
      actionTemplateId: req.body?.actionTemplateId,
      byEmail: ownerEmail, byNickname: ownerName,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/pump-on', async (_req, res) => {
  try {
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
    const sec = parseFloat(req.body?.seconds);
    if (!Number.isFinite(sec) || sec <= 0) throw new Error('positive seconds required');
    const { ownerEmail, ownerName } = _ownerInfo();
    await actionEngine.fireAction({
      inline: { name: `Timed ${sec}s`, steps: [{ type: 'on', durationMs: Math.round(sec * 1000) }] },
      byEmail: ownerEmail, byNickname: ownerName,
    });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/cycle', async (req, res) => {
  try {
    const onSec = parseFloat(req.body?.onSec);
    const offSec = parseFloat(req.body?.offSec);
    const times = parseInt(req.body?.times, 10);
    if (!Number.isFinite(onSec) || onSec <= 0) throw new Error('on seconds required');
    if (!Number.isFinite(offSec) || offSec <= 0) throw new Error('off seconds required');
    if (!Number.isInteger(times) || times <= 0) throw new Error('repeat times required');
    const { ownerEmail, ownerName } = _ownerInfo();
    await actionEngine.fireAction({
      inline: { name: `Cycle ${onSec}/${offSec} ×${times}`, steps: [{
        type: 'repeat', times, steps: [
          { type: 'on', durationMs: Math.round(onSec * 1000) },
          { type: 'off', durationMs: Math.round(offSec * 1000) },
        ]
      }] },
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
