const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { createLogger } = require('./utils/logger');
const { ownerLayout, escape } = require('./views/layout');
const config = require('./config');
const { bus } = require('./services/event-bus');
const chat = require('./services/chat-service');
const session = require('./services/session-service');
const signaling = require('./services/signaling-service');

const logger = createLogger('Owner');

function pill(state, label) {
  const cls = state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : 'warn';
  return `<span class="pill ${cls}">${escape(label)}</span>`;
}

function start() {
  const app = express();
  const PORT = parseInt(process.env.OWNER_PORT || '3001', 10);
  const HOST = '127.0.0.1';

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    const peer = req.socket.remoteAddress || '';
    if (peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1') return next();
    res.status(403).type('text').send('owner GUI is loopback-only');
  });

  app.use(require('./routes/launchpad'));
  app.use(require('./routes/chat-webcam'));
  app.use(require('./routes/templates'));
  app.use(require('./routes/network'));
  app.use(require('./routes/users'));
  app.use(require('./routes/devices'));

  const server = http.createServer(app);
  const wss = new WebSocket.Server({ server, path: '/ws/owner' });

  function enrichState() {
    const cfg = config.load();
    return { ...session.getState(), ownerCamera: cfg.owner?.camera || {} };
  }

  wss.on('connection', (ws, req) => {
    const peer = req.socket.remoteAddress || '';
    if (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') {
      ws.close(1008, 'loopback only');
      return;
    }
    const cfg = config.load();
    const ownerEmail = cfg.cloudflare?.ownerEmail || 'owner@local';

    const sendRaw = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };
    const send = (type, payload) => sendRaw({ type, ...payload });

    const reg = signaling.registerOwner(ownerEmail, ws, sendRaw);
    if (!reg.ok) { ws.close(1008, reg.reason); return; }

    send('hello', { email: ownerEmail, isOwner: true, peers: signaling.allPeers(ownerEmail) });
    send('state', { state: enrichState() });
    send('chat-history', { messages: chat.snapshot() });
    signaling.broadcast({ type: 'peer-joined', email: ownerEmail, isOwner: true }, ownerEmail);

    const onState = () => send('state', { state: enrichState() });
    const onChat = (message) => send('chat', { message });
    bus.on('state', onState);
    bus.on('chat', onChat);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg && (msg.type === 'webrtc-offer' || msg.type === 'webrtc-answer' || msg.type === 'webrtc-ice')) {
        if (!msg.toEmail) return;
        signaling.deliver(msg.toEmail, { ...msg, fromEmail: ownerEmail });
      } else if (msg && msg.type === 'broadcast-state') {
        signaling.broadcast({ type: 'broadcast-state', email: ownerEmail, broadcasting: !!msg.broadcasting }, ownerEmail);
      }
    });

    ws.on('close', () => {
      bus.off('state', onState);
      bus.off('chat', onChat);
      signaling.unregister(ownerEmail, ws);
      signaling.broadcast({ type: 'peer-left', email: ownerEmail });
    });
    ws.on('error', () => {});
  });

  server.listen(PORT, HOST, () => {
    logger.info(`owner server on http://${HOST}:${PORT} (loopback only) + ws on /ws/owner`);
  });
}

module.exports = { start };
