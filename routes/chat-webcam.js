const express = require('express');
const config = require('../config');
const chat = require('../services/chat-service');
const session = require('../services/session-service');
const { emitState } = require('../services/event-bus');
const { ownerLayout, escape } = require('../views/layout');
const { createLogger } = require('../utils/logger');

const logger = createLogger('ChatWebcam');
const router = express.Router();

router.get('/chat-webcam', (_req, res) => {
  const cfg = config.load();
  const owner = cfg.owner || {};
  const cam = owner.camera || { mode: 'off', resolution: { width: 1280, height: 720 }, snapshotEveryPct: 5 };
  const camRes = cam.resolution || { width: 1280, height: 720 };
  const chatGlobalOn = cfg.chat?.enabled !== false;

  const body = `
    <h2>Chat / Webcam</h2>

    <div class="card">
      <h3>Chat</h3>
      <p>
        <label style="font-size:1.05rem"><input id="cw-chat-enable" type="checkbox" ${chatGlobalOn ? 'checked' : ''}> <strong>Enable chat for visitors</strong></label>
      </p>
      <p class="muted" style="font-size:0.95rem;margin:0">
        Master switch. When off, all connected visitors lose chat — the input box is hidden and any send attempt is rejected.
        <strong>You (the host) can always chat regardless.</strong> Per-participant overrides live in the Launchpad participant list (Ch column); revoked users stay revoked even if you flip this back on.
      </p>
    </div>

    <div class="card">
      <h3>Owner display name</h3>
      <p>
        <input id="cw-name" type="text" value="${escape(owner.displayName || '')}" placeholder="e.g. Airegasm" style="width:60%" onblur="cwSaveName(true)" onkeydown="if(event.key==='Enter') cwSaveName(true)">
        <button onclick="cwSaveName()">Save</button>
        <span class="muted" style="font-size:0.95rem">Saves automatically when you click out or hit Enter — Save button is optional. Shown in chat and in the browser tab title.</span>
      </p>
    </div>

    <div class="card">
      <h3>Webcam mode</h3>
      <p>
        <label style="margin-right:18px"><input type="radio" name="cw-mode" value="off" ${cam.mode === 'off' ? 'checked' : ''}> Off</label>
        <label style="margin-right:18px"><input type="radio" name="cw-mode" value="live" ${cam.mode === 'live' ? 'checked' : ''}> Live</label>
        <label><input type="radio" name="cw-mode" value="snapshot" ${cam.mode === 'snapshot' ? 'checked' : ''}> Snapshot</label>
      </p>
      <p class="muted" style="font-size:0.95rem">
        <strong>Off</strong>: nothing sent to visitors.
        <strong>Live</strong>: stream your cam to visitors (WebRTC mesh, max 5 — wiring in 7b-iv).
        <strong>Snapshot</strong>: grab a single frame and post it to chat whenever the session capacity climbs by the threshold below.
      </p>
      <p id="cw-snap-row" style="${cam.mode === 'snapshot' ? '' : 'display:none'}">
        <label>Send snap every
          <input id="cw-thresh" type="number" min="1" max="100" step="1" value="${escape(String(cam.snapshotEveryPct || 5))}" style="width:80px">
        % capacity increase (up to 100%)</label>
      </p>
      <p style="margin-top:14px;border-top:1px solid #2a2f3a;padding-top:14px">
        <label><input id="cw-allow-ctrl-cam" type="checkbox" ${cam.allowControllerBroadcast ? 'checked' : ''}> Allow controllers to broadcast webcam</label>
        <span class="muted" style="font-size:0.95rem;display:block;margin-top:4px">When on, allowlisted controllers (visitors with the Control tickbox) see an opt-in "enable my cam" button on their side. They never publish unless they tap it.</span>
      </p>
    </div>

    <div class="card">
      <h3>Cam preview &amp; resolution</h3>
      <p>
        <label>Resolution
          <select id="cw-res" onchange="cwSaveResolution()" style="min-width:260px">
            <option value="640x480"   ${camRes.width === 640  && camRes.height === 480  ? 'selected' : ''}>640×480 (4:3 · low)</option>
            <option value="960x540"   ${camRes.width === 960  && camRes.height === 540  ? 'selected' : ''}>960×540 (16:9 · qHD)</option>
            <option value="1280x720"  ${camRes.width === 1280 && camRes.height === 720  ? 'selected' : ''}>1280×720 (16:9 · 720p)</option>
            <option value="1920x1080" ${camRes.width === 1920 && camRes.height === 1080 ? 'selected' : ''}>1920×1080 (16:9 · 1080p)</option>
            <option value="640x640"   ${camRes.width === 640  && camRes.height === 640  ? 'selected' : ''}>640×640 (1:1 · square)</option>
            <option value="native"    ${camRes.width === 'native' ? 'selected' : ''}>Camera default</option>
          </select>
        </label>
      </p>
      <p class="muted" style="font-size:0.95rem;margin:6px 0 12px">Visitors see whatever aspect ratio you broadcast — the UI scales tiles automatically. Controllers stay locked at 1:1 regardless. The browser may snap to the closest supported resolution.</p>
      <div style="position:relative;display:inline-block;background:#0a0c10;border:1px solid #2a2f3a;border-radius:8px;overflow:hidden;max-width:100%">
        <video id="cw-video" autoplay muted playsinline style="display:block;max-width:720px;width:100%;height:auto"></video>
      </div>
      <p style="margin-top:14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button onclick="cwStartCam()">Start camera</button>
        <button onclick="cwStopCam()">Stop camera</button>
        <button onclick="cwSendTestSnap()">Send test snapshot</button>
        <span id="cw-actual" class="muted" style="font-size:0.9rem"></span>
      </p>
    </div>

    <canvas id="cw-canvas" width="512" height="512" style="display:none"></canvas>

    <div id="cw-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px;z-index:1100"></div>

    <script>
      const SAVED_RES = ${JSON.stringify(camRes)};
      const SAVED_MODE = ${JSON.stringify(cam.mode)};
      const SAVED_THRESH = ${JSON.stringify(cam.snapshotEveryPct)};
      let videoEl = null, stream = null;
      let lastSnapCapacity = -Infinity;

      function flash(msg, cls) {
        const el = document.getElementById('cw-msg');
        el.innerHTML = '<div class="card" style="margin:0;border-color:' + (cls === 'bad' ? '#f08484' : cls === 'ok' ? '#6ddc9b' : '#f0c674') + '">' + msg + '</div>';
        setTimeout(() => { el.innerHTML = ''; }, 4000);
      }
      function _videoConstraintsFromSaved() {
        if (SAVED_RES && SAVED_RES.width === 'native') return { video: true, audio: false };
        return { video: { width: { ideal: SAVED_RES.width }, height: { ideal: SAVED_RES.height } }, audio: false };
      }
      async function cwStartCam() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          flash('Browser has no getUserMedia. Use Chrome/Firefox/Edge over http://localhost or https://.', 'bad');
          return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia(_videoConstraintsFromSaved());
          const v = document.getElementById('cw-video');
          v.srcObject = stream;
          videoEl = v;
          v.onloadedmetadata = () => {
            const actual = document.getElementById('cw-actual');
            if (actual && v.videoWidth) actual.textContent = 'actual: ' + v.videoWidth + '×' + v.videoHeight;
          };
        } catch (e) {
          console.error('camera failed', e);
          let hint = '';
          if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') hint = ' — no camera device detected (check OS privacy/cam access) or the chosen resolution isn\\'t supported (try Camera default)';
          else if (e.name === 'NotAllowedError') hint = ' — browser permission denied (click the camera icon in the address bar)';
          else if (e.name === 'NotReadableError') hint = ' — camera busy (Zoom/Meet/etc. holding it?)';
          else if (e.name === 'SecurityError') hint = ' — page must be served over https:// or http://localhost';
          flash('camera failed: ' + e.name + ': ' + e.message + hint, 'bad');
        }
      }
      function cwStopCam() {
        if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
        const v = document.getElementById('cw-video');
        v.srcObject = null;
        const actual = document.getElementById('cw-actual');
        if (actual) actual.textContent = '';
      }
      async function cwSaveResolution() {
        const val = document.getElementById('cw-res').value;
        let resolution;
        if (val === 'native') resolution = { width: 'native', height: 'native' };
        else {
          const [w, h] = val.split('x').map(Number);
          resolution = { width: w, height: h };
        }
        const r = await fetch('/api/owner/camera', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ resolution }) });
        if (!r.ok) { const d = await r.json(); return flash(d.error || 'failed', 'bad'); }
        // re-acquire with new resolution if cam is on
        if (stream) { cwStopCam(); await cwStartCam(); }
        flash('resolution saved · ' + val, 'ok');
      }
      let __lastSavedName = ${JSON.stringify(owner.displayName || '')};
      async function cwSaveName(silentIfUnchanged) {
        const displayName = document.getElementById('cw-name').value.trim();
        if (silentIfUnchanged && displayName === __lastSavedName) return;
        const r = await fetch('/api/launchpad/owner', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ displayName }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        __lastSavedName = displayName;
        document.title = 'PumpDirect — ' + (displayName || 'owner');
        flash('saved', 'ok');
      }
      async function cwSaveMode(mode) {
        const r = await fetch('/api/owner/camera', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ mode }) });
        if (!r.ok) { const d = await r.json(); flash(d.error || 'failed', 'bad'); }
        document.getElementById('cw-snap-row').style.display = mode === 'snapshot' ? '' : 'none';
      }
      async function cwSaveThresh(v) {
        const n = Math.max(1, Math.min(100, parseFloat(v) || 5));
        const r = await fetch('/api/owner/camera', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ snapshotEveryPct: n }) });
        if (!r.ok) { const d = await r.json(); flash(d.error || 'failed', 'bad'); }
      }
      function grabSnapshotDataUrl() {
        const v = document.getElementById('cw-video');
        if (!v || !v.videoWidth) return null;
        const canvas = document.getElementById('cw-canvas');
        // Target ~640px on long edge, preserve aspect.
        const maxLong = 640;
        const ar = v.videoWidth / v.videoHeight;
        let cw, ch;
        if (v.videoWidth >= v.videoHeight) { cw = Math.min(maxLong, v.videoWidth); ch = Math.round(cw / ar); }
        else { ch = Math.min(maxLong, v.videoHeight); cw = Math.round(ch * ar); }
        canvas.width = cw; canvas.height = ch;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight, 0, 0, cw, ch);
        return canvas.toDataURL('image/jpeg', 0.82);
      }
      async function postSnapshot(dataUrl) {
        const r = await fetch('/api/owner/snapshot', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ dataUrl }) });
        if (!r.ok) { const d = await r.json(); flash(d.error || 'failed', 'bad'); return false; }
        return true;
      }
      async function cwSendTestSnap() {
        const url = grabSnapshotDataUrl();
        if (!url) return flash('start the camera first', 'bad');
        if (await postSnapshot(url)) flash('snapshot posted', 'ok');
      }

      // Mode + threshold change handlers
      document.querySelectorAll('input[name="cw-mode"]').forEach(r => r.addEventListener('change', e => cwSaveMode(e.target.value)));
      document.getElementById('cw-thresh').addEventListener('change', e => cwSaveThresh(e.target.value));
      document.getElementById('cw-chat-enable').addEventListener('change', async e => {
        const r = await fetch('/api/owner/chat', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ enabled: e.target.checked }) });
        if (!r.ok) { const d = await r.json(); flash(d.error || 'failed', 'bad'); }
        else flash(e.target.checked ? 'chat enabled for visitors' : 'chat disabled for visitors', 'ok');
      });
      document.getElementById('cw-allow-ctrl-cam').addEventListener('change', async e => {
        const r = await fetch('/api/owner/camera', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ allowControllerBroadcast: e.target.checked }) });
        if (!r.ok) { const d = await r.json(); flash(d.error || 'failed', 'bad'); }
        else flash(e.target.checked ? 'controller broadcast allowed' : 'controller broadcast disabled', 'ok');
      });

      // Snapshot trigger — runs whenever a state update arrives via the launchpad WS
      function maybeSnap(state) {
        if (SAVED_MODE !== 'snapshot') return;
        if (!stream) return;  // cam off — no snap
        const cap = state?.capacity || 0;
        const thresh = SAVED_THRESH || 5;
        if (cap >= lastSnapCapacity + thresh) {
          lastSnapCapacity = cap;
          const url = grabSnapshotDataUrl();
          if (url) postSnapshot(url);
        }
      }
      let cwWsBackoff = 0;
      function connectOwnerWs() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(proto + '://' + location.host + '/ws/owner');
        ws.addEventListener('open', () => { cwWsBackoff = 0; });
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === 'state') maybeSnap(m.state);
        };
        ws.onclose = () => {
          const delay = Math.min(30000, 500 * Math.pow(2, cwWsBackoff)) + Math.floor(Math.random() * 500);
          cwWsBackoff = Math.min(cwWsBackoff + 1, 6);
          setTimeout(connectOwnerWs, delay);
        };
      }
      connectOwnerWs();
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'Chat/Webcam', active: 'chatwebcam', body }));
});

router.patch('/api/owner/camera', (req, res) => {
  try {
    const cfg = config.load();
    const cur = cfg.owner?.camera || { mode: 'off', resolution: { width: 1280, height: 720 }, snapshotEveryPct: 5 };
    const patch = req.body || {};
    const next = { ...cur };
    if (patch.mode && ['off', 'live', 'snapshot'].includes(patch.mode)) next.mode = patch.mode;
    if (patch.resolution && typeof patch.resolution === 'object') {
      const w = patch.resolution.width;
      const h = patch.resolution.height;
      if (w === 'native' && h === 'native') next.resolution = { width: 'native', height: 'native' };
      else if (Number.isFinite(Number(w)) && Number.isFinite(Number(h))) next.resolution = { width: Number(w), height: Number(h) };
    }
    if (patch.snapshotEveryPct != null) {
      next.snapshotEveryPct = Math.max(1, Math.min(100, Number(patch.snapshotEveryPct) || cur.snapshotEveryPct));
    }
    if (typeof patch.allowControllerBroadcast === 'boolean') {
      next.allowControllerBroadcast = patch.allowControllerBroadcast;
    }
    config.save({ owner: { camera: next } });
    emitState(session.getState());
    res.json({ camera: next });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.patch('/api/owner/chat', (req, res) => {
  try {
    const enabled = req.body?.enabled;
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled (boolean) required' });
    const next = config.save({ chat: { enabled } });
    emitState(session.getState());
    res.json({ chat: next.chat });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/owner/snapshot', (req, res) => {
  try {
    const dataUrl = req.body?.dataUrl;
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'dataUrl required (image data url)' });
    }
    const cfg = config.load();
    const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';
    const ownerName = cfg.owner?.displayName?.trim() || ownerEmail.split('@')[0] || 'owner';
    chat.push({ fromEmail: ownerEmail, fromNickname: ownerName, image: { dataUrl } });
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
