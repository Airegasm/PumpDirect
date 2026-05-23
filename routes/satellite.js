// Localhost-only satellite endpoints used in Dual-Target mode. When this
// PumpDirect instance is the Target for someone else's host session, these
// routes let the target's own browser bridge the host's commands to the
// target's local device. Strictly localhost — the router is mounted on
// the owner-server which is already 127.0.0.1-bound by default.
//
// Endpoints are also `Origin`-checked (defense in depth) so even if the
// owner-server ever gets accidentally exposed beyond loopback, nothing
// non-local can call them.

const express = require('express');
const path = require('path');
const fs = require('fs');
const satellite = require('../services/satellite-service');
const devices = require('../services/devices-service');
const control = require('../services/device-control');
const { createLogger } = require('../utils/logger');

const router = express.Router();
const logger = createLogger('SatelliteRoute');

let PKG_VERSION = '0.0.0';
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  PKG_VERSION = pkg.version || '0.0.0';
} catch {}

function _localOnly(req, res, next) {
  // Belt-and-braces: only accept requests from the host machine itself.
  // We REQUIRE an Origin header — a missing one is the curl/server-side-proxy
  // bypass case, which can't be a real browser request from localhost anyway.
  const origin = req.headers.origin || '';
  if (!origin) return res.status(403).json({ error: 'Origin header required' });
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return res.status(403).json({ error: 'satellite endpoints are localhost-only' });
  }
  next();
}
router.use('/api/satellite', _localOnly);

router.get('/api/satellite/status', (_req, res) => {
  const prim = devices.primary ? devices.primary() : null;
  const calibratedSeconds = prim?.calibration?.secondsTo100 || 0;
  const ready = !!(prim && calibratedSeconds > 0);
  res.json({
    ready,
    calibratedSeconds,
    deviceLabel: prim ? (prim.label || prim.id || 'pump') : null,
    version: PKG_VERSION,
    busy: satellite.getRunStatus().busy,
  });
});

router.post('/api/satellite/claim', (req, res) => {
  try {
    const body = req.body || {};
    const prim = devices.primary ? devices.primary() : null;
    if (!prim || !prim.calibration?.secondsTo100) {
      return res.status(409).json({ error: 'primary device not calibrated — cannot claim' });
    }
    const result = satellite.claim({
      hostUrl: body.hostUrl,
      hostEmail: body.hostEmail,
      sessionId: body.sessionId,
    });
    res.json({
      ok: true,
      token: result.token,
      expiresAt: result.expiresAt,
      deviceLabel: prim.label || prim.id || 'pump',
      version: PKG_VERSION,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/api/satellite/release', async (req, res) => {
  // Abort any in-flight chain (turns off the plug) THEN drop pairing.
  // Previously called into a dead local runState.abortCtl that was never
  // assigned, so release was a no-op for a running chain.
  try { await satellite.abortRun(); } catch (e) { logger.warn('release abortRun failed: ' + e.message); }
  satellite.release(req.body?.token);
  res.json({ ok: true });
});

// Server-Sent Events stream of satellite state for the paired visitor's
// browser to relay back to the host. Token via query string (EventSource
// doesn't support custom headers). Connection auto-closes if the token
// becomes invalid (e.g., release called or session ended on host side).
router.get('/api/satellite/state', (req, res) => {
  const token = req.query?.token;
  if (!satellite.validateToken(String(token || ''))) return res.status(401).json({ error: 'bad pairing token' });
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  // Initial snapshot so the host sees current state before the first
  // emit (e.g., if pairing already had a run in progress).
  res.write(`data: ${JSON.stringify(satellite.getRunStatus())}\n\n`);
  const unsub = satellite.subscribeState((snapshot) => {
    try { res.write(`data: ${JSON.stringify(snapshot)}\n\n`); } catch {}
  });
  // Keep-alive ping every 25s so reverse proxies don't bail.
  const keep = setInterval(() => { try { res.write(': keep-alive\n\n'); } catch {} }, 25_000);
  req.on('close', () => { unsub(); clearInterval(keep); });
});

// Run an inline action chain on this PumpDirect's primary device. The
// satellite step-runner pre-empts any prior run (one chain at a time) and
// ensures device-off when finished.
router.post('/api/satellite/run-action', async (req, res) => {
  const { token, steps, label } = req.body || {};
  if (!satellite.validateToken(token)) return res.status(401).json({ error: 'bad pairing token' });
  if (!Array.isArray(steps) || !steps.length) return res.status(400).json({ error: 'steps required' });
  // Fire and ack — chain runs async on the satellite. The host's chain
  // timing waits via its own state-relay logic (step 9).
  res.json({ ok: true, queued: true, label: label || null });
  satellite.runStepsOnPrimary(steps, label).catch(e => logger.warn('runStepsOnPrimary failed: ' + e.message));
});

// Target safety: abort any running chain immediately and ensure the device
// is off. Used by both the host (pump-off button targeting the T pump) and
// the target's own "Stop my pump" button (step 8 wires that UI).
router.post('/api/satellite/pump-off', async (req, res) => {
  const { token } = req.body || {};
  if (!satellite.validateToken(token)) return res.status(401).json({ error: 'bad pairing token' });
  // abortRun() now itself turns off the primary device, so we no longer need
  // the duplicate turnOff that used to follow.
  try { await satellite.abortRun(); } catch (e) { logger.error('pump-off abort failed: ' + e.message); }
  res.json({ ok: true });
});

module.exports = router;
