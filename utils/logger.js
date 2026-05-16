const { EventEmitter } = require('events');

const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3, TRACE: 4 };
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

const MAX_BUFFER = 1000;
const ringBuffer = [];
const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(50);

function formatArg(a) {
  if (a == null) return String(a);
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

function record(level, prefix, args) {
  const entry = {
    ts: Date.now(),
    level,
    prefix,
    msg: args.map(formatArg).join(' '),
  };
  ringBuffer.push(entry);
  if (ringBuffer.length > MAX_BUFFER) ringBuffer.shift();
  try { logEmitter.emit('log', entry); } catch {}
  return entry;
}

function createLogger(prefix) {
  const fmt = (level, args) => {
    const entry = record(level, prefix, args);
    const stamp = new Date(entry.ts).toISOString();
    return [`[${stamp}] [${prefix}]`, ...args];
  };
  return {
    error: (...args) => { if (LOG_LEVELS.ERROR <= currentLevel) console.error(...fmt('ERROR', args)); },
    warn:  (...args) => { if (LOG_LEVELS.WARN  <= currentLevel) console.warn (...fmt('WARN',  args)); },
    info:  (...args) => { if (LOG_LEVELS.INFO  <= currentLevel) console.log  (...fmt('INFO',  args)); },
    debug: (...args) => { if (LOG_LEVELS.DEBUG <= currentLevel) console.log  (...fmt('DEBUG', args)); },
    trace: (...args) => { if (LOG_LEVELS.TRACE <= currentLevel) console.log  (...fmt('TRACE', args)); },
    always:(...args) => { console.log(...fmt('ALWAYS', args)); },
  };
}

function snapshot(limit = MAX_BUFFER, levels = null) {
  const all = levels ? ringBuffer.filter(e => levels.has(e.level)) : ringBuffer;
  return all.slice(-limit);
}

function subscribe(handler) {
  logEmitter.on('log', handler);
  return () => logEmitter.off('log', handler);
}

function recordExternal(level, prefix, message) {
  return record(level, prefix, [message]);
}

module.exports = {
  LOG_LEVELS,
  createLogger,
  snapshot,
  subscribe,
  recordExternal,
  MAX_BUFFER,
};
