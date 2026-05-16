// Entry point. Wires up the two HTTP servers, installs lifecycle handlers,
// and routes stray console.error/console.warn into the in-process log
// ring buffer so the System tab can surface them.

const path = require('path');
const { createLogger, recordExternal } = require('./utils/logger');
const { repairModeSync, repairTreeSync } = require('./utils/atomic-write');
const config = require('./config');

const logger = createLogger('Boot');

// ---- console capture --------------------------------------------------------
// Tuya and Govee services (and any future code) emit raw console.error/
// console.warn lines that bypass the logger. Intercept globally so the
// System tab sees them.
function _stringify(args) {
  return args.map(a => {
    if (a == null) return String(a);
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}
const _origError = console.error.bind(console);
const _origWarn  = console.warn.bind(console);
console.error = (...args) => { try { recordExternal('ERROR', 'console', _stringify(args)); } catch {} _origError(...args); };
console.warn  = (...args) => { try { recordExternal('WARN',  'console', _stringify(args)); } catch {} _origWarn (...args); };

// ---- repair file permissions on startup ------------------------------------
// Earlier versions wrote config.json + data/* with the process umask (usually
// 0644). Tighten them on every boot so a single deploy of this hardened build
// fixes existing installs.
try { repairModeSync(config.CONFIG_PATH); } catch {}
try { repairTreeSync(path.join(__dirname, 'data')); } catch {}

// ---- start servers ----------------------------------------------------------
const publicServer = require('./public-server');
const ownerServer = require('./owner-server');
const actionEngine = require('./services/action-engine');
const devices = require('./services/devices-service');
const control = require('./services/device-control');

publicServer.start();
ownerServer.start();

// ---- lifecycle --------------------------------------------------------------
let shuttingDown = false;
async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.always(`shutdown: ${reason}`);

  // Safety: kill the action engine and force-off the primary pump before exit.
  try { actionEngine.stopForSessionEnd(); } catch (e) { logger.error('stopForSessionEnd', e.message); }
  try {
    const primary = devices.primary();
    if (primary) await control.turnOff(primary).catch(e => logger.error('primary turnOff', e.message));
  } catch (e) { logger.error('primary lookup', e.message); }

  try { await publicServer.shutdown(); } catch {}
  try { await ownerServer.shutdown(); }  catch {}

  // Hard-stop in case some listener is wedged.
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  logger.error('unhandledRejection:', err?.stack || err?.message || err);
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException:', err?.stack || err?.message || err);
  // Don't exit on uncaught — the safety shutdown would force the pump off,
  // but losing the whole process on a recoverable error is worse than the
  // alternative (the action engine guards every command). Log loudly and
  // let the process keep serving.
});
