const express = require('express');
const config = require('../config');
const minigames = require('../services/minigames-service');
const templates = require('../services/templates-service');
const session = require('../services/session-service');
const { ownerLayout, escape } = require('../views/layout');

const router = express.Router();

function _ownerNick() {
  const cfg = config.load();
  const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';
  return {
    email: ownerEmail,
    nickname: (cfg.owner?.displayName || '').trim()
      || (cfg.accounts || []).find(a => a.email === ownerEmail)?.nickname
      || ownerEmail.split('@')[0],
  };
}

router.get('/minigames', (_req, res) => {
  const items = minigames.list();
  const wheels = templates.listWheels();
  const body = `
    <h2>Mini Games</h2>
    <p class="muted">Minigames are dice-/wheel-style action shortcuts you can attach to a milestone (or the always-available pool) so participants can roll for a result that drives the pump.</p>

    <div class="card">
      <h3>Available minigames</h3>
      <table style="width:100%;border-collapse:collapse;font-size:1rem">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border)">
          <th style="padding:8px 0;width:160px">Name</th>
          <th>Description</th>
          <th style="width:80px">Color</th>
        </tr></thead>
        <tbody>
          ${items.map(m => `
            <tr>
              <td style="padding:10px 0"><strong style="color:${m.color}">${m.kind === 'prize-wheel' ? '🎡' : '🎲'} ${escape(m.name)}</strong></td>
              <td>${escape(m.description || '')}</td>
              <td><span style="display:inline-block;width:20px;height:20px;border-radius:5px;background:${m.color};vertical-align:middle;border:1px solid var(--border)"></span></td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <p class="muted" style="font-size:0.9rem;margin-top:14px">Attach these to milestones on the <a href="/templates" style="color:var(--accent)">Pump Templates</a> page. The button colour above shows what participants will see.</p>
    </div>

    <div class="card">
      <h3>Wheel templates</h3>
      <p class="muted" style="font-size:0.95rem">Each wheel has 1–10 sections. When you attach <strong>🎡 Prize Wheel</strong> to a milestone, you pick which of these wheels are available. Sections of type <em>action</em> fire their steps when the pointer lands; <em>spin again</em> rolls another spin; <em>no prize</em> lands silently.</p>
      ${wheels.length
        ? `<table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:1rem">
            <thead><tr style="text-align:left;border-bottom:1px solid var(--border)">
              <th style="padding:8px 0">Name</th>
              <th style="width:120px">Sections</th>
              <th style="width:110px">Randomize</th>
              <th>Preview</th>
              <th style="width:160px"></th>
            </tr></thead>
            <tbody>
              ${wheels.map(w => `
                <tr>
                  <td><strong>${escape(w.name)}</strong></td>
                  <td>${w.sections.length}</td>
                  <td>${w.randomize ? '<span class="pill ok">on</span>' : '<span class="muted">off</span>'}</td>
                  <td>${w.sections.map(s => `<span style="display:inline-block;background:${escape(s.color)};color:#fff;padding:2px 8px;border-radius:8px;margin:1px 3px;font-size:0.8rem">${escape(s.label)}${s.type === 'spin-again' ? ' ↻' : s.type === 'no-prize' ? ' ∅' : ''}</span>`).join('')}</td>
                  <td>
                    <button onclick="mgEditWheel('${escape(w.id)}')">Edit</button>
                    <button onclick="mgDeleteWheel('${escape(w.id)}', '${escape(w.name)}')">Delete</button>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>`
        : '<p class="muted" style="margin-top:10px">No wheels yet — create one below.</p>'}
      <p style="margin-top:14px"><button onclick="mgNewWheel()">+ New wheel</button></p>
    </div>

    <div id="mg-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px;z-index:1100"></div>

    <!-- modal -->
    <div id="modal-bg" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center">
      <div id="modal" style="background:var(--bg-2);border:1px solid var(--border);border-radius:10px;padding:28px;max-width:760px;width:92%;max-height:92vh;overflow:auto">
        <h2 id="modal-title">Edit</h2>
        <div id="modal-body"></div>
        <p style="margin-top:20px;text-align:right">
          <button onclick="modalClose()" style="background:var(--bg-3);color:var(--text)">Cancel</button>
          <button id="modal-save" onclick="modalSave()">Save</button>
        </p>
      </div>
    </div>

    <script>
      let modalSaveFn = null;
      function flash(msg, cls) {
        const el = document.getElementById('mg-msg');
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

      // ---- Wheel CRUD ----
      const PALETTE = ${JSON.stringify(['#e74c3c', '#f39c12', '#f1c40f', '#27ae60', '#3498db', '#7b3fd6', '#e84393'])};
      let __sectionDraft = [];   // editor-local
      function _newSection() {
        const i = __sectionDraft.length;
        return {
          label: 'Prize ' + (i + 1),
          color: PALETTE[i % PALETTE.length],
          type: 'action',
          mode: 'continuous',
          seconds: 5,
          cycleOn: 1, cycleOff: 1, cycleTimes: 5,
        };
      }
      function _sectionFromWheel(s, i) {
        // Inverse of _sectionToSteps — best-effort recovery for the editor.
        const base = {
          label: s.label,
          color: s.color,
          type: s.type || 'action',
          mode: 'continuous',
          seconds: 5,
          cycleOn: 1, cycleOff: 1, cycleTimes: 5,
        };
        if (base.type === 'action' && Array.isArray(s.steps) && s.steps.length) {
          const first = s.steps[0];
          if (first.type === 'on') {
            base.mode = 'continuous';
            base.seconds = Math.round((first.durationMs || 1000) / 1000);
          } else if (first.type === 'repeat' && Array.isArray(first.steps)) {
            base.mode = 'cycle';
            base.cycleTimes = first.times || 5;
            const onStep  = first.steps.find(x => x.type === 'on');
            const offStep = first.steps.find(x => x.type === 'off');
            if (onStep)  base.cycleOn  = Math.round((onStep.durationMs || 1000) / 1000);
            if (offStep) base.cycleOff = Math.round((offStep.durationMs || 1000) / 1000);
          }
        }
        return base;
      }
      function _sectionToSteps(s) {
        if (s.type !== 'action') return [];
        if (s.mode === 'cycle') {
          return [{ type: 'repeat', times: Math.max(1, parseInt(s.cycleTimes, 10) || 1), steps: [
            { type: 'on',  durationMs: Math.max(100, Math.round(parseFloat(s.cycleOn)  * 1000)) },
            { type: 'off', durationMs: Math.max(100, Math.round(parseFloat(s.cycleOff) * 1000)) },
          ]}];
        }
        return [{ type: 'on', durationMs: Math.max(100, Math.round(parseFloat(s.seconds) * 1000)) }];
      }
      function _safeAttr(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
      function _renderSectionRows() {
        const wrap = document.getElementById('m-sections');
        if (!wrap) return;
        wrap.innerHTML = __sectionDraft.map((s, i) => {
          const stepBlock = s.type !== 'action' ? '<span class="muted" style="font-size:0.9rem">no pump action</span>' :
            '<label style="margin-right:10px"><input type="radio" name="m-mode-' + i + '" value="continuous"' + (s.mode === 'continuous' ? ' checked' : '') + ' onchange="__sectionDraft[' + i + '].mode=\\'continuous\\';_renderSectionRows()"> Continuous</label>'
          + '<label><input type="radio" name="m-mode-' + i + '" value="cycle"' + (s.mode === 'cycle' ? ' checked' : '') + ' onchange="__sectionDraft[' + i + '].mode=\\'cycle\\';_renderSectionRows()"> Cycle</label>'
          + (s.mode === 'cycle'
              ? '<div style="margin-top:6px"><label>On: <input type="number" min="0.1" step="0.1" value="' + _safeAttr(s.cycleOn) + '" style="width:70px" oninput="__sectionDraft[' + i + '].cycleOn=this.value"> s</label> '
              + '<label>Off: <input type="number" min="0.1" step="0.1" value="' + _safeAttr(s.cycleOff) + '" style="width:70px" oninput="__sectionDraft[' + i + '].cycleOff=this.value"> s</label> '
              + '<label>× <input type="number" min="1" value="' + _safeAttr(s.cycleTimes) + '" style="width:70px" oninput="__sectionDraft[' + i + '].cycleTimes=this.value"></label></div>'
              : '<div style="margin-top:6px"><label>Pump on for <input type="number" min="0.1" step="0.1" value="' + _safeAttr(s.seconds) + '" style="width:80px" oninput="__sectionDraft[' + i + '].seconds=this.value"> seconds</label></div>');
          return ''
            + '<div style="display:flex;flex-direction:column;gap:8px;padding:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-3);margin-bottom:10px">'
            + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
            +   '<input type="color" value="' + _safeAttr(s.color) + '" style="width:36px;height:32px;border:1px solid var(--border);border-radius:6px;padding:0" oninput="__sectionDraft[' + i + '].color=this.value">'
            +   '<input type="text" value="' + _safeAttr(s.label) + '" style="flex:1;min-width:140px" placeholder="Label" oninput="__sectionDraft[' + i + '].label=this.value">'
            +   '<select style="min-width:130px" onchange="__sectionDraft[' + i + '].type=this.value;_renderSectionRows()">'
            +     '<option value="action"' + (s.type === 'action' ? ' selected' : '') + '>Action</option>'
            +     '<option value="spin-again"' + (s.type === 'spin-again' ? ' selected' : '') + '>Spin again</option>'
            +     '<option value="no-prize"' + (s.type === 'no-prize' ? ' selected' : '') + '>No prize</option>'
            +   '</select>'
            +   '<button onclick="_moveSection(' + i + ',-1)" ' + (i === 0 ? 'disabled' : '') + '>↑</button>'
            +   '<button onclick="_moveSection(' + i + ',1)" ' + (i === __sectionDraft.length - 1 ? 'disabled' : '') + '>↓</button>'
            +   '<button onclick="_removeSection(' + i + ')" style="background:#4a1b1b">×</button>'
            + '</div>'
            + '<div>' + stepBlock + '</div>'
            + '</div>';
        }).join('');
        const addBtn = document.getElementById('m-add-section');
        if (addBtn) addBtn.disabled = __sectionDraft.length >= 10;
      }
      function _moveSection(i, dir) {
        const j = i + dir;
        if (j < 0 || j >= __sectionDraft.length) return;
        const t = __sectionDraft[i]; __sectionDraft[i] = __sectionDraft[j]; __sectionDraft[j] = t;
        _renderSectionRows();
      }
      function _removeSection(i) {
        if (__sectionDraft.length <= 1) return flash('a wheel needs at least one section', 'bad');
        __sectionDraft.splice(i, 1);
        _renderSectionRows();
      }
      function _addSection() {
        if (__sectionDraft.length >= 10) return;
        __sectionDraft.push(_newSection());
        _renderSectionRows();
      }
      function _wheelFormHtml(w) {
        return ''
          + '<p><label>Name <input id="m-name" type="text" style="width:100%" value="' + _safeAttr(w?.name || '') + '"></label></p>'
          + '<p><label><input type="checkbox" id="m-randomize"' + (w?.randomize ? ' checked' : '') + '> Randomize section positions on every spin</label></p>'
          + '<h4 style="margin:16px 0 8px">Sections (1–10)</h4>'
          + '<div id="m-sections"></div>'
          + '<p><button id="m-add-section" onclick="_addSection()">+ Add section</button></p>';
      }
      function mgNewWheel() {
        __sectionDraft = [_newSection(), _newSection(), _newSection()];
        modalOpen('New wheel template', _wheelFormHtml(null), async () => {
          const name = document.getElementById('m-name').value.trim();
          const randomize = document.getElementById('m-randomize').checked;
          const sections = __sectionDraft.map(s => ({
            label: s.label, color: s.color, type: s.type,
            steps: _sectionToSteps(s),
          }));
          const r = await fetch('/api/minigames/wheels', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ name, randomize, sections }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
        setTimeout(_renderSectionRows, 0);
      }
      async function mgEditWheel(id) {
        const list = await fetch('/api/minigames/wheels').then(r => r.json());
        const w = (list.wheels || []).find(x => x.id === id);
        if (!w) return flash('wheel not found', 'bad');
        __sectionDraft = (w.sections || []).map(_sectionFromWheel);
        modalOpen('Edit wheel template', _wheelFormHtml(w), async () => {
          const name = document.getElementById('m-name').value.trim();
          const randomize = document.getElementById('m-randomize').checked;
          const sections = __sectionDraft.map(s => ({
            label: s.label, color: s.color, type: s.type,
            steps: _sectionToSteps(s),
          }));
          const r = await fetch('/api/minigames/wheels/' + id, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ name, randomize, sections }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
        setTimeout(_renderSectionRows, 0);
      }
      async function mgDeleteWheel(id, name) {
        if (!confirm('Delete wheel "' + name + '"? It will be removed from any milestone or always-available list that references it.')) return;
        const r = await fetch('/api/minigames/wheels/' + id, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.reload();
      }
    </script>

    <div class="card">
      <h3>How Prize Wheel works</h3>
      <ul style="line-height:1.7;font-size:1rem">
        <li>Click <strong>🎡 Prize Wheel</strong> on a milestone — a popup lists the wheel templates the milestone allows.</li>
        <li>Pick a wheel; the server pre-computes the result and broadcasts the chain to every viewer. The SVG wheel spins in sync on all screens and lands on the same wedge.</li>
        <li><strong>Action</strong> sections fire their configured pump (continuous duration or on/off cycle). <strong>Spin again</strong> triggers another spin. <strong>No prize</strong> lands silently. Max ${minigames.PRIZE_WHEEL_MAX_CHAIN || 8} chained spins before forcing a non-spin-again result.</li>
      </ul>
    </div>

    <div class="card">
      <h3>How Dice Roll works</h3>
      <ul style="line-height:1.7;font-size:1rem">
        <li>Owner or any controller-flagged visitor presses the purple <strong>🎲 Dice Roll</strong> button.</li>
        <li>A popup asks how many d6 dice to roll (1–6) and which result mode: <em>Continuous</em> (pump on for N seconds where N is total pips) or <em>Cycle</em> (N rounds of 1 sec on / 1 sec off).</li>
        <li>The server pre-computes the result and broadcasts the exact dice values to every viewer. All clients display the matching Lottie animations in a cluster — they land in sync, on the same numbers.</li>
      </ul>
    </div>
  `;
  res.type('html').send(ownerLayout({ title: 'Mini Games', active: 'minigames', body }));
});

// --- Wheel CRUD API ---
router.get('/api/minigames/wheels', (_req, res) => res.json({ wheels: templates.listWheels() }));
router.post('/api/minigames/wheels', (req, res) => {
  try { res.json({ wheel: templates.createWheel(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/minigames/wheels/:id', (req, res) => {
  try { res.json({ wheel: templates.updateWheel(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/minigames/wheels/:id', (req, res) => {
  try { templates.deleteWheel(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

// --- Minigame triggers (owner) ---
router.post('/api/minigame/dice-roll', async (req, res) => {
  try {
    const s = session.getState();
    if (!s.active) return res.status(400).json({ error: 'no active session' });
    const o = _ownerNick();
    await minigames.runDiceRoll({
      count: req.body?.count,
      mode: req.body?.mode,
      byEmail: o.email,
      byNickname: o.nickname,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/minigame/prize-wheel', async (req, res) => {
  try {
    const s = session.getState();
    if (!s.active) return res.status(400).json({ error: 'no active session' });
    const o = _ownerNick();
    const result = minigames.requestPrizeWheel({
      // Either pin a wheel (used by future "test this wheel" flows on the
      // Mini Games tab) or hand over the candidate list from the milestone
      // button — the server randomly picks one.
      wheelId: req.body?.wheelId,
      wheelIds: req.body?.wheelIds,
      byEmail: o.email,
      byNickname: o.nickname,
    });
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/minigame/prize-wheel/spin', (req, res) => {
  try {
    const o = _ownerNick();
    minigames.confirmPrizeSpin({ spinToken: req.body?.spinToken, byEmail: o.email });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
