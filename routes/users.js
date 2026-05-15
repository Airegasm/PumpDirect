const express = require('express');
const cf = require('../services/cloudflare-service');
const config = require('../config');
const { ownerLayout, escape } = require('../views/layout');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Users');
const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function syncAccessPolicy() {
  const cfg = config.load();
  const { apiToken, apiTokenValidated, accountId, hostname } = cfg.cloudflare;
  if (!apiTokenValidated || !apiToken || !accountId || !hostname) {
    throw new Error('Cloudflare setup not complete — finish the Network wizard first');
  }
  const emails = (cfg.accounts || []).map(a => a.email).filter(Boolean);
  await cf.ensureAccessApp(apiToken, accountId, {
    name: 'PumpDirect',
    domain: hostname,
    allowedEmails: emails,
  });
}

function pill(state, label) {
  const cls = state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${escape(label)}</span>`;
}

router.get('/users', (_req, res) => {
  const cfg = config.load();
  const accounts = cfg.accounts || [];
  const setupReady = cfg.setupComplete && cfg.cloudflare.apiTokenValidated;

  const rows = accounts.map(a => `
    <tr>
      <td>${escape(a.nickname || '')} ${a.isOwner ? pill('ok', 'owner') : ''}</td>
      <td><code>${escape(a.email)}</code></td>
      <td class="muted">${escape((a.addedAt || '').slice(0, 10))}</td>
      <td>
        ${a.isOwner
          ? '<span class="muted" style="font-size:0.9rem">cannot remove</span>'
          : `<button onclick="uDelete('${escape(a.email)}')">Remove</button>`}
      </td>
    </tr>
  `).join('');

  const body = `
    <h2>Users</h2>
    ${!setupReady
      ? `<div class="card" style="border-color:#f0c674"><p>Finish the Network wizard first — adding/removing users here writes directly to the Cloudflare Access policy.</p></div>`
      : ''}

    <div class="card">
      <h3>Allowed accounts</h3>
      <p class="muted">Authoritative list. Adds/removals push to the Cloudflare Access policy (your hostname: <code>${escape(cfg.cloudflare.hostname || '?')}</code>) so guests can sign in via one-time email PIN.</p>
      <table style="width:100%;border-collapse:collapse">
        <thead>
          <tr style="text-align:left;border-bottom:1px solid #2a2f3a">
            <th style="padding:8px 0">Nickname</th><th>Email</th><th>Added</th><th></th>
          </tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="4" class="muted">No accounts yet.</td></tr>'}</tbody>
      </table>
    </div>

    <div class="card">
      <h3>Add a guest</h3>
      <p>
        <input id="u-nickname" type="text" placeholder="nickname" style="width:30%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
        <input id="u-email" type="email" placeholder="email" style="width:40%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
        <button onclick="uAdd()" ${setupReady ? '' : 'disabled'}>Add</button>
      </p>
      <p class="muted">Guests get a CF login (one-time PIN to their email) when they visit <code>${escape(cfg.cloudflare.hostname || 'your-host')}</code>. No password to manage.</p>
    </div>

    <div id="u-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px"></div>

    <script>
      function flash(msg, cls) {
        const el = document.getElementById('u-msg');
        el.innerHTML = '<div class="card" style="margin:0;border-color:' + (cls === 'bad' ? '#f08484' : cls === 'ok' ? '#6ddc9b' : '#f0c674') + '">' + msg + '</div>';
        setTimeout(() => { el.innerHTML = ''; }, 4000);
      }
      async function uAdd() {
        const nickname = document.getElementById('u-nickname').value.trim();
        const email = document.getElementById('u-email').value.trim().toLowerCase();
        if (!nickname || !email) return flash('nickname and email required', 'bad');
        const r = await fetch('/api/users', {
          method: 'POST',
          headers: {'content-type':'application/json'},
          body: JSON.stringify({ nickname, email }),
        });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('added — CF policy synced', 'ok');
        setTimeout(() => location.reload(), 500);
      }
      async function uDelete(email) {
        if (!confirm('Remove ' + email + ' from the allowlist?')) return;
        const r = await fetch('/api/users/' + encodeURIComponent(email), { method: 'DELETE' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        flash('removed — CF policy synced', 'ok');
        setTimeout(() => location.reload(), 500);
      }
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'Users', active: 'users', body }));
});

router.post('/api/users', async (req, res) => {
  const nickname = (req.body?.nickname || '').trim();
  const email = (req.body?.email || '').trim().toLowerCase();
  if (!nickname) return res.status(400).json({ error: 'nickname required' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid email' });

  const cfg = config.load();
  if ((cfg.accounts || []).some(a => a.email.toLowerCase() === email)) {
    return res.status(400).json({ error: 'email already in allowlist' });
  }
  const accounts = [...(cfg.accounts || []), { email, nickname, addedAt: new Date().toISOString() }];
  config.save({ accounts });
  try {
    await syncAccessPolicy();
    res.json({ message: 'added', email });
  } catch (e) {
    logger.error('access sync failed on add', e.message);
    config.save({ accounts: cfg.accounts });
    res.status(500).json({ error: `CF sync failed (rolled back): ${e.message}` });
  }
});

router.delete('/api/users/:email', async (req, res) => {
  const email = decodeURIComponent(req.params.email).trim().toLowerCase();
  const cfg = config.load();
  const accounts = cfg.accounts || [];
  const target = accounts.find(a => a.email.toLowerCase() === email);
  if (!target) return res.status(404).json({ error: 'not found' });
  if (target.isOwner) return res.status(400).json({ error: 'cannot remove owner' });

  const next = accounts.filter(a => a.email.toLowerCase() !== email);
  config.save({ accounts: next });
  try {
    await syncAccessPolicy();
    res.json({ message: 'removed', email });
  } catch (e) {
    logger.error('access sync failed on delete', e.message);
    config.save({ accounts });
    res.status(500).json({ error: `CF sync failed (rolled back): ${e.message}` });
  }
});

module.exports = router;
