// Tiny WebRTC signaling relay. Lives in-process across owner + public servers.
const { createLogger } = require('../utils/logger');
const { bus } = require('./event-bus');
const logger = createLogger('Signaling');

const conns = new Map(); // email -> Set<{ ws, role, send }>
const presence = new Map(); // email -> 'connected' | 'afk' (absent = not in session)
const VISITOR_CAP = 5;

function _notifyPresence() {
  // Lazy-require to avoid a load-order tangle on first boot.
  const session = require('./session-service');
  bus.emit('state', session.getState());
}
function setPresence(email, status) {
  if (presence.get(email) === status) return;
  presence.set(email, status);
  _notifyPresence();
}
function clearPresence(email) {
  if (!presence.has(email)) return;
  presence.delete(email);
  _notifyPresence();
}
function getPresenceMap() { return presence; }

function registerOwner(email, ws, send) {
  return _register(email, ws, send, 'owner');
}
function registerVisitor(email, ws, send) {
  const distinct = visitorEmails();
  if (!distinct.includes(email) && distinct.length >= VISITOR_CAP) {
    return { ok: false, reason: `visitor cap reached (${VISITOR_CAP})` };
  }
  return _register(email, ws, send, 'visitor');
}
function _register(email, ws, send, role) {
  if (!conns.has(email)) conns.set(email, new Set());
  const entry = { ws, send, role };
  conns.get(email).add(entry);
  return { ok: true, entry };
}
function unregister(email, ws) {
  const set = conns.get(email);
  if (!set) return;
  for (const e of set) if (e.ws === ws) set.delete(e);
  if (set.size === 0) conns.delete(email);
}
function visitorEmails() {
  const out = [];
  for (const [email, set] of conns) {
    for (const e of set) if (e.role === 'visitor') { out.push(email); break; }
  }
  return out;
}
function allPeers(ownerEmail) {
  const out = [];
  for (const [email, set] of conns) {
    const isOwner = email === ownerEmail;
    out.push({ email, isOwner });
  }
  return out;
}
function deliver(toEmail, payload) {
  const set = conns.get(toEmail);
  if (!set) return false;
  let any = false;
  for (const e of set) {
    try { e.send(payload); any = true; } catch {}
  }
  return any;
}
function broadcast(payload, excludeEmail = null) {
  for (const [email, set] of conns) {
    if (email === excludeEmail) continue;
    for (const e of set) {
      try { e.send(payload); } catch {}
    }
  }
}

module.exports = { registerOwner, registerVisitor, unregister, deliver, broadcast, allPeers, visitorEmails, setPresence, clearPresence, getPresenceMap, VISITOR_CAP };
