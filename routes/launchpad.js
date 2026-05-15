const express = require('express');
const session = require('../services/session-service');
const templatesSvc = require('../services/templates-service');
const devicesSvc = require('../services/devices-service');
const actionEngine = require('../services/action-engine');
const chat = require('../services/chat-service');
const config = require('../config');
const { ownerLayout, escape } = require('../views/layout');
const { rtcClientJs } = require('../views/rtc-client');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Launchpad');
const router = express.Router();

function pill(state, label) {
  const cls = state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${escape(label)}</span>`;
}

function gauge(pct) {
  const r = 80, c = 2 * Math.PI * r;
  const filled = Math.min(100, Math.max(0, Number(pct) || 0));
  const dash = (filled / 100) * c;
  return `<svg viewBox="0 0 200 200" style="width:240px;height:240px">
    <circle cx="100" cy="100" r="${r}" stroke="#2a2f3a" stroke-width="22" fill="none"/>
    <circle cx="100" cy="100" r="${r}" stroke="#2a6df4" stroke-width="22" fill="none"
            stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}"
            stroke-linecap="round"
            transform="rotate(-90 100 100)"
            style="transition:stroke-dasharray 0.4s ease"/>
    <text x="100" y="108" text-anchor="middle" font-size="42" font-weight="700" fill="#e8e8e8">${filled.toFixed(0)}%</text>
    <text x="100" y="138" text-anchor="middle" font-size="14" fill="#7a8597">capacity</text>
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

  // Determine active milestone (if session running and template has milestones)
  let activeMilestone = null;
  if (state.active && templateProfile && templateProfile.milestones?.length) {
    activeMilestone = templateProfile.milestones
      .filter(m => state.capacity >= m.capacityMin && state.capacity <= m.capacityMax)
      .sort((a, b) => (b.capacityMin) - (a.capacityMin))[0] || null;
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
      <td><input type="checkbox" data-flag="canConnect" ${p.canConnect ? 'checked' : ''} onchange="lpSetFlag('${escape(p.email)}', 'canConnect', this.checked)"></td>
      <td><input type="checkbox" data-flag="canControl" ${p.canControl ? 'checked' : ''} onchange="lpSetFlag('${escape(p.email)}', 'canControl', this.checked)"></td>
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

    <div class="card">
      <h3>Owner display name</h3>
      <p>
        <input id="lp-owner-input" type="text" value="${escape(ownerDisplayName)}" placeholder="e.g. Airegasm" style="width:50%">
        <button onclick="lpSaveOwnerName()">Save</button>
        <span class="muted" style="font-size:0.9rem">Shown in chat as your nickname and in the browser tab title. Will move to the Chat/Webcam tab once that tab is built.</span>
      </p>
    </div>

    <div class="card">
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
    </div>

    <div class="grid-2">
      <div class="card" style="text-align:center">
        <h3>Capacity</h3>
        ${gauge(state.capacity)}
        <p class="muted" style="margin-top:8px">
          ${state.active
            ? (state.emergencyStopped ? pill('bad', 'E-STOP active')
              : state.paused ? pill('warn', 'paused')
              : pill('ok', 'running'))
            : pill('warn', 'idle')}
          ${state.pumpOn ? pill('ok', 'pump on') : pill('warn', 'pump off')}
        </p>
        <p class="muted" style="font-size:0.95rem">
          Active milestone: ${activeMilestone ? `<strong>${escape(activeMilestone.name)}</strong> (${activeMilestone.capacityMin}–${activeMilestone.capacityMax}%)` : '<em>none</em>'}<br>
          Running action: ${state.currentActionTemplateId ? `<strong>${escape(actionsById[state.currentActionTemplateId]?.name || '?')}</strong>` : '<em>idle</em>'}
        </p>
      </div>

      <div class="card">
        <h3>Currently Displayed Message</h3>
        <p style="font-size:1.15rem;line-height:1.5;min-height:80px">${state.active ? escape(state.currentDisplayMessage || '(none)') : escape(profile.welcomeMessage || '(no welcome message)')}</p>
        <p class="muted" style="font-size:0.9rem">${state.active
          ? (activeMilestone ? 'Showing milestone announcement.' : 'Showing welcome message until first milestone is reached.')
          : 'Visitors see the welcome message when no session is running.'}</p>
        <p><button onclick="lpEditWelcome()">Edit welcome message</button></p>
      </div>
    </div>

    <div class="card">
      <h3>Session controls</h3>
      <p>
        ${state.active
          ? `<button onclick="lpStop()" style="background:#7a3a3a">Stop Session</button>
             <button onclick="lpEstop()" style="background:#a13030;font-weight:700">E-STOP</button>
             <button onclick="lpTogglePause()">${state.paused ? 'Resume' : 'Pause'} Device Control</button>`
          : `<button onclick="lpStart()" ${sessionReady ? '' : 'disabled'}>Start Session</button>
             ${!sessionReady ? `<span class="muted" style="font-size:0.9rem">${!calibratedReady ? 'Primary pump must be calibrated.' : 'Add at least one allowed user.'}</span>` : ''}`}
      </p>
    </div>

    <div class="card">
      <h3>Available actions ${state.active ? '' : '<span class="muted" style="font-size:0.9rem;font-weight:normal">(session not running)</span>'}</h3>
      <div>${actionButtons}</div>
    </div>

    <div class="card">
      <h3>Allowed participants</h3>
      <p class="muted">Who can join when a session starts. Connect = can reach the visitor view. Control = can fire action templates.</p>
      <table style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;border-bottom:1px solid #2a2f3a">
          <th style="padding:8px 0">Nickname</th><th>Email</th><th>Connect</th><th>Control</th><th></th>
        </tr></thead>
        <tbody>${allowedRows || '<tr><td colspan="5" class="muted">No participants yet — pick from your account list below.</td></tr>'}</tbody>
      </table>
      ${ineligible.length ? `
        <p style="margin-top:16px">
          Add from accounts:
          <select id="lp-add-pick">${addParticipantOptions}</select>
          <button onclick="lpAddParticipant()">Add</button>
        </p>
      ` : '<p class="muted" style="margin-top:12px">All known accounts already added. Manage accounts on the Users tab.</p>'}
    </div>

    <div class="card">
      <h3>Webcam <span class="muted" style="font-size:0.9rem;font-weight:normal">— mode: ${escape(cfg.owner?.camera?.mode || 'off')}</span></h3>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
        <div>
          <div id="local-tile" style="width:220px;height:220px;background:#0a0c10;border:1px solid #2a2f3a;border-radius:10px;overflow:hidden;display:grid;place-items:center;color:#7a8597;font-size:0.95rem">Local cam off</div>
          <p style="margin:10px 0">
            <button id="btn-cam" onclick="lpToggleCam()">${cfg.owner?.camera?.mode === 'live' ? 'Stop camera' : 'Start camera'}</button>
            <button id="btn-vid" onclick="lpToggleVideo()" disabled>Mute video</button>
            <button id="btn-aud" onclick="lpToggleAudio()" disabled>Mute audio</button>
          </p>
        </div>
        <div>
          <h4 style="margin:0 0 8px">Remote (controllers)</h4>
          <div id="remote-tiles" style="display:flex;flex-wrap:wrap;gap:12px"></div>
        </div>
      </div>
      <p class="muted" style="font-size:0.95rem;margin-top:10px">Live mode mesh-publishes to viewers via WebRTC (≤5). Switch the mode on the Chat/Webcam tab. Snapshot mode uses the cam preview there.</p>
    </div>

    <div class="card">
      <h3>Chat ${profile.settings.chatroomEnabled ? '' : '<span class="muted" style="font-size:0.9rem;font-weight:normal">(disabled for visitors in this profile)</span>'}</h3>
      <div id="chat-log" style="height:320px;overflow-y:auto;background:#0a0c10;border:1px solid #2a2f3a;border-radius:8px;padding:14px;display:flex;flex-direction:column;gap:10px"></div>
      <p style="margin-top:12px">
        <input id="chat-input" type="text" placeholder="say something…" style="width:70%" onkeydown="if(event.key==='Enter') lpSendChat()">
        <button onclick="lpSendChat()">Send</button>
      </p>
      <p class="muted" style="font-size:0.9rem">Live in this owner GUI. Visitor-side chat view + kick/ban/mute land in 7b-iv.</p>
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
      async function lpSaveOwnerName() {
        const displayName = document.getElementById('lp-owner-input').value;
        const r = await fetch('/api/launchpad/owner', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ displayName }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        document.title = 'PumpDirect — ' + (displayName || 'owner');
        document.getElementById('lp-owner-name').textContent = displayName || 'owner';
        flash('owner name saved', 'ok');
      }
      async function lpSendChat() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        const r = await fetch('/api/launchpad/chat', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ text }) });
        if (!r.ok) { const d = await r.json(); flash(d.error || 'failed', 'bad'); }
      }
      function renderChatMessage(m) {
        const log = document.getElementById('chat-log');
        const row = document.createElement('div');
        const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (m.type === 'system') {
          row.innerHTML = '<span class="muted" style="font-style:italic;font-size:0.95rem">' + escapeHtml(m.text) + ' <span style="opacity:0.6">· ' + time + '</span></span>';
        } else if (m.type === 'image' && m.image && m.image.dataUrl) {
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span class="muted" style="font-size:0.8rem">' + time + '</span><br>' +
            '<img src="' + m.image.dataUrl + '" alt="snapshot" style="max-width:100%;width:320px;height:auto;border-radius:8px;display:block;margin-top:6px">';
        } else {
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span class="muted" style="font-size:0.8rem">' + time + '</span><br>' + escapeHtml(m.text);
        }
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
      function escapeHtml(s) { return String(s||'').replace(/[<>&"']/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
      function applyState(s) {
        // gauge
        const pct = Math.max(0, Math.min(100, s.capacity || 0));
        const r = 80, c = 2 * Math.PI * r, dash = (pct / 100) * c;
        const ring = document.querySelector('svg circle[stroke="#2a6df4"]');
        if (ring) ring.setAttribute('stroke-dasharray', dash.toFixed(1) + ' ' + (c - dash).toFixed(1));
        const text = document.querySelector('svg text');
        if (text) text.textContent = Math.round(pct) + '%';
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
        tile.innerHTML = '<video autoplay muted playsinline style="width:100%;height:100%;object-fit:cover"></video>';
        tile.querySelector('video').srcObject = stream;
      }
      function resetLocalTile() { document.getElementById('local-tile').textContent = 'Local cam off'; }
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
          if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: true }));
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
        t.enabled = !t.enabled;
        document.getElementById('btn-vid').textContent = t.enabled ? 'Mute video' : 'Unmute video';
      }
      function lpToggleAudio() {
        if (!localStream) return;
        const t = localStream.getAudioTracks()[0]; if (!t) return;
        t.enabled = !t.enabled;
        document.getElementById('btn-aud').textContent = t.enabled ? 'Mute audio' : 'Unmute audio';
      }
      function attachRemoteTile(email, stream) {
        let tile = document.getElementById('remote-' + cssId(email));
        if (!tile) {
          tile = document.createElement('div');
          tile.id = 'remote-' + cssId(email);
          tile.style.cssText = 'width:200px;height:200px;background:#0a0c10;border:1px solid #2a2f3a;border-radius:10px;overflow:hidden;position:relative';
          tile.innerHTML = '<video autoplay playsinline style="width:100%;height:100%;object-fit:cover"></video><div style="position:absolute;bottom:6px;left:8px;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:4px;font-size:0.85rem">' + escapeHtml(email) + '</div>';
          document.getElementById('remote-tiles').appendChild(tile);
        }
        tile.querySelector('video').srcObject = stream;
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
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === 'state') applyState(m.state);
          else if (m.type === 'chat') renderChatMessage(m.message);
          else if (m.type === 'chat-history') {
            const log = document.getElementById('chat-log');
            log.innerHTML = '';
            (m.messages || []).forEach(renderChatMessage);
          } else if (window.__rtc) {
            window.__rtc.onSignalingMsg(m);
            if (m.type === 'hello' && OWNER_CAM_MODE === 'live' && !localStream) lpStartCam();
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

router.post('/api/launchpad/profiles/:id/participants', (req, res) => {
  try {
    const profile = session.getProfile(req.params.id);
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) throw new Error('email required');
    if (profile.allowedParticipants.some(p => p.email === email)) throw new Error('already added');
    const next = [...profile.allowedParticipants, { email, canConnect: true, canControl: false }];
    session.updateProfile(req.params.id, { allowedParticipants: next });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/launchpad/profiles/:id/participants/:email', (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const profile = session.getProfile(req.params.id);
    const next = profile.allowedParticipants.filter(p => p.email !== email);
    session.updateProfile(req.params.id, { allowedParticipants: next });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/launchpad/profiles/:id/participants/:email', (req, res) => {
  try {
    const email = decodeURIComponent(req.params.email).toLowerCase();
    const profile = session.getProfile(req.params.id);
    const next = profile.allowedParticipants.map(p => p.email === email ? { ...p, ...req.body } : p);
    session.updateProfile(req.params.id, { allowedParticipants: next });
    // if session is active, also push to live state
    if (session.getState().active) {
      try { session.updateParticipantFlags(email, req.body); } catch {}
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/launchpad/session/start', (req, res) => {
  try {
    const state = session.startSession(req.body?.profileId);
    const profile = session.getProfile(state.sessionProfileId);
    actionEngine.resetForNewSession(profile.welcomeMessage);
    chat.system(`Session started: ${profile.name}`);
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
    if (!wasPaused) actionEngine.abort('device control paused');
    const state = session.setPaused(!wasPaused);
    chat.system(state.paused ? 'Device control paused' : 'Device control resumed');
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
