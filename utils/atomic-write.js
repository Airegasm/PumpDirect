const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const locks = new Map();

function withLock(file, fn) {
  const prev = locks.get(file) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(file, next.finally(() => { if (locks.get(file) === next) locks.delete(file); }));
  return next;
}

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
    return;
  }
  try { fs.chmodSync(dir, DIR_MODE); } catch {}
}

function writeAtomicSync(file, data) {
  ensureDirSync(path.dirname(file));
  const tmp = file + '.tmp-' + randomBytes(6).toString('hex');
  fs.writeFileSync(tmp, data, { mode: FILE_MODE });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, FILE_MODE); } catch {}
}

function repairModeSync(file) {
  try { fs.chmodSync(file, FILE_MODE); } catch {}
}

function repairTreeSync(dir) {
  try { fs.chmodSync(dir, DIR_MODE); } catch {}
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) repairTreeSync(full);
    else repairModeSync(full);
  }
}

module.exports = { withLock, ensureDirSync, writeAtomicSync, repairModeSync, repairTreeSync, FILE_MODE, DIR_MODE };
