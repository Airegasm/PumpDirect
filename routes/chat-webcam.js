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
  const cam = owner.camera || { mode: 'off', crop: { xPct: 25, yPct: 12.5, sizePct: 50 }, snapshotEveryPct: 5 };

  const body = `
    <h2>Chat / Webcam</h2>

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
      <h3>Cam preview &amp; crop (1:1)</h3>
      <p class="muted">Drag the square to position it. Drag the bottom-right corner to resize. Visitors see only the cropped region.</p>
      <div id="cw-stage" style="position:relative;display:inline-block;background:#0a0c10;border:1px solid #2a2f3a;border-radius:8px;overflow:hidden;max-width:100%">
        <video id="cw-video" autoplay muted playsinline style="display:block;max-width:640px;width:100%;height:auto"></video>
        <div id="cw-crop" style="position:absolute;border:2px solid #2a6df4;box-shadow:0 0 0 9999px rgba(0,0,0,0.45);box-sizing:border-box;cursor:move;touch-action:none">
          <div id="cw-handle" style="position:absolute;right:-10px;bottom:-10px;width:20px;height:20px;background:#2a6df4;border-radius:50%;cursor:nwse-resize;touch-action:none"></div>
        </div>
      </div>
      <p style="margin-top:14px">
        <button onclick="cwStartCam()">Start camera</button>
        <button onclick="cwStopCam()">Stop camera</button>
        <button onclick="cwSaveCrop()">Save crop</button>
        <button onclick="cwSendTestSnap()">Send test snapshot to chat</button>
      </p>
      <p class="muted" style="font-size:0.95rem">Current saved crop:
        x=<span id="cw-x">${cam.crop.xPct.toFixed(1)}</span>%,
        y=<span id="cw-y">${cam.crop.yPct.toFixed(1)}</span>%,
        size=<span id="cw-size">${cam.crop.sizePct.toFixed(1)}</span>%
      </p>
    </div>

    <canvas id="cw-canvas" width="512" height="512" style="display:none"></canvas>

    <div id="cw-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px;z-index:1100"></div>

    <script>
      const SAVED_CROP = ${JSON.stringify(cam.crop)};
      const SAVED_MODE = ${JSON.stringify(cam.mode)};
      const SAVED_THRESH = ${JSON.stringify(cam.snapshotEveryPct)};
      let videoEl = null, stream = null;
      let crop = { ...SAVED_CROP };
      let lastSnapCapacity = -Infinity;

      function flash(msg, cls) {
        const el = document.getElementById('cw-msg');
        el.innerHTML = '<div class="card" style="margin:0;border-color:' + (cls === 'bad' ? '#f08484' : cls === 'ok' ? '#6ddc9b' : '#f0c674') + '">' + msg + '</div>';
        setTimeout(() => { el.innerHTML = ''; }, 4000);
      }
      function applyCropOverlay() {
        const v = document.getElementById('cw-video');
        const box = document.getElementById('cw-crop');
        if (!v || !v.videoWidth) return;
        const dispW = v.clientWidth, dispH = v.clientHeight;
        const size = (crop.sizePct / 100) * dispH;
        const x = (crop.xPct / 100) * dispW;
        const y = (crop.yPct / 100) * dispH;
        box.style.left = x + 'px';
        box.style.top = y + 'px';
        box.style.width = size + 'px';
        box.style.height = size + 'px';
      }
      function clampCrop() {
        crop.sizePct = Math.max(10, Math.min(100, crop.sizePct));
        const v = document.getElementById('cw-video');
        const aspect = (v.videoWidth && v.videoHeight) ? (v.videoWidth / v.videoHeight) : 16/9;
        // Convert crop size (% of height) to width %.
        const widthPct = crop.sizePct / aspect;
        crop.xPct = Math.max(0, Math.min(100 - widthPct, crop.xPct));
        crop.yPct = Math.max(0, Math.min(100 - crop.sizePct, crop.yPct));
      }
      async function cwStartCam() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          flash('Browser has no getUserMedia. Use Chrome/Firefox/Edge over http://localhost or https://.', 'bad');
          return;
        }
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
          const v = document.getElementById('cw-video');
          v.srcObject = stream;
          videoEl = v;
          v.onloadedmetadata = () => { applyCropOverlay(); };
        } catch (e) {
          console.error('camera failed', e);
          let hint = '';
          if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') hint = ' — no camera device detected (check OS privacy/cam access)';
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
      async function cwSaveCrop() {
        clampCrop();
        const r = await fetch('/api/owner/camera', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ crop }) });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        document.getElementById('cw-x').textContent = crop.xPct.toFixed(1);
        document.getElementById('cw-y').textContent = crop.yPct.toFixed(1);
        document.getElementById('cw-size').textContent = crop.sizePct.toFixed(1);
        flash('crop saved', 'ok');
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
        const sw = v.videoWidth, sh = v.videoHeight;
        const cropPxSize = (crop.sizePct / 100) * sh;
        const cropPxX = (crop.xPct / 100) * sw;
        const cropPxY = (crop.yPct / 100) * sh;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(v, cropPxX, cropPxY, cropPxSize, cropPxSize, 0, 0, 512, 512);
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
      document.getElementById('cw-allow-ctrl-cam').addEventListener('change', async e => {
        const r = await fetch('/api/owner/camera', { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ allowControllerBroadcast: e.target.checked }) });
        if (!r.ok) { const d = await r.json(); flash(d.error || 'failed', 'bad'); }
        else flash(e.target.checked ? 'controller broadcast allowed' : 'controller broadcast disabled', 'ok');
      });

      // Drag/resize the crop overlay
      const stage = document.getElementById('cw-stage');
      const box = document.getElementById('cw-crop');
      const handle = document.getElementById('cw-handle');
      let dragMode = null, startPt = null, startCrop = null;
      function pt(e) { return { x: e.clientX, y: e.clientY }; }
      function onPointerDown(e, mode) {
        const v = document.getElementById('cw-video');
        if (!v || !v.videoWidth) return;
        dragMode = mode;
        startPt = pt(e);
        startCrop = { ...crop };
        e.preventDefault();
        e.stopPropagation();
      }
      box.addEventListener('pointerdown', e => { if (e.target !== handle) onPointerDown(e, 'move'); });
      handle.addEventListener('pointerdown', e => onPointerDown(e, 'resize'));
      document.addEventListener('pointermove', e => {
        if (!dragMode) return;
        const v = document.getElementById('cw-video');
        const dxPct = ((e.clientX - startPt.x) / v.clientWidth) * 100;
        const dyPct = ((e.clientY - startPt.y) / v.clientHeight) * 100;
        if (dragMode === 'move') {
          crop.xPct = startCrop.xPct + dxPct;
          crop.yPct = startCrop.yPct + dyPct;
        } else if (dragMode === 'resize') {
          crop.sizePct = startCrop.sizePct + dyPct;  // resize along Y for 1:1
        }
        clampCrop();
        applyCropOverlay();
      });
      document.addEventListener('pointerup', () => { dragMode = null; });

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
      function connectOwnerWs() {
        const proto = location.protocol === 'https:' ? 'wss' : 'ws';
        const ws = new WebSocket(proto + '://' + location.host + '/ws/owner');
        ws.onmessage = (e) => {
          const m = JSON.parse(e.data);
          if (m.type === 'state') maybeSnap(m.state);
        };
        ws.onclose = () => setTimeout(connectOwnerWs, 1500);
      }
      connectOwnerWs();
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'Chat/Webcam', active: 'chatwebcam', body }));
});

router.patch('/api/owner/camera', (req, res) => {
  try {
    const cfg = config.load();
    const cur = cfg.owner?.camera || { mode: 'off', crop: { xPct: 25, yPct: 12.5, sizePct: 50 }, snapshotEveryPct: 5 };
    const patch = req.body || {};
    const next = { ...cur };
    if (patch.mode && ['off', 'live', 'snapshot'].includes(patch.mode)) next.mode = patch.mode;
    if (patch.crop && typeof patch.crop === 'object') {
      next.crop = {
        xPct: clamp01(patch.crop.xPct, cur.crop.xPct),
        yPct: clamp01(patch.crop.yPct, cur.crop.yPct),
        sizePct: Math.max(10, Math.min(100, Number(patch.crop.sizePct) || cur.crop.sizePct)),
      };
    }
    if (patch.snapshotEveryPct != null) {
      next.snapshotEveryPct = Math.max(1, Math.min(100, Number(patch.snapshotEveryPct) || cur.snapshotEveryPct));
    }
    if (typeof patch.allowControllerBroadcast === 'boolean') {
      next.allowControllerBroadcast = patch.allowControllerBroadcast;
    }
    config.save({ owner: { camera: next } });
    // Push fresh state so subscribers see the new owner-cam config without a refresh.
    emitState(session.getState());
    res.json({ camera: next });
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

function clamp01(val, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(100, n));
}

module.exports = router;
