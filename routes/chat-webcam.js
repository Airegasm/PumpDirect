const express = require('express');
const config = require('../config');
const chat = require('../services/chat-service');
const session = require('../services/session-service');
const { emitState } = require('../services/event-bus');
const { ownerLayout, escape } = require('../views/layout');
const { camPipelineJs } = require('../views/cam-pipeline');
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
      <h3>Your display name</h3>
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
      <p style="display:flex;gap:18px;flex-wrap:wrap;align-items:center">
        <label>Camera
          <select id="cw-device" onchange="cwChangeDevice()" style="min-width:260px">
            <option value="">(detecting…)</option>
          </select>
        </label>
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
      <p class="muted" style="font-size:0.9rem;margin:0 0 12px">Browsers hide camera labels until you grant permission once — click <strong>Start camera</strong> below and the names will fill in.</p>
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

    <div class="card" id="cw-controls-card">
      <h3 style="margin:0 0 4px">Camera adjustments — <span style="color:#6ddc9b">Native (hardware)</span></h3>
      <p class="muted" style="font-size:0.9rem;margin:0 0 14px">Sliders below only appear for controls your camera actually exposes via the browser. Most laptop / fixed-lens webcams (including Elgato Facecam) only show brightness / contrast / saturation / white balance / exposure. Hardware PTZ cameras add zoom/pan/tilt. All changes apply at the camera and are visible to viewers with zero CPU cost.</p>
      <div id="cw-controls-empty" class="muted" style="font-size:0.95rem">Press <strong>Start camera</strong> to detect available controls.</div>
      <div id="cw-controls" style="display:none;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px"></div>
      <p id="cw-controls-actions" style="display:none;margin:14px 0 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button onclick="cwResetControls()" style="background:#2a2f3a;color:#e8e8e8">Reset hardware controls</button>
        <span class="muted" style="font-size:0.85rem">Saved per-camera, per-browser.</span>
      </p>
    </div>

    <div class="card" id="cw-software-card">
      <h3 style="margin:0 0 4px">Camera adjustments — <span style="color:#f0c674">Software (PumpDirect canvas pipeline)</span></h3>
      <p class="muted" style="font-size:0.9rem;margin:0 0 14px">Works on <strong>any camera</strong>. We capture each frame, transform it on a canvas, and re-publish the result. Adds ~5–15% CPU at 720p30 on modern hardware. <strong>Off by default</strong> — only turns on when you tick the box below. Settings apply to both your preview here and the live broadcast on Launchpad.</p>
      <p style="margin:0 0 12px">
        <label style="font-size:1.05rem"><input id="cw-sw-enabled" type="checkbox"> <strong>Enable software pipeline</strong></label>
      </p>
      <div id="cw-sw-controls" style="display:none;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px"></div>
      <p id="cw-sw-actions" style="display:none;margin:14px 0 0;align-items:center;gap:8px;flex-wrap:wrap">
        <button onclick="cwResetSoftwareControls()" style="background:#2a2f3a;color:#e8e8e8">Reset software controls</button>
        <span class="muted" style="font-size:0.85rem">Stop + Start camera if it doesn't take effect immediately.</span>
      </p>
    </div>

    <div class="card" id="cw-mic-card">
      <h3 style="margin:0 0 4px">Microphone test</h3>
      <p class="muted" style="font-size:0.9rem;margin:0 0 14px">Pick the mic Launchpad will broadcast and confirm the level is reasonable. The selection here applies to your live broadcast (Launchpad → Start camera).</p>
      <p style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="flex:1;min-width:260px">Microphone
          <select id="cw-mic" onchange="cwMicChange()" style="width:100%;font-size:1rem;padding:6px">
            <option value="">(detecting…)</option>
          </select>
        </label>
        <button onclick="cwMicTest()" id="cw-mic-test-btn" style="white-space:nowrap">Start test</button>
      </p>
      <div style="margin-top:8px">
        <div style="font-size:0.85rem;color:var(--text-muted);margin-bottom:4px">Mic level (say something)</div>
        <div style="height:14px;background:#0a0c10;border:1px solid var(--border);border-radius:4px;overflow:hidden">
          <div id="cw-mic-vu" style="height:100%;width:0;background:linear-gradient(90deg,#1a8a4d,#6ddc9b,#f0c674,#f08484);transition:width 60ms"></div>
        </div>
      </div>
      <p id="cw-mic-err" class="muted" style="margin:10px 0 0;font-size:0.9rem;color:#f08484;display:none"></p>
    </div>

    <canvas id="cw-canvas" width="512" height="512" style="display:none"></canvas>

    <div id="cw-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px;z-index:1100"></div>

    <script>${camPipelineJs()}</script>
    <script>
      const SAVED_RES = ${JSON.stringify(camRes)};
      const SAVED_MODE = ${JSON.stringify(cam.mode)};
      const SAVED_THRESH = ${JSON.stringify(cam.snapshotEveryPct)};
      let videoEl = null, stream = null;       // What's shown in the preview (post-pipeline if enabled).
      let rawStream = null;                    // The raw getUserMedia stream — kept so we can rebuild pipeline.
      let pipeline = null;                     // { stream, stop } from PDCam.startPipeline when active.
      let lastSnapCapacity = -Infinity;

      function flash(msg, cls) {
        const el = document.getElementById('cw-msg');
        el.innerHTML = '<div class="card" style="margin:0;border-color:' + (cls === 'bad' ? '#f08484' : cls === 'ok' ? '#6ddc9b' : '#f0c674') + '">' + msg + '</div>';
        setTimeout(() => { el.innerHTML = ''; }, 4000);
      }
      const DEVICE_KEY = 'pd-cam-device-id';
      function _videoConstraintsFromSaved() {
        const v = (SAVED_RES && SAVED_RES.width === 'native')
          ? {}
          : { width: { ideal: SAVED_RES.width }, height: { ideal: SAVED_RES.height } };
        const id = localStorage.getItem(DEVICE_KEY);
        if (id) v.deviceId = { exact: id };
        return { video: Object.keys(v).length ? v : true, audio: false };
      }
      async function cwPopulateDevices() {
        const sel = document.getElementById('cw-device');
        if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        try {
          const all = await navigator.mediaDevices.enumerateDevices();
          const cams = all.filter(d => d.kind === 'videoinput');
          const saved = localStorage.getItem(DEVICE_KEY);
          if (!cams.length) { sel.innerHTML = '<option value="">(no cameras detected)</option>'; return; }
          sel.innerHTML = cams.map((c, i) => {
            const label = c.label || ('Camera ' + (i + 1) + ' (grant cam permission to see name)');
            const isSelected = saved ? (c.deviceId === saved) : (i === 0);
            return '<option value="' + c.deviceId + '"' + (isSelected ? ' selected' : '') + '>' + label.replace(/[<>&"]/g, ch => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[ch])) + '</option>';
          }).join('');
        } catch (e) { console.warn('enumerateDevices failed', e); }
      }
      async function cwChangeDevice() {
        const id = document.getElementById('cw-device').value;
        if (id) localStorage.setItem(DEVICE_KEY, id);
        else localStorage.removeItem(DEVICE_KEY);
        if (stream) { cwStopCam(); await cwStartCam(); }
        else flash('camera selection saved — press Start camera', 'ok');
      }
      async function cwStartCam() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          flash('Browser has no getUserMedia. Use Chrome/Firefox/Edge over http://localhost or https://.', 'bad');
          return;
        }
        try {
          rawStream = await navigator.mediaDevices.getUserMedia(_videoConstraintsFromSaved());
          // If the software pipeline is enabled, wrap the raw stream. Preview
          // and (eventually) the broadcast both see the processed output.
          if (window.PDCam && window.PDCam.isEnabled()) {
            pipeline = window.PDCam.startPipeline(rawStream);
            stream = pipeline.stream;
          } else {
            stream = rawStream;
          }
          const v = document.getElementById('cw-video');
          v.srcObject = stream;
          videoEl = v;
          v.onloadedmetadata = () => {
            const actual = document.getElementById('cw-actual');
            if (actual && v.videoWidth) actual.textContent = 'actual: ' + v.videoWidth + '×' + v.videoHeight;
          };
          // Labels are blank until camera permission is granted at least once
          // for this origin. Re-populate so the dropdown shows real names.
          cwPopulateDevices();
          // Detect and render hardware camera controls (zoom, pan, brightness,
          // etc. - whatever the camera exposes via MediaStreamTrack capabilities).
          cwBuildControlsUI();
        } catch (e) {
          console.error('camera failed', e);
          let hint = '';
          if (e.name === 'OverconstrainedError') {
            // Most likely: the saved deviceId was unplugged. Clear and retry once.
            const stale = !!localStorage.getItem(DEVICE_KEY);
            if (stale) {
              localStorage.removeItem(DEVICE_KEY);
              flash('saved camera not found — retrying with default', 'warn');
              return cwStartCam();
            }
            hint = ' — chosen resolution may not be supported (try Camera default)';
          }
          else if (e.name === 'NotFoundError') hint = ' — no camera device detected (check OS privacy/cam access)';
          else if (e.name === 'NotAllowedError') hint = ' — browser permission denied (click the camera icon in the address bar)';
          else if (e.name === 'NotReadableError') hint = ' — camera busy (Zoom/Meet/etc. holding it?)';
          else if (e.name === 'SecurityError') hint = ' — page must be served over https:// or http://localhost';
          flash('camera failed: ' + e.name + ': ' + e.message + hint, 'bad');
        }
      }
      // Initial populate (labels likely blank until first cam grant).
      cwPopulateDevices();
      if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', cwPopulateDevices);
      }

      // -------- Hardware camera controls (MediaStreamTrack capabilities) --------
      // Per-camera tweaks (zoom, pan, brightness, etc.) come from
      // track.getCapabilities() and apply via track.applyConstraints().
      // Settings persist in localStorage keyed by deviceId so each cam
      // remembers its own tuning across sessions.
      const CONTROLS_KEY_PREFIX = 'pd-cam-controls:';
      // Capability key -> { label, kind, unit }. We only render controls for
      // capabilities the current camera actually advertises.
      const CAPABILITY_META = {
        zoom:                  { label: 'Zoom',                 kind: 'range' },
        pan:                   { label: 'Pan',                  kind: 'range' },
        tilt:                  { label: 'Tilt',                 kind: 'range' },
        brightness:            { label: 'Brightness',           kind: 'range' },
        contrast:              { label: 'Contrast',             kind: 'range' },
        saturation:            { label: 'Saturation',           kind: 'range' },
        sharpness:             { label: 'Sharpness',            kind: 'range' },
        colorTemperature:      { label: 'Color temperature',    kind: 'range', unit: 'K' },
        exposureCompensation:  { label: 'Exposure compensation',kind: 'range', unit: 'EV' },
        exposureTime:          { label: 'Exposure time',        kind: 'range', unit: 'µs' },
        iso:                   { label: 'ISO',                  kind: 'range' },
        focusDistance:         { label: 'Focus distance',       kind: 'range' },
        whiteBalanceMode:      { label: 'White balance',        kind: 'enum' },
        exposureMode:          { label: 'Exposure mode',        kind: 'enum' },
        focusMode:             { label: 'Focus mode',           kind: 'enum' },
        torch:                 { label: 'Torch (LED)',          kind: 'bool' },
      };
      function _camKey() {
        const id = localStorage.getItem(DEVICE_KEY) || 'default';
        return CONTROLS_KEY_PREFIX + id;
      }
      function _loadSavedControls() {
        try { return JSON.parse(localStorage.getItem(_camKey()) || '{}'); } catch { return {}; }
      }
      function _saveControl(key, value) {
        const cur = _loadSavedControls();
        if (value === null || value === undefined || value === '') delete cur[key];
        else cur[key] = value;
        localStorage.setItem(_camKey(), JSON.stringify(cur));
      }
      function _capabilityEscape(s) { return String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])); }
      async function cwBuildControlsUI() {
        const wrap = document.getElementById('cw-controls');
        const empty = document.getElementById('cw-controls-empty');
        const actions = document.getElementById('cw-controls-actions');
        if (!stream) return;
        const track = stream.getVideoTracks()[0];
        if (!track || !track.getCapabilities) {
          empty.textContent = 'Your browser does not expose MediaStreamTrack capabilities (try Chrome or Edge).';
          wrap.style.display = 'none'; actions.style.display = 'none';
          return;
        }
        const caps = track.getCapabilities() || {};
        const settings = track.getSettings() || {};
        const saved = _loadSavedControls();
        const rows = [];
        for (const [key, meta] of Object.entries(CAPABILITY_META)) {
          if (!(key in caps)) continue;
          const cap = caps[key];
          const current = (key in saved) ? saved[key] : settings[key];
          if (meta.kind === 'range' && typeof cap === 'object' && 'min' in cap && 'max' in cap) {
            const step = cap.step || ((cap.max - cap.min) / 100) || 1;
            const val = (current != null) ? current : ((cap.max + cap.min) / 2);
            rows.push(
              '<div data-cap="' + key + '">' +
              '<label style="display:flex;justify-content:space-between;font-size:0.95rem;margin-bottom:4px"><span>' + meta.label + '</span><span class="muted" id="cw-cap-val-' + key + '">' + (Number(val).toFixed(step < 1 ? 2 : 0)) + (meta.unit ? ' ' + meta.unit : '') + '</span></label>' +
              '<input type="range" min="' + cap.min + '" max="' + cap.max + '" step="' + step + '" value="' + val + '" style="width:100%" oninput="cwApplyCapability(\\'' + key + '\\', Number(this.value), true)" onchange="cwApplyCapability(\\'' + key + '\\', Number(this.value))">' +
              '</div>'
            );
          } else if (meta.kind === 'enum' && Array.isArray(cap)) {
            const opts = cap.map(v => '<option value="' + _capabilityEscape(v) + '"' + (v === current ? ' selected' : '') + '>' + _capabilityEscape(v) + '</option>').join('');
            rows.push(
              '<div data-cap="' + key + '">' +
              '<label style="display:block;font-size:0.95rem;margin-bottom:4px">' + meta.label + '</label>' +
              '<select onchange="cwApplyCapability(\\'' + key + '\\', this.value)" style="width:100%">' + opts + '</select>' +
              '</div>'
            );
          } else if (meta.kind === 'bool' && (cap === true || (Array.isArray(cap) && cap.includes(true)))) {
            rows.push(
              '<div data-cap="' + key + '">' +
              '<label style="display:block;font-size:0.95rem"><input type="checkbox"' + (current ? ' checked' : '') + ' onchange="cwApplyCapability(\\'' + key + '\\', this.checked)"> ' + meta.label + '</label>' +
              '</div>'
            );
          }
        }
        if (!rows.length) {
          empty.textContent = 'This camera does not expose any adjustable controls via the browser. (Common for cheaper integrated webcams; USB cameras typically expose more.)';
          wrap.style.display = 'none'; actions.style.display = 'none';
          return;
        }
        wrap.innerHTML = rows.join('');
        wrap.style.display = 'grid';
        actions.style.display = 'flex';
        empty.style.display = 'none';
        // Re-apply persisted values so settings carry across browser sessions
        // (the camera itself doesn't always remember).
        if (Object.keys(saved).length) {
          for (const [k, v] of Object.entries(saved)) {
            try { await track.applyConstraints({ advanced: [{ [k]: v }] }); } catch {}
          }
        }
      }
      async function cwApplyCapability(key, value, liveUpdateOnly) {
        if (!stream) return;
        const track = stream.getVideoTracks()[0];
        if (!track) return;
        const valSpan = document.getElementById('cw-cap-val-' + key);
        if (valSpan && typeof value === 'number') {
          const meta = CAPABILITY_META[key] || {};
          valSpan.textContent = value.toFixed(value < 10 && Math.abs(value) < 100 && (value % 1 !== 0 || Math.abs(value) < 5) ? 2 : 0) + (meta.unit ? ' ' + meta.unit : '');
        }
        if (liveUpdateOnly) return;  // oninput fires constantly; only persist + apply on change
        try {
          await track.applyConstraints({ advanced: [{ [key]: value }] });
          _saveControl(key, value);
        } catch (e) {
          flash('failed to apply ' + key + ': ' + e.message, 'bad');
        }
      }
      async function cwResetControls() {
        if (!stream) return;
        localStorage.removeItem(_camKey());
        // Easiest way to fully reset: stop + restart the camera. The hardware
        // returns to defaults and our saved overrides are now gone.
        cwStopCam();
        await cwStartCam();
        flash('camera controls reset', 'ok');
      }

      // -------- Software pipeline UI (Phase 2) --------
      // Friendly labels and units for the keys defined in views/cam-pipeline.js.
      // Bool-like keys (mirror) get checkboxes; rest are sliders with a numeric readout.
      const SW_META = {
        zoom:       { label: 'Digital zoom',      unit: '×',   fmt: v => v.toFixed(2) + '×' },
        panX:       { label: 'Pan X',             unit: '',    fmt: v => v.toFixed(2) },
        panY:       { label: 'Pan Y',             unit: '',    fmt: v => v.toFixed(2) },
        hue:        { label: 'Hue rotate',        unit: '°',   fmt: v => v.toFixed(0) + '°' },
        brightness: { label: 'Brightness (sw)',   unit: '',    fmt: v => v.toFixed(2) },
        contrast:   { label: 'Contrast (sw)',     unit: '',    fmt: v => v.toFixed(2) },
        saturate:   { label: 'Saturation (sw)',   unit: '',    fmt: v => v.toFixed(2) },
        mirror:     { label: 'Mirror horizontally', bool: true },
      };
      function cwBuildSoftwareUI() {
        if (!window.PDCam) return;
        const wrap = document.getElementById('cw-sw-controls');
        const actions = document.getElementById('cw-sw-actions');
        const tickbox = document.getElementById('cw-sw-enabled');
        tickbox.checked = window.PDCam.isEnabled();
        tickbox.onchange = async () => {
          window.PDCam.setEnabled(tickbox.checked);
          wrap.style.display = tickbox.checked ? 'grid' : 'none';
          actions.style.display = tickbox.checked ? 'flex' : 'none';
          if (rawStream) {
            // Restart so the pipeline gets attached/detached cleanly.
            cwStopCam();
            await cwStartCam();
          }
        };
        const rows = window.PDCam.SETTINGS_SPEC.map(([key, def, min, max, step]) => {
          const meta = SW_META[key] || { label: key };
          const cur = window.PDCam.get(key);
          if (meta.bool) {
            return '<div><label style="display:block;font-size:0.95rem"><input type="checkbox"' + (cur ? ' checked' : '') + ' onchange="cwSetSoftware(\\'' + key + '\\', this.checked ? 1 : 0)"> ' + meta.label + '</label></div>';
          }
          return (
            '<div>' +
            '<label style="display:flex;justify-content:space-between;font-size:0.95rem;margin-bottom:4px"><span>' + meta.label + '</span><span class="muted" id="cw-sw-val-' + key + '">' + meta.fmt(cur) + '</span></label>' +
            '<input type="range" min="' + min + '" max="' + max + '" step="' + step + '" value="' + cur + '" style="width:100%" oninput="cwSetSoftware(\\'' + key + '\\', Number(this.value))">' +
            '</div>'
          );
        });
        wrap.innerHTML = rows.join('');
        wrap.style.display = tickbox.checked ? 'grid' : 'none';
        actions.style.display = tickbox.checked ? 'flex' : 'none';
      }
      function cwSetSoftware(key, val) {
        if (!window.PDCam) return;
        window.PDCam.set(key, val);
        const span = document.getElementById('cw-sw-val-' + key);
        const meta = SW_META[key];
        if (span && meta && meta.fmt) span.textContent = meta.fmt(val);
      }
      async function cwResetSoftwareControls() {
        window.PDCam.resetAll();
        cwBuildSoftwareUI();
        if (rawStream && pipeline) {
          // Pipeline reads localStorage each frame; reset will be picked up next frame.
          flash('software adjustments reset', 'ok');
        }
      }
      cwBuildSoftwareUI();
      function cwStopCam() {
        if (pipeline) { try { pipeline.stop(); } catch {} pipeline = null; }
        if (rawStream) { rawStream.getTracks().forEach(t => { try { t.stop(); } catch {} }); rawStream = null; }
        if (stream && stream !== rawStream) { try { stream.getTracks().forEach(t => t.stop()); } catch {} }
        stream = null;
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

      // -------- Microphone test ----------
      const MIC_KEY = 'pd-host-mic-id';
      let cwMicStream = null;
      let cwMicVuStop = null;
      async function cwPopulateMics() {
        const sel = document.getElementById('cw-mic');
        if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
        try {
          const devs = await navigator.mediaDevices.enumerateDevices();
          const mics = devs.filter(d => d.kind === 'audioinput');
          const saved = localStorage.getItem(MIC_KEY);
          if (!mics.length) { sel.innerHTML = '<option value="">(no microphones detected)</option>'; return; }
          sel.innerHTML = mics.map((m, i) => {
            const label = m.label || ('Microphone ' + (i + 1) + ' (grant mic permission to see name)');
            const isSel = saved ? (m.deviceId === saved) : (i === 0);
            return '<option value="' + m.deviceId + '"' + (isSel ? ' selected' : '') + '>' + label.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c])) + '</option>';
          }).join('');
        } catch (e) { console.warn('enumerateDevices failed', e); }
      }
      function cwMicChange() {
        const v = document.getElementById('cw-mic').value;
        if (v) localStorage.setItem(MIC_KEY, v); else localStorage.removeItem(MIC_KEY);
        if (cwMicStream) { cwStopMicTest(); cwMicTest(); }
        else flash('mic selection saved · used by Launchpad broadcast', 'ok');
      }
      function cwStopMicTest() {
        if (cwMicVuStop) { try { cwMicVuStop(); } catch {} cwMicVuStop = null; }
        if (cwMicStream) { cwMicStream.getTracks().forEach(t => { try { t.stop(); } catch {} }); cwMicStream = null; }
        const btn = document.getElementById('cw-mic-test-btn');
        if (btn) btn.textContent = 'Start test';
        const vu = document.getElementById('cw-mic-vu');
        if (vu) vu.style.width = '0%';
      }
      async function cwMicTest() {
        const err = document.getElementById('cw-mic-err');
        err.style.display = 'none';
        if (cwMicStream) { cwStopMicTest(); return; }
        try {
          const id = document.getElementById('cw-mic').value;
          const audio = id ? { deviceId: { exact: id } } : true;
          cwMicStream = await navigator.mediaDevices.getUserMedia({ audio });
          cwMicVuStop = window.PDCam.startVuMeter(cwMicStream, document.getElementById('cw-mic-vu'));
          document.getElementById('cw-mic-test-btn').textContent = 'Stop test';
          // Labels were probably blank until now - repopulate so user sees real names.
          cwPopulateMics();
        } catch (e) {
          err.textContent = 'Mic test failed: ' + e.name + ' - ' + e.message;
          err.style.display = 'block';
        }
      }
      cwPopulateMics();
      if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
        navigator.mediaDevices.addEventListener('devicechange', cwPopulateMics);
      }
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
