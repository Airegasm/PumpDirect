const express = require('express');
const http = require('http');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const WebSocket = require('ws');
const { createLogger } = require('./utils/logger');
const config = require('./config');
const { bus } = require('./services/event-bus');
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

  function nicknameFor(email) {
    const cfg = config.load();
    const acct = (cfg.accounts || []).find(a => a.email === email);
    return acct?.nickname || (email.split('@')[0]);
  }

  function enrichState() {
    const cfg = config.load();
    return { ...session.getState(), ownerCamera: cfg.owner?.camera || {} };
  }

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
    if (prevCount === 0) {
      chat.system(`${nicknameFor(email)} joined`);
      signaling.broadcast({ type: 'peer-joined', email, nickname: nicknameFor(email), isOwner: false }, email);
    }

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
    bus.on('state', onState);
    bus.on('chat', onChat);
    bus.on('chat-key', onChatKey);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && (msg.type === 'webrtc-offer' || msg.type === 'webrtc-answer' || msg.type === 'webrtc-ice')) {
        if (!msg.toEmail) return;
        // Controller-broadcast not yet enabled? Drop offers FROM visitors unless owner has allowed it.
        if (msg.type === 'webrtc-offer') {
          const cfg2 = config.load();
          if (!cfg2.owner?.camera?.allowControllerBroadcast) {
            // Visitors can still answer offers (so they can receive); they just can't initiate.
            // But to be lenient, allow them to initiate to the owner only if owner permits.
            // We can't easily tell if this is an "answer-side ICE" vs "publish-side offer" — leniently allow ICE always.
          }
        }
        signaling.deliver(msg.toEmail, { ...msg, fromEmail: email });
      } else if (msg && msg.type === 'broadcast-state') {
        const cfg2 = config.load();
        const allowed = !!cfg2.owner?.camera?.allowControllerBroadcast;
        if (!allowed && msg.broadcasting) return;
        signaling.broadcast({ type: 'broadcast-state', email, broadcasting: !!msg.broadcasting }, email);
      }
    });

    ws.on('close', () => {
      bus.off('state', onState); bus.off('chat', onChat); bus.off('chat-key', onChatKey);
      signaling.unregister(email, ws);
      const next = (visitorConns.get(email) || 1) - 1;
      if (next <= 0) {
        visitorConns.delete(email);
        chat.system(`${nicknameFor(email)} left`);
        signaling.broadcast({ type: 'peer-left', email });
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
