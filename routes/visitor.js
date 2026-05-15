const express = require('express');
const session = require('../services/session-service');
const templatesSvc = require('../services/templates-service');
const actionEngine = require('../services/action-engine');
const chat = require('../services/chat-service');
const config = require('../config');
const { rtcClientJs } = require('../views/rtc-client');
const { chatCryptoJs } = require('../views/chat-crypto');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Visitor');
const router = express.Router();

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function findAccount(email) {
  const cfg = config.load();
  return (cfg.accounts || []).find(a => a.email === email) || null;
}

function findParticipant(email) {
  const s = session.getState();
  return (s.participants || []).find(p => p.email === email) || null;
}

function activeProfile() {
  const s = session.getState();
  if (!s.sessionProfileId) return null;
  try { return session.getProfile(s.sessionProfileId); } catch { return null; }
}

function gauge(pct) {
  const r = 70, c = 2 * Math.PI * r;
  const cap = Math.max(0, Number(pct) || 0);
  const needle = Math.min(100, cap);
  const dash = (needle / 100) * c;
  const over = cap > 100;
  return `<svg id="gauge" viewBox="0 0 180 180" style="width:180px;height:180px">
    <circle cx="90" cy="90" r="${r}" stroke="#2a2f3a" stroke-width="20" fill="none"/>
    <circle id="gauge-fill" cx="90" cy="90" r="${r}" stroke="${over ? '#f0c674' : '#2a6df4'}" stroke-width="20" fill="none"
            stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}" stroke-linecap="round"
            transform="rotate(-90 90 90)" style="transition:stroke-dasharray 0.4s ease"/>
    <text id="gauge-pct" x="90" y="100" text-anchor="middle" font-size="38" font-weight="700" fill="${over ? '#f0c674' : '#e8e8e8'}">${cap.toFixed(0)}%</text>
  </svg>`;
}

function renderVisitorPage(req) {
  const email = req.user?.email || '';
  const cfg = config.load();
  const state = session.getState();
  const profile = activeProfile();
  const tplData = templatesSvc.load();
  const tpl = profile ? tplData.templateProfiles.find(p => p.id === profile.templateProfileId) : null;
  const actionsById = Object.fromEntries(tplData.actionTemplates.map(a => [a.id, a]));

  const account = findAccount(email);
  const nickname = account?.nickname || email.split('@')[0];

  const participant = findParticipant(email);
  const canConnect = !state.active || (participant && participant.canConnect !== false);
  const canControl = !!(state.active && participant && participant.canControl);
  const chatEnabled = !!(profile && profile.settings?.chatroomEnabled);

  // Resolve active milestone — at ≥100% capacity, is100Plus milestone wins.
  let activeMilestone = null;
  if (state.active && tpl && tpl.milestones?.length) {
    if (state.capacity >= 100) {
      activeMilestone = tpl.milestones.find(m => m.is100Plus) || null;
    }
    if (!activeMilestone) {
      activeMilestone = tpl.milestones
        .filter(m => !m.is100Plus && state.capacity >= m.capacityMin && state.capacity <= m.capacityMax)
        .sort((a, b) => b.capacityMin - a.capacityMin)[0] || null;
    }
  }
  const milestoneActionIds = activeMilestone ? (activeMilestone.actionTemplateIds || []) : [];
  const alwaysActionIds = tpl?.defaultActionTemplateIds || [];
  const visibleActionIds = state.active
    ? Array.from(new Set([...milestoneActionIds, ...alwaysActionIds]))
    : [];

  const css = `
    :root { color-scheme: dark; font-size: 18px; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #0f1115; color: #e8e8e8; line-height: 1.5; min-height: 100vh; display: flex; flex-direction: column; }
    .topbar { background: #161922; padding: 14px 16px; border-bottom: 1px solid #2a2f3a; display: flex; align-items: center; justify-content: space-between; }
    .topbar h1 { margin: 0; font-size: 1.1rem; font-weight: 600; }
    .you { font-size: 0.85rem; color: #7a8597; }
    main { flex: 1; padding: 18px 16px 18px; max-width: 1100px; margin: 0 auto; width: 100%; }
    .card { background: #161922; border: 1px solid #2a2f3a; border-radius: 12px; padding: 18px; margin-bottom: 16px; }
    .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 0.85rem; }
    .pill.ok { background: #133d2b; color: #6ddc9b; }
    .pill.warn { background: #4a3413; color: #f0c674; }
    .pill.bad { background: #4a1b1b; color: #f08484; }
    .action-btn { min-height: 56px; padding: 14px 18px; background: #2a6df4; color: #fff; border: 0; border-radius: 10px; font-size: 1rem; font-family: inherit; cursor: pointer; }
    .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .action-btn.running { background: #6ddc9b; color: #0f1115; }
    .top-row { display: grid; grid-template-columns: 300px 1fr; gap: 16px; margin-bottom: 16px; align-items: stretch; }
    .top-row > .card { margin: 0; min-height: 360px; }
    .gauge-card { display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .pump-status { font-size: 1.1rem; font-weight: 600; margin: 10px 0 0; min-height: 1.5em; color: #e8e8e8; }
    .pump-status .pump-state { color: #6ddc9b; }
    .pump-status.idle .pump-state { color: #7a8597; }
    .pump-status .pump-count { color: #f0c674; margin-left: 4px; font-weight: 500; }
    .cycle-status { font-size: 0.95rem; color: #f0c674; margin: 2px 0 0; min-height: 1.1em; }
    .milestone-pane .milestone-title { font-size: 1.5rem; font-weight: 700; margin: 0 0 10px; }
    .milestone-pane .milestone-announcement { font-size: 1.1rem; line-height: 1.5; min-height: 80px; margin: 0 0 18px; }
    .milestone-pane .action-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; }
    .cam-grid { display: flex; justify-content: center; align-items: flex-start; gap: 16px; flex-wrap: wrap; margin-bottom: 16px; width: 100%; }
    .cam-slot { flex: 1 1 0; min-width: 0; max-width: min(85vh, 80vw); display: flex; flex-direction: column; gap: 10px; align-items: stretch; }
    .cam-slot:empty { display: none; }
    .cam-tile { width: 100%; aspect-ratio: 1; background:#0a0c10; border:1px solid #2a2f3a; border-radius:14px; overflow:hidden; position:relative; }
    .cam-tile video { width:100%; height:100%; object-fit:cover; }
    .cam-tile .rt-label { position:absolute; bottom:8px; left:10px; background:rgba(0,0,0,0.65); padding:4px 10px; border-radius:6px; font-size:0.9rem; }
    .cam-tile .rt-ctrls { position:absolute; top:8px; right:8px; display:flex; gap:6px; }
    .cam-tile .rt-ctrls button { background:rgba(0,0,0,0.6); border:0; color:#fff; border-radius:6px; padding:6px 10px; font-size:1rem; cursor:pointer; }
    .cam-tile.muted-video video { visibility: hidden; }
    .chat-row { display: grid; grid-template-columns: 1fr 220px; gap: 12px; }
    .chat-row > .card { margin: 0; display: flex; flex-direction: column; }
    .chat-pane .chat-log { flex: 1; min-height: 280px; max-height: 56vh; overflow-y: auto; background:#0a0c10; border:1px solid #2a2f3a; border-radius:10px; padding:12px; display:flex; flex-direction:column; gap:10px; }
    .chat-pane .chat-input-row { margin-top: 10px; display: flex; gap: 8px; }
    .chat-pane .chat-input-row input { flex:1; min-height:48px; padding:12px 14px; background:#0a0c10; color:#e8e8e8; border:1px solid #2a2f3a; border-radius:10px; font-size:1rem; font-family:inherit; }
    .chat-pane .chat-input-row button { min-height:48px; padding:0 22px; background:#2a6df4; color:#fff; border:0; border-radius:10px; font-size:1rem; cursor:pointer; }
    .participants-pane .p-list { display: flex; flex-direction: column; gap: 6px; max-height: 56vh; overflow-y: auto; }
    .participants-pane .p-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background:#0a0c10; border:1px solid #2a2f3a; border-radius:6px; font-size: 0.95rem; }
    .presence-dot { width: 8px; height: 8px; border-radius: 50%; background:#7a8597; flex-shrink:0; }
    @media (max-width: 760px) {
      .top-row { grid-template-columns: 1fr; }
      .chat-row { grid-template-columns: 1fr; }
      .cam-slot { max-width: 100%; }
      .milestone-pane .action-grid { grid-template-columns: 1fr 1fr; }
    }
    #session-stage { position: relative; }
    #standby-overlay { display:none; position:absolute; inset:0; background: rgba(15,17,21,0.78); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); z-index: 50; align-items: center; justify-content: center; border-radius: 12px; }
    #standby-overlay.active { display: flex; }
    .standby-text { font-size: clamp(2.5rem, 12vw, 6rem); font-weight: 900; letter-spacing: 0.12em; text-transform: uppercase; color: #f0c674; text-shadow: 0 6px 40px rgba(0,0,0,0.6); text-align: center; padding: 0 20px; }
    #session-stage.standby > :not(#standby-overlay) { filter: grayscale(0.6); }
  `;

  if (!canConnect) {
    return `<!doctype html><html lang="en"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>PumpDirect</title><style>${css}</style></head>
      <body><main><div class="card"><h2>Not on the participant list</h2>
      <p style="font-size:1.05rem">Hi <strong>${escapeHtml(nickname)}</strong>. You're on the owner's account allowlist but haven't been added to the active session.</p>
      </div></main></body></html>`;
  }

  if (!state.active) {
    return `<!doctype html><html lang="en"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
      <title>PumpDirect</title>
      <style>
        ${css}
        body { display:flex; align-items:center; justify-content:center; }
        .splash { text-align:center; padding:40px 24px; max-width:520px; }
        .splash h1 { font-size:2rem; margin:0 0 18px; }
        .splash .welcome { font-size:1.1rem; color:#9aa4b2; line-height:1.5; margin:18px 0 0; }
        .splash .dot { display:inline-block; width:10px; height:10px; border-radius:50%; background:#7a8597; margin-right:8px; vertical-align:middle; animation:pulse 2s infinite; }
        @keyframes pulse { 0%,100%{opacity:0.4} 50%{opacity:1} }
      </style></head>
      <body>
        <div class="topbar" style="position:absolute;top:0;left:0;right:0">
          <h1>PumpDirect</h1>
          <span class="you">${escapeHtml(nickname)}</span>
        </div>
        <div class="splash">
          <h1><span class="dot"></span>No active session</h1>
          <p style="color:#9aa4b2">The owner hasn't started a session yet. This page will refresh automatically when one begins.</p>
          ${profile?.welcomeMessage ? `<p class="welcome">${escapeHtml(profile.welcomeMessage)}</p>` : ''}
        </div>
        <script>
          // Reload as soon as the session goes live.
          function connect() {
            const proto = location.protocol === 'https:' ? 'wss' : 'ws';
            const ws = new WebSocket(proto + '://' + location.host + '/ws/visitor');
            ws.onmessage = (e) => {
              const m = JSON.parse(e.data);
              if (m.type === 'state' && m.state && m.state.active) location.reload();
            };
            ws.onclose = () => setTimeout(connect, 1500);
          }
          connect();
        </script>
      </body></html>`;
  }

  const actionGrid = !state.active
    ? '<p class="muted" style="color:#7a8597">No active session.</p>'
    : !canControl
      ? '<p class="muted" style="color:#7a8597">You can watch + chat, but the owner has not enabled device control for you.</p>'
      : visibleActionIds.length
        ? `<div class="action-grid">${visibleActionIds.map(id => {
            const a = actionsById[id];
            return `<button class="action-btn" data-action-id="${escapeHtml(id)}" onclick="vFire('${escapeHtml(id)}')">${escapeHtml(a?.name || '?')}</button>`;
          }).join('')}</div>`
        : '<p class="muted" style="color:#7a8597">No actions available at this capacity.</p>';

  // Participant list — live during session, allowlist preview when idle.
  const ownerEmailCfg = cfg.cloudflare?.ownerEmail || '';
  const partList = (state.active ? (state.participants || []) : (profile?.allowedParticipants || []))
    .map(p => {
      const nick = (cfg.accounts || []).find(a => a.email === p.email)?.nickname || (p.email.split('@')[0]);
      const isOwner = p.email === ownerEmailCfg;
      const isMe = p.email === email;
      return `<div class="p-item">
        <span class="presence-dot"></span>
        <span>${escapeHtml(nick)}${isOwner ? ' <span class="pill ok" style="font-size:0.7rem;padding:1px 6px">owner</span>' : ''}${isMe ? ' <span class="muted" style="font-size:0.8rem">(you)</span>' : ''}</span>
      </div>`;
    }).join('');

  return `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>PumpDirect${profile ? ' — ' + escapeHtml(profile.name) : ''}</title><style>${css}</style>
  </head><body>
    <div class="topbar">
      <h1>PumpDirect</h1>
      <span class="you">${escapeHtml(nickname)}</span>
    </div>
    <main>
      <div id="session-stage">
        <div id="standby-overlay"><div class="standby-text">Please Stand By</div></div>
      <div class="top-row">
        <div class="card gauge-card">
          ${gauge(state.capacity)}
          <p class="pump-status ${state.pumpOn ? '' : 'idle'}" id="pump-status">
            Pump: <span class="pump-state">${state.pumpOn ? 'Running' : 'Idle'}</span><span class="pump-count" id="pump-count"></span>
          </p>
          <p class="cycle-status" id="cycle-status"></p>
        </div>
        <div class="card milestone-pane">
          <p class="milestone-title">${activeMilestone ? escapeHtml(activeMilestone.name) : (state.active ? escapeHtml(tpl?.name || 'Default') : 'Idle')}</p>
          <p class="milestone-announcement">${state.active ? escapeHtml(state.currentDisplayMessage || profile?.welcomeMessage || '') : escapeHtml(profile?.welcomeMessage || '')}</p>
          ${actionGrid}
        </div>
      </div>

      <div class="cam-grid">
        <div class="cam-slot" id="cam-controller-slot"></div>
        <div class="cam-slot" id="cam-owner-slot"></div>
      </div>
      </div><!-- /session-stage -->

      <div class="card" id="cam-broadcast-card" style="display:none">
        <h3 style="margin:0 0 8px;font-size:1.05rem">Your webcam</h3>
        <p id="cam-broadcast-msg" class="muted" style="margin:0 0 12px;font-size:0.95rem">You have been given cam broadcast permissions. Your preview will appear in the cam grid above.</p>
        <p style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0">
          <button id="cam-broadcast-btn" class="action-btn" onclick="vToggleBroadcast()">Enable my webcam</button>
          <span id="cam-broadcast-controls" style="display:none">
            <button id="my-vid-btn" onclick="vMuteMyVideo()">Hide video</button>
            <button id="my-aud-btn" onclick="vMuteMyAudio()">Mute audio</button>
          </span>
        </p>
      </div>

      <div class="chat-row">
        <div class="card chat-pane">
          <h3 style="margin:0 0 10px;font-size:1.05rem">Chat${chatEnabled ? '' : ' <span class="muted" style="font-size:0.9rem;font-weight:normal">(disabled)</span>'}</h3>
          <div id="chat-log" class="chat-log"></div>
          ${chatEnabled ? `
            <div class="chat-input-row">
              <input id="chat-input" type="text" placeholder="say something…" autocomplete="off" enterkeyhint="send" onkeydown="if(event.key==='Enter') vSend()">
              <button onclick="vSend()">Send</button>
            </div>` : ''}
        </div>
        <div class="card participants-pane">
          <h3 style="margin:0 0 10px;font-size:1.05rem">Participants</h3>
          <div class="p-list">${partList || '<p class="muted" style="font-size:0.9rem">No one yet.</p>'}</div>
        </div>
      </div>
    </main>

    <!-- Age-confirmation gate. Sessions only count once the owner runs them, so
         this fires only when state.active is true. Stored in sessionStorage so it
         appears once per browser session, not on every page reload. -->
    <div id="age-gate" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.9);z-index:9999;align-items:center;justify-content:center;padding:24px">
      <div style="max-width:520px;background:#161922;border:1px solid #f0c674;border-radius:14px;padding:30px;text-align:center">
        <h1 style="font-size:1.6rem;margin:0 0 14px;color:#f0c674">Age confirmation required</h1>
        <p style="font-size:1.05rem;line-height:1.5;margin:0 0 18px">
          By continuing, you confirm that you are <strong>at least 18 years of age, or 21 if the law in your jurisdiction requires it</strong> to engage with this content.
        </p>
        <p style="font-size:0.95rem;color:#9aa4b2;margin:0 0 22px">
          The owner of this instance is responsible for verifying participant ages and consent. If you are not of legal age, leave this page now.
        </p>
        <p style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin:0">
          <button onclick="vAgeConfirm()" class="action-btn">I am of legal age — continue</button>
          <button onclick="vAgeDecline()" style="background:#4a1b1b">Leave</button>
        </p>
      </div>
    </div>

    <script>
      ${rtcClientJs({ myEmail: email })}
      ${chatCryptoJs()}
    </script>
    <script>
      const CAN_CONTROL = ${JSON.stringify(canControl)};
      const CHAT_ENABLED = ${JSON.stringify(chatEnabled)};
      const NICKNAME = ${JSON.stringify(nickname)};
      const MY_EMAIL = ${JSON.stringify(email)};
      // Show age gate on a live session unless already confirmed this browser session.
      if (!sessionStorage.getItem('pd_age_ok')) {
        document.getElementById('age-gate').style.display = 'flex';
      }
      function vAgeConfirm() {
        sessionStorage.setItem('pd_age_ok', '1');
        document.getElementById('age-gate').style.display = 'none';
      }
      function vAgeDecline() {
        window.location.href = 'about:blank';
      }
      let wsSig = null;
      function cssId(s) { return String(s).replace(/[^a-z0-9_-]/gi, '_'); }
      function attachRemoteTile(email, stream, nickname, isOwner) {
        const label = nickname || email;
        let tile = document.getElementById('rt-' + cssId(email));
        if (!tile) {
          tile = document.createElement('div');
          tile.id = 'rt-' + cssId(email);
          tile.className = 'cam-tile';
          tile.innerHTML =
            '<video autoplay playsinline></video>' +
            '<div class="rt-label"></div>' +
            '<div class="rt-ctrls">' +
              '<button data-act="hide">👁</button>' +
              '<button data-act="mute">🔊</button>' +
            '</div>';
          const slot = isOwner
            ? document.getElementById('cam-owner-slot')
            : document.getElementById('cam-controller-slot');
          slot.appendChild(tile);
          const v = tile.querySelector('video');
          const hideBtn = tile.querySelector('button[data-act="hide"]');
          const muteBtn = tile.querySelector('button[data-act="mute"]');
          hideBtn.onclick = () => { const hidden = tile.classList.toggle('muted-video'); hideBtn.textContent = hidden ? '🚫' : '👁'; };
          muteBtn.onclick = () => { v.muted = !v.muted; muteBtn.textContent = v.muted ? '🔇' : '🔊'; };
        }
        tile.querySelector('.rt-label').textContent = label;
        tile.querySelector('video').srcObject = stream;
      }
      function removeRemoteTile(email) {
        const tile = document.getElementById('rt-' + cssId(email));
        if (tile) tile.remove();
      }
      function escapeHtml(s) { return String(s||'').replace(/[<>&"']/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
      let myBroadcastStream = null;
      function addLocalBroadcastTile(stream) {
        const slot = document.getElementById('cam-controller-slot');
        let tile = document.getElementById('local-broadcast-tile');
        if (!tile) {
          tile = document.createElement('div');
          tile.id = 'local-broadcast-tile';
          tile.className = 'cam-tile';
          tile.innerHTML = '<video autoplay muted playsinline></video><div class="rt-label">' + escapeHtml(NICKNAME) + ' (you)</div>';
          slot.insertBefore(tile, slot.firstChild);
        }
        tile.querySelector('video').srcObject = stream;
      }
      function removeLocalBroadcastTile() {
        const tile = document.getElementById('local-broadcast-tile');
        if (tile) tile.remove();
      }
      async function vToggleBroadcast() {
        const btn = document.getElementById('cam-broadcast-btn');
        const controls = document.getElementById('cam-broadcast-controls');
        if (myBroadcastStream) {
          myBroadcastStream.getTracks().forEach(t => t.stop());
          myBroadcastStream = null;
          removeLocalBroadcastTile();
          controls.style.display = 'none';
          btn.textContent = 'Enable my webcam';
          if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: false }));
          if (window.__rtc) window.__rtc.tearDownAll();
          return;
        }
        try {
          try {
            myBroadcastStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
          } catch (e1) {
            myBroadcastStream = await navigator.mediaDevices.getUserMedia({ video: true });
          }
          addLocalBroadcastTile(myBroadcastStream);
          controls.style.display = '';
          document.getElementById('my-vid-btn').textContent = 'Hide video';
          document.getElementById('my-aud-btn').textContent = 'Mute audio';
          document.getElementById('my-aud-btn').disabled = !myBroadcastStream.getAudioTracks()[0];
          btn.textContent = 'Stop broadcasting';
          if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: true }));
          if (window.__rtc) await window.__rtc.publishToAll();
        } catch (e) { alert('Camera failed: ' + e.message); }
      }
      function vMuteMyVideo() {
        if (!myBroadcastStream) return;
        const t = myBroadcastStream.getVideoTracks()[0]; if (!t) return;
        t.enabled = !t.enabled;
        document.getElementById('my-vid-btn').textContent = t.enabled ? 'Hide video' : 'Show video';
      }
      function vMuteMyAudio() {
        if (!myBroadcastStream) return;
        const t = myBroadcastStream.getAudioTracks()[0]; if (!t) return;
        t.enabled = !t.enabled;
        document.getElementById('my-aud-btn').textContent = t.enabled ? 'Mute audio' : 'Unmute audio';
      }
      function applyBroadcastCard(s) {
        const card = document.getElementById('cam-broadcast-card');
        if (!card) return;
        const myP = (s.participants || []).find(p => p.email === MY_EMAIL);
        const allowed = CAN_CONTROL && s?.ownerCamera?.allowControllerBroadcast && !!(myP && myP.canBroadcast);
        card.style.display = allowed ? '' : 'none';
        if (!allowed && myBroadcastStream) {
          myBroadcastStream.getTracks().forEach(t => t.stop());
          myBroadcastStream = null;
          removeLocalBroadcastTile();
          document.getElementById('cam-broadcast-controls').style.display = 'none';
          document.getElementById('cam-broadcast-btn').textContent = 'Enable my webcam';
        }
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

      function applyStandby(s) {
        const stage = document.getElementById('session-stage');
        const overlay = document.getElementById('standby-overlay');
        const text = overlay && overlay.querySelector('.standby-text');
        if (!stage || !overlay) return;
        const standby = s.active && (s.paused || s.emergencyStopped);
        stage.classList.toggle('standby', standby);
        overlay.classList.toggle('active', standby);
        if (text) {
          if (s.emergencyStopped) { text.textContent = 'E-STOP'; text.style.color = '#f08484'; }
          else { text.textContent = 'Please Stand By'; text.style.color = '#f0c674'; }
        }
      }
      function applyState(s) {
        applyStandby(s);
        __pumpOnState = !!s.pumpOn;
        __stepState = s.currentStep || null;
        __repeatState = s.currentRepeat || null;
        renderPumpLine();
        // If my own participant flags changed since page load, reload so server-rendered
        // sections (action buttons / "not in session" banner / etc.) match the new permissions.
        const myP = (s.participants || []).find(p => p.email === MY_EMAIL);
        const sig = myP ? (Number(!!myP.canConnect) + ':' + Number(!!myP.canControl) + ':' + Number(!!myP.canBroadcast) + ':' + Number(!!myP.muted)) : 'gone';
        if (window.__mySig !== undefined && window.__mySig !== sig && s.active) {
          location.reload();
          return;
        }
        window.__mySig = sig;
        applyBroadcastCard(s);
        const r = 70, c = 2 * Math.PI * r;
        const cap = Math.max(0, s.capacity || 0);
        const needle = Math.min(100, cap);
        const over = cap > 100;
        const dash = (needle / 100) * c;
        const fill = document.getElementById('gauge-fill');
        if (fill) {
          fill.setAttribute('stroke-dasharray', dash.toFixed(1) + ' ' + (c - dash).toFixed(1));
          fill.setAttribute('stroke', over ? '#f0c674' : '#2a6df4');
        }
        const text = document.getElementById('gauge-pct');
        if (text) { text.textContent = Math.round(cap) + '%'; text.setAttribute('fill', over ? '#f0c674' : '#e8e8e8'); }
        // action button lock
        const running = s.currentActionTemplateId;
        document.querySelectorAll('.action-btn').forEach(btn => {
          const id = btn.dataset.actionId;
          if (running) {
            btn.disabled = running !== id;
            if (running === id) btn.classList.add('running');
            else btn.classList.remove('running');
          } else {
            btn.disabled = false;
            btn.classList.remove('running');
          }
        });
        // if session went idle (active→false) or vice versa, reload to re-render layout
        if (s.active !== window.__visitorActive) {
          if (window.__visitorActive !== undefined) location.reload();
          window.__visitorActive = s.active;
        }
      }
      async function renderChat(m) {
        const log = document.getElementById('chat-log');
        if (!log) return;
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
            imageDataUrl = m.image.dataUrl;
          }
        }
        const row = document.createElement('div');
        row.className = 'chat-row' + (m.type === 'system' ? ' system' : '');
        const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (m.type === 'system') {
          row.innerHTML = escapeHtml(text) + ' <span style="opacity:0.6">· ' + time + '</span>';
        } else if (m.type === 'image' && imageDataUrl) {
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span style="opacity:0.6;font-size:0.85rem">' + time + '</span><br>' +
            '<img src="' + imageDataUrl + '" alt="snapshot" style="max-width:100%;width:280px;height:auto;border-radius:8px;display:block;margin-top:6px">';
        } else {
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span style="opacity:0.6;font-size:0.85rem">' + time + '</span><br>' + escapeHtml(text);
        }
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
      async function vFire(id) {
        const r = await fetch('/api/visitor/fire-action', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ actionTemplateId: id }) });
        if (!r.ok) { const d = await r.json(); alert(d.error || 'failed'); }
      }
      async function vSend() {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        // E2EE: encrypt client-side so server (and CF edge) only see ciphertext.
        const encrypted = window.__chat?.ready() ? await window.__chat.encrypt(text) : null;
        const body = encrypted ? { encrypted } : { text };
        const r = await fetch('/api/visitor/chat', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
        if (!r.ok) { const d = await r.json(); alert(d.error || 'failed'); }
      }
      function connect() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(proto + '://' + location.host + '/ws/visitor');
        wsSig = ws;
        if (window.__rtc) {
          window.__rtc.init({
            sendSig: (obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); },
            getLocalStream: () => myBroadcastStream,
            onRemoteStream: attachRemoteTile,
            onRemoteGone: removeRemoteTile,
          });
        }
        ws.onmessage = async (e) => {
          const m = JSON.parse(e.data);
          if (m.type === 'state') applyState(m.state);
          else if (m.type === 'chat-key') {
            const buffered = await window.__chat.setKey(m.key);
            if (buffered && buffered.length) buffered.forEach(renderChat);
          }
          else if (m.type === 'chat') renderChat(m.message);
          else if (m.type === 'chat-history') {
            const log = document.getElementById('chat-log');
            if (log) { log.innerHTML = ''; (m.messages || []).forEach(renderChat); }
          } else if (window.__rtc) {
            window.__rtc.onSignalingMsg(m);
          }
        };
        ws.onclose = () => { wsSig = null; setTimeout(connect, 1500); };
      }
      connect();
    </script>
  </body></html>`;
}

router.get('/', (req, res) => {
  res.type('html').send(renderVisitorPage(req));
});

router.post('/api/visitor/chat', (req, res) => {
  const email = req.user?.email;
  if (!email) return res.status(401).json({ error: 'unauthenticated' });
  const profile = activeProfile();
  if (!profile?.settings?.chatroomEnabled) return res.status(403).json({ error: 'chat is disabled in this session' });
  const participant = findParticipant(email);
  if (session.getState().active && (!participant || participant.canConnect === false)) {
    return res.status(403).json({ error: 'not in this session' });
  }
  if (participant?.muted) return res.status(403).json({ error: 'you are muted' });
  const account = findAccount(email);
  const nickname = account?.nickname || email.split('@')[0];
  const encrypted = typeof req.body?.encrypted === 'string' ? req.body.encrypted : null;
  const text = (req.body?.text || '').trim();
  if (!encrypted && !text) return res.status(400).json({ error: 'empty message' });
  chat.push({ fromEmail: email, fromNickname: nickname, text, encrypted });
  res.json({ ok: true });
});

router.post('/api/visitor/fire-action', async (req, res) => {
  const email = req.user?.email;
  if (!email) return res.status(401).json({ error: 'unauthenticated' });
  const state = session.getState();
  if (!state.active) return res.status(400).json({ error: 'no active session' });
  const participant = findParticipant(email);
  if (!participant || !participant.canControl) {
    return res.status(403).json({ error: 'you do not have device control permission for this session' });
  }
  const account = findAccount(email);
  const nickname = account?.nickname || email.split('@')[0];
  try {
    await actionEngine.fireAction({
      actionTemplateId: req.body?.actionTemplateId,
      byEmail: email,
      byNickname: nickname,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = { router, renderVisitorPage };
