const express = require('express');
const fs = require('fs');
const path = require('path');
const triggers = require('../services/triggers-service');
const devicesSvc = require('../services/devices-service');
const { ownerLayout, escape } = require('../views/layout');

const router = express.Router();

const ASSETS_ROOT = path.join(__dirname, '..', 'public', 'assets', 'triggers');
const LOTTIE_DIR = path.join(ASSETS_ROOT, 'lottie');
const SOUND_DIR  = path.join(ASSETS_ROOT, 'sound');
const VIDEO_DIR  = path.join(ASSETS_ROOT, 'video');
function _ensureAssetDirs() {
  for (const d of [LOTTIE_DIR, SOUND_DIR, VIDEO_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function listLottieFiles() { _ensureAssetDirs(); return fs.readdirSync(LOTTIE_DIR).filter(f => f.endsWith('.json')).sort(); }
function listSoundFiles()  { _ensureAssetDirs(); return fs.readdirSync(SOUND_DIR).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f)).sort(); }
function listVideoFiles()  { _ensureAssetDirs(); return fs.readdirSync(VIDEO_DIR).filter(f => /\.(webm|mp4)$/i.test(f)).sort(); }

function _safeBasename(name) {
  // Strip path separators, allow only filename-safe chars. Empty → 'upload'.
  const stripped = String(name || '').replace(/[\\/]/g, '').replace(/[^a-zA-Z0-9_.\-]/g, '_');
  return stripped || 'upload';
}
function _writeUnique(dir, sanitized) {
  let target = sanitized, n = 1;
  while (fs.existsSync(path.join(dir, target))) {
    const dotIdx = sanitized.lastIndexOf('.');
    const base = dotIdx >= 0 ? sanitized.slice(0, dotIdx) : sanitized;
    const ext  = dotIdx >= 0 ? sanitized.slice(dotIdx) : '';
    target = `${base}-${n}${ext}`;
    n++;
  }
  return target;
}

router.get('/triggers', (req, res) => {
  const data = triggers.load();
  const lottieFiles = listLottieFiles();
  const soundFiles = listSoundFiles();
  const videoFiles = listVideoFiles();
  const allDevices = (() => {
    try { return devicesSvc.loadAll(); } catch { return []; }
  })();
  const primary = allDevices.find(d => d.isPrimary);
  const devicesForEditor = [
    { id: 'primary', label: primary ? `Primary (${primary.label})` : 'Primary pump' },
    ...allDevices.filter(d => !d.isPrimary).map(d => ({ id: d.id, label: d.label })),
  ];
  const devicesForOff = [{ id: 'all', label: 'All devices' }, ...devicesForEditor];

  const actionById = Object.fromEntries(data.triggerActions.map(a => [a.id, a]));
  const groupById  = Object.fromEntries(data.triggerActionGroups.map(g => [g.id, g]));

  const triggerTemplatesBody = data.triggerTemplates.length
    ? `<select id="tt-select" onchange="location.search='?template=' + encodeURIComponent(this.value)" style="min-width:280px">
         ${data.triggerTemplates.map(t => `<option value="${escape(t.id)}">${escape(t.name)}</option>`).join('')}
       </select>
       <button onclick="ttRename()">Rename</button>
       <button onclick="ttDelete()">Delete</button>`
    : '<span class="muted">No trigger templates yet.</span>';

  const body = `
    <h2>Triggers</h2>
    <p class="muted">Conditions that fire a chosen Trigger Action or Group during a live session. Attach a Trigger Template to a session profile via the Launchpad Settings modal.</p>

    <div class="card">
      <h3>Trigger Templates</h3>
      <p>${triggerTemplatesBody}
        <button onclick="ttNew()">+ New template</button></p>
      <div id="tt-rows"><p class="muted">Select a template above to see its triggers.</p></div>
    </div>

    <div class="card">
      <h3>Trigger Actions</h3>
      <p class="muted">Each action is a reusable, named profile of sub-actions that run in order.</p>
      ${data.triggerActions.length
        ? `<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:1rem">
            <thead><tr style="text-align:left;border-bottom:1px solid var(--border)">
              <th style="padding:8px 0">Name</th><th>Sub-actions</th><th style="width:160px"></th>
            </tr></thead>
            <tbody>
              ${data.triggerActions.map(a => `
                <tr>
                  <td><strong>${escape(a.name)}</strong></td>
                  <td class="muted">${a.steps.map(s => '<code style="margin:1px 4px">' + escape(_summarizeSubAction(s)) + '</code>').join('')}</td>
                  <td>
                    <button onclick="taEdit('${escape(a.id)}')">Edit</button>
                    <button onclick="taDelete('${escape(a.id)}', '${escape(a.name)}')">Delete</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>`
        : '<p class="muted">No trigger actions yet.</p>'}
      <p style="margin-top:12px"><button onclick="taNew()">+ New trigger action</button></p>
    </div>

    <div class="card">
      <h3>Trigger Action Groups</h3>
      <p class="muted">Sequential collections of Trigger Actions — handy for combining shorter actions into reusable macros.</p>
      ${data.triggerActionGroups.length
        ? `<table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:1rem">
            <thead><tr style="text-align:left;border-bottom:1px solid var(--border)">
              <th style="padding:8px 0">Name</th><th>Action sequence</th><th style="width:160px"></th>
            </tr></thead>
            <tbody>
              ${data.triggerActionGroups.map(g => `
                <tr>
                  <td><strong>${escape(g.name)}</strong></td>
                  <td class="muted">${(g.actionIds || []).map(aid => '<span class="pill ok" style="margin:1px 3px">' + escape(actionById[aid]?.name || '?') + '</span>').join('') || '<em>empty</em>'}</td>
                  <td>
                    <button onclick="tgEdit('${escape(g.id)}')">Edit</button>
                    <button onclick="tgDelete('${escape(g.id)}', '${escape(g.name)}')">Delete</button>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>`
        : '<p class="muted">No trigger action groups yet.</p>'}
      <p style="margin-top:12px"><button onclick="tgNew()">+ New trigger action group</button></p>
    </div>

    <div id="tr-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px;z-index:1100"></div>

    <script src="/assets/vendor/lottie.min.js"></script>

    <div id="modal-bg" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center">
      <div id="modal" style="background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:28px;max-width:820px;width:94%;max-height:92vh;overflow:auto">
        <h2 id="modal-title">Edit</h2>
        <div id="modal-body"></div>
        <p style="margin-top:20px;text-align:right">
          <button onclick="modalClose()" style="background:var(--bg-3);color:var(--text)">Cancel</button>
          <button id="modal-save" onclick="modalSave()">Save</button>
        </p>
      </div>
    </div>

    <script>
      const TRIGGER_ACTIONS  = ${JSON.stringify(data.triggerActions.map(a => ({ id: a.id, name: a.name })))};
      const TRIGGER_GROUPS   = ${JSON.stringify(data.triggerActionGroups.map(g => ({ id: g.id, name: g.name })))};
      const TRIGGER_TPLS     = ${JSON.stringify(data.triggerTemplates.map(t => ({ id: t.id, name: t.name })))};
      const SUB_ACTION_KINDS = ${JSON.stringify(triggers.listSubActionKinds())};
      const DEVICES_ON       = ${JSON.stringify(devicesForEditor)};
      const DEVICES_OFF      = ${JSON.stringify(devicesForOff)};
      let LOTTIE_FILES       = ${JSON.stringify(lottieFiles)};
      let SOUND_FILES        = ${JSON.stringify(soundFiles)};
      let VIDEO_FILES        = ${JSON.stringify(videoFiles)};
      // Pop a native file picker, upload the bytes to the matching trigger-
      // assets endpoint, refresh the in-memory file list, and select the new
      // filename on the row that requested it. Keeps the editor focused on
      // doing instead of file-system bookkeeping.
      function _uploadTriggerAsset(i, kind) {
        const input = document.createElement('input');
        input.type = 'file';
        const accept = {
          lottie: '.json,application/json',
          sound:  '.mp3,.wav,.ogg,.m4a,audio/*',
          video:  '.webm,.mp4,video/webm,video/mp4',
        }[kind] || '*/*';
        const endpoint = {
          lottie: '/api/triggers/upload-lottie',
          sound:  '/api/triggers/upload-sound',
          video:  '/api/triggers/upload-video',
        }[kind];
        if (!endpoint) return;
        input.accept = accept;
        input.onchange = async () => {
          const f = input.files && input.files[0];
          if (!f) return;
          let buf;
          try { buf = await f.arrayBuffer(); }
          catch (e) { flash('read failed: ' + e.message, 'bad'); return; }
          const r = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(f.name) },
            body: buf,
          });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.error) { flash(d.error || 'upload failed', 'bad'); return; }
          if (kind === 'lottie')      LOTTIE_FILES = d.files || LOTTIE_FILES;
          else if (kind === 'sound')  SOUND_FILES  = d.files || SOUND_FILES;
          else if (kind === 'video')  VIDEO_FILES  = d.files || VIDEO_FILES;
          __subDraft[i].path = d.filename;
          _renderSubActionRows();
          flash('uploaded ' + d.filename, 'ok');
        };
        input.click();
      }
      let ACTIVE_TPL_ID = ${JSON.stringify((data.triggerTemplates.find(t => t.id === (req.query?.template)) || data.triggerTemplates[0])?.id || null)};
      let modalSaveFn = null;

      function flash(msg, cls) {
        const el = document.getElementById('tr-msg');
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
      function _safeAttr(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

      // ===========================
      // Trigger Templates (top)
      // ===========================
      function ttNew() {
        modalOpen('New trigger template', '<p><label>Name <input id="m-name" type="text" placeholder="e.g. Reveal Set"></label></p>', async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/triggers/templates', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ name }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.search = '?template=' + encodeURIComponent(d.template.id);
        });
      }
      async function ttRename() {
        if (!ACTIVE_TPL_ID) return flash('Select a template first', 'bad');
        const cur = TRIGGER_TPLS.find(t => t.id === ACTIVE_TPL_ID);
        modalOpen('Rename trigger template', '<p><label>Name <input id="m-name" type="text" value="' + _safeAttr(cur?.name || '') + '"></label></p>', async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/triggers/templates/' + ACTIVE_TPL_ID, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ name }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
      }
      async function ttDelete() {
        if (!ACTIVE_TPL_ID) return flash('Select a template first', 'bad');
        const cur = TRIGGER_TPLS.find(t => t.id === ACTIVE_TPL_ID);
        if (!confirm('Delete trigger template "' + (cur?.name || ACTIVE_TPL_ID) + '"? Its trigger rows will be gone too.')) return;
        const r = await fetch('/api/triggers/templates/' + ACTIVE_TPL_ID, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.search = '';
      }

      // ---- Trigger rows inside the active template ----
      function renderTriggerRows() {
        const host = document.getElementById('tt-rows');
        if (!host) return;
        if (!ACTIVE_TPL_ID) { host.innerHTML = '<p class="muted">No trigger template selected.</p>'; return; }
        fetch('/api/triggers/templates/' + ACTIVE_TPL_ID).then(r => r.json()).then(d => {
          const t = d.template;
          if (!t.triggers.length) {
            host.innerHTML = '<p class="muted">No triggers yet.</p><p style="margin-top:10px"><button onclick="trNew()">+ Add trigger</button></p>';
            return;
          }
          host.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:1rem;margin-top:8px">'
            + '<thead><tr style="text-align:left;border-bottom:1px solid var(--border)">'
            +   '<th style="padding:8px 0;width:170px">Trigger Type</th>'
            +   '<th style="width:100px">Value</th>'
            +   '<th>Trigger Action / Group</th>'
            +   '<th style="width:160px"></th>'
            + '</tr></thead><tbody>'
            + t.triggers.map(row => {
                let tgtLabel = '?';
                if (row.target?.kind === 'action') tgtLabel = '🎯 ' + (TRIGGER_ACTIONS.find(a => a.id === row.target.id)?.name || '?');
                else if (row.target?.kind === 'group') tgtLabel = '📦 ' + (TRIGGER_GROUPS.find(g => g.id === row.target.id)?.name || '?');
                return '<tr>'
                  + '<td>' + _safeAttr(row.type) + '</td>'
                  + '<td>' + (row.type === 'CAPACITY_REACHED' ? (row.value + '%') : '') + '</td>'
                  + '<td>' + _safeAttr(tgtLabel) + '</td>'
                  + '<td>'
                  +   '<button onclick="trEdit(\\'' + row.id + '\\')">Edit</button> '
                  +   '<button onclick="trDelete(\\'' + row.id + '\\')">Delete</button>'
                  + '</td>'
                + '</tr>';
              }).join('')
            + '</tbody></table>'
            + '<p style="margin-top:12px"><button onclick="trNew()">+ Add trigger</button></p>';
        });
      }
      function _triggerRowFormHtml(row) {
        const type = row?.type || 'CAPACITY_REACHED';
        const value = row?.value != null ? row.value : 50;
        // Target dropdown lists actions then groups with category prefixes.
        const opts = [];
        opts.push('<optgroup label="Trigger Actions">');
        for (const a of TRIGGER_ACTIONS) opts.push('<option value="action:' + a.id + '"' + (row?.target?.kind === 'action' && row?.target?.id === a.id ? ' selected' : '') + '>🎯 ' + _safeAttr(a.name) + '</option>');
        opts.push('</optgroup>');
        opts.push('<optgroup label="Trigger Action Groups">');
        for (const g of TRIGGER_GROUPS) opts.push('<option value="group:' + g.id + '"' + (row?.target?.kind === 'group' && row?.target?.id === g.id ? ' selected' : '') + '>📦 ' + _safeAttr(g.name) + '</option>');
        opts.push('</optgroup>');
        return ''
          + '<p><label>Trigger type <select id="m-type">'
          +   '<option value="CAPACITY_REACHED"' + (type === 'CAPACITY_REACHED' ? ' selected' : '') + '>CAPACITY_REACHED</option>'
          + '</select></label></p>'
          + '<p id="m-row-value-wrap"><label>Value (% capacity) <input id="m-value" type="number" min="0" max="9999" value="' + _safeAttr(value) + '" style="width:120px"></label></p>'
          + '<p><label>Target <select id="m-target" style="min-width:280px">' + opts.join('') + '</select></label></p>'
          + (TRIGGER_ACTIONS.length || TRIGGER_GROUPS.length ? '' : '<p class="muted">No trigger actions or groups exist yet — create one below before assigning.</p>');
      }
      function _readTriggerRow() {
        const t = document.getElementById('m-target').value || '';
        const [kind, id] = t.split(':');
        return {
          type: document.getElementById('m-type').value,
          value: Number(document.getElementById('m-value').value),
          target: { kind, id },
        };
      }
      function trNew() {
        if (!ACTIVE_TPL_ID) return flash('Select a template first', 'bad');
        modalOpen('Add trigger', _triggerRowFormHtml(null), async () => {
          const body = _readTriggerRow();
          const r = await fetch('/api/triggers/templates/' + ACTIVE_TPL_ID + '/triggers', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          modalClose();
          renderTriggerRows();
        });
      }
      async function trEdit(triggerId) {
        const tpl = await fetch('/api/triggers/templates/' + ACTIVE_TPL_ID).then(r => r.json());
        const row = (tpl.template?.triggers || []).find(x => x.id === triggerId);
        if (!row) return flash('row not found', 'bad');
        modalOpen('Edit trigger', _triggerRowFormHtml(row), async () => {
          const body = _readTriggerRow();
          const r = await fetch('/api/triggers/templates/' + ACTIVE_TPL_ID + '/triggers/' + triggerId, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          modalClose();
          renderTriggerRows();
        });
      }
      async function trDelete(triggerId) {
        if (!confirm('Delete this trigger row?')) return;
        const r = await fetch('/api/triggers/templates/' + ACTIVE_TPL_ID + '/triggers/' + triggerId, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        renderTriggerRows();
      }

      // ===========================
      // Trigger Actions (middle)
      // ===========================
      let __subDraft = [];
      function _newSubAction(kind) {
        const base = { kind };
        if (kind === 'text-overlay') { base.mode = 'add'; base.anchor = 'top-left'; base.text = 'Caption'; base.fontColor = '#ffffff'; base.bgColor = '#000000aa'; base.fontSize = 24; }
        else if (kind === 'lottie-overlay') { base.path = LOTTIE_FILES[0] || ''; base.durationMs = 2500; base.freezeLastFrame = false; base.xPct = 50; base.yPct = 50; base.widthPct = 40; }
        else if (kind === 'video-overlay') {
          base.mode = 'add';
          base.path = VIDEO_FILES[0] || '';
          base.durationMs = 8000;
          base.freezeLastFrame = false;
          base.loop = false;
          base.muted = false;
          base.circleCrop = false;
          base.xPct = 50; base.yPct = 50; base.widthPct = 50;
          base.endBehavior = 'default';
          base.clearMode = 'vanish';
          base.fadeMs = 1000;
          base.introOutroStyle = 'corner-slide';
          base.cornerSlide = { anchor: 'BR', slideIn: 'right', slideOut: 'right', inMs: 500, outMs: 500 };
        }
        else if (kind === 'play-sound') { base.path = SOUND_FILES[0] || ''; base.volume = 1; base.blocking = false; base.estDurationMs = 1500; }
        else if (kind === 'cam-toast')  { base.text = 'Heads up!'; base.textColor = '#ffffff'; base.bgColor = '#1c482e'; }
        else if (kind === 'device-control') { base.mode = 'on'; base.deviceId = 'primary'; base.durationMs = 5000; base.cycleOnMs = 1000; base.cycleOffMs = 1000; base.cycleTimes = 5; }
        else if (kind === 'wait') { base.durationMs = 1000; }
        else if (kind === 'end-session') { base.mode = 'instant'; base.delayMs = 5000; }
        return base;
      }
      // ---- lottie-overlay editor: preview + drag-center + width slider ----
      const LOTTIE_PREVIEW_W = 320;
      function _lottiePreviewSlotHtml(s) {
        const wPct = Math.max(5, Math.min(100, Number(s.widthPct != null ? s.widthPct : 40)));
        return ''
          + '<div class="lot-prev-slot" style="position:absolute;'
          +   'left:' + (s.xPct != null ? s.xPct : 50) + '%;'
          +   'top:' + (s.yPct != null ? s.yPct : 50) + '%;'
          +   'width:' + wPct + '%;aspect-ratio:var(--src-aspect, 1);transform:translate(-50%,-50%);'
          +   'background:rgba(123,63,214,0.32);border:2px dashed #b88dff;border-radius:6px;'
          +   'pointer-events:none;display:flex;align-items:center;justify-content:center;'
          +   'color:#fff;font-size:0.78rem;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,0.7)">'
          +   _safeAttr((s.path || 'lottie').replace(/\\.json$/, ''))
          +   '<div style="position:absolute;left:50%;top:50%;width:10px;height:10px;background:#fff;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 2px rgba(0,0,0,0.5)"></div>'
          + '</div>';
      }
      function _renderLottiePreview(i) {
        const prev = document.getElementById('tov-lot-prev-' + i);
        if (!prev) return;
        prev.innerHTML = _lottiePreviewSlotHtml(__subDraft[i]);
      }
      // Fetch the Lottie JSON's natural w/h and apply that aspect ratio to the
      // preview rectangle so it matches the source file's shape.
      function _applyLottieAspect(i) {
        const prev = document.getElementById('tov-lot-prev-' + i);
        const p = __subDraft[i] && __subDraft[i].path;
        if (!prev || !p) return;
        fetch('/assets/triggers/lottie/' + encodeURIComponent(p))
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (!d || !(d.w > 0) || !(d.h > 0)) return;
            const ar = d.w + '/' + d.h;
            prev.style.aspectRatio = ar;
            prev.style.setProperty('--src-aspect', ar);
          })
          .catch(() => {});
      }
      // 5 quick-anchor preset buttons (top-left, top-right, center, bottom-left, bottom-right).
      // Coordinates are computed at click time from the current widthPct so the slot
      // snaps to the cam-tile edge (not centered there, which would clip).
      function _xyAnchorButtons(i, kind) {
        const presets = [
          { label: '↖ TL', pos: 'TL' },
          { label: '↗ TR', pos: 'TR' },
          { label: '· C',  pos: 'C'  },
          { label: '↙ BL', pos: 'BL' },
          { label: '↘ BR', pos: 'BR' },
        ];
        return presets.map(p =>
          '<button type="button" onclick="_setXYAnchor(' + i + ',\\'' + p.pos + '\\',\\'' + kind + '\\')" '
            + 'style="padding:6px 10px;font-size:0.85rem;border-radius:6px;border:1px solid var(--border);background:var(--bg-2);color:var(--text);cursor:pointer">'
            + p.label + '</button>'
        ).join('');
      }
      // Switch the end-behavior radio AND seed the nested config object
      // for the picked branch so the validator has live values to read on
      // save (instead of relying on the editor's display-only defaults).
      function _setVideoEndBehavior(i, eb) {
        if (!__subDraft[i]) return;
        __subDraft[i].endBehavior = eb;
        if (eb === 'clear') {
          if (!__subDraft[i].clearMode) __subDraft[i].clearMode = 'vanish';
          if (!__subDraft[i].fadeMs)    __subDraft[i].fadeMs    = 1000;
        } else if (eb === 'intro-outro') {
          if (!__subDraft[i].introOutroStyle) __subDraft[i].introOutroStyle = 'corner-slide';
          if (!__subDraft[i].cornerSlide) {
            __subDraft[i].cornerSlide = { anchor: 'BR', slideIn: 'right', slideOut: 'right', inMs: 500, outMs: 500 };
          }
        }
        _renderSubActionRows();
      }
      function _setXYAnchor(i, position, kind) {
        if (!__subDraft[i]) return;
        const w = Math.max(5, Math.min(100, Number(__subDraft[i].widthPct) || 40));
        const half = w / 2;
        // Assumes the slot's aspect matches the preview rect's aspect (which
        // the aspect-applier ensures), so heightPct ≈ widthPct in this frame.
        const map = {
          'TL': [half, half],
          'TR': [100 - half, half],
          'C':  [50, 50],
          'BL': [half, 100 - half],
          'BR': [100 - half, 100 - half],
        };
        const [x, y] = map[position] || [50, 50];
        __subDraft[i].xPct = x;
        __subDraft[i].yPct = y;
        if (kind === 'video') _renderVideoPreview(i);
        else _renderLottiePreview(i);
      }
      function _lottieOverlayBody(s, i) {
        const opts = LOTTIE_FILES.map(f => '<option value="' + _safeAttr(f) + '"' + (s.path === f ? ' selected' : '') + '>' + _safeAttr(f) + '</option>').join('')
                   || '<option value="">(drop .json files in public/assets/triggers/lottie/)</option>';
        const wPct = s.widthPct != null ? s.widthPct : 40;
        return ''
          + '<div style="display:grid;grid-template-columns:1fr 340px;gap:14px;align-items:start">'
          +   '<div>'
          +     '<label style="display:block;margin-bottom:4px;font-size:0.85rem;color:var(--text-muted)">Lottie file</label>'
          +     '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
          +       '<select onchange="__subDraft[' + i + '].path=this.value;_renderSubActionRows()" style="min-width:220px">' + opts + '</select>'
          +       '<button type="button" onclick="_uploadTriggerAsset(' + i + ',\\'lottie\\')">⬆ Upload .json</button>'
          +     '</div>'
          +     '<div style="display:flex;gap:12px;align-items:center;margin-top:10px;flex-wrap:wrap">'
          +       '<label>Duration <input type="number" min="100" step="100" value="' + s.durationMs + '" style="width:100px" oninput="__subDraft[' + i + '].durationMs=Number(this.value)"> ms</label>'
          +       '<label><input type="checkbox"' + (s.freezeLastFrame ? ' checked' : '') + ' onchange="__subDraft[' + i + '].freezeLastFrame=this.checked"> Freeze last frame</label>'
          +     '</div>'
          +     '<div style="margin-top:14px">'
          +       '<label>Size: <strong id="tov-w-val-' + i + '">' + wPct + '%</strong> of cam width</label>'
          +       '<input type="range" min="5" max="100" step="1" value="' + wPct + '" style="width:100%;margin-top:4px" oninput="__subDraft[' + i + '].widthPct=Number(this.value); document.getElementById(\\'tov-w-val-' + i + '\\').textContent = this.value + \\'%\\'; _renderLottiePreview(' + i + ')">'
          +     '</div>'
          +     '<p style="margin:8px 0 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
          +       '<span class="muted" style="font-size:0.85rem;margin-right:4px">Snap:</span>'
          +       _xyAnchorButtons(i, 'lottie')
          +     '</p>'
          +     '<p style="margin:6px 0 0"><span class="muted" style="font-size:0.85rem">Click/drag on the preview for precise positioning.</span></p>'
          +   '</div>'
          +   '<div>'
          +     '<div class="muted" style="font-size:0.85rem;margin-bottom:4px">Preview (source-shaped, drag to position)</div>'
          +     '<div id="tov-lot-prev-' + i + '" data-idx="' + i + '" class="lottie-prev-stage" '
          +       'style="position:relative;width:' + LOTTIE_PREVIEW_W + 'px;aspect-ratio:1;'
          +       'background:#000;border:1px solid var(--border);border-radius:6px;overflow:hidden;cursor:crosshair;user-select:none">'
          +       _lottiePreviewSlotHtml(s)
          +     '</div>'
          +   '</div>'
          + '</div>';
      }
      function _attachLottiePreviewDrag() {
        document.querySelectorAll('.lottie-prev-stage').forEach(prev => {
          const idx = Number(prev.dataset.idx);
          function setFromXY(clientX, clientY) {
            const rect = prev.getBoundingClientRect();
            const xp = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
            const yp = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
            __subDraft[idx].xPct = Math.round(xp * 10) / 10;
            __subDraft[idx].yPct = Math.round(yp * 10) / 10;
            _renderLottiePreview(idx);
          }
          prev.onmousedown = (e) => {
            setFromXY(e.clientX, e.clientY);
            const move = (ev) => setFromXY(ev.clientX, ev.clientY);
            const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
            e.preventDefault();
          };
          prev.ontouchstart = (e) => {
            const t = e.touches[0]; if (!t) return;
            setFromXY(t.clientX, t.clientY);
            const move = (ev) => { const tt = ev.touches[0]; if (tt) { setFromXY(tt.clientX, tt.clientY); ev.preventDefault(); } };
            const up = () => { document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up); };
            document.addEventListener('touchmove', move, { passive: false });
            document.addEventListener('touchend', up);
          };
        });
      }

      // ---- video-overlay editor: preview + drag-center + width slider ----
      const VIDEO_PREVIEW_W = 320;
      function _videoPreviewSlotHtml(s) {
        const wPct = Math.max(5, Math.min(100, Number(s.widthPct != null ? s.widthPct : 50)));
        const label = (s.path || 'video').replace(/\\.(webm|mp4)$/i, '');
        // Slot uses the source aspect (set via CSS var on the outer prev),
        // so its width = wPct% of outer.width and height matches the source.
        const cropRadius = s.circleCrop ? '50%' : '6px';
        return ''
          + '<div class="vid-prev-slot" style="position:absolute;'
          +   'left:' + (s.xPct != null ? s.xPct : 50) + '%;'
          +   'top:'  + (s.yPct != null ? s.yPct : 50) + '%;'
          +   'width:' + wPct + '%;aspect-ratio:var(--src-aspect, 1);transform:translate(-50%,-50%);'
          +   'background:rgba(42,109,244,0.32);border:2px dashed #79a6ff;border-radius:' + cropRadius + ';'
          +   'pointer-events:none;display:flex;align-items:center;justify-content:center;'
          +   'color:#fff;font-size:0.78rem;font-weight:700;text-shadow:0 1px 2px rgba(0,0,0,0.7);text-align:center;padding:0 6px">'
          +   _safeAttr(label)
          +   '<div style="position:absolute;left:50%;top:50%;width:10px;height:10px;background:#fff;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 2px rgba(0,0,0,0.5)"></div>'
          + '</div>';
      }
      function _renderVideoPreview(i) {
        const prev = document.getElementById('tov-vid-prev-' + i);
        if (!prev) return;
        prev.innerHTML = _videoPreviewSlotHtml(__subDraft[i]);
      }
      // Partial re-render: only the cam-toast preview pill (keeps focus in the
      // text input / color pickers above).
      function _renderCamToastPreview(i) {
        const wrap = document.getElementById('ct-prev-' + i);
        const s = __subDraft[i];
        if (!wrap || !s) return;
        const tc = _safeAttr(s.textColor || '#ffffff');
        const bc = _safeAttr(s.bgColor   || '#1c482e');
        const txt = _safeAttr(s.text || '');
        wrap.innerHTML = '<span style="background:' + bc + ';color:' + tc + ';padding:5px 16px;border-radius:999px;font-size:0.92rem;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,0.85)">' + (txt || '(empty)') + '</span>';
      }
      // Probe the selected video's natural width/height via a hidden <video>
      // element and stamp the aspect onto the preview rectangle (and the
      // slot via a CSS var) so the editor reflects the file's true shape.
      function _applyVideoAspect(i) {
        const prev = document.getElementById('tov-vid-prev-' + i);
        const p = __subDraft[i] && __subDraft[i].path;
        if (!prev || !p) return;
        const probe = document.createElement('video');
        probe.preload = 'metadata';
        probe.muted = true;
        probe.src = '/assets/triggers/video/' + encodeURIComponent(p);
        probe.addEventListener('loadedmetadata', () => {
          if (probe.videoWidth > 0 && probe.videoHeight > 0) {
            const ar = probe.videoWidth + '/' + probe.videoHeight;
            prev.style.aspectRatio = ar;
            prev.style.setProperty('--src-aspect', ar);
          }
        });
      }
      function _videoOverlayBody(s, i) {
        const mode = s.mode === 'clear' ? 'clear' : 'add';
        const modeRow =
            '<label style="margin-right:14px"><input type="radio" name="m-vov-mode-' + i + '" value="add"' + (mode === 'add' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'add\\';_renderSubActionRows()"> ADD</label>'
          + '<label><input type="radio" name="m-vov-mode-' + i + '" value="clear"' + (mode === 'clear' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'clear\\';_renderSubActionRows()"> CLEAR</label>';
        if (mode === 'clear') {
          return modeRow
            + '<p class="muted" style="font-size:0.9rem;margin:10px 0 0">Wipes whatever video / lottie overlay is currently mounted on the host cam tile. No file or position needed.</p>';
        }
        const opts = VIDEO_FILES.map(f => '<option value="' + _safeAttr(f) + '"' + (s.path === f ? ' selected' : '') + '>' + _safeAttr(f) + '</option>').join('')
                   || '<option value="">(no videos uploaded yet)</option>';
        const wPct = s.widthPct != null ? s.widthPct : 50;
        const dur = s.durationMs != null ? s.durationMs : 8000;
        const endBehavior = (s.endBehavior === 'clear' || s.endBehavior === 'intro-outro') ? s.endBehavior : 'default';
        const clearMode = s.clearMode === 'fade' ? 'fade' : 'vanish';
        const fadeMs = s.fadeMs != null ? s.fadeMs : 1000;
        const cs = s.cornerSlide || { anchor: 'BR', slideIn: 'right', slideOut: 'right', inMs: 500, outMs: 500 };

        const dirOpts = (sel) => ['left','right','top','bottom']
          .map(d => '<option value="' + d + '"' + (sel === d ? ' selected' : '') + '>' + d + '</option>').join('');
        const anchorOpts = (sel) => ['TL','TR','BL','BR','C']
          .map(a => '<option value="' + a + '"' + (sel === a ? ' selected' : '') + '>' + a + '</option>').join('');

        const radioName = 'm-vov-end-' + i;
        const endBehaviorRow = !s.loop ? ''
          +   '<div style="margin-top:12px;padding-top:8px;border-top:1px dashed var(--border)">'
          +     '<div class="muted" style="font-size:0.85rem;margin-bottom:6px">End behavior (when video finishes playing)</div>'
          +     '<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">'
          +       '<label><input type="radio" name="' + radioName + '" value="default"' + (endBehavior === 'default' ? ' checked' : '') + ' onchange="_setVideoEndBehavior(' + i + ',\\'default\\')"> Default</label>'
          +       '<label><input type="radio" name="' + radioName + '" value="clear"' + (endBehavior === 'clear' ? ' checked' : '') + ' onchange="_setVideoEndBehavior(' + i + ',\\'clear\\')"> Clear when complete</label>'
          +       '<label><input type="radio" name="' + radioName + '" value="intro-outro"' + (endBehavior === 'intro-outro' ? ' checked' : '') + ' onchange="_setVideoEndBehavior(' + i + ',\\'intro-outro\\')"> Intro / Outro</label>'
          +     '</div>'
          +     (endBehavior === 'clear' ? ''
            +   '<div style="margin-top:6px;margin-left:18px;display:flex;gap:14px;align-items:center;flex-wrap:wrap">'
            +     '<label><input type="radio" name="m-vov-clearmode-' + i + '" value="vanish"' + (clearMode === 'vanish' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].clearMode=\\'vanish\\';_renderSubActionRows()"> Vanish</label>'
            +     '<label style="display:flex;gap:6px;align-items:center"><input type="radio" name="m-vov-clearmode-' + i + '" value="fade"' + (clearMode === 'fade' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].clearMode=\\'fade\\';_renderSubActionRows()"> Freeze and fade <input type="number" min="0.1" step="0.1" value="' + (fadeMs / 1000) + '" style="width:70px"' + (clearMode === 'fade' ? '' : ' disabled') + ' oninput="__subDraft[' + i + '].fadeMs=Math.max(100, Number(this.value) * 1000)"> sec</label>'
            +   '</div>'
            : '')
          +     (endBehavior === 'intro-outro' ? ''
            +   '<div style="margin-top:8px;margin-left:18px;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-3)">'
            +     '<div style="font-size:0.85rem;font-weight:600;margin-bottom:6px">Corner Slide</div>'
            +     '<div style="display:grid;grid-template-columns:auto 1fr;gap:8px 14px;align-items:center;font-size:0.9rem;max-width:480px">'
            +       '<label>Target corner</label>'
            +       '<select onchange="__subDraft[' + i + '].cornerSlide.anchor=this.value">' + anchorOpts(cs.anchor) + '</select>'
            +       '<label>Slide in from</label>'
            +       '<select onchange="__subDraft[' + i + '].cornerSlide.slideIn=this.value">' + dirOpts(cs.slideIn) + '</select>'
            +       '<label>Slide out to</label>'
            +       '<select onchange="__subDraft[' + i + '].cornerSlide.slideOut=this.value">' + dirOpts(cs.slideOut) + '</select>'
            +       '<label>Slide in duration</label>'
            +       '<span><input type="number" min="0.1" step="0.1" value="' + (cs.inMs / 1000) + '" style="width:80px" oninput="__subDraft[' + i + '].cornerSlide.inMs=Math.max(100, Number(this.value) * 1000)"> sec</span>'
            +       '<label>Slide out duration</label>'
            +       '<span><input type="number" min="0.1" step="0.1" value="' + (cs.outMs / 1000) + '" style="width:80px" oninput="__subDraft[' + i + '].cornerSlide.outMs=Math.max(100, Number(this.value) * 1000)"> sec</span>'
            +     '</div>'
            +     '<p class="muted" style="font-size:0.8rem;margin:6px 0 0">Video slides in from offscreen → plays once → slides off in the chosen exit direction.</p>'
            +   '</div>'
            : '')
          +   '</div>'
          : '';
        return ''
          + modeRow
          + '<div style="margin-top:10px;display:grid;grid-template-columns:1fr 340px;gap:14px;align-items:start">'
          +   '<div>'
          +     '<label style="display:block;margin-bottom:4px;font-size:0.85rem;color:var(--text-muted)">Video file (.webm or .mp4 — use alpha-WebM if you need transparency)</label>'
          +     '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
          +       '<select onchange="__subDraft[' + i + '].path=this.value;_renderSubActionRows()" style="min-width:220px">' + opts + '</select>'
          +       '<button type="button" onclick="_uploadTriggerAsset(' + i + ',\\'video\\')">⬆ Upload video</button>'
          +     '</div>'
          +     '<div style="display:flex;gap:12px;align-items:center;margin-top:10px;flex-wrap:wrap">'
          +       '<label>Duration <input type="number" min="100" step="100" value="' + dur + '" style="width:110px" oninput="__subDraft[' + i + '].durationMs=Number(this.value)"' + ((s.loop || s.freezeLastFrame) ? ' disabled' : '') + '> ms</label>'
          +       '<label><input type="checkbox"' + (s.loop ? ' checked' : '') + ' onchange="__subDraft[' + i + '].loop=this.checked;if(this.checked){__subDraft[' + i + '].freezeLastFrame=false;__subDraft[' + i + '].endBehavior=\\'default\\';}_renderSubActionRows()"> Loop</label>'
          +       '<label><input type="checkbox"' + (s.freezeLastFrame ? ' checked' : '') + (endBehavior !== 'default' ? ' disabled' : '') + ' onchange="__subDraft[' + i + '].freezeLastFrame=this.checked;if(this.checked){__subDraft[' + i + '].loop=false;}_renderSubActionRows()"> Freeze last frame</label>'
          +       '<label><input type="checkbox"' + (s.muted ? ' checked' : '') + ' onchange="__subDraft[' + i + '].muted=this.checked"> Muted</label>'
          +       '<label title="Clips the slot to a circle/ellipse. Looks best with a 1:1 source."><input type="checkbox"' + (s.circleCrop ? ' checked' : '') + ' onchange="__subDraft[' + i + '].circleCrop=this.checked;_renderVideoPreview(' + i + ')"> Circle crop</label>'
          +     '</div>'
          +     '<div style="margin-top:14px">'
          +       '<label>Size: <strong id="tov-vw-val-' + i + '">' + wPct + '%</strong> of cam width</label>'
          +       '<input type="range" min="5" max="100" step="1" value="' + wPct + '" style="width:100%;margin-top:4px" oninput="__subDraft[' + i + '].widthPct=Number(this.value); document.getElementById(\\'tov-vw-val-' + i + '\\').textContent = this.value + \\'%\\'; _renderVideoPreview(' + i + ')">'
          +     '</div>'
          +     '<p style="margin:8px 0 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
          +       '<span class="muted" style="font-size:0.85rem;margin-right:4px">Snap:</span>'
          +       _xyAnchorButtons(i, 'video')
          +     '</p>'
          +     '<p style="margin:6px 0 0"><span class="muted" style="font-size:0.85rem">Click/drag the preview for precise positioning. Loop and Freeze are mutually exclusive — End behavior overrides Freeze.</span></p>'
          +     endBehaviorRow
          +   '</div>'
          +   '<div>'
          +     '<div class="muted" style="font-size:0.85rem;margin-bottom:4px">Preview (source-shaped, drag to position)</div>'
          +     '<div id="tov-vid-prev-' + i + '" data-idx="' + i + '" class="video-prev-stage" '
          +       'style="position:relative;width:' + VIDEO_PREVIEW_W + 'px;aspect-ratio:1;'
          +       'background:#000;border:1px solid var(--border);border-radius:6px;overflow:hidden;cursor:crosshair;user-select:none">'
          +       _videoPreviewSlotHtml(s)
          +     '</div>'
          +   '</div>'
          + '</div>';
      }
      function _attachVideoPreviewDrag() {
        document.querySelectorAll('.video-prev-stage').forEach(prev => {
          const idx = Number(prev.dataset.idx);
          function setFromXY(clientX, clientY) {
            const rect = prev.getBoundingClientRect();
            const xp = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
            const yp = Math.max(0, Math.min(100, ((clientY - rect.top) / rect.height) * 100));
            __subDraft[idx].xPct = Math.round(xp * 10) / 10;
            __subDraft[idx].yPct = Math.round(yp * 10) / 10;
            _renderVideoPreview(idx);
          }
          prev.onmousedown = (e) => {
            setFromXY(e.clientX, e.clientY);
            const move = (ev) => setFromXY(ev.clientX, ev.clientY);
            const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
            e.preventDefault();
          };
          prev.ontouchstart = (e) => {
            const t = e.touches[0]; if (!t) return;
            setFromXY(t.clientX, t.clientY);
            const move = (ev) => { const tt = ev.touches[0]; if (tt) { setFromXY(tt.clientX, tt.clientY); ev.preventDefault(); } };
            const up = () => { document.removeEventListener('touchmove', move); document.removeEventListener('touchend', up); };
            document.addEventListener('touchmove', move, { passive: false });
            document.addEventListener('touchend', up);
          };
        });
      }

      const TEXT_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
      function _anchorGrid(idx, current, includeAll) {
        const opts = TEXT_ANCHORS.concat(includeAll ? ['all'] : []);
        return '<div id="tov-anchors-' + idx + '" style="display:flex;flex-wrap:wrap;gap:6px">' + opts.map(a => {
          const sel = a === current;
          const label = a === 'all' ? 'ALL' : a;
          return '<button type="button" data-anchor="' + a + '" onclick="_setAnchor(' + idx + ',\\'' + a + '\\')" '
            + 'style="padding:8px 10px;border-radius:8px;font-size:0.85rem;border:1px solid var(--border);background:'
            + (sel ? '#7b3fd6' : 'var(--bg-2)') + ';color:' + (sel ? '#fff' : 'var(--text)') + ';cursor:pointer">' + label + '</button>';
        }).join('') + '</div>';
      }
      function _setAnchor(i, anchor) {
        __subDraft[i].anchor = anchor;
        const grid = document.getElementById('tov-anchors-' + i);
        if (grid) {
          grid.querySelectorAll('button').forEach(b => {
            const sel = b.dataset.anchor === anchor;
            b.style.background = sel ? '#7b3fd6' : 'var(--bg-2)';
            b.style.color = sel ? '#fff' : 'var(--text)';
          });
        }
        _renderTextOverlayPreview(i);
      }
      function _textOverlayPreview(s) {
        // 4:3 black rectangle, 320×240, with the text positioned at the chosen anchor.
        if (s.mode === 'clear') {
          const txt = s.anchor === 'all' ? 'Clears every overlay' : 'Clears ' + s.anchor;
          return '<div style="display:flex;align-items:center;justify-content:center;width:320px;height:240px;background:#000;border:2px dashed #f0c674;border-radius:6px;color:#f0c674;font-style:italic">' + _safeAttr(txt) + '</div>';
        }
        const ax = (s.anchor || 'top-left');
        const pos = {
          'top-left':     'top:8px;left:8px;text-align:left',
          'top-right':    'top:8px;right:8px;text-align:right',
          'bottom-left':  'bottom:8px;left:8px;text-align:left',
          'bottom-right': 'bottom:8px;right:8px;text-align:right',
          'center':       'top:50%;left:50%;transform:translate(-50%,-50%);text-align:center',
        }[ax] || 'top:8px;left:8px';
        const bg = s.bgColor ? 'background:' + _safeAttr(s.bgColor) + ';padding:4px 8px;border-radius:6px' : '';
        return '<div style="position:relative;width:320px;height:240px;background:#000;border:1px solid var(--border);border-radius:6px;overflow:hidden">'
          + '<div style="position:absolute;' + pos + ';max-width:90%;color:' + _safeAttr(s.fontColor || '#fff')
          + ';font-size:' + Math.max(8, Math.min(60, (s.fontSize || 24) * (240 / 720))) + 'px;font-weight:700;line-height:1.2;'
          + bg + '">' + _safeAttr(s.text || '').replace(/\\n/g, '<br>') + '</div>'
        + '</div>';
      }
      // Lightweight re-render: replaces ONLY the preview rectangle's contents
      // — never the surrounding inputs — so focus stays in the textarea/font
      // size while you're typing or pressing arrow keys.
      function _renderTextOverlayPreview(i) {
        const wrap = document.getElementById('tov-text-prev-' + i);
        if (!wrap) return;
        wrap.innerHTML = _textOverlayPreview(__subDraft[i]);
      }
      function _textOverlayBody(s, i) {
        const modeRow =
            '<label style="margin-right:14px"><input type="radio" name="m-tov-mode-' + i + '" value="add"' + (s.mode === 'add' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'add\\';_renderSubActionRows()"> ADD</label>'
          + '<label><input type="radio" name="m-tov-mode-' + i + '" value="clear"' + (s.mode === 'clear' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'clear\\';_renderSubActionRows()"> CLEAR</label>';
        if (s.mode === 'clear') {
          return modeRow + '<div style="margin-top:8px"><div class="muted" style="font-size:0.85rem;margin-bottom:4px">Anchor</div>' + _anchorGrid(i, s.anchor, true) + '</div>'
            + '<div id="tov-text-prev-' + i + '" style="margin-top:10px">' + _textOverlayPreview(s) + '</div>';
        }
        const hasBg = !!s.bgColor;
        return ''
          + modeRow
          + '<div style="display:grid;grid-template-columns:1fr 340px;gap:14px;margin-top:10px;align-items:start">'
          +   '<div>'
          +     '<label style="display:block;margin-bottom:4px;font-size:0.85rem;color:var(--text-muted)">Text</label>'
          +     '<textarea rows="3" style="width:100%" oninput="__subDraft[' + i + '].text=this.value;_renderTextOverlayPreview(' + i + ')">' + _safeAttr(s.text || '') + '</textarea>'
          +     '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">'
          +       '<label>Font <input type="color" value="' + _safeAttr(s.fontColor || '#ffffff') + '" style="width:36px;height:32px;border:1px solid var(--border);border-radius:6px;padding:0" oninput="__subDraft[' + i + '].fontColor=this.value;_renderTextOverlayPreview(' + i + ')"></label>'
          +       '<label><input type="checkbox"' + (hasBg ? ' checked' : '') + ' onchange="__subDraft[' + i + '].bgColor = this.checked ? \\'#000000aa\\' : null;_renderSubActionRows()"> Background</label>'
          +       (hasBg ? '<input type="color" value="' + _safeAttr((s.bgColor || '#000000').slice(0, 7)) + '" style="width:36px;height:32px;border:1px solid var(--border);border-radius:6px;padding:0" oninput="__subDraft[' + i + '].bgColor=this.value;_renderTextOverlayPreview(' + i + ')">' : '')
          +       '<label>Size <input type="number" min="8" max="200" value="' + (s.fontSize || 24) + '" style="width:80px" oninput="__subDraft[' + i + '].fontSize=Number(this.value);_renderTextOverlayPreview(' + i + ')"> px</label>'
          +     '</div>'
          +     '<div style="margin-top:14px">'
          +       '<div class="muted" style="font-size:0.85rem;margin-bottom:4px">Anchor</div>'
          +       _anchorGrid(i, s.anchor, false)
          +     '</div>'
          +   '</div>'
          +   '<div>'
          +     '<div class="muted" style="font-size:0.85rem;margin-bottom:4px">Preview (cam-shaped)</div>'
          +     '<div id="tov-text-prev-' + i + '">' + _textOverlayPreview(s) + '</div>'
          +   '</div>'
          + '</div>';
      }
      function _renderSubActionRows() {
        const wrap = document.getElementById('m-sub-rows');
        if (!wrap) return;
        wrap.innerHTML = __subDraft.map((s, i) => {
          const kindOpts = SUB_ACTION_KINDS.map(k => '<option value="' + k.kind + '"' + (s.kind === k.kind ? ' selected' : '') + (k.enabled ? '' : ' disabled') + '>' + k.kind + (k.enabled ? '' : ' (spec TBD)') + '</option>').join('');
          let body = '';
          if (s.kind === 'text-overlay') {
            body = _textOverlayBody(s, i);
          } else if (s.kind === 'lottie-overlay') {
            body = _lottieOverlayBody(s, i);
          } else if (s.kind === 'video-overlay') {
            body = _videoOverlayBody(s, i);
          } else if (s.kind === 'play-sound') {
            const opts = SOUND_FILES.map(f => '<option value="' + _safeAttr(f) + '"' + (s.path === f ? ' selected' : '') + '>' + _safeAttr(f) + '</option>').join('');
            body = '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
                 +   '<label>File <select onchange="__subDraft[' + i + '].path=this.value" style="min-width:200px">' + (opts || '<option value="">(no sounds uploaded yet)</option>') + '</select></label>'
                 +   '<button type="button" onclick="_uploadTriggerAsset(' + i + ',\\'sound\\')">⬆ Upload audio</button>'
                 +   '<label>Vol <input type="number" min="0" max="1" step="0.05" value="' + s.volume + '" style="width:70px" oninput="__subDraft[' + i + '].volume=Number(this.value)"></label>'
                 +   '<label><input type="checkbox"' + (s.blocking ? ' checked' : '') + ' onchange="__subDraft[' + i + '].blocking=this.checked;_renderSubActionRows()"> hold for ' + (s.blocking ? '<input type="number" min="0" step="100" value="' + s.estDurationMs + '" style="width:80px" oninput="__subDraft[' + i + '].estDurationMs=Number(this.value)"> ms' : 'duration') + '</label>'
                 + '</div>';
          } else if (s.kind === 'cam-toast') {
            const tc = _safeAttr(s.textColor || '#ffffff');
            const bc = _safeAttr(s.bgColor   || '#1c482e');
            const txt = _safeAttr(s.text || '');
            body = '<label style="display:block;margin-bottom:4px;font-size:0.85rem;color:var(--text-muted)">Notification text</label>'
                 + '<input type="text" maxlength="200" style="width:100%" value="' + txt + '" oninput="__subDraft[' + i + '].text=this.value;_renderCamToastPreview(' + i + ')">'
                 + '<div style="display:flex;gap:14px;align-items:center;margin-top:10px;flex-wrap:wrap">'
                 +   '<label style="display:flex;gap:6px;align-items:center">Text color <input type="color" value="' + tc + '" style="width:36px;height:32px;border:1px solid var(--border);border-radius:6px;padding:0" oninput="__subDraft[' + i + '].textColor=this.value;_renderCamToastPreview(' + i + ')"></label>'
                 +   '<label style="display:flex;gap:6px;align-items:center">Background <input type="color" value="' + bc + '" style="width:36px;height:32px;border:1px solid var(--border);border-radius:6px;padding:0" oninput="__subDraft[' + i + '].bgColor=this.value;_renderCamToastPreview(' + i + ')"></label>'
                 +   '<span class="muted" style="font-size:0.85rem">Toast rises over the host cam tile, same animation as button-press flashes.</span>'
                 + '</div>'
                 + '<div style="margin-top:10px"><span class="muted" style="font-size:0.85rem">Preview:</span></div>'
                 + '<div id="ct-prev-' + i + '" style="margin-top:4px;background:#000;padding:14px;border:1px solid var(--border);border-radius:6px;display:flex;justify-content:center">'
                 +   '<span style="background:' + bc + ';color:' + tc + ';padding:5px 16px;border-radius:999px;font-size:0.92rem;font-weight:600;text-shadow:0 1px 2px rgba(0,0,0,0.85)">' + (txt || '(empty)') + '</span>'
                 + '</div>';
          } else if (s.kind === 'device-control') {
            const modeRadios = '<label><input type="radio" name="m-dc-mode-' + i + '" value="on"' + (s.mode === 'on' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'on\\';_renderSubActionRows()"> On</label> '
                             + '<label><input type="radio" name="m-dc-mode-' + i + '" value="on-cycle"' + (s.mode === 'on-cycle' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'on-cycle\\';_renderSubActionRows()"> Cycle</label> '
                             + '<label><input type="radio" name="m-dc-mode-' + i + '" value="off"' + (s.mode === 'off' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'off\\';_renderSubActionRows()"> Off</label>';
            // 'all' is always legal now (off = turn everything off; on / cycle
            // = drive every device in lockstep) so we surface it for every mode.
            const devList = DEVICES_OFF;
            const devOpts = devList.map(d => '<option value="' + _safeAttr(d.id) + '"' + (s.deviceId === d.id ? ' selected' : '') + '>' + _safeAttr(d.label) + '</option>').join('');
            const detail = s.mode === 'off'
              ? ''
              : s.mode === 'on'
                ? '<label>Duration <input type="number" min="100" step="100" value="' + s.durationMs + '" style="width:100px" oninput="__subDraft[' + i + '].durationMs=Number(this.value)"' + (s.infinite ? ' disabled' : '') + '> ms</label> '
                  + '<label><input type="checkbox"' + (s.infinite ? ' checked' : '') + ' onchange="__subDraft[' + i + '].infinite=this.checked;_renderSubActionRows()"> infinite</label>'
                : '<label>On <input type="number" min="100" step="100" value="' + s.cycleOnMs + '" style="width:80px" oninput="__subDraft[' + i + '].cycleOnMs=Number(this.value)"> ms</label> '
                  + '<label>Off <input type="number" min="100" step="100" value="' + s.cycleOffMs + '" style="width:80px" oninput="__subDraft[' + i + '].cycleOffMs=Number(this.value)"> ms</label> '
                  + '<label>× <input type="number" min="1" value="' + s.cycleTimes + '" style="width:70px" oninput="__subDraft[' + i + '].cycleTimes=Number(this.value)"' + (s.cycleInfinite ? ' disabled' : '') + '></label> '
                  + '<label><input type="checkbox"' + (s.cycleInfinite ? ' checked' : '') + ' onchange="__subDraft[' + i + '].cycleInfinite=this.checked;_renderSubActionRows()"> infinite</label>';
            body = modeRadios
                 + '<div style="margin-top:6px"><label>Device <select onchange="__subDraft[' + i + '].deviceId=this.value" style="min-width:220px">' + devOpts + '</select></label></div>'
                 + (detail ? '<div style="margin-top:6px">' + detail + '</div>' : '');
          } else if (s.kind === 'wait') {
            body = '<label>Duration <input type="number" min="100" step="100" value="' + s.durationMs + '" style="width:100px" oninput="__subDraft[' + i + '].durationMs=Number(this.value)"> ms</label>';
          } else if (s.kind === 'turn-off-host-cam') {
            body = '<span class="muted">No options.</span>';
          } else if (s.kind === 'end-session') {
            const sec = Math.round((s.delayMs || 5000) / 1000);
            body = ''
              + '<label style="margin-right:14px"><input type="radio" name="m-es-mode-' + i + '" value="instant"' + (s.mode === 'instant' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'instant\\';_renderSubActionRows()"> Instant</label>'
              + '<label><input type="radio" name="m-es-mode-' + i + '" value="delayed"' + (s.mode === 'delayed' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'delayed\\';_renderSubActionRows()"> After</label>'
              + (s.mode === 'delayed'
                  ? '<label style="margin-left:10px"><input type="number" min="1" max="300" step="1" value="' + sec + '" style="width:80px" oninput="__subDraft[' + i + '].delayMs=Math.max(1000, Number(this.value) * 1000)"> seconds</label>'
                    + '<p class="muted" style="font-size:0.85rem;margin:8px 0 0">Visitors see a full-screen countdown (<em>“Session ending in N”</em>) while the timer runs, then the session ends.</p>'
                  : '<p class="muted" style="font-size:0.85rem;margin:8px 0 0">Ends the active session immediately.</p>');
          } else {
            body = '<span class="muted">Spec TBD — this sub-action can\\'t be saved yet.</span>';
          }
          const collapsed = !!s._collapsed;
          const summary = collapsed ? _clientSummarize(s) : '';
          return ''
            + '<div class="sub-action-row" draggable="true" data-idx="' + i + '" style="border:1px solid var(--border);border-radius:8px;background:var(--bg-3);padding:10px 12px;margin-bottom:10px">'
            +   '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
            +     '<span class="sub-drag-handle" title="drag to reorder" style="cursor:grab;color:var(--text-faint);font-size:1.1rem;padding:4px 6px;user-select:none">⋮⋮</span>'
            +     '<button type="button" onclick="_toggleSub(' + i + ')" title="' + (collapsed ? 'expand' : 'collapse') + '" style="background:transparent;color:var(--text);border:1px solid var(--border);padding:4px 8px;font-size:0.8rem;min-width:30px">' + (collapsed ? '▶' : '▼') + '</button>'
            +     '<select onchange="__subDraft[' + i + '] = _newSubAction(this.value);_renderSubActionRows()" style="min-width:180px">' + kindOpts + '</select>'
            +     (collapsed ? '<span style="flex:1;min-width:0;color:var(--text-muted);font-size:0.9rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + _safeAttr(summary) + '</span>' : '')
            +     '<button onclick="_moveSub(' + i + ',-1)" ' + (i === 0 ? 'disabled' : '') + ' title="move up">↑</button>'
            +     '<button onclick="_moveSub(' + i + ',1)" ' + (i === __subDraft.length - 1 ? 'disabled' : '') + ' title="move down">↓</button>'
            +     '<button onclick="_copySub(' + i + ')" title="duplicate this sub-action">📋</button>'
            +     '<button onclick="_removeSub(' + i + ')" style="background:#4a1b1b' + (collapsed ? '' : ';margin-left:auto') + '" title="delete">×</button>'
            +   '</div>'
            +   (collapsed ? '' : '<div style="margin-top:8px">' + body + '</div>')
            + '</div>';
        }).join('');
        _attachSubActionDrag();
        _attachLottiePreviewDrag();
        _attachVideoPreviewDrag();
        // After the previews mount, fetch each source file's natural aspect
        // and stamp it onto the corresponding preview rectangle.
        __subDraft.forEach((s, idx) => {
          if (!s || s._collapsed) return;
          if (s.kind === 'video-overlay' && s.mode !== 'clear') _applyVideoAspect(idx);
          else if (s.kind === 'lottie-overlay')                 _applyLottieAspect(idx);
        });
      }
      function _attachSubActionDrag() {
        const container = document.getElementById('m-sub-rows');
        if (!container) return;
        let srcIdx = null;
        container.querySelectorAll('.sub-action-row').forEach(el => {
          el.addEventListener('dragstart', e => {
            srcIdx = Number(el.dataset.idx);
            el.style.opacity = '0.4';
            e.dataTransfer.effectAllowed = 'move';
            try { e.dataTransfer.setData('text/plain', String(srcIdx)); } catch {}
          });
          el.addEventListener('dragend', () => { el.style.opacity = ''; srcIdx = null; });
          el.addEventListener('dragover', e => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            el.style.outline = '2px dashed var(--accent)';
          });
          el.addEventListener('dragleave', () => { el.style.outline = ''; });
          el.addEventListener('drop', e => {
            e.preventDefault();
            el.style.outline = '';
            const src = srcIdx != null ? srcIdx : Number(e.dataTransfer.getData('text/plain'));
            const tgt = Number(el.dataset.idx);
            if (!Number.isFinite(src) || src === tgt) return;
            const moved = __subDraft.splice(src, 1)[0];
            __subDraft.splice(tgt, 0, moved);
            _renderSubActionRows();
          });
        });
      }
      function _moveSub(i, dir) {
        const j = i + dir;
        if (j < 0 || j >= __subDraft.length) return;
        const t = __subDraft[i]; __subDraft[i] = __subDraft[j]; __subDraft[j] = t;
        _renderSubActionRows();
      }
      function _copySub(i) {
        // Deep-clone via JSON so editor inputs don't share refs (e.g. nested
        // arrays). Inserts the duplicate immediately after the source — drag
        // it wherever from there.
        const src = __subDraft[i];
        if (!src) return;
        const dup = JSON.parse(JSON.stringify(src));
        __subDraft.splice(i + 1, 0, dup);
        _renderSubActionRows();
      }
      function _removeSub(i) {
        __subDraft.splice(i, 1);
        _renderSubActionRows();
      }
      function _addSub() {
        const firstEnabled = SUB_ACTION_KINDS.find(k => k.enabled);
        if (!firstEnabled) return;
        // Newly-added rows open expanded so the editor is ready to use.
        __subDraft.push(Object.assign(_newSubAction(firstEnabled.kind), { _collapsed: false }));
        _renderSubActionRows();
      }
      function _toggleSub(i) {
        if (!__subDraft[i]) return;
        __subDraft[i]._collapsed = !__subDraft[i]._collapsed;
        _renderSubActionRows();
      }
      // One-line client-side summary used in the collapsed-row header. Server
      // has its own _summarizeSubAction for the actions table; this mirrors
      // the same shapes but reads the in-progress draft.
      function _clientSummarize(s) {
        if (!s) return '';
        if (s.kind === 'text-overlay') {
          if (s.mode === 'clear') return 'clear text · ' + (s.anchor || '?');
          const t = String(s.text || '');
          const trimmed = t.length > 30 ? t.slice(0, 30) + '…' : t;
          return 'text “' + trimmed + '” · ' + (s.anchor || '?');
        }
        if (s.kind === 'lottie-overlay') return 'lottie ' + (s.path || '?') + ' · ' + s.durationMs + 'ms' + (s.freezeLastFrame ? ' · frozen' : '');
        if (s.kind === 'video-overlay') {
          if (s.mode === 'clear') return 'clear video overlay';
          const endBits = s.endBehavior === 'clear'
            ? (s.clearMode === 'fade' ? ' · fade ' + (s.fadeMs / 1000) + 's' : ' · auto-clear')
            : (s.endBehavior === 'intro-outro'
                ? ' · slide(' + (s.cornerSlide?.anchor || '?') + ')'
                : '');
          const flags = (s.loop ? ' · loop' : '') + (s.freezeLastFrame ? ' · frozen' : '')
            + (s.muted ? ' · muted' : '') + (s.circleCrop ? ' · circle' : '') + endBits;
          const dur = (s.loop || s.freezeLastFrame) ? '' : ' · ' + s.durationMs + 'ms';
          return 'video ' + (s.path || '?') + dur + flags;
        }
        if (s.kind === 'play-sound') return 'sound ' + (s.path || '?') + (s.blocking ? ' · hold ' + s.estDurationMs + 'ms' : '');
        if (s.kind === 'cam-toast') {
          const t = String(s.text || '');
          const trimmed = t.length > 30 ? t.slice(0, 30) + '…' : t;
          return 'toast "' + trimmed + '"';
        }
        if (s.kind === 'device-control') {
          if (s.mode === 'off') return 'device off · ' + (s.deviceId || '?');
          if (s.mode === 'on') return 'device on · ' + (s.deviceId || '?') + (s.infinite ? ' · ∞' : ' · ' + s.durationMs + 'ms');
          if (s.mode === 'on-cycle') return 'device cycle · ' + (s.deviceId || '?') + ' · ' + s.cycleOnMs + '/' + s.cycleOffMs + 'ms × ' + (s.cycleInfinite ? '∞' : s.cycleTimes);
        }
        if (s.kind === 'wait') return 'wait · ' + s.durationMs + 'ms';
        if (s.kind === 'turn-off-host-cam') return 'host cam off';
        if (s.kind === 'end-session') return 'end session' + (s.mode === 'delayed' ? ' · after ' + Math.round((s.delayMs || 0) / 1000) + 's' : ' · instant');
        return s.kind;
      }
      function _actionFormHtml(a) {
        return ''
          + '<p><label>Name <input id="m-name" type="text" style="width:100%" value="' + _safeAttr(a?.name || '') + '"></label></p>'
          + '<h4 style="margin:14px 0 8px">Sub-actions (run in order)</h4>'
          + '<div id="m-sub-rows"></div>'
          + '<p><button onclick="_addSub()">+ Add sub-action</button></p>';
      }
      function taNew() {
        __subDraft = [];
        modalOpen('New trigger action', _actionFormHtml(null), async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/triggers/actions', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ name, steps: __subDraft }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
        setTimeout(_renderSubActionRows, 0);
      }
      async function taEdit(id) {
        const list = await fetch('/api/triggers/actions').then(r => r.json());
        const a = (list.actions || []).find(x => x.id === id);
        if (!a) return flash('not found', 'bad');
        // Existing rows open collapsed — keeps the editor scannable rather than
        // a mile of inputs. Click the chevron on any row to expand it.
        __subDraft = (a.steps || []).map(s => Object.assign(JSON.parse(JSON.stringify(s)), { _collapsed: true }));
        modalOpen('Edit trigger action', _actionFormHtml(a), async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/triggers/actions/' + id, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ name, steps: __subDraft }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
        setTimeout(_renderSubActionRows, 0);
      }
      async function taDelete(id, name) {
        if (!confirm('Delete trigger action "' + name + '"? It will be removed from any group or trigger row referencing it.')) return;
        const r = await fetch('/api/triggers/actions/' + id, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.reload();
      }

      // ===========================
      // Trigger Action Groups (bottom)
      // ===========================
      let __groupDraft = [];   // ordered list of action ids
      function _renderGroupRows() {
        const wrap = document.getElementById('m-group-rows');
        if (!wrap) return;
        wrap.innerHTML = __groupDraft.map((aid, i) => {
          const opts = TRIGGER_ACTIONS.map(a => '<option value="' + a.id + '"' + (aid === a.id ? ' selected' : '') + '>' + _safeAttr(a.name) + '</option>').join('');
          return ''
            + '<div style="display:flex;gap:8px;align-items:center;border:1px solid var(--border);background:var(--bg-3);padding:8px;border-radius:8px;margin-bottom:8px">'
            +   '<select onchange="__groupDraft[' + i + ']=this.value" style="flex:1;min-width:200px">' + opts + '</select>'
            +   '<button onclick="_moveGroup(' + i + ',-1)" ' + (i === 0 ? 'disabled' : '') + '>↑</button>'
            +   '<button onclick="_moveGroup(' + i + ',1)" ' + (i === __groupDraft.length - 1 ? 'disabled' : '') + '>↓</button>'
            +   '<button onclick="_removeGroup(' + i + ')" style="background:#4a1b1b">×</button>'
            + '</div>';
        }).join('');
      }
      function _moveGroup(i, dir) {
        const j = i + dir; if (j < 0 || j >= __groupDraft.length) return;
        const t = __groupDraft[i]; __groupDraft[i] = __groupDraft[j]; __groupDraft[j] = t;
        _renderGroupRows();
      }
      function _removeGroup(i) { __groupDraft.splice(i, 1); _renderGroupRows(); }
      function _addGroupRow() {
        if (!TRIGGER_ACTIONS.length) return flash('Create a trigger action first', 'bad');
        __groupDraft.push(TRIGGER_ACTIONS[0].id);
        _renderGroupRows();
      }
      function _groupFormHtml(g) {
        return ''
          + '<p><label>Name <input id="m-name" type="text" style="width:100%" value="' + _safeAttr(g?.name || '') + '"></label></p>'
          + '<h4 style="margin:14px 0 8px">Actions (run in order)</h4>'
          + '<div id="m-group-rows"></div>'
          + '<p><button onclick="_addGroupRow()">+ Add action</button></p>';
      }
      function tgNew() {
        __groupDraft = [];
        modalOpen('New trigger action group', _groupFormHtml(null), async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/triggers/groups', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ name, actionIds: __groupDraft }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
        setTimeout(_renderGroupRows, 0);
      }
      async function tgEdit(id) {
        const list = await fetch('/api/triggers/groups').then(r => r.json());
        const g = (list.groups || []).find(x => x.id === id);
        if (!g) return flash('not found', 'bad');
        __groupDraft = (g.actionIds || []).slice();
        modalOpen('Edit trigger action group', _groupFormHtml(g), async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/triggers/groups/' + id, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ name, actionIds: __groupDraft }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
        setTimeout(_renderGroupRows, 0);
      }
      async function tgDelete(id, name) {
        if (!confirm('Delete trigger action group "' + name + '"? It will be removed from any trigger row referencing it.')) return;
        const r = await fetch('/api/triggers/groups/' + id, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.reload();
      }

      // Render the rows of the active trigger template on load.
      const sel = document.getElementById('tt-select');
      if (sel) {
        sel.value = ACTIVE_TPL_ID || '';
        sel.addEventListener('change', () => { ACTIVE_TPL_ID = sel.value; renderTriggerRows(); });
      }
      renderTriggerRows();
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'Triggers', active: 'triggers', body }));
});

function _summarizeSubAction(s) {
  if (s.kind === 'text-overlay') {
    if (s.mode === 'clear') return 'clear text ' + s.anchor;
    const t = (s.text || '').slice(0, 24) + (s.text && s.text.length > 24 ? '…' : '');
    return 'text "' + t + '" → ' + s.anchor;
  }
  if (s.kind === 'lottie-overlay') return 'lottie ' + s.path + ' (' + s.durationMs + 'ms' + (s.freezeLastFrame ? ', frozen' : '') + ')';
  if (s.kind === 'video-overlay') {
    if (s.mode === 'clear') return 'clear video overlay';
    const endStr = s.endBehavior === 'clear'
      ? (s.clearMode === 'fade' ? 'fade ' + (s.fadeMs / 1000) + 's' : 'auto-clear')
      : (s.endBehavior === 'intro-outro' ? 'slide @ ' + (s.cornerSlide?.anchor || '?') : null);
    const flags = [
      s.loop ? 'loop' : null,
      s.freezeLastFrame ? 'frozen' : null,
      s.muted ? 'muted' : null,
      s.circleCrop ? 'circle' : null,
      endStr,
    ].filter(Boolean).join(', ');
    const dur = (s.loop || s.freezeLastFrame) ? '' : s.durationMs + 'ms';
    const parts = [dur, flags].filter(Boolean).join('; ');
    return 'video ' + s.path + (parts ? ' (' + parts + ')' : '');
  }
  if (s.kind === 'play-sound')     return 'sound ' + s.path + (s.blocking ? ' (hold ' + s.estDurationMs + 'ms)' : '');
  if (s.kind === 'cam-toast') {
    const t = String(s.text || '');
    return 'toast "' + (t.length > 40 ? t.slice(0, 40) + '…' : t) + '"';
  }
  if (s.kind === 'device-control') {
    if (s.mode === 'off')      return 'device off (' + s.deviceId + ')';
    if (s.mode === 'on')       return 'device on ' + s.deviceId + (s.infinite ? ' (∞)' : (' ' + s.durationMs + 'ms'));
    if (s.mode === 'on-cycle') return 'device cycle ' + s.deviceId + ' ' + s.cycleOnMs + '/' + s.cycleOffMs + 'ms × ' + (s.cycleInfinite ? '∞' : s.cycleTimes);
  }
  if (s.kind === 'wait')              return 'wait ' + s.durationMs + 'ms';
  if (s.kind === 'turn-off-host-cam') return 'host cam off';
  if (s.kind === 'end-session')       return 'end session' + (s.mode === 'delayed' ? ' (after ' + Math.round((s.delayMs || 0) / 1000) + 's)' : ' (instant)');
  return s.kind;
}

// =====================
// REST API
// =====================

// File upload — the global express.json() body parser ignores octet-stream,
// so this route gets the raw bytes via express.raw().
router.post('/api/triggers/upload-lottie', express.raw({ type: '*/*', limit: '10mb' }), (req, res) => {
  try {
    const raw = decodeURIComponent(String(req.headers['x-filename'] || 'upload.json'));
    const sanitized = _safeBasename(raw);
    if (!sanitized.toLowerCase().endsWith('.json')) return res.status(400).json({ error: 'file must be .json' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });
    try { JSON.parse(req.body.toString('utf8')); }
    catch { return res.status(400).json({ error: 'file is not valid JSON (Lottie files are JSON)' }); }
    _ensureAssetDirs();
    const filename = _writeUnique(LOTTIE_DIR, sanitized);
    fs.writeFileSync(path.join(LOTTIE_DIR, filename), req.body);
    res.json({ ok: true, filename, files: listLottieFiles() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/triggers/upload-sound', express.raw({ type: '*/*', limit: '25mb' }), (req, res) => {
  try {
    const raw = decodeURIComponent(String(req.headers['x-filename'] || 'upload.mp3'));
    const sanitized = _safeBasename(raw);
    if (!/\.(mp3|wav|ogg|m4a)$/i.test(sanitized)) return res.status(400).json({ error: 'sound must be .mp3 / .wav / .ogg / .m4a' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });
    _ensureAssetDirs();
    const filename = _writeUnique(SOUND_DIR, sanitized);
    fs.writeFileSync(path.join(SOUND_DIR, filename), req.body);
    res.json({ ok: true, filename, files: listSoundFiles() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/triggers/upload-video', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  try {
    const raw = decodeURIComponent(String(req.headers['x-filename'] || 'upload.webm'));
    const sanitized = _safeBasename(raw);
    if (!/\.(webm|mp4)$/i.test(sanitized)) return res.status(400).json({ error: 'video must be .webm or .mp4' });
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'empty upload' });
    _ensureAssetDirs();
    const filename = _writeUnique(VIDEO_DIR, sanitized);
    fs.writeFileSync(path.join(VIDEO_DIR, filename), req.body);
    res.json({ ok: true, filename, files: listVideoFiles() });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/api/triggers/actions', (_req, res) => res.json({ actions: triggers.listActions() }));
router.get('/api/triggers/actions/:id', (req, res) => {
  try { res.json({ action: triggers.getAction(req.params.id) }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
router.post('/api/triggers/actions', (req, res) => {
  try { res.json({ action: triggers.createAction(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/triggers/actions/:id', (req, res) => {
  try { res.json({ action: triggers.updateAction(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/triggers/actions/:id', (req, res) => {
  try { triggers.deleteAction(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/api/triggers/groups', (_req, res) => res.json({ groups: triggers.listGroups() }));
router.post('/api/triggers/groups', (req, res) => {
  try { res.json({ group: triggers.createGroup(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/triggers/groups/:id', (req, res) => {
  try { res.json({ group: triggers.updateGroup(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/triggers/groups/:id', (req, res) => {
  try { triggers.deleteGroup(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/api/triggers/templates', (_req, res) => res.json({ templates: triggers.listTemplates() }));
router.get('/api/triggers/templates/:id', (req, res) => {
  try { res.json({ template: triggers.getTemplate(req.params.id) }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
router.post('/api/triggers/templates', (req, res) => {
  try { res.json({ template: triggers.createTemplate(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/triggers/templates/:id', (req, res) => {
  try { res.json({ template: triggers.updateTemplate(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/triggers/templates/:id', (req, res) => {
  try { triggers.deleteTemplate(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/triggers/templates/:id/triggers', (req, res) => {
  try { res.json({ trigger: triggers.addTrigger(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/triggers/templates/:id/triggers/:trigId', (req, res) => {
  try { res.json({ trigger: triggers.updateTrigger(req.params.id, req.params.trigId, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/triggers/templates/:id/triggers/:trigId', (req, res) => {
  try { triggers.deleteTrigger(req.params.id, req.params.trigId); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
