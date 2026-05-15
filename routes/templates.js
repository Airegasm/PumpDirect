const express = require('express');
const templates = require('../services/templates-service');
const { ownerLayout, escape } = require('../views/layout');
const { createLogger } = require('../utils/logger');

const logger = createLogger('TemplatesRoute');
const router = express.Router();

function pill(state, label) {
  const cls = state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${escape(label)}</span>`;
}

function summarizeSteps(steps, depth = 0) {
  if (!Array.isArray(steps) || !steps.length) return '<em>empty</em>';
  return steps.map(s => {
    if (s.type === 'on') return `On ${(s.durationMs / 1000)}s`;
    if (s.type === 'off') return `Off ${(s.durationMs / 1000)}s`;
    if (s.type === 'repeat') return `repeat ${s.times}× [ ${summarizeSteps(s.steps, depth + 1)} ]`;
    return '<em>?</em>';
  }).join(' · ');
}

router.get('/templates', (req, res) => {
  const data = templates.load();
  const activeProfileId = req.query.profile || templates.FACTORY_PROFILE_ID;
  const activeProfile = data.templateProfiles.find(p => p.id === activeProfileId) || data.templateProfiles[0];

  const profileOptions = data.templateProfiles
    .map(p => `<option value="${escape(p.id)}" ${p.id === activeProfile.id ? 'selected' : ''}>${escape(p.name)}${p.isFactory ? ' (factory)' : ''}</option>`)
    .join('');

  const actionsById = Object.fromEntries(data.actionTemplates.map(a => [a.id, a]));

  const milestonesBody = activeProfile.isFactory
    ? `<p class="muted">The Default profile has no milestones. Actions assigned in the "Always available" section below fire regardless of capacity.</p>`
    : (activeProfile.milestones.length
      ? `<table style="width:100%;border-collapse:collapse">
          <thead><tr style="text-align:left;border-bottom:1px solid #2a2f3a">
            <th style="padding:8px 0">Name</th><th>Range</th><th>Announcement</th><th>Action templates</th><th></th>
          </tr></thead>
          <tbody>${activeProfile.milestones.map(m => `
            <tr data-mid="${escape(m.id)}">
              <td><strong>${escape(m.name)}</strong></td>
              <td><code>${m.capacityMin}–${m.capacityMax}%</code></td>
              <td class="muted">${escape((m.announcement || '').slice(0, 80))}${(m.announcement || '').length > 80 ? '…' : ''}</td>
              <td>${(m.actionTemplateIds || []).map(id => `<span class="pill ok">${escape(actionsById[id]?.name || '?')}</span>`).join(' ') || '<span class="muted">none</span>'}</td>
              <td>
                <button onclick="tplEditMilestone('${escape(activeProfile.id)}', '${escape(m.id)}')">Edit</button>
                <button onclick="tplDeleteMilestone('${escape(activeProfile.id)}', '${escape(m.id)}')">Delete</button>
              </td>
            </tr>`).join('')}
          </tbody>
        </table>`
      : '<p class="muted">No milestones yet.</p>');

  const actionsBody = data.actionTemplates.length
    ? `<table style="width:100%;border-collapse:collapse">
        <thead><tr style="text-align:left;border-bottom:1px solid #2a2f3a">
          <th style="padding:8px 0;width:30px"></th><th>Name</th><th>Steps</th><th></th>
        </tr></thead>
        <tbody id="actions-tbody">${data.actionTemplates.map(a => `
          <tr draggable="true" data-id="${escape(a.id)}" class="draggable-row">
            <td class="drag-handle" style="cursor:grab;color:#7a8597;text-align:center">⋮⋮</td>
            <td><strong>${escape(a.name)}</strong></td>
            <td><code>${summarizeSteps(a.steps)}</code></td>
            <td>
              <button onclick="tplEditAction('${escape(a.id)}')">Edit</button>
              <button onclick="tplDeleteAction('${escape(a.id)}', '${escape(a.name)}')">Delete</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>`
    : '<p class="muted">No action templates yet.</p>';

  const alwaysIds = activeProfile.defaultActionTemplateIds || [];
  const alwaysAvailableBody = `
    <p class="muted">${activeProfile.isFactory
      ? 'Default-profile actions fire any time during a session, regardless of capacity. Drag to reorder.'
      : 'Optional: actions assigned here fire at any capacity in addition to the milestone-gated ones. Drag to reorder.'}</p>
    <ul id="always-list" data-profile="${escape(activeProfile.id)}" style="list-style:none;padding:0;margin:0;display:flex;flex-wrap:wrap;gap:8px">
      ${alwaysIds.length
        ? alwaysIds.map(id => `<li draggable="true" data-id="${escape(id)}" class="draggable-pill" style="cursor:grab;background:#133d2b;color:#6ddc9b;padding:8px 14px;border-radius:999px;font-size:0.95rem">⋮⋮ ${escape(actionsById[id]?.name || '?')}</li>`).join('')
        : '<li class="muted">none assigned</li>'}
    </ul>
    <p style="margin-top:16px"><button onclick="tplEditAlwaysAvailable('${escape(activeProfile.id)}')">Edit always-available list</button></p>
  `;

  const body = `
    <h2>Pump Templates</h2>

    <div class="card">
      <h3>Template Profile</h3>
      <p>
        <select id="profile-select" onchange="location.search='?profile=' + encodeURIComponent(this.value)" style="min-width:280px">
          ${profileOptions}
        </select>
        <button onclick="tplNewProfile()">+ New profile</button>
        ${activeProfile.isFactory
          ? '<span class="pill warn">factory — immutable name/milestones</span>'
          : `<button onclick="tplRenameProfile('${escape(activeProfile.id)}', '${escape(activeProfile.name)}')">Rename</button>
             <button onclick="tplDeleteProfile('${escape(activeProfile.id)}', '${escape(activeProfile.name)}')">Delete</button>`}
      </p>
      <p class="muted">Profile: <strong>${escape(activeProfile.name)}</strong>${activeProfile.isFactory ? ' (the seeded fallback — used when a session profile doesn\'t pick a template)' : ''}</p>
    </div>

    <div class="card">
      <h3>Milestones</h3>
      ${milestonesBody}
      ${activeProfile.isFactory ? '' : `<p style="margin-top:12px"><button onclick="tplNewMilestone('${escape(activeProfile.id)}')">+ Add milestone</button></p>`}
    </div>

    <div class="card">
      <h3>Always available (no milestone gating)</h3>
      ${alwaysAvailableBody}
    </div>

    <div class="card">
      <h3>Action Template Pool</h3>
      <p class="muted">Reusable routines. Assign them to milestones above, or to the always-available list.</p>
      ${actionsBody}
      <p style="margin-top:12px"><button onclick="tplNewAction()">+ New action template</button></p>
    </div>

    <!-- modal -->
    <div id="modal-bg" style="display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:1000;align-items:center;justify-content:center">
      <div id="modal" style="background:#161922;border:1px solid #2a2f3a;border-radius:10px;padding:32px;max-width:720px;width:90%;max-height:90vh;overflow:auto">
        <h2 id="modal-title">Edit</h2>
        <div id="modal-body"></div>
        <p style="margin-top:24px;text-align:right">
          <button onclick="modalClose()" style="background:#2a2f3a">Cancel</button>
          <button id="modal-save" onclick="modalSave()">Save</button>
        </p>
      </div>
    </div>

    <div id="tpl-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px;z-index:1100"></div>

    <script>
      const ALL_ACTIONS = ${JSON.stringify(data.actionTemplates.map(a => ({ id: a.id, name: a.name })))};
      const ACTIVE_PROFILE_ID = ${JSON.stringify(activeProfile.id)};
      let modalSaveFn = null;

      function flash(msg, cls) {
        const el = document.getElementById('tpl-msg');
        el.innerHTML = '<div class="card" style="margin:0;border-color:' + (cls === 'bad' ? '#f08484' : cls === 'ok' ? '#6ddc9b' : '#f0c674') + '">' + msg + '</div>';
        setTimeout(() => { el.innerHTML = ''; }, 4000);
      }
      function modalOpen(title, bodyHtml, onSave) {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = bodyHtml;
        modalSaveFn = onSave;
        document.getElementById('modal-bg').style.display = 'flex';
      }
      function modalClose() { document.getElementById('modal-bg').style.display = 'none'; modalSaveFn = null; }
      async function modalSave() {
        if (modalSaveFn) {
          try { await modalSaveFn(); } catch (e) { flash(e.message, 'bad'); }
        }
      }

      // ---- profiles ----
      function tplNewProfile() {
        modalOpen('New template profile', '<p><label>Name <input id="m-name" type="text" placeholder="e.g. Edging Set"></label></p>', async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/templates/profiles', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ name }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.search = '?profile=' + encodeURIComponent(d.profile.id);
        });
      }
      function tplRenameProfile(id, currentName) {
        modalOpen('Rename profile', '<p><label>Name <input id="m-name" type="text" value="' + currentName.replace(/"/g, '&quot;') + '"></label></p>', async () => {
          const name = document.getElementById('m-name').value.trim();
          const r = await fetch('/api/templates/profiles/' + id, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ name }) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
      }
      async function tplDeleteProfile(id, name) {
        if (!confirm('Delete profile "' + name + '" and all its milestones? Action template pool is unaffected.')) return;
        const r = await fetch('/api/templates/profiles/' + id, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.search = '';
      }

      // ---- always-available ----
      function tplEditAlwaysAvailable(profileId) {
        const profileResp = fetch('/api/templates/profiles/' + profileId).then(r => r.json()).then(p => {
          const current = new Set(p.profile.defaultActionTemplateIds || []);
          const options = ALL_ACTIONS.map(a => '<label style="display:block;padding:4px 0"><input type="checkbox" value="' + a.id + '"' + (current.has(a.id) ? ' checked' : '') + '> ' + a.name + '</label>').join('');
          modalOpen('Always-available action templates', options || '<p class="muted">No action templates exist yet. Create some first.</p>', async () => {
            const ids = Array.from(document.querySelectorAll('#modal-body input[type="checkbox"]:checked')).map(c => c.value);
            const r = await fetch('/api/templates/profiles/' + profileId, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ defaultActionTemplateIds: ids }) });
            const d = await r.json();
            if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
            location.reload();
          });
        });
      }

      // ---- milestones ----
      function _milestoneFormHtml(m) {
        const checked = new Set(m?.actionTemplateIds || []);
        const actionList = ALL_ACTIONS.map(a => '<label style="display:block;padding:4px 0"><input type="checkbox" value="' + a.id + '"' + (checked.has(a.id) ? ' checked' : '') + '> ' + a.name + '</label>').join('') || '<p class="muted">No action templates exist yet.</p>';
        return ''
          + '<p><label>Name <input id="m-name" type="text" value="' + (m?.name?.replace(/"/g, '&quot;') || '') + '" style="width:100%"></label></p>'
          + '<p><label>Capacity range '
          + '<input id="m-min" type="number" min="0" max="100" value="' + (m?.capacityMin ?? 0) + '" style="width:80px"> – '
          + '<input id="m-max" type="number" min="0" max="100" value="' + (m?.capacityMax ?? 10) + '" style="width:80px"> %</label></p>'
          + '<p><label>Announcement <textarea id="m-announcement" rows="3" style="width:100%;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:6px;padding:10px">' + (m?.announcement || '') + '</textarea></label></p>'
          + '<p>Assigned action templates:</p>'
          + '<div style="max-height:200px;overflow:auto;border:1px solid #2a2f3a;border-radius:6px;padding:8px">' + actionList + '</div>';
      }
      function _readMilestoneForm() {
        return {
          name: document.getElementById('m-name').value.trim(),
          capacityMin: Number(document.getElementById('m-min').value),
          capacityMax: Number(document.getElementById('m-max').value),
          announcement: document.getElementById('m-announcement').value,
          actionTemplateIds: Array.from(document.querySelectorAll('#modal-body input[type="checkbox"]:checked')).map(c => c.value),
        };
      }
      function tplNewMilestone(profileId) {
        modalOpen('New milestone', _milestoneFormHtml(null), async () => {
          const r = await fetch('/api/templates/profiles/' + profileId + '/milestones', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(_readMilestoneForm()) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
      }
      async function tplEditMilestone(profileId, milestoneId) {
        const p = await fetch('/api/templates/profiles/' + profileId).then(r => r.json());
        const m = p.profile.milestones.find(x => x.id === milestoneId);
        modalOpen('Edit milestone', _milestoneFormHtml(m), async () => {
          const r = await fetch('/api/templates/profiles/' + profileId + '/milestones/' + milestoneId, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify(_readMilestoneForm()) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
      }
      async function tplDeleteMilestone(profileId, milestoneId) {
        if (!confirm('Delete this milestone?')) return;
        const r = await fetch('/api/templates/profiles/' + profileId + '/milestones/' + milestoneId, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.reload();
      }

      // ---- action templates ----
      function _actionFormHtml(a) {
        return ''
          + '<p><label>Name <input id="m-name" type="text" value="' + (a?.name?.replace(/"/g, '&quot;') || '') + '" style="width:100%"></label></p>'
          + '<p><label>Steps (JSON)<br><span class="muted" style="font-size:0.85rem">'
          + 'Examples: <code>[{"type":"on","durationMs":10000}]</code> — Slow Stream<br>'
          + '<code>[{"type":"repeat","times":10,"steps":[{"type":"on","durationMs":2000},{"type":"off","durationMs":1000}]}]</code> — Pulse'
          + '</span></label></p>'
          + '<p><textarea id="m-steps" rows="10" style="width:100%;font-family:ui-monospace,monospace;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:6px;padding:10px;font-size:0.95rem">'
          + JSON.stringify(a?.steps || [{type:'on', durationMs: 5000}], null, 2)
          + '</textarea></p>';
      }
      function _readActionForm() {
        let steps;
        try { steps = JSON.parse(document.getElementById('m-steps').value); }
        catch (e) { throw new Error('steps is not valid JSON: ' + e.message); }
        return { name: document.getElementById('m-name').value.trim(), steps };
      }
      function tplNewAction() {
        modalOpen('New action template', _actionFormHtml(null), async () => {
          const body = _readActionForm();
          const r = await fetch('/api/templates/actions', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
      }
      async function tplEditAction(id) {
        const all = await fetch('/api/templates/actions').then(r => r.json());
        const a = all.actions.find(x => x.id === id);
        modalOpen('Edit action template', _actionFormHtml(a), async () => {
          const body = _readActionForm();
          const r = await fetch('/api/templates/actions/' + id, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify(body) });
          const d = await r.json();
          if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
          location.reload();
        });
      }
      // ---- drag-to-reorder ----
      function attachDragReorder(container, onReorder) {
        if (!container) return;
        let dragEl = null;
        for (const item of container.querySelectorAll('[draggable="true"]')) {
          item.addEventListener('dragstart', e => { dragEl = item; item.style.opacity = '0.4'; e.dataTransfer.effectAllowed = 'move'; });
          item.addEventListener('dragend', () => { item.style.opacity = ''; dragEl = null; });
          item.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; });
          item.addEventListener('drop', e => {
            e.preventDefault();
            if (!dragEl || dragEl === item) return;
            const items = Array.from(container.querySelectorAll('[draggable="true"]'));
            const dragIdx = items.indexOf(dragEl);
            const dropIdx = items.indexOf(item);
            if (dragIdx < dropIdx) item.after(dragEl);
            else item.before(dragEl);
            const ids = Array.from(container.querySelectorAll('[draggable="true"]')).map(el => el.dataset.id);
            onReorder(ids);
          });
        }
      }
      attachDragReorder(document.getElementById('actions-tbody'), async ids => {
        const r = await fetch('/api/templates/actions/order', { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ ids }) });
        const d = await r.json();
        if (!r.ok || d.error) flash(d.error || 'reorder failed', 'bad');
        else flash('pool order saved', 'ok');
      });
      const alwaysList = document.getElementById('always-list');
      if (alwaysList && alwaysList.querySelectorAll('[draggable="true"]').length > 0) {
        attachDragReorder(alwaysList, async ids => {
          const profileId = alwaysList.dataset.profile;
          const r = await fetch('/api/templates/profiles/' + profileId, {
            method: 'PATCH', headers: {'content-type':'application/json'},
            body: JSON.stringify({ defaultActionTemplateIds: ids }),
          });
          const d = await r.json();
          if (!r.ok || d.error) flash(d.error || 'reorder failed', 'bad');
          else flash('order saved', 'ok');
        });
      }

      async function tplDeleteAction(id, name) {
        if (!confirm('Delete "' + name + '"? It will also be removed from any milestones or always-available lists referencing it.')) return;
        const r = await fetch('/api/templates/actions/' + id, { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        location.reload();
      }
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'Pump Templates', active: 'templates', body }));
});

// --- API ---

router.get('/api/templates/profiles', (_req, res) => res.json({ profiles: templates.listProfiles() }));
router.get('/api/templates/profiles/:id', (req, res) => {
  try { res.json({ profile: templates.getProfile(req.params.id) }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
router.post('/api/templates/profiles', (req, res) => {
  try { res.json({ profile: templates.createProfile(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/templates/profiles/:id', (req, res) => {
  try { res.json({ profile: templates.updateProfile(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/templates/profiles/:id', (req, res) => {
  try { templates.deleteProfile(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.post('/api/templates/profiles/:id/milestones', (req, res) => {
  try { res.json({ milestone: templates.addMilestone(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/templates/profiles/:id/milestones/:mid', (req, res) => {
  try { res.json({ milestone: templates.updateMilestone(req.params.id, req.params.mid, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/templates/profiles/:id/milestones/:mid', (req, res) => {
  try { templates.deleteMilestone(req.params.id, req.params.mid); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

router.get('/api/templates/actions', (_req, res) => res.json({ actions: templates.listActions() }));
router.post('/api/templates/actions/order', (req, res) => {
  try { res.json({ actions: templates.reorderActions(req.body?.ids || []) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.post('/api/templates/actions', (req, res) => {
  try { res.json({ action: templates.createAction(req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.patch('/api/templates/actions/:id', (req, res) => {
  try { res.json({ action: templates.updateAction(req.params.id, req.body || {}) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
router.delete('/api/templates/actions/:id', (req, res) => {
  try { templates.deleteAction(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
