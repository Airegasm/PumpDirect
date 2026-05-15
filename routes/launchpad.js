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

  // Allowed participants table (per profile, edited on this page)
  const allowedRows = profile.allowedParticipants.map(p => `
    <tr data-email="${escape(p.email)}">
      <td>${escape(cfg.accounts.find(a => a.email === p.email)?.nickname || '(unknown)')}</td>
      <td><code>${escape(p.email)}</code></td>
      <td><input type="checkbox" ${p.canConnect ? 'checked' : ''} onchange="lpSetFlag('${escape(p.email)}', 'canConnect', this.checked)"></td>
      <td><input type="checkbox" ${p.canControl ? 'checked' : ''} onchange="lpSetFlag('${escape(p.email)}', 'canControl', this.checked)"></td>
      <td><input type="checkbox" ${p.canBroadcast ? 'checked' : ''} onchange="lpSetFlag('${escape(p.email)}', 'canBroadcast', this.checked)"></td>
      <td><button onclick="lpRemoveParticipant('${escape(p.email)}')">Remove</button></td>
    </tr>`).join('');

  const ineligible = allAllowedEmails.filter(e => !profile.allowedParticipants.some(p => p.email === e));
  const addParticipantOptions = ineligible.map(e => `<option value="${escape(e)}">${escape(e)}</option>`).join('');

  // Action buttons (milestone-specific + always-available)
  const milestoneActionIds = activeMilestone ? (activeMilestone.actionTemplateIds || []) : [];
  const alwaysActionIds = templateProfile?.defaultActionTemplateIds || [];
  const visibleActionIds = state.active
    ? Array.from(new Set([...milestoneActionIds, ...alwaysActionIds]))
    : [];
  const actionButtons = visibleActionIds.length
    ? visibleActionIds.map(id => {
        const a = actionsById[id];
        return `<button class="action-btn" data-action-id="${escape(id)}" onclick="lpFireAction('${escape(id)}')" style="margin:4px">${escape(a?.name || '?')}</button>`;
      }).join('')
    : `<p class="muted">${state.active ? 'No actions available at this capacity.' : 'Start a session to enable action templates.'}</p>`;

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
        ${gauge(state.capacity)}
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
        <p class="muted" style="font-size:0.9rem;margin:0 0 14px">
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
        <h3 style="margin:0 0 12px">Participants <span class="muted" style="font-size:0.85rem;font-weight:normal">(${profile.allowedParticipants.length})</span></h3>
        <div class="p-list">
          ${profile.allowedParticipants.length
            ? profile.allowedParticipants.map(p => `
              <div class="p-item" data-email="${escape(p.email)}">
                <span class="presence-dot"></span>
                <span>${escape(cfg.accounts.find(a => a.email === p.email)?.nickname || p.email.split('@')[0])}</span>
                <span class="p-flags">
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
        if (__stepState && __stepState.durationMs > 0) {
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
        applyStandby(s);
        maybeAutoToggleCam(s);
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
        // action buttons lock during run
        const running = s.currentActionTemplateId;
        document.querySelectorAll('.action-btn').forEach(btn => {
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
      }
      // ---- Webcam (local publish) ----
      let localStream = null;
      function setLocalTileFromStream(stream) {
        const tile = document.getElementById('local-tile');
        tile.style.display = 'block';
        tile.innerHTML =
          '<video autoplay muted playsinline></video>' +
          '<div class="rt-label">you</div>';
        tile.querySelector('video').srcObject = stream;
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
          // Try video + audio first; fall back to video-only if audio is the problem.
          try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          } catch (e1) {
            console.warn('AV failed, retrying video-only:', e1);
            localStream = await navigator.mediaDevices.getUserMedia({ video: true });
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
        tile.querySelector('video').srcObject = stream;
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
    const next = profile.allowedParticipants.map(p => p.email === email ? { ...p, ...req.body } : p);
    session.updateProfile(req.params.id, { allowedParticipants: next });
    if (session.getState().active && session.getState().sessionProfileId === req.params.id) {
      try { session.updateParticipantFlags(email, req.body); } catch {}
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

router.post('/api/launchpad/session/fire-action', async (req, res) => {
  try {
    const cfg = config.load();
    const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';
    const ownerName = cfg.owner?.displayName?.trim() || ownerEmail.split('@')[0] || 'owner';
    await actionEngine.fireAction({
      actionTemplateId: req.body?.actionTemplateId,
      byEmail: ownerEmail,
      byNickname: ownerName,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
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
