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
function _ensureAssetDirs() {
  for (const d of [LOTTIE_DIR, SOUND_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}
function listLottieFiles() { _ensureAssetDirs(); return fs.readdirSync(LOTTIE_DIR).filter(f => f.endsWith('.json')).sort(); }
function listSoundFiles()  { _ensureAssetDirs(); return fs.readdirSync(SOUND_DIR).filter(f => /\.(mp3|wav|ogg|m4a)$/i.test(f)).sort(); }

router.get('/triggers', (req, res) => {
  const data = triggers.load();
  const lottieFiles = listLottieFiles();
  const soundFiles = listSoundFiles();
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
      const LOTTIE_FILES     = ${JSON.stringify(lottieFiles)};
      const SOUND_FILES      = ${JSON.stringify(soundFiles)};
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
        else if (kind === 'play-sound') { base.path = SOUND_FILES[0] || ''; base.volume = 1; base.blocking = false; base.estDurationMs = 1500; }
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
          +   'width:' + wPct + '%;aspect-ratio:1;transform:translate(-50%,-50%);'
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
      function _lottieOverlayBody(s, i) {
        const opts = LOTTIE_FILES.map(f => '<option value="' + _safeAttr(f) + '"' + (s.path === f ? ' selected' : '') + '>' + _safeAttr(f) + '</option>').join('')
                   || '<option value="">(drop .json files in public/assets/triggers/lottie/)</option>';
        const wPct = s.widthPct != null ? s.widthPct : 40;
        return ''
          + '<div style="display:grid;grid-template-columns:1fr 340px;gap:14px;align-items:start">'
          +   '<div>'
          +     '<label style="display:block;margin-bottom:4px;font-size:0.85rem;color:var(--text-muted)">Lottie file</label>'
          +     '<select onchange="__subDraft[' + i + '].path=this.value;_renderSubActionRows()" style="min-width:220px">' + opts + '</select>'
          +     '<div style="display:flex;gap:12px;align-items:center;margin-top:10px;flex-wrap:wrap">'
          +       '<label>Duration <input type="number" min="100" step="100" value="' + s.durationMs + '" style="width:100px" oninput="__subDraft[' + i + '].durationMs=Number(this.value)"> ms</label>'
          +       '<label><input type="checkbox"' + (s.freezeLastFrame ? ' checked' : '') + ' onchange="__subDraft[' + i + '].freezeLastFrame=this.checked"> Freeze last frame</label>'
          +     '</div>'
          +     '<div style="margin-top:14px">'
          +       '<label>Size: <strong id="tov-w-val-' + i + '">' + wPct + '%</strong> of cam width</label>'
          +       '<input type="range" min="5" max="100" step="1" value="' + wPct + '" style="width:100%;margin-top:4px" oninput="__subDraft[' + i + '].widthPct=Number(this.value); document.getElementById(\\'tov-w-val-' + i + '\\').textContent = this.value + \\'%\\'; _renderLottiePreview(' + i + ')">'
          +     '</div>'
          +     '<p class="muted" style="font-size:0.85rem;margin:8px 0 0">Click/drag on the preview to move the Lottie center within the host webcam.</p>'
          +   '</div>'
          +   '<div>'
          +     '<div class="muted" style="font-size:0.85rem;margin-bottom:4px">Preview (cam-shaped, drag to position)</div>'
          +     '<div id="tov-lot-prev-' + i + '" data-idx="' + i + '" class="lottie-prev-stage" '
          +       'style="position:relative;width:' + LOTTIE_PREVIEW_W + 'px;height:' + Math.round(LOTTIE_PREVIEW_W * 3 / 4) + 'px;'
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

      const TEXT_ANCHORS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
      function _anchorGrid(idx, current, includeAll) {
        const opts = TEXT_ANCHORS.concat(includeAll ? ['all'] : []);
        return opts.map(a => {
          const sel = a === current;
          const label = a === 'all' ? 'ALL' : a;
          return '<button type="button" onclick="__subDraft[' + idx + '].anchor=\\'' + a + '\\';_renderSubActionRows()" '
            + 'style="padding:8px 10px;border-radius:8px;font-size:0.85rem;border:1px solid var(--border);background:'
            + (sel ? '#7b3fd6' : 'var(--bg-2)') + ';color:' + (sel ? '#fff' : 'var(--text)') + ';cursor:pointer">' + label + '</button>';
        }).join(' ');
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
      function _textOverlayBody(s, i) {
        const modeRow =
            '<label style="margin-right:14px"><input type="radio" name="m-tov-mode-' + i + '" value="add"' + (s.mode === 'add' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'add\\';_renderSubActionRows()"> ADD</label>'
          + '<label><input type="radio" name="m-tov-mode-' + i + '" value="clear"' + (s.mode === 'clear' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'clear\\';_renderSubActionRows()"> CLEAR</label>';
        if (s.mode === 'clear') {
          return modeRow + '<div style="margin-top:8px"><div class="muted" style="font-size:0.85rem;margin-bottom:4px">Anchor</div>' + _anchorGrid(i, s.anchor, true) + '</div>'
            + '<div style="margin-top:10px">' + _textOverlayPreview(s) + '</div>';
        }
        const hasBg = !!s.bgColor;
        return ''
          + modeRow
          + '<div style="display:grid;grid-template-columns:1fr 340px;gap:14px;margin-top:10px;align-items:start">'
          +   '<div>'
          +     '<label style="display:block;margin-bottom:4px;font-size:0.85rem;color:var(--text-muted)">Text</label>'
          +     '<textarea rows="3" style="width:100%" oninput="__subDraft[' + i + '].text=this.value;_renderSubActionRows()">' + _safeAttr(s.text || '') + '</textarea>'
          +     '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">'
          +       '<label>Font <input type="color" value="' + _safeAttr(s.fontColor || '#ffffff') + '" style="width:36px;height:32px;border:1px solid var(--border);border-radius:6px;padding:0" oninput="__subDraft[' + i + '].fontColor=this.value;_renderSubActionRows()"></label>'
          +       '<label><input type="checkbox"' + (hasBg ? ' checked' : '') + ' onchange="__subDraft[' + i + '].bgColor = this.checked ? \\'#000000aa\\' : null;_renderSubActionRows()"> Background</label>'
          +       (hasBg ? '<input type="color" value="' + _safeAttr((s.bgColor || '#000000').slice(0, 7)) + '" style="width:36px;height:32px;border:1px solid var(--border);border-radius:6px;padding:0" oninput="__subDraft[' + i + '].bgColor=this.value;_renderSubActionRows()">' : '')
          +       '<label>Size <input type="number" min="8" max="200" value="' + (s.fontSize || 24) + '" style="width:80px" oninput="__subDraft[' + i + '].fontSize=Number(this.value);_renderSubActionRows()"> px</label>'
          +     '</div>'
          +     '<div style="margin-top:14px">'
          +       '<div class="muted" style="font-size:0.85rem;margin-bottom:4px">Anchor</div>'
          +       _anchorGrid(i, s.anchor, false)
          +     '</div>'
          +   '</div>'
          +   '<div>'
          +     '<div class="muted" style="font-size:0.85rem;margin-bottom:4px">Preview (cam-shaped)</div>'
          +     _textOverlayPreview(s)
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
          } else if (s.kind === 'play-sound') {
            const opts = SOUND_FILES.map(f => '<option value="' + _safeAttr(f) + '"' + (s.path === f ? ' selected' : '') + '>' + _safeAttr(f) + '</option>').join('');
            body = '<label>File <select onchange="__subDraft[' + i + '].path=this.value" style="min-width:200px">' + (opts || '<option value="">(drop .mp3/.wav/.ogg in public/assets/triggers/sound/)</option>') + '</select></label> '
                 + '<label>Vol <input type="number" min="0" max="1" step="0.05" value="' + s.volume + '" style="width:70px" oninput="__subDraft[' + i + '].volume=Number(this.value)"></label> '
                 + '<label><input type="checkbox"' + (s.blocking ? ' checked' : '') + ' onchange="__subDraft[' + i + '].blocking=this.checked;_renderSubActionRows()"> hold for ' + (s.blocking ? '<input type="number" min="0" step="100" value="' + s.estDurationMs + '" style="width:80px" oninput="__subDraft[' + i + '].estDurationMs=Number(this.value)"> ms' : 'duration') + '</label>';
          } else if (s.kind === 'device-control') {
            const modeRadios = '<label><input type="radio" name="m-dc-mode-' + i + '" value="on"' + (s.mode === 'on' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'on\\';_renderSubActionRows()"> On</label> '
                             + '<label><input type="radio" name="m-dc-mode-' + i + '" value="on-cycle"' + (s.mode === 'on-cycle' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'on-cycle\\';_renderSubActionRows()"> Cycle</label> '
                             + '<label><input type="radio" name="m-dc-mode-' + i + '" value="off"' + (s.mode === 'off' ? ' checked' : '') + ' onchange="__subDraft[' + i + '].mode=\\'off\\';_renderSubActionRows()"> Off</label>';
            const devList = (s.mode === 'off' ? DEVICES_OFF : DEVICES_ON);
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
          return ''
            + '<div class="sub-action-row" draggable="true" data-idx="' + i + '" style="border:1px solid var(--border);border-radius:8px;background:var(--bg-3);padding:12px;margin-bottom:10px">'
            +   '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
            +     '<span class="sub-drag-handle" title="drag to reorder" style="cursor:grab;color:var(--text-faint);font-size:1.1rem;padding:4px 6px;user-select:none">⋮⋮</span>'
            +     '<select onchange="__subDraft[' + i + '] = _newSubAction(this.value);_renderSubActionRows()" style="min-width:180px">' + kindOpts + '</select>'
            +     '<button onclick="_moveSub(' + i + ',-1)" ' + (i === 0 ? 'disabled' : '') + ' title="move up">↑</button>'
            +     '<button onclick="_moveSub(' + i + ',1)" ' + (i === __subDraft.length - 1 ? 'disabled' : '') + ' title="move down">↓</button>'
            +     '<button onclick="_copySub(' + i + ')" title="duplicate this sub-action">📋</button>'
            +     '<button onclick="_removeSub(' + i + ')" style="background:#4a1b1b;margin-left:auto" title="delete">×</button>'
            +   '</div>'
            +   '<div style="margin-top:8px">' + body + '</div>'
            + '</div>';
        }).join('');
        _attachSubActionDrag();
        _attachLottiePreviewDrag();
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
        __subDraft.push(_newSubAction(firstEnabled.kind));
        _renderSubActionRows();
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
        __subDraft = JSON.parse(JSON.stringify(a.steps || []));
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
  if (s.kind === 'play-sound')     return 'sound ' + s.path + (s.blocking ? ' (hold ' + s.estDurationMs + 'ms)' : '');
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
