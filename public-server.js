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
const { verifyAccessJwt } = require('./utils/cf-access-jwt');

const logger = createLogger('Public');

// Host's own PumpDirect version — used as the compatibility baseline for
// Dual-Target pairings. Major-version mismatch on the target's satellite
// rejects the handshake (different step-shape risks unsafe execution).
let HOST_PKG_VERSION = '0.0.0';
try {
  HOST_PKG_VERSION = require('./package.json').version || '0.0.0';
} catch {}
function _majorOf(v) { return String(v || '').split('.')[0] || '0'; }

let httpServer = null;
let wss = null;
let lastJwtUnconfiguredWarn = 0;

function _warnJwtUnconfigured(extra = '') {
  const now = Date.now();
  if (now - lastJwtUnconfiguredWarn < 60_000) return;
  lastJwtUnconfiguredWarn = now;
  logger.warn(
    `Cloudflare Access JWT verification is NOT enabled — trusting Cf-Access-Authenticated-User-Email header alone.` +
    ` Configure cloudflare.teamDomain and cloudflare.accessAud (Network tab → step 6) to enable strict verification.` +
    (extra ? ' ' + extra : '')
  );
}

async function verifyRequest(jwt, email) {
  const cfg = config.load();
  const { teamDomain, accessAud } = cfg.cloudflare || {};
  if (!teamDomain || !accessAud) {
    // Hard fail. The previous behaviour was to trust the raw email header,
    // which means anything that reaches loopback (a misconfigured tunnel, a
    // co-resident process) could spoof any visitor. Setting up CF Access JWT
    // verification is one click in the Network → Access policy wizard.
    _warnJwtUnconfigured('Refusing the request until configured. Set cloudflare.teamDomain + cloudflare.accessAud.');
    return { ok: false, reason: 'Cloudflare Access JWT verification not configured on this host' };
  }
  try {
    const payload = await verifyAccessJwt(jwt, { teamDomain, audTag: accessAud });
    const jwtEmail = (payload.email || payload.identity?.email || '').toLowerCase();
    if (email && jwtEmail && jwtEmail !== email.toLowerCase()) {
      return { ok: false, reason: 'header/jwt email mismatch' };
    }
    return { ok: true, mode: 'jwt-verified', email: jwtEmail || email, payload };
  } catch (e) {
    return { ok: false, reason: `jwt invalid: ${e.message}` };
  }
}

function start() {
  const app = express();
  const PORT = parseInt(process.env.PUBLIC_PORT || process.env.PORT || '3000', 10);
  const HOST = process.env.PUBLIC_HOST || '127.0.0.1';
  const AUTH_HEADER = process.env.AUTH_HEADER || 'Cf-Access-Authenticated-User-Email';
  const JWT_HEADER = 'cf-access-jwt-assertion';
  const TRUST_PROXY = process.env.TRUST_PROXY || 'loopback';

  app.set('trust proxy', TRUST_PROXY);

  // Tight CORS: only the configured public hostname, no credentials.
  app.use(cors({
    origin(origin, cb) {
      if (!origin) return cb(null, false);  // same-origin/no-origin allowed via no CORS headers
      const cfg = config.load();
      const allowed = cfg.cloudflare?.hostname ? `https://${cfg.cloudflare.hostname}` : null;
      cb(null, !!(allowed && origin === allowed));
    },
    credentials: false,
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 240, standardHeaders: true, legacyHeaders: false }));

  // Per-route stricter limiter for the dangerous mutation paths. Anything
  // that fires a pump action (or could be used to dodge one) goes here so a
  // single visitor can't hammer the device or saturate the action engine.
  const sensitiveLimiter = rateLimit({ windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false });
  for (const path of [
    '/api/visitor/fire-action',
    '/api/visitor/pump-on',
    '/api/visitor/pump-off',
    '/api/visitor/timed',
    '/api/visitor/cycle',
    '/api/visitor/minigame',     // matches /minigame/*
    '/api/visitor/pass-control',
    '/api/visitor/accept-start',
  ]) app.use(path, sensitiveLimiter);
  app.use('/api/visitor/chat', rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false }));

  // Auth middleware. Two layers: (1) header email gives identity,
  // (2) JWT verification (when configured) proves it came from Cloudflare.
  app.use(async (req, res, next) => {
    if (req.path === '/healthz') return next();
    const email = req.header(AUTH_HEADER);
    const jwt = req.headers[JWT_HEADER];
    if (!email) { req.user = null; return next(); }

    const verdict = await verifyRequest(jwt, email);
    if (!verdict.ok) {
      logger.warn(`auth rejected for ${email}: ${verdict.reason}`);
      return res.status(401).json({ error: 'authentication failed' });
    }
    req.user = { email: verdict.email, authMode: verdict.mode };
    next();
  });

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', (_req, res) => {
    const cfg = config.load();
    const ready = !!cfg.setupComplete;
    res.status(ready ? 200 : 503).json({ ok: ready, setupComplete: ready });
  });

  app.use((req, res, next) => {
    if (req.path === '/healthz' || req.path === '/readyz') return next();
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

  httpServer = http.createServer(app);
  wss = new WebSocket.Server({ noServer: true });

  httpServer.on('upgrade', async (req, socket, head) => {
    if (req.url !== '/ws/visitor') { socket.destroy(); return; }
    const email = req.headers[AUTH_HEADER.toLowerCase()];
    const jwt = req.headers[JWT_HEADER];
    if (!email) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    const cfg = config.load();
    if (!cfg.setupComplete) { socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); return; }

    const verdict = await verifyRequest(jwt, String(email));
    if (!verdict.ok) {
      logger.warn(`ws auth rejected for ${email}: ${verdict.reason}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
    }

    const emailNorm = String(verdict.email).toLowerCase();
    const ownerEmail = (cfg.cloudflare?.ownerEmail || '').toLowerCase();
    if (emailNorm === ownerEmail) {
      // The owner GUI lives on a different (loopback) server. A visitor must
      // never register on the public WS as the owner — that would let them
      // intercept signaling targeted at the real owner browser.
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }
    const accounts = (cfg.accounts || []).map(a => (a.email || '').toLowerCase()).filter(Boolean);
    if (!accounts.includes(emailNorm)) {
      logger.warn(`ws rejected: ${emailNorm} not in allowlist`);
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userEmail = emailNorm;
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
    // Dual-target sessions reserve both cam slots for host + target —
    // no guest cam broadcasts in mutual mode.
    if (s.mode === 'dual-target') return false;
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
        // Restrict signaling delivery to known peers — the owner or other
        // visitors currently registered for this session — never arbitrary
        // emails. Defense in depth on top of the broadcast-permission check.
        const toLower = String(msg.toEmail).toLowerCase();
        const knownPeers = signaling.allPeers(ownerEmail).map(p => p.email.toLowerCase());
        if (!knownPeers.includes(toLower)) {
          logger.warn(`dropped ${msg.type} from ${email}: target ${msg.toEmail} not a known peer`);
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
      } else if (msg && msg.type === 'target-state-update') {
        // Only the active target's relay is honored. Anything else is dropped
        // (prevents a non-paired visitor from spoofing target state).
        const s = session.getState();
        if (!s.active || s.mode !== 'dual-target') return;
        const pair = session.getActiveTargetPair();
        if (!pair || pair.email !== email) return;
        if (msg.snapshot && typeof msg.snapshot === 'object') {
          session.setTargetState(msg.snapshot);
        }
      } else if (msg && msg.type === 'satellite-claim') {
        // Dual-Target handshake response from the paired visitor. Translates
        // their satellite probe result into a canTarget state flip.
        const s = session.getState();
        if (!s.active || s.mode !== 'dual-target') {
          logger.warn(`satellite-claim from ${email} ignored — session not active or not dual-target`);
          return;
        }
        const p = (s.participants || []).find(x => x.email === email);
        if (!p || p.canTarget !== 'pending') {
          logger.warn(`satellite-claim from ${email} ignored — not in pending T state`);
          return;
        }
        if (msg.ok && msg.token) {
          // Version compatibility — reject if major version differs.
          if (_majorOf(msg.version) !== _majorOf(HOST_PKG_VERSION)) {
            try { session.setParticipantTarget(email, false); } catch {}
            logger.warn(`satellite-claim rejected: ${email} runs PumpDirect v${msg.version || '?'} but host is v${HOST_PKG_VERSION} (major mismatch)`);
            return;
          }
          try {
            session.setParticipantTarget(email, true, String(msg.deviceLabel || ''));
            session.setParticipantTargetToken(email, String(msg.token));
            logger.info(`satellite-claim accepted: ${email} now T (device: ${msg.deviceLabel || '?'}, version: ${msg.version || '?'})`);
            // Push the host's action template library to the newly-paired
            // target so their browser can render the shared button grid.
            try {
              const templates = require('./services/templates-service');
              const templateSvc = require('./services/templates-service');
              const profile = session.getProfile(s.sessionProfileId);
              const tplProfile = profile?.templateProfileId
                ? templateSvc.load().templateProfiles.find(t => t.id === profile.templateProfileId)
                : null;
              send('template-snapshot', {
                templates: templateSvc.listActions(),
                templateProfile: tplProfile || null,
                profileMode: profile?.mode || 'single-target',
              });
            } catch (e) { logger.warn('template-snapshot push failed: ' + e.message); }
          } catch (e) { logger.warn(`satellite-claim accept failed: ${e.message}`); }
        } else {
          try {
            session.setParticipantTarget(email, false);
            logger.info(`satellite-claim rejected: ${email} (${msg.reason || 'no reason'}) — demoted to standard guest`);
          } catch (e) { logger.warn(`satellite-claim reject failed: ${e.message}`); }
        }
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
          // Dual-Target: if this email was the active T, free the slot so
          // the host can re-assign. Their pairing token also gets wiped.
          try {
            const s = session.getState();
            if (s.active && s.mode === 'dual-target') {
              const pair = session.getActiveTargetPair();
              if (pair && pair.email === email) {
                session.setParticipantTarget(email, false);
                logger.info(`dual-target slot released — ${email} disconnected past rejoin grace`);
              }
            }
          } catch (e) { logger.warn('target cleanup on disconnect failed: ' + e.message); }
        }, REJOIN_GRACE_MS);
        pendingLeave.set(email, { timer, nickname: nick });
      } else {
        visitorConns.set(email, next);
      }
    });
    ws.on('error', (err) => { logger.warn('visitor ws error', err.message); });
  });

  httpServer.listen(PORT, HOST, () => {
    logger.info(`public server on ${HOST}:${PORT} (auth header: ${AUTH_HEADER}) + ws on /ws/visitor`);
    const cfg = config.load();
    if (!cfg.cloudflare?.teamDomain || !cfg.cloudflare?.accessAud) _warnJwtUnconfigured('Run setup or update step 6 to enable.');
  });
}

async function shutdown() {
  if (!httpServer) return;
  logger.always('public server shutting down');
  return new Promise(resolve => {
    try { wss?.clients.forEach(ws => { try { ws.close(1001, 'shutdown'); } catch {} }); } catch {}
    httpServer.close(() => resolve());
    setTimeout(() => resolve(), 1500);
  });
}

module.exports = { start, shutdown };
