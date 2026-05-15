const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const WebSocket = require('ws');
const { createLogger } = require('./utils/logger');
const config = require('./config');
const { bus, emitPresenceMsg } = require('./services/event-bus');
const session = require('./services/session-service');
const chat = require('./services/chat-service');
const signaling = require('./services/signaling-service');
const visitorRoutes = require('./routes/visitor');

const logger = createLogger('Public');

function start() {
  const app = express();
  const PORT = parseInt(process.env.PUBLIC_PORT || process.env.PORT || '3000', 10);
  const HOST = process.env.PUBLIC_HOST || '127.0.0.1';
  const AUTH_HEADER = process.env.AUTH_HEADER || 'Cf-Access-Authenticated-User-Email';
  const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';

  app.set('trust proxy', TRUST_PROXY);
  app.use(cors());
  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }));

  app.use((req, _res, next) => {
    const email = req.header(AUTH_HEADER);
    req.user = email ? { email } : null;
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  app.use((req, res, next) => {
    if (req.path === '/healthz') return next();
    const cfg = config.load();
    if (!cfg.setupComplete) {
      return res.status(503).type('html').send(`<!doctype html><title>PumpDirect</title>
<style>body{font-family:system-ui;background:#0f1115;color:#e8e8e8;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:40px}</style>
<h1>PumpDirect is being set up</h1><p style="color:#9aa4b2">The owner is still completing initial configuration.</p>`);
    }
    if (!req.user) return res.status(401).json({ error: 'unauthenticated' });
    next();
  });

  // Static assets (dice Lottie JSON, lottie-web player). Mounted before
  // anything that could 404 / redirect.
  app.use('/assets', express.static(path.join(__dirname, 'public', 'assets'), { maxAge: '1h' }));

  app.use(visitorRoutes.router);

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws/visitor') { socket.destroy(); return; }
    const email = req.headers[AUTH_HEADER.toLowerCase()];
    if (!email) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const cfg = config.load();
    if (!cfg.setupComplete) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userEmail = String(email);
      wss.emit('connection', ws, req);
    });
  });

  const visitorConns = new Map(); // email -> count
  // Reload-grace state: when a visitor's last WS closes we wait briefly before
  // announcing "left" and clearing presence. If they reconnect within the grace
  // window we treat it as a continuous session — no chat noise, no peer flicker
  // on the participant list.
  const pendingLeave = new Map(); // email -> { timer, nickname }
  const REJOIN_GRACE_MS = 6000;

  function nicknameFor(email) {
    const cfg = config.load();
    // Owner's public-facing name comes from owner.displayName so visitors see
    // the intended label (matches owner-server's nicknameFor).
    if (email === cfg.cloudflare?.ownerEmail && (cfg.owner?.displayName || '').trim()) {
      return cfg.owner.displayName.trim();
    }
    const acct = (cfg.accounts || []).find(a => a.email === email);
    return acct?.nickname || (email.split('@')[0]);
  }

  function enrichState() {
    const cfg = config.load();
    const s = session.getState();
    const pmap = signaling.getPresenceMap();
    const participants = (s.participants || []).map(p => ({ ...p, presence: pmap.get(p.email) || null }));
    return { ...s, participants, ownerPresence: pmap.get(cfg.cloudflare?.ownerEmail || '') || null, ownerCamera: cfg.owner?.camera || {} };
  }

  // STRICT broadcast permission check (server-side authoritative). A visitor
  // can publish their cam ONLY if every condition is true:
  //   * owner enabled "Allow controllers to broadcast webcam" globally
  //   * a session is active
  //   * the visitor is a participant with canConnect
  //   * the visitor is the active controller (canControl)
  //   * the per-participant canBroadcast flag is set
  function _canVisitorBroadcast(email) {
    const cfg = config.load();
    if (!cfg.owner?.camera?.allowControllerBroadcast) return false;
    const s = session.getState();
    if (!s.active) return false;
    const p = (s.participants || []).find(x => x.email === email);
    if (!p) return false;
    if (p.canConnect === false) return false;
    if (!p.canControl) return false;
    if (!p.canBroadcast) return false;
    return true;
  }

  // Track who's actively publishing so we can force-stop them when their
  // permission gets revoked. Updated by the broadcast-state WS messages.
  const broadcasting = new Set();
  function _forceUnbroadcast(email, reason) {
    if (!broadcasting.has(email)) return;
    broadcasting.delete(email);
    // Tell the publisher's own tab(s) to drop the stream and let every peer
    // remove their tile of this visitor.
    signaling.deliver(email, { type: 'force-unbroadcast', reason });
    signaling.broadcast({ type: 'broadcast-state', email, broadcasting: false }, email);
    logger.warn(`force-unbroadcast ${email}: ${reason}`);
  }
  // Every state event re-checks permissions; revocations are caught here.
  bus.on('state', () => {
    for (const email of Array.from(broadcasting)) {
      if (!_canVisitorBroadcast(email)) _forceUnbroadcast(email, 'permission revoked');
    }
  });

  wss.on('connection', (ws) => {
    const email = ws.userEmail;
    const cfg = config.load();
    const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';

    const sendRaw = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    const send = (type, payload) => sendRaw({ type, ...payload });

    const reg = signaling.registerVisitor(email, ws, sendRaw);
    if (!reg.ok) { ws.close(1008, reg.reason); return; }

    const peerListWithNicks = signaling.allPeers(ownerEmail).map(p => ({ ...p, nickname: nicknameFor(p.email) }));
    send('hello', { email, nickname: nicknameFor(email), isOwner: false, peers: peerListWithNicks });
    send('chat-key', { key: chat.getKeyBase64() });
    send('state', { state: enrichState() });
    send('chat-history', { messages: chat.snapshot() });

    const prevCount = visitorConns.get(email) || 0;
    visitorConns.set(email, prevCount + 1);
    const pending = pendingLeave.get(email);
    if (pending) {
      // Reconnected inside the grace window — cancel the pending "left" so we
      // never announce join either. The other peers' PCs are torn down/rebuilt
      // by WebRTC anyway, but chat + presence stay quiet.
      clearTimeout(pending.timer);
      pendingLeave.delete(email);
    } else if (prevCount === 0) {
      emitPresenceMsg({ text: `${nicknameFor(email)} joined`, ts: Date.now() });
    }
    if (prevCount === 0) {
      signaling.broadcast({ type: 'peer-joined', email, nickname: nicknameFor(email), isOwner: false }, email);
    }
    signaling.setPresence(email, 'connected');

    const onState = () => send('state', { state: enrichState() });
    const onChat = (message) => {
      const s = session.getState();
      if (s.active) {
        const p = (s.participants || []).find(x => x.email === email);
        if (!p || p.canConnect === false) return;
      }
      send('chat', { message });
    };
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
        // An OFFER from a visitor is always a publish-side message (their PC
        // is the initiator). If they don't have broadcast permission RIGHT
        // NOW, drop it. Answers + ICE are relayed regardless (they're
        // responses to existing PCs, possibly for the inbound direction).
        if (msg.type === 'webrtc-offer' && !_canVisitorBroadcast(email)) {
          logger.warn(`dropped webrtc-offer from ${email}: not allowed to broadcast`);
          return;
        }
        signaling.deliver(msg.toEmail, { ...msg, fromEmail: email });
      } else if (msg && msg.type === 'broadcast-state') {
        if (msg.broadcasting && !_canVisitorBroadcast(email)) {
          logger.warn(`dropped broadcast-state:true from ${email}: not allowed`);
          return;
        }
        if (msg.broadcasting) broadcasting.add(email);
        else broadcasting.delete(email);
        signaling.broadcast({ type: 'broadcast-state', email, broadcasting: !!msg.broadcasting }, email);
      } else if (msg && msg.type === 'track-state') {
        signaling.broadcast({ type: 'track-state', email, videoMuted: !!msg.videoMuted, audioMuted: !!msg.audioMuted }, email);
      } else if (msg && msg.type === 'visibility') {
        signaling.setPresence(email, msg.hidden ? 'afk' : 'connected');
      }
    });

    ws.on('close', () => {
      bus.off('state', onState); bus.off('chat', onChat); bus.off('chat-key', onChatKey); bus.off('overlay', onOverlay); bus.off('presence-msg', onPresenceMsg);
      signaling.unregister(email, ws);
      broadcasting.delete(email);
      const next = (visitorConns.get(email) || 1) - 1;
      if (next <= 0) {
        visitorConns.delete(email);
        // peer-left fires now so other clients can rebuild WebRTC PCs on the
        // reconnect; the chat-system + presence-clear get deferred so a quick
        // reload doesn't spam "left/joined" or flicker the participant list.
        signaling.broadcast({ type: 'peer-left', email });
        const nick = nicknameFor(email);
        const timer = setTimeout(() => {
          pendingLeave.delete(email);
          signaling.clearPresence(email);
          emitPresenceMsg({ text: `${nick} left`, ts: Date.now() });
        }, REJOIN_GRACE_MS);
        pendingLeave.set(email, { timer, nickname: nick });
      } else {
        visitorConns.set(email, next);
      }
    });
    ws.on('error', () => {});
  });

  server.listen(PORT, HOST, () => {
    logger.info(`public server on ${HOST}:${PORT} (auth header: ${AUTH_HEADER}) + ws on /ws/visitor`);
  });
}

module.exports = { start };
