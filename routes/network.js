const express = require('express');
const cf = require('../services/cloudflare-service');
const hardening = require('../services/hardening-service');
const config = require('../config');
const { ownerLayout, escape } = require('../views/layout');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Network');
const router = express.Router();

function pill(state, label) {
  const cls = state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${escape(label)}</span>`;
}

function renderHardening(hd) {
  if (hd.unsupported) {
    return `<div class="card"><p>Hardened service install is not implemented for <code>${escape(hd.platform)}</code>. PumpDirect will still run via <code>./start.sh</code> manually.</p></div>`;
  }
  if (hd.platform === 'linux') {
    const status = hd.installed
      ? `${pill('ok', `installed at ${hd.unitPath}`)} ${pill(hd.active ? 'ok' : 'bad', hd.active ? `active (${hd.sub || ''})` : 'inactive')}${hd.since ? `<span class="muted"> · since ${escape(hd.since)}</span>` : ''}`
      : pill('warn', 'not installed');
    return `
      <div class="card">
        <p>Status: ${status}</p>
        <p class="muted">A hardened systemd unit runs PumpDirect as your user with NoNewPrivileges, ProtectSystem=strict, ProtectHome=read-only (except project + ~/.cloudflared), restricted address families, dropped caps, and PrivateDevices.</p>
        <p>
          <button onclick="hdGenerate()">${hd.installed ? 'Regenerate unit file' : 'Generate unit file'}</button>
          ${hd.installed
            ? `<button onclick="hdShowUninstall()">Show uninstall command</button>`
            : ''}
        </p>
        <div id="hd-instructions"></div>
      </div>
      <div class="card">
        <h3>Preview of generated unit</h3>
        <pre id="hd-unit-preview" style="max-height:300px;overflow:auto"></pre>
        <p><button onclick="hdLoadPreview()">Load preview</button></p>
      </div>
    `;
  }
  if (hd.platform === 'win32') {
    const status = hd.installed
      ? `${pill('ok', `service ${hd.serviceName} installed`)} ${pill(hd.active ? 'ok' : 'bad', hd.active ? 'running' : 'stopped')}`
      : pill('warn', 'not installed');
    return `
      <div class="card">
        <p>Status: ${status}</p>
        <p class="muted">Windows installs PumpDirect as a Windows Service using <a href="https://nssm.cc/" target="_blank">NSSM</a> (downloaded on first install). Runs auto-start, with a Windows Defender Firewall rule pinning the listener to loopback.</p>
        <p>
          <button onclick="hdWinGenerate()">${hd.installed ? 'Regenerate installer scripts' : 'Generate installer scripts'}</button>
          ${hd.installed ? `<button onclick="hdWinShowUninstall()">Show uninstall command</button>` : ''}
        </p>
        <div id="hd-instructions"></div>
      </div>
    `;
  }
  return '';
}

function renderInstallTabs(platform) {
  const tabs = [
    { id: 'linux',  label: 'Linux (Debian/Ubuntu)', match: 'linux' },
    { id: 'win32',  label: 'Windows',               match: 'win32' },
    { id: 'darwin', label: 'macOS',                 match: 'darwin' },
  ];
  const tabBar = tabs.map(t =>
    `<button type="button" class="install-tab${platform === t.match ? ' active' : ''}" onclick="showInstall('${t.id}', this)">${escape(t.label)}${platform === t.match ? ' (detected)' : ''}</button>`
  ).join('');

  const pane = (id, visible, html) =>
    `<div id="install-${id}" class="install-pane" style="${visible ? '' : 'display:none'}">${html}</div>`;

  return `
    <style>
      .install-tab-bar { display:flex; gap:6px; margin: 8px 0; }
      .install-tab { background:#0f1115; color:#9aa4b2; border:1px solid #2a2f3a; border-radius:6px; padding:10px 18px; font-size:1rem; cursor:pointer; }
      .install-tab.active { background:#161922; color:#fff; border-color:#2a6df4; }
      .install-pane { background:#0f1115; border:1px solid #2a2f3a; border-radius:6px; padding:12px; }
      details summary { cursor:pointer; color:#9aa4b2; margin-top:8px; }
    </style>
    <div class="install-tab-bar">${tabBar}</div>
    ${pane('linux', platform === 'linux', `
      <p>Click below — downloads the official <code>.deb</code> and opens your package manager (sudo prompt from the OS).</p>
      <p><button onclick="cfInstall()">Download &amp; launch installer</button></p>
      <details><summary>Manual command (any Linux)</summary>
        <pre>curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
sudo dpkg -i /tmp/cloudflared.deb</pre>
        <p class="muted">RPM users: substitute <code>cloudflared-linux-x86_64.rpm</code> and <code>sudo rpm -ivh</code>. Arch: <code>sudo pacman -S cloudflared</code>.</p>
      </details>
    `)}
    ${pane('win32', platform === 'win32', `
      <p>Click below — downloads the official <code>.msi</code> and opens it (UAC prompt from Windows).</p>
      <p><button onclick="cfInstall()">Download &amp; launch installer</button></p>
      <details><summary>Manual command (PowerShell)</summary>
        <pre>winget install --id Cloudflare.cloudflared</pre>
      </details>
    `)}
    ${pane('darwin', platform === 'darwin', `
      <p>macOS install is via Homebrew. Click below to run <code>brew install cloudflared</code>.</p>
      <p><button onclick="cfInstall()">Run brew install</button></p>
      <details><summary>Manual command</summary>
        <pre>brew install cloudflared</pre>
      </details>
    `)}
  `;
}

async function gatherState() {
  const cfg = config.load();
  const [detect, tunnels, hd] = await Promise.all([
    cf.detectCloudflared(),
    cf.isLoggedIn() ? cf.listTunnels().catch(() => []) : Promise.resolve([]),
    hardening.detectStatus(),
  ]);
  const tunnel = cfg.cloudflare.tunnelName
    ? tunnels.find(t => t.name === cfg.cloudflare.tunnelName) || null
    : null;
  const hostnameFromConfig = cf.readConfigHostname();
  const persistedInstalled = !!cfg.hardening.installed;
  const detectedInstalled = !!hd.installed;
  if (persistedInstalled !== detectedInstalled
      || cfg.hardening.platform !== hd.platform
      || cfg.hardening.method !== hd.method) {
    config.save({ hardening: { installed: detectedInstalled, platform: hd.platform, method: hd.method } });
  }
  return {
    cfg: config.load(),
    detect,
    loggedIn: cf.isLoggedIn(),
    tunnels,
    tunnel,
    hostnameFromConfig,
    hardening: hd,
  };
}

router.get('/network', async (_req, res) => {
  const s = await gatherState();
  const cf_ = s.cfg.cloudflare;
  const hd = s.cfg.hardening;

  const step = (n, title, ok, content) => `
    <div class="card">
      <h3>${n}. ${escape(title)} ${pill(ok ? 'ok' : 'warn', ok ? 'done' : 'pending')}</h3>
      ${content}
    </div>`;

  const accessGate = cf_.apiTokenValidated && cf_.accessProductEnabled === false
    ? `<div class="card" style="border-color:#f0c674">
         <h3>One-time action required on Cloudflare</h3>
         <p>Your CF account doesn't have <strong>Access</strong> enabled yet. Open <a href="https://one.dash.cloudflare.com/" target="_blank">one.dash.cloudflare.com</a> → <strong>Zero Trust</strong> → click <strong>Get started</strong> / <strong>Enable Access</strong>. You'll be prompted to pick a team subdomain (anything works — it's the login URL prefix for your tenant). Then come back and click step 3's Validate button again.</p>
       </div>`
    : '';

  const body = `
    <h2>Network</h2>
    <p class="muted">Setup is sequential. Each step unlocks the next. Re-run any step if state drifts.</p>
    ${accessGate}

    <h3 style="margin-top:24px">Cloudflare Tunnel <span class="muted">— required for public exposure</span></h3>

    ${step(1, 'Install cloudflared', s.detect.installed, `
      ${s.detect.installed
        ? `<p>Detected: <code>${escape(s.detect.version)}</code></p>`
        : `<p class="muted">Pick your OS — your detected platform is highlighted.</p>${renderInstallTabs(process.platform)}`}
      <p><button onclick="cfAction('/api/network/cf/detect')">Re-check</button></p>
    `)}

    ${step(2, 'Authenticate with Cloudflare', s.loggedIn, `
      <p>${s.loggedIn ? 'Logged in — cert.pem present.' : 'Click Start. A browser window opens for you to pick a zone and authorize. After you click Authorize, this step turns green.'}</p>
      <div id="cf-login-url"></div>
      <p>
        <button id="cf-login-start" ${s.loggedIn || !s.detect.installed ? 'disabled' : ''} onclick="cfLoginStart()">Start login</button>
        <button onclick="cfAction('/api/network/cf/login/status')">Refresh status</button>
      </p>
    `)}

    ${step(3, 'API token', !!cf_.apiTokenValidated, `
      <p>Token needs <em>Account → Access: Apps and Policies → Edit</em> and <em>Zone → DNS → Read</em>.
         <a href="https://dash.cloudflare.com/profile/api-tokens" target="_blank">Create one →</a></p>
      <p>
        <input id="cf-token" type="password" placeholder="paste API token" style="width:60%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
        <button onclick="cfSaveToken()">Validate &amp; save</button>
      </p>
      ${cf_.apiTokenValidated ? `<p class="muted">Token validated. Zone: <code>${escape(cf_.zoneName || '?')}</code></p>` : ''}
    `)}

    ${step(4, 'Create tunnel', !!cf_.tunnelId, `
      <p>${cf_.tunnelId
        ? `Tunnel <code>${escape(cf_.tunnelName)}</code> · <code>${escape(cf_.tunnelId)}</code>`
        : 'Pick a name. We use it locally only.'}</p>
      <p>
        <input id="cf-tunnel-name" type="text" value="${escape(cf_.tunnelName || 'pumpdirect')}" style="width:30%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
        <button ${!s.loggedIn ? 'disabled' : ''} onclick="cfCreateTunnel()">${cf_.tunnelId ? 'Re-create / reuse' : 'Create'}</button>
      </p>
      <details style="margin-top:8px">
        <summary>Windows alternative — create the tunnel manually on the Cloudflare dashboard</summary>
        <ol style="margin:10px 0 0 22px;padding:0;font-size:0.95rem;line-height:1.7">
          <li>If step 2/3/4 fail on Windows, complete steps 1–3 as normal, then come here.</li>
          <li>Open <a href="https://one.dash.cloudflare.com/" target="_blank">one.dash.cloudflare.com</a> → <strong>Networks</strong> → <strong>Tunnels</strong> (older UI: Network → Connectors) → <strong>Create a tunnel</strong>.</li>
          <li>Pick <strong>Cloudflared</strong>, give the tunnel a name (e.g. <code>pumpdirect</code>), save it, and copy the name.</li>
          <li>The next page (<em>Install and run a connector</em>) shows a Windows install command. Open <strong>Command Prompt as Administrator</strong> and paste/run it. The page shows a spinner that turns green once the connector reports in — if it never goes green, re-run the same command in an elevated Command Prompt.</li>
          <li>Back here: type the same tunnel name into the textbox above and click <strong>Re-create / reuse</strong>. PumpDirect finds the existing tunnel by name and links to it.</li>
          <li>Continue with steps 5 and 6 as normal.</li>
        </ol>
      </details>
    `)}

    ${step(5, 'Public hostname', !!cf_.hostname, `
      <p>${cf_.hostname ? `Hostname: <code>${escape(cf_.hostname)}</code>` : 'Subdomain + your Cloudflare zone.'}</p>
      <p>
        <input id="cf-sub" type="text" value="${escape(cf_.subdomain || 'app')}" style="width:120px;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
        <span class="muted">.</span>
        <input id="cf-domain" type="text" value="${escape(cf_.zoneName || '')}" placeholder="example.com" style="width:30%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
        <button ${!cf_.tunnelId ? 'disabled' : ''} onclick="cfSetHostname()">Route DNS</button>
      </p>
    `)}

    ${step(6, 'Access policy', cf_.accessPolicyConfirmed, `
      <p>Your email is auto-added as the only allowed user. Add more later from the Users tab.</p>
      <p>
        <input id="cf-owner-email" type="email" placeholder="your@email.com" value="${escape(cf_.ownerEmail || '')}" style="width:40%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
      </p>
      <p>
        <label class="muted" style="display:block;margin:6px 0">Cloudflare team subdomain (required to verify JWTs and prevent header impersonation):</label>
        <input id="cf-team-domain" type="text" placeholder="yourteam.cloudflareaccess.com"
               value="${escape(cf_.teamDomain || '')}"
               style="width:60%;padding:6px;background:#0a0c10;color:#e8e8e8;border:1px solid #2a2f3a;border-radius:4px">
        <span class="muted" style="font-size:0.9rem">Find it at <a href="https://one.dash.cloudflare.com/" target="_blank">one.dash.cloudflare.com</a> → Settings → Custom Pages (or the URL of the team's login page).</span>
      </p>
      <p>
        <button ${!cf_.apiTokenValidated || !cf_.hostname ? 'disabled' : ''} onclick="cfCreateAccessPolicy()">${cf_.accessPolicyConfirmed ? 'Re-sync policy' : 'Create policy'}</button>
      </p>
      ${cf_.accessAud
        ? `<p class="muted" style="font-size:0.9rem">JWT verification: <span class="pill ${cf_.teamDomain ? 'ok' : 'warn'}">${cf_.teamDomain ? 'enabled' : 'aud captured, set team domain to enable'}</span></p>`
        : `<p class="muted" style="font-size:0.9rem">JWT verification: ${pill('warn', 'header-only auth — fill the form above and re-sync')}</p>`}
    `)}

    <h3 style="margin-top:24px">OS Hardening <span class="muted">— ${escape(s.hardening.platform)} detected</span></h3>
    ${renderHardening(s.hardening)}

    <div id="cf-msg" style="position:fixed;bottom:20px;right:20px;max-width:380px"></div>

    <script>
      function flash(msg, cls) {
        const el = document.getElementById('cf-msg');
        el.innerHTML = '<div class="card" style="margin:0;border-color:' + (cls === 'bad' ? '#f08484' : cls === 'ok' ? '#6ddc9b' : '#f0c674') + '">' + msg + '</div>';
        setTimeout(() => { el.innerHTML = ''; }, 4000);
      }
      async function cfAction(url, body) {
        try {
          const res = await fetch(url, { method: 'POST', headers: {'content-type':'application/json'}, body: body ? JSON.stringify(body) : undefined });
          const data = await res.json();
          if (!res.ok || data.error) { flash(data.error || 'failed', 'bad'); return null; }
          flash(data.message || 'done', 'ok');
          if (data.reload !== false) setTimeout(() => location.reload(), 500);
          return data;
        } catch (e) { flash(e.message, 'bad'); return null; }
      }
      function showInstall(id, btn) {
        document.querySelectorAll('.install-pane').forEach(p => p.style.display = 'none');
        document.getElementById('install-' + id).style.display = '';
        document.querySelectorAll('.install-tab').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
      }
      async function cfInstall() {
        flash('downloading installer…', 'warn');
        const r = await fetch('/api/network/cf/install', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'install failed', 'bad');
        flash('installer launched — complete it in the OS dialog, then re-check', 'ok');
        let n = 0;
        const poll = setInterval(async () => {
          n++;
          const det = await (await fetch('/api/network/cf/detect', { method: 'POST' })).json();
          if (det.installed) { clearInterval(poll); flash('cloudflared installed', 'ok'); setTimeout(() => location.reload(), 500); }
          else if (n > 60) clearInterval(poll);
        }, 3000);
      }
      async function cfLoginStart() {
        document.getElementById('cf-login-start').disabled = true;
        const r = await fetch('/api/network/cf/login/start', { method: 'POST' });
        const d = await r.json();
        if (d.url) {
          document.getElementById('cf-login-url').innerHTML = '<p class="muted">If a browser tab did not open, visit:<br><a href="' + d.url + '" target="_blank">' + d.url + '</a></p>';
        }
        const poll = setInterval(async () => {
          const s = await (await fetch('/api/network/cf/login/status')).json();
          if (s.url && !document.getElementById('cf-login-url').textContent) {
            document.getElementById('cf-login-url').innerHTML = '<p class="muted">Visit: <a href="' + s.url + '" target="_blank">' + s.url + '</a></p>';
          }
          if (s.loggedIn) { clearInterval(poll); flash('logged in', 'ok'); setTimeout(() => location.reload(), 500); }
          if (s.error) { clearInterval(poll); flash(s.error, 'bad'); document.getElementById('cf-login-start').disabled = false; }
        }, 1500);
      }
      function cfSaveToken() {
        const token = document.getElementById('cf-token').value.trim();
        if (!token) return flash('paste a token first', 'bad');
        cfAction('/api/network/cf/token', { token });
      }
      function cfCreateTunnel() {
        const name = document.getElementById('cf-tunnel-name').value.trim();
        if (!name) return flash('name required', 'bad');
        cfAction('/api/network/cf/tunnel', { name });
      }
      function cfSetHostname() {
        const subdomain = document.getElementById('cf-sub').value.trim();
        const domain = document.getElementById('cf-domain').value.trim();
        if (!subdomain || !domain) return flash('subdomain and domain required', 'bad');
        cfAction('/api/network/cf/hostname', { subdomain, domain });
      }
      async function hdGenerate() {
        const r = await fetch('/api/network/hd/generate', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        const cmd = d.installCommand;
        document.getElementById('hd-instructions').innerHTML =
          '<div class="card" style="margin-top:12px"><p>Unit file written to <code>' + d.path + '</code>. Run this command in a terminal (asks for your sudo password):</p>' +
          '<pre>' + cmd + '</pre>' +
          '<p><button onclick="navigator.clipboard.writeText(\\'' + cmd.replace(/'/g, "\\\\'") + '\\'); flash(\\'copied\\', \\'ok\\')">Copy command</button> ' +
          '<button onclick="location.reload()">Re-check status</button></p></div>';
      }
      async function hdLoadPreview() {
        const r = await fetch('/api/network/hd/preview');
        const d = await r.json();
        document.getElementById('hd-unit-preview').textContent = d.unit || (d.error || '');
      }
      async function hdShowUninstall() {
        const r = await fetch('/api/network/hd/uninstall-command');
        const d = await r.json();
        document.getElementById('hd-instructions').innerHTML =
          '<div class="card" style="margin-top:12px"><p>Run this command in a terminal:</p><pre>' + d.command + '</pre>' +
          '<p><button onclick="navigator.clipboard.writeText(\\'' + d.command.replace(/'/g, "\\\\'") + '\\'); flash(\\'copied\\', \\'ok\\')">Copy command</button> ' +
          '<button onclick="location.reload()">Re-check status</button></p></div>';
      }
      async function hdWinGenerate() {
        const r = await fetch('/api/network/hd/win/generate', { method: 'POST' });
        const d = await r.json();
        if (!r.ok || d.error) return flash(d.error || 'failed', 'bad');
        document.getElementById('hd-instructions').innerHTML =
          '<div class="card" style="margin-top:12px"><p>Installer script written to <code>' + d.installPath + '</code>. Open an <strong>admin PowerShell</strong> and run:</p>' +
          '<pre>' + d.installCommand + '</pre>' +
          '<p>NSSM downloads the first time. After it finishes, return here and click Re-check.</p>' +
          '<p><button onclick="navigator.clipboard.writeText(\\'' + d.installCommand.replace(/'/g, "\\\\'").replace(/\\\\/g, "\\\\\\\\") + '\\'); flash(\\'copied\\', \\'ok\\')">Copy command</button> ' +
          '<button onclick="location.reload()">Re-check status</button></p></div>';
      }
      async function hdWinShowUninstall() {
        const r = await fetch('/api/network/hd/win/uninstall-command');
        const d = await r.json();
        document.getElementById('hd-instructions').innerHTML =
          '<div class="card" style="margin-top:12px"><p>Open an <strong>admin PowerShell</strong> and run:</p><pre>' + d.command + '</pre>' +
          '<p><button onclick="navigator.clipboard.writeText(\\'' + d.command.replace(/'/g, "\\\\'").replace(/\\\\/g, "\\\\\\\\") + '\\'); flash(\\'copied\\', \\'ok\\')">Copy command</button> ' +
          '<button onclick="location.reload()">Re-check status</button></p></div>';
      }
      function cfCreateAccessPolicy() {
        const ownerEmail = document.getElementById('cf-owner-email').value.trim();
        if (!ownerEmail) return flash('email required', 'bad');
        const teamDomain = (document.getElementById('cf-team-domain').value || '').trim().replace(/^https?:\\/\\//, '').replace(/\\/+$/, '');
        cfAction('/api/network/cf/access', { ownerEmail, teamDomain });
      }
    </script>
  `;
  res.type('html').send(ownerLayout({ title: 'Network', active: 'network', body }));
});

// --- API endpoints ---

router.post('/api/network/cf/install', async (_req, res) => {
  try {
    const r = await cf.downloadAndLaunchInstaller();
    res.json({ message: `installer launched: ${r.launched}`, reload: false });
  } catch (e) {
    logger.error('install failed', e.message);
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/network/cf/detect', async (_req, res) => {
  const d = await cf.detectCloudflared();
  res.json({ message: d.installed ? `detected ${d.version}` : 'not found', ...d });
});

router.post('/api/network/cf/login/start', (_req, res) => {
  const r = cf.startLogin();
  res.json({ ...r, reload: false });
});

router.get('/api/network/cf/login/status', (_req, res) => {
  res.json({ ...cf.loginStatus(), reload: false });
});

router.post('/api/network/cf/token', async (req, res) => {
  const token = (req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    await cf.validateToken(token);
    const zones = await cf.listZones(token);
    if (!zones.length) return res.status(400).json({ error: 'token has no zone access' });
    const cfg = config.load();
    const existingZone = cfg.cloudflare.zoneName && zones.find(z => z.name === cfg.cloudflare.zoneName);
    const chosen = existingZone || zones[0];
    const accessEnabled = await cf.isAccessEnabled(token, chosen.accountId);
    config.save({
      cloudflare: {
        apiToken: token,
        apiTokenValidated: true,
        zoneName: chosen.name,
        accountId: chosen.accountId,
        accessProductEnabled: accessEnabled,
      },
    });
    const msg = accessEnabled
      ? `token OK — zone ${chosen.name}`
      : `token OK — zone ${chosen.name}. Access product not enabled yet on this CF account; enable at https://one.dash.cloudflare.com/ then re-validate.`;
    res.json({ message: msg });
  } catch (e) {
    logger.error('token validate failed', e.message);
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/network/cf/tunnel', async (req, res) => {
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!cf.isLoggedIn()) return res.status(400).json({ error: 'log in first (step 2)' });
  try {
    const t = await cf.createTunnel(name);
    config.save({ cloudflare: { tunnelId: t.id, tunnelName: t.name } });
    res.json({ message: t.reused ? `reused existing tunnel ${t.name}` : `created tunnel ${t.name}` });
  } catch (e) {
    logger.error('create tunnel failed', e.message);
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/network/cf/hostname', async (req, res) => {
  const subdomain = (req.body?.subdomain || '').trim();
  const domain = (req.body?.domain || '').trim();
  if (!subdomain || !domain) return res.status(400).json({ error: 'subdomain and domain required' });
  const cfg = config.load();
  if (!cfg.cloudflare.tunnelId) return res.status(400).json({ error: 'create the tunnel first (step 4)' });
  const hostname = `${subdomain}.${domain}`;
  try {
    cf.writeConfig({ tunnelId: cfg.cloudflare.tunnelId, hostname });
    await cf.routeDns(cfg.cloudflare.tunnelName, hostname);
    config.save({ cloudflare: { hostname, subdomain } });
    res.json({ message: `routed DNS for ${hostname}. Reinstall the OS service (Hardening) to apply config changes.` });
  } catch (e) {
    logger.error('route dns failed', e.message);
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/network/cf/access', async (req, res) => {
  const ownerEmail = (req.body?.ownerEmail || '').trim();
  if (!ownerEmail) return res.status(400).json({ error: 'email required' });
  const teamDomain = (req.body?.teamDomain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') || null;
  const cfg = config.load();
  const { apiToken, accountId, hostname } = cfg.cloudflare;
  if (!apiToken) return res.status(400).json({ error: 'validate API token first' });
  if (!hostname) return res.status(400).json({ error: 'set public hostname first' });
  try {
    const enabled = await cf.isAccessEnabled(apiToken, accountId);
    if (!enabled) {
      config.save({ cloudflare: { accessProductEnabled: false } });
      return res.status(400).json({
        error: 'Cloudflare Access product is not enabled on your account yet. Open https://one.dash.cloudflare.com/ (Zero Trust → Access) and click "Get started" / "Enable Access" once. Then come back and retry.',
      });
    }
    const existingEmails = (cfg.accounts || []).map(a => a.email).filter(Boolean);
    const allowedEmails = Array.from(new Set([ownerEmail, ...existingEmails]));
    const result = await cf.ensureAccessApp(apiToken, accountId, {
      name: 'PumpDirect',
      domain: hostname,
      allowedEmails,
    });
    const ownerExists = (cfg.accounts || []).some(a => a.email === ownerEmail);
    const accounts = ownerExists ? cfg.accounts : [
      ...(cfg.accounts || []),
      { email: ownerEmail, nickname: 'owner', isOwner: true, addedAt: new Date().toISOString() },
    ];
    config.save({
      cloudflare: {
        ownerEmail,
        accessPolicyConfirmed: true,
        teamDomain,
        accessAud: result.aud || cfg.cloudflare.accessAud,
      },
      accounts,
      setupComplete: true,
    });
    const jwtMsg = (teamDomain && result.aud)
      ? ' JWT verification is now enabled.'
      : ' WARNING: JWT verification not enabled — provide the team subdomain on this step to harden authentication.';
    res.json({ message: 'Access policy synced.' + jwtMsg });
  } catch (e) {
    logger.error('access policy failed', e.message);
    res.status(400).json({ error: e.message });
  }
});

// --- Hardening endpoints ---

router.get('/api/network/hd/preview', (_req, res) => {
  if (process.platform !== 'linux') return res.json({ error: 'preview only for Linux for now' });
  res.json({ unit: hardening.generateLinuxUnit() });
});

router.post('/api/network/hd/generate', (_req, res) => {
  if (process.platform !== 'linux') return res.status(400).json({ error: 'only Linux supported in this sub-phase' });
  try {
    const filePath = hardening.writeLinuxUnit();
    const installCommand = hardening.linuxInstallCommand();
    res.json({ path: filePath, installCommand, reload: false });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/network/hd/uninstall-command', (_req, res) => {
  if (process.platform !== 'linux') return res.status(400).json({ error: 'only Linux supported in this sub-phase' });
  res.json({ command: hardening.linuxUninstallCommand() });
});

router.post('/api/network/hd/win/generate', (_req, res) => {
  if (process.platform !== 'win32') return res.status(400).json({ error: 'only Windows here' });
  try {
    const paths = hardening.writeWindowsScripts();
    res.json({
      installPath: paths.installPath,
      uninstallPath: paths.uninstallPath,
      installCommand: hardening.windowsInstallCommand(),
      reload: false,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/api/network/hd/win/uninstall-command', (_req, res) => {
  if (process.platform !== 'win32') return res.status(400).json({ error: 'only Windows here' });
  res.json({ command: hardening.windowsUninstallCommand() });
});

router.post('/api/network/hd/refresh', async (_req, res) => {
  const status = await hardening.detectStatus();
  config.save({
    hardening: {
      installed: !!status.installed,
      platform: status.platform,
      method: status.method,
    },
  });
  res.json({ message: status.installed ? `${status.method} on ${status.platform}` : 'not installed', status });
});

module.exports = router;
