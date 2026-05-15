const express = require('express');
const session = require('../services/session-service');
const templatesSvc = require('../services/templates-service');
const actionEngine = require('../services/action-engine');
const chat = require('../services/chat-service');
const config = require('../config');
const { rtcClientJs } = require('../views/rtc-client');
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
  const filled = Math.min(100, Math.max(0, Number(pct) || 0));
  const dash = (filled / 100) * c;
  return `<svg id="gauge" viewBox="0 0 180 180" style="width:180px;height:180px">
    <circle cx="90" cy="90" r="${r}" stroke="#2a2f3a" stroke-width="20" fill="none"/>
    <circle id="gauge-fill" cx="90" cy="90" r="${r}" stroke="#2a6df4" stroke-width="20" fill="none"
            stroke-dasharray="${dash.toFixed(1)} ${(c - dash).toFixed(1)}" stroke-linecap="round"
            transform="rotate(-90 90 90)" style="transition:stroke-dasharray 0.4s ease"/>
    <text id="gauge-pct" x="90" y="100" text-anchor="middle" font-size="38" font-weight="700" fill="#e8e8e8">${filled.toFixed(0)}%</text>
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

  // Resolve action buttons (same logic as owner side)
  let activeMilestone = null;
  if (state.active && tpl && tpl.milestones?.length) {
    activeMilestone = tpl.milestones
      .filter(m => state.capacity >= m.capacityMin && state.capacity <= m.capacityMax)
      .sort((a, b) => b.capacityMin - a.capacityMin)[0] || null;
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
    main { flex: 1; padding: 18px 16px 110px; max-width: 720px; margin: 0 auto; width: 100%; }
    .card { background: #161922; border: 1px solid #2a2f3a; border-radius: 12px; padding: 18px; margin-bottom: 16px; }
    .gauge-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-size: 0.85rem; }
    .pill.ok { background: #133d2b; color: #6ddc9b; }
    .pill.warn { background: #4a3413; color: #f0c674; }
    .pill.bad { background: #4a1b1b; color: #f08484; }
    .message { font-size: 1.1rem; line-height: 1.5; min-height: 60px; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .action-btn { min-height: 56px; padding: 14px 18px; background: #2a6df4; color: #fff; border: 0; border-radius: 10px; font-size: 1rem; font-family: inherit; cursor: pointer; }
    .action-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .action-btn.running { background: #6ddc9b; color: #0f1115; }
    .chat-log { height: 280px; overflow-y: auto; background: #0a0c10; border: 1px solid #2a2f3a; border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 10px; font-size: 1rem; }
    .chat-row { line-height: 1.4; }
    .chat-row.system { color: #7a8597; font-style: italic; font-size: 0.95rem; }
    .chat-bar { position: fixed; bottom: 0; left: 0; right: 0; background: #161922; border-top: 1px solid #2a2f3a; padding: 12px 16px calc(12px + env(safe-area-inset-bottom)); display: flex; gap: 10px; }
    .chat-bar input { flex: 1; min-height: 48px; padding: 12px 14px; background: #0a0c10; color: #e8e8e8; border: 1px solid #2a2f3a; border-radius: 10px; font-size: 1rem; font-family: inherit; }
    .chat-bar button { min-height: 48px; padding: 0 22px; background: #2a6df4; color: #fff; border: 0; border-radius: 10px; font-size: 1rem; font-family: inherit; cursor: pointer; }
    @media (min-width: 720px) {
      .actions { grid-template-columns: repeat(3, 1fr); }
    }
  `;

  if (!canConnect) {
    return `<!doctype html><html lang="en"><head>
      <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>PumpDirect</title><style>${css}</style></head>
      <body><main><div class="card"><h2>Not on the participant list</h2>
      <p class="message">Hi <strong>${escapeHtml(nickname)}</strong>. You're on the owner's account allowlist but haven't been added to the active session.</p>
      </div></main></body></html>`;
  }

  const messageBlock = state.active
    ? `<p class="message">${escapeHtml(state.currentDisplayMessage || profile?.welcomeMessage || '')}</p>`
    : `<p class="message">${escapeHtml(profile?.welcomeMessage || cfg.cloudflare?.hostname ? 'Session not active.' : '')}</p>`;

  const actionsBlock = !state.active
    ? '<p class="muted" style="color:#7a8597">No active session.</p>'
    : !canControl
      ? '<p class="muted" style="color:#7a8597">You can watch + chat, but the owner has not enabled device control for you.</p>'
      : visibleActionIds.length
        ? `<div class="actions">${visibleActionIds.map(id => {
            const a = actionsById[id];
            return `<button class="action-btn" data-action-id="${escapeHtml(id)}" onclick="vFire('${escapeHtml(id)}')">${escapeHtml(a?.name || '?')}</button>`;
          }).join('')}</div>`
        : '<p class="muted" style="color:#7a8597">No actions available at this capacity.</p>';

  const chatBlock = chatEnabled
    ? `<div class="card">
        <h3 style="margin:0 0 12px;font-size:1.05rem">Chat</h3>
        <div id="chat-log" class="chat-log"></div>
      </div>
      <div class="chat-bar">
        <input id="chat-input" type="text" placeholder="say something…" autocomplete="off" enterkeyhint="send" onkeydown="if(event.key==='Enter') vSend()">
        <button onclick="vSend()">Send</button>
      </div>`
    : '<p class="muted" style="color:#7a8597">Chat is disabled in this session profile.</p>';

  return `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
    <title>PumpDirect${profile ? ' — ' + escapeHtml(profile.name) : ''}</title><style>${css}</style>
  </head><body>
    <div class="topbar">
      <h1>PumpDirect</h1>
      <span class="you">${escapeHtml(nickname)}</span>
    </div>
    <main>
      <div class="card gauge-wrap">
        ${gauge(state.capacity)}
        <p>
          ${state.active
            ? (state.emergencyStopped ? '<span class="pill bad">E-STOP</span>'
              : state.paused ? '<span class="pill warn">paused</span>'
              : '<span class="pill ok">live</span>')
            : '<span class="pill warn">idle</span>'}
          <span id="gauge-milestone" class="pill ${activeMilestone ? 'ok' : 'warn'}" style="margin-left:8px">${activeMilestone ? escapeHtml(activeMilestone.name) : 'no milestone'}</span>
        </p>
      </div>

      <div class="card">
        ${messageBlock}
      </div>

      <div class="card" id="cam-tiles-card" style="display:none">
        <h3 style="margin:0 0 12px;font-size:1.05rem">Cams</h3>
        <div id="remote-tiles" style="display:flex;flex-wrap:wrap;gap:10px"></div>
      </div>

      <div class="card">
        <h3 style="margin:0 0 12px;font-size:1.05rem">Actions</h3>
        <div id="actions-host">${actionsBlock}</div>
      </div>

      <div class="card" id="cam-broadcast-card" style="display:none">
        <h3 style="margin:0 0 8px;font-size:1.05rem">Webcam broadcast</h3>
        <p id="cam-broadcast-msg" style="margin:0 0 12px">You have been given cam broadcast permissions.</p>
        <p><button id="cam-broadcast-btn" class="action-btn" onclick="vToggleBroadcast()">Enable my webcam</button></p>
        <video id="cam-broadcast-preview" autoplay muted playsinline style="display:none;width:180px;height:180px;object-fit:cover;border-radius:10px;margin-top:10px"></video>
      </div>

      ${chatBlock}
    </main>

    <script>
      ${rtcClientJs({ myEmail: email })}
    </script>
    <script>
      const CAN_CONTROL = ${JSON.stringify(canControl)};
      const CHAT_ENABLED = ${JSON.stringify(chatEnabled)};
      const NICKNAME = ${JSON.stringify(nickname)};
      const MY_EMAIL = ${JSON.stringify(email)};
      let wsSig = null;
      function cssId(s) { return String(s).replace(/[^a-z0-9_-]/gi, '_'); }
      function attachRemoteTile(email, stream) {
        const card = document.getElementById('cam-tiles-card');
        card.style.display = '';
        let tile = document.getElementById('rt-' + cssId(email));
        if (!tile) {
          tile = document.createElement('div');
          tile.id = 'rt-' + cssId(email);
          tile.style.cssText = 'width:46vw;max-width:200px;aspect-ratio:1/1;background:#0a0c10;border:1px solid #2a2f3a;border-radius:10px;overflow:hidden;position:relative';
          tile.innerHTML = '<video autoplay playsinline style="width:100%;height:100%;object-fit:cover"></video><div style="position:absolute;bottom:6px;left:8px;background:rgba(0,0,0,0.6);padding:2px 8px;border-radius:4px;font-size:0.8rem">' + escapeHtml(email) + '</div>';
          document.getElementById('remote-tiles').appendChild(tile);
        }
        tile.querySelector('video').srcObject = stream;
      }
      function removeRemoteTile(email) {
        const tile = document.getElementById('rt-' + cssId(email));
        if (tile) tile.remove();
        if (!document.getElementById('remote-tiles').children.length) {
          document.getElementById('cam-tiles-card').style.display = 'none';
        }
      }
      function escapeHtml(s) { return String(s||'').replace(/[<>&"']/g, c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;'}[c])); }
      let myBroadcastStream = null;
      async function vToggleBroadcast() {
        const btn = document.getElementById('cam-broadcast-btn');
        const preview = document.getElementById('cam-broadcast-preview');
        if (myBroadcastStream) {
          myBroadcastStream.getTracks().forEach(t => t.stop());
          myBroadcastStream = null;
          preview.srcObject = null;
          preview.style.display = 'none';
          btn.textContent = 'Enable my webcam';
          if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: false }));
          if (window.__rtc) window.__rtc.tearDownAll();
          return;
        }
        try {
          myBroadcastStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true });
          preview.srcObject = myBroadcastStream;
          preview.style.display = '';
          btn.textContent = 'Stop broadcasting';
          if (wsSig?.readyState === 1) wsSig.send(JSON.stringify({ type: 'broadcast-state', broadcasting: true }));
          if (window.__rtc) await window.__rtc.publishToAll();
        } catch (e) { alert('Camera failed: ' + e.message); }
      }
      function applyBroadcastCard(s) {
        const card = document.getElementById('cam-broadcast-card');
        if (!card) return;
        const allowed = CAN_CONTROL && s?.ownerCamera?.allowControllerBroadcast;
        card.style.display = allowed ? '' : 'none';
        if (!allowed && myBroadcastStream) {
          myBroadcastStream.getTracks().forEach(t => t.stop());
          myBroadcastStream = null;
          const preview = document.getElementById('cam-broadcast-preview');
          preview.srcObject = null;
          preview.style.display = 'none';
          document.getElementById('cam-broadcast-btn').textContent = 'Enable my webcam';
        }
      }
      function applyState(s) {
        applyBroadcastCard(s);
        const r = 70, c = 2 * Math.PI * r;
        const pct = Math.max(0, Math.min(100, s.capacity || 0));
        const dash = (pct / 100) * c;
        const fill = document.getElementById('gauge-fill');
        if (fill) fill.setAttribute('stroke-dasharray', dash.toFixed(1) + ' ' + (c - dash).toFixed(1));
        const text = document.getElementById('gauge-pct');
        if (text) text.textContent = Math.round(pct) + '%';
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
      function renderChat(m) {
        const log = document.getElementById('chat-log');
        if (!log) return;
        const row = document.createElement('div');
        row.className = 'chat-row' + (m.type === 'system' ? ' system' : '');
        const time = new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        if (m.type === 'system') {
          row.innerHTML = escapeHtml(m.text) + ' <span style="opacity:0.6">· ' + time + '</span>';
        } else if (m.type === 'image' && m.image && m.image.dataUrl) {
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span style="opacity:0.6;font-size:0.85rem">' + time + '</span><br>' +
            '<img src="' + m.image.dataUrl + '" alt="snapshot" style="max-width:100%;width:280px;height:auto;border-radius:8px;display:block;margin-top:6px">';
        } else {
          row.innerHTML = '<strong style="color:#6ddc9b">' + escapeHtml(m.fromNickname) + '</strong> <span style="opacity:0.6;font-size:0.85rem">' + time + '</span><br>' + escapeHtml(m.text);
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
        const r = await fetch('/api/visitor/chat', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ text }) });
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
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === 'state') applyState(m.state);
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
  const text = (req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty message' });
  chat.push({ fromEmail: email, fromNickname: nickname, text });
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
