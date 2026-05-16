const express = require('express');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');
const { createLogger } = require('./utils/logger');
const { ownerLayout, escape } = require('./views/layout');
const { csrfMiddleware } = require('./utils/csrf');
const config = require('./config');
const { bus } = require('./services/event-bus');
const chat = require('./services/chat-service');
const session = require('./services/session-service');
const signaling = require('./services/signaling-service');
const { TOS_VERSION } = require('./views/tos');
const systemRoute = require('./routes/system');

const logger = createLogger('Owner');

let httpServer = null;
let ownerWss = null;
let systemWss = null;

function pill(state, label) {
  const cls = state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${escape(label)}</span>`;
}

function start() {
  const app = express();
  const PORT = parseInt(process.env.OWNER_PORT || '3001', 10);
  const HOST = '127.0.0.1';

  app.use(express.json({ limit: '2mb' }));
  // Note: express.urlencoded is intentionally NOT used. It would enable
  // CORS-simple cross-origin POSTs that bypass the JSON content-type
  // preflight, expanding the CSRF surface beyond what the Origin check
  // and X-CSRF-Token guard can cover with confidence.

  app.use((req, res, next) => {
    const peer = req.socket.remoteAddress || '';
    if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') return next();
    res.status(403).type('text').send('owner GUI is loopback-only');
  });

  // CSRF guard on every /api/* mutation. Mounted before any routes so the
  // Origin / Referer check + double-submit-cookie token validation runs on
  // every request that could mutate state.
  const allowedOrigins = new Set([
    `http://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
  ]);
  app.use(csrfMiddleware({ allowedOrigins }));

  // TOS gate — every route except the TOS page + accept API requires acceptance.
  app.use(require('./routes/tos'));
  app.use((req, res, next) => {
    if (req.path === '/tos' || req.path.startsWith('/api/owner/tos') || req.path.startsWith('/api/owner/update-check')) return next();
    const cfg = config.load();
    if (cfg.owner?.tosAcceptedVersion === TOS_VERSION) return next();
    if ((req.headers.accept || '').includes('text/html')) return res.redirect('/tos');
    res.status(403).json({ error: 'TOS not accepted — open /tos in a browser to accept' });
  });

  // Static assets (dice Lottie JSON, lottie-web player, etc.) — must be mounted
  // BEFORE the TOS gate would otherwise treat them as missing pages. The TOS
  // middleware above doesn't intercept /assets/* explicitly; static files don't
  // negotiate HTML so the redirect rule doesn't trigger, but be defensive.
  app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1h' }));

  app.use(require('./routes/launchpad'));
  app.use(require('./routes/chat-webcam'));
  app.use(require('./routes/templates'));
  app.use(require('./routes/network'));
  app.use(require('./routes/users'));
  app.use(require('./routes/devices'));
  app.use(require('./routes/triggers'));
  app.use(require('./routes/minigames'));
  app.use(require('./routes/help'));
  // Satellite endpoints — localhost-only, used when this instance acts
  // as the Target for someone else's Dual-Target session.
  app.use(require('./routes/satellite'));
  // System tab — live log streaming, also localhost-only.
  app.use(systemRoute.router);

  httpServer = http.createServer(app);
  ownerWss = new WebSocket.Server({ noServer: true });
  systemWss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const peer = req.socket.remoteAddress || '';
    const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
    if (!loopback) { socket.destroy(); return; }
    if (req.url === '/ws/owner') {
      ownerWss.handleUpgrade(req, socket, head, ws => ownerWss.emit('connection', ws, req));
    } else if (req.url === '/ws/system') {
      systemWss.handleUpgrade(req, socket, head, ws => systemWss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  // Reload-grace: defer presence clear when the last owner-tab WS closes so a
  // refresh / nav between tabs doesn't flicker the Host row on visitor screens.
  let ownerPresenceClearTimer = null;
  const REJOIN_GRACE_MS = 6000;

  function enrichState() {
    const cfg = config.load();
    const s = session.getState();
    const pmap = signaling.getPresenceMap();
    const participants = (s.participants || []).map(p => ({ ...p, presence: pmap.get(p.email) || null }));
    return { ...s, participants, ownerPresence: pmap.get(cfg.cloudflare?.ownerEmail || '') || null, ownerCamera: cfg.owner?.camera || {} };
  }

  function nicknameFor(email) {
    const cfg = config.load();
    if (email === cfg.cloudflare?.ownerEmail && cfg.owner?.displayName) return cfg.owner.displayName;
    const acct = (cfg.accounts || []).find(a => a.email === email);
    return acct?.nickname || (String(email || '').split('@')[0] || 'unknown');
  }

  function peerListWithNicks(myEmail) {
    return signaling.allPeers(myEmail).map(p => ({ ...p, nickname: nicknameFor(p.email) }));
  }

  ownerWss.on('connection', (ws, req) => {
    const cfg = config.load();
    const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';

    const sendRaw = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    const send = (type, payload) => sendRaw({ type, ...payload });

    const reg = signaling.registerOwner(ownerEmail, ws, sendRaw);
    if (!reg.ok) { ws.close(1008, reg.reason); return; }

    send('hello', { email: ownerEmail, nickname: nicknameFor(ownerEmail), isOwner: true, peers: peerListWithNicks(ownerEmail) });
    send('chat-key', { key: chat.getKeyBase64() });
    send('state', { state: enrichState() });
    send('chat-history', { messages: chat.snapshot() });
    signaling.broadcast({ type: 'peer-joined', email: ownerEmail, nickname: nicknameFor(ownerEmail), isOwner: true }, ownerEmail);
    if (ownerPresenceClearTimer) { clearTimeout(ownerPresenceClearTimer); ownerPresenceClearTimer = null; }
    signaling.setPresence(ownerEmail, 'connected');

    const onState = () => send('state', { state: enrichState() });
    const onChat = (message) => send('chat', { message });
    const onChatKey = (key) => send('chat-key', { key });
    const onOverlay = (payload) => send('overlay', payload);
    const onPresenceMsg = (payload) => send('presence-msg', payload);
    bus.on('state', onState);
    bus.on('chat', onChat);
    bus.on('chat-key', onChatKey);
    bus.on('overlay', onOverlay);
    bus.on('presence-msg', onPresenceMsg);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && (msg.type === 'webrtc-offer' || msg.type === 'webrtc-answer' || msg.type === 'webrtc-ice')) {
        if (!msg.toEmail) return;
        signaling.deliver(msg.toEmail, { ...msg, fromEmail: ownerEmail });
      } else if (msg && msg.type === 'broadcast-state') {
        signaling.broadcast({ type: 'broadcast-state', email: ownerEmail, broadcasting: !!msg.broadcasting }, ownerEmail);
      } else if (msg && msg.type === 'track-state') {
        signaling.broadcast({ type: 'track-state', email: ownerEmail, videoMuted: !!msg.videoMuted, audioMuted: !!msg.audioMuted }, ownerEmail);
      } else if (msg && msg.type === 'visibility') {
        signaling.setPresence(ownerEmail, msg.hidden ? 'afk' : 'connected');
      }
    });

    ws.on('close', () => {
      bus.off('state', onState);
      bus.off('chat', onChat);
      bus.off('chat-key', onChatKey);
      bus.off('overlay', onOverlay);
      bus.off('presence-msg', onPresenceMsg);
      signaling.unregister(ownerEmail, ws);
      // Only clear presence once the last owner-tab WS closes, and even then
      // defer so a refresh doesn't flip the Host row offline-then-online.
      signaling.broadcast({ type: 'peer-left', email: ownerEmail });
      const stillOpen = signaling.allPeers(ownerEmail).some(p => p.email === ownerEmail);
      if (!stillOpen) {
        if (ownerPresenceClearTimer) clearTimeout(ownerPresenceClearTimer);
        ownerPresenceClearTimer = setTimeout(() => {
          ownerPresenceClearTimer = null;
          if (!signaling.allPeers(ownerEmail).some(p => p.email === ownerEmail)) {
            signaling.clearPresence(ownerEmail);
          }
        }, REJOIN_GRACE_MS);
      }
    });
    ws.on('error', (err) => { logger.warn('owner ws error', err.message); });
  });

  systemRoute.attachWebSocket(systemWss);

  httpServer.listen(PORT, HOST, () => {
    logger.info(`owner server on http://${HOST}:${PORT} (loopback only) + ws on /ws/owner, /ws/system`);
  });
}

async function shutdown() {
  if (!httpServer) return;
  logger.always('owner server shutting down');
  return new Promise(resolve => {
    try {
      ownerWss?.clients.forEach(ws => { try { ws.close(1001, 'shutdown'); } catch {} });
      systemWss?.clients.forEach(ws => { try { ws.close(1001, 'shutdown'); } catch {} });
    } catch {}
    httpServer.close(() => resolve());
    setTimeout(() => resolve(), 1500);
  });
}

module.exports = { start, shutdown };
