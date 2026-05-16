const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { createLogger } = require('../utils/logger');

const logger = createLogger('CF');
const execFileP = promisify(execFile);

const CFD_DIR = path.join(os.homedir(), '.cloudflared');
const CERT_PATH = path.join(CFD_DIR, 'cert.pem');
const CONFIG_PATH = path.join(CFD_DIR, 'config.yml');

const CF_API = 'https://api.cloudflare.com/client/v4';

async function detectCloudflared() {
  try {
    const { stdout } = await execFileP('cloudflared', ['--version']);
    return { installed: true, version: stdout.trim().split('\n')[0] };
  } catch {
    return { installed: false, version: null };
  }
}

function isLoggedIn() {
  return fs.existsSync(CERT_PATH);
}

const loginState = { proc: null, url: null, error: null };

function startLogin() {
  if (isLoggedIn()) return { alreadyLoggedIn: true, url: null };
  if (loginState.proc && !loginState.proc.killed) return { pending: true, url: loginState.url };

  loginState.url = null;
  loginState.error = null;
  const proc = spawn('cloudflared', ['tunnel', 'login']);
  loginState.proc = proc;

  const onData = buf => {
    const s = buf.toString();
    const m = s.match(/https:\/\/dash\.cloudflare\.com\/argotunnel\?[^\s]+/);
    if (m && !loginState.url) loginState.url = m[0];
  };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('exit', code => {
    if (code !== 0 && !isLoggedIn()) loginState.error = `cloudflared exited with code ${code}`;
    loginState.proc = null;
  });

  return { pending: true, url: null };
}

function loginStatus() {
  return {
    loggedIn: isLoggedIn(),
    pending: !!(loginState.proc && !loginState.proc.killed),
    url: loginState.url,
    error: loginState.error,
  };
}

async function listTunnels() {
  if (!isLoggedIn()) return [];
  try {
    const { stdout } = await execFileP('cloudflared', ['tunnel', 'list', '--output', 'json']);
    return JSON.parse(stdout);
  } catch (e) {
    logger.error('listTunnels failed', e.message);
    return [];
  }
}

async function findTunnel(name) {
  const list = await listTunnels();
  return list.find(t => t.name === name) || null;
}

async function createTunnel(name) {
  const existing = await findTunnel(name);
  if (existing) return { id: existing.id, name: existing.name, reused: true };
  const { stdout } = await execFileP('cloudflared', ['tunnel', 'create', name]);
  const idMatch = stdout.match(/with id ([0-9a-f-]{36})/);
  if (!idMatch) throw new Error('could not parse tunnel id from cloudflared output');
  return { id: idMatch[1], name, reused: false };
}

function writeConfig({ tunnelId, hostname, originPort = 3000 }) {
  const credentialsFile = path.join(CFD_DIR, `${tunnelId}.json`);
  const yml =
`tunnel: ${tunnelId}
credentials-file: ${credentialsFile}

ingress:
  - hostname: ${hostname}
    service: http://127.0.0.1:${originPort}
  - service: http_status:404
`;
  fs.writeFileSync(CONFIG_PATH, yml);
  return CONFIG_PATH;
}

function readConfigHostname() {
  try {
    const yml = fs.readFileSync(CONFIG_PATH, 'utf8');
    const m = yml.match(/^\s*-\s*hostname:\s*(\S+)/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function routeDns(tunnelName, hostname) {
  const { stdout, stderr } = await execFileP('cloudflared', ['tunnel', 'route', 'dns', tunnelName, hostname]);
  return (stdout + stderr).trim();
}

async function cfFetch(token, urlPath, { method = 'GET', body } = {}) {
  const res = await fetch(CF_API + urlPath, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!json.success) {
    const msg = json.errors?.[0]?.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.payload = json;
    throw err;
  }
  return json.result;
}

async function validateToken(token) {
  const verified = await cfFetch(token, '/user/tokens/verify');
  return { status: verified.status };
}

async function listZones(token) {
  const zones = await cfFetch(token, '/zones?per_page=50');
  return zones.map(z => ({ id: z.id, name: z.name, accountId: z.account.id, accountName: z.account.name }));
}

async function getAccountIdForZone(token, zoneName) {
  const zones = await listZones(token);
  const z = zones.find(z => z.name === zoneName);
  if (!z) throw new Error(`zone ${zoneName} not found on this token`);
  return z.accountId;
}

async function findAccessApp(token, accountId, domain) {
  const apps = await cfFetch(token, `/accounts/${accountId}/access/apps`);
  return apps.find(a => a.domain === domain) || null;
}

async function isAccessEnabled(token, accountId) {
  try {
    await cfFetch(token, `/accounts/${accountId}/access/apps`);
    return true;
  } catch (e) {
    const matches = (e.payload?.errors || []).some(err =>
      err.code === 12109 ||
      /not_enabled/.test(String(err.code || '')) ||
      /not_enabled/i.test(String(err.message || ''))
    );
    if (matches || /not_enabled/i.test(e.message || '')) return false;
    throw e;
  }
}

async function ensureAccessApp(token, accountId, { name, domain, sessionDuration = '8h', allowedEmails }) {
  let app = await findAccessApp(token, accountId, domain);
  if (!app) {
    app = await cfFetch(token, `/accounts/${accountId}/access/apps`, {
      method: 'POST',
      body: {
        name,
        domain,
        type: 'self_hosted',
        session_duration: sessionDuration,
        app_launcher_visible: true,
      },
    });
  }
  const policies = await cfFetch(token, `/accounts/${accountId}/access/apps/${app.id}/policies`);
  const existing = policies.find(p => p.name === 'PumpDirect allowlist');
  const emails = allowedEmails.length ? allowedEmails : ['noone@example.invalid'];
  const policyBody = {
    name: 'PumpDirect allowlist',
    decision: 'allow',
    include: emails.map(e => ({ email: { email: e } })),
  };
  if (existing) {
    await cfFetch(token, `/accounts/${accountId}/access/apps/${app.id}/policies/${existing.id}`, {
      method: 'PUT',
      body: policyBody,
    });
  } else {
    await cfFetch(token, `/accounts/${accountId}/access/apps/${app.id}/policies`, {
      method: 'POST',
      body: policyBody,
    });
  }
  // app.aud is the Application AUD tag — JWT verification requires it to be
  // saved into config alongside the team subdomain.
  return { appId: app.id, domain: app.domain, aud: app.aud || null };
}

function downloadFile(url, dest, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        return downloadFile(res.headers.location, dest, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    });
    req.on('error', reject);
  });
}

const RELEASE_BASE = 'https://github.com/cloudflare/cloudflared/releases/latest/download';

function installerVariantFor(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') {
    const file = arch === 'arm64' ? 'cloudflared-linux-arm64.deb' : 'cloudflared-linux-amd64.deb';
    return { kind: 'linux-deb', url: `${RELEASE_BASE}/${file}`, savePath: path.join(os.tmpdir(), file) };
  }
  if (platform === 'win32') {
    const file = arch === 'arm64' ? 'cloudflared-windows-arm64.msi' : 'cloudflared-windows-amd64.msi';
    return { kind: 'win32-msi', url: `${RELEASE_BASE}/${file}`, savePath: path.join(os.tmpdir(), file) };
  }
  if (platform === 'darwin') {
    return { kind: 'darwin-brew', url: null, savePath: null };
  }
  return null;
}

async function downloadAndLaunchInstaller({ platform = process.platform, arch = process.arch } = {}) {
  const v = installerVariantFor(platform, arch);
  if (!v) throw new Error(`no installer recipe for ${platform}/${arch}`);
  if (v.kind === 'darwin-brew') {
    spawn('brew', ['install', 'cloudflared'], { detached: true, stdio: 'ignore' }).unref();
    return { launched: 'brew install cloudflared (Terminal will open)' };
  }
  await downloadFile(v.url, v.savePath);
  if (v.kind === 'linux-deb') {
    const opener = ['xdg-open', 'gnome-open', 'kde-open'].find(c => {
      try { require('child_process').execFileSync('which', [c], { stdio: 'ignore' }); return true; }
      catch { return false; }
    });
    if (!opener) throw new Error(`downloaded to ${v.savePath} but no xdg-open found — install manually: sudo dpkg -i ${v.savePath}`);
    spawn(opener, [v.savePath], { detached: true, stdio: 'ignore' }).unref();
    return { launched: `${opener} ${v.savePath}` };
  }
  if (v.kind === 'win32-msi') {
    spawn('msiexec', ['/i', v.savePath], { detached: true, stdio: 'ignore' }).unref();
    return { launched: `msiexec /i ${v.savePath}` };
  }
}

module.exports = {
  detectCloudflared,
  isLoggedIn,
  startLogin,
  loginStatus,
  listTunnels,
  findTunnel,
  createTunnel,
  writeConfig,
  readConfigHostname,
  routeDns,
  validateToken,
  listZones,
  getAccountIdForZone,
  findAccessApp,
  isAccessEnabled,
  ensureAccessApp,
  installerVariantFor,
  downloadAndLaunchInstaller,
  CERT_PATH,
  CONFIG_PATH,
};
