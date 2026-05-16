const express = require('express');
const config = require('../config');
const { TOS_VERSION, renderTosPage } = require('../views/tos');
const updateCheck = require('../services/update-check');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Tos');
const router = express.Router();

router.get('/tos', async (_req, res) => {
  let updateInfo = null;
  try { updateInfo = await updateCheck.checkForUpdates(); } catch (e) { logger.error('update check failed', e.message); }
  res.type('html').send(renderTosPage({ updateInfo }));
});

router.post('/api/owner/tos/accept', (req, res) => {
  try {
    const v = parseInt(req.body?.version, 10);
    if (v !== TOS_VERSION) return res.status(400).json({ error: 'TOS version mismatch — refresh the page and try again' });
    config.save({ owner: { tosAcceptedVersion: TOS_VERSION } });
    res.json({ ok: true, version: TOS_VERSION });
  } catch (e) {
    logger.error('TOS accept failed to save', e.message);
    res.status(500).json({ error: 'Could not save — PumpDirect cannot write config.json (' + e.message + '). Move the PumpDirect folder somewhere writable (not Program Files or a read-only location) and restart.' });
  }
});

router.get('/api/owner/update-check', async (_req, res) => {
  try {
    const info = await updateCheck.checkForUpdates();
    res.json({ ok: true, info });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/owner/update-check/refresh', async (_req, res) => {
  updateCheck.invalidate();
  try {
    const info = await updateCheck.checkForUpdates();
    res.json({ ok: true, info });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
