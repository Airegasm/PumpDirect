const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createLogger } = require('../utils/logger');

const logger = createLogger('Update');
const execFileP = promisify(execFile);
const PROJECT_DIR = path.resolve(__dirname, '..');
const CACHE_TTL_MS = 60 * 60 * 1000;

let cache = null;
let cacheTime = 0;

async function checkForUpdates() {
  const now = Date.now();
  if (cache && (now - cacheTime) < CACHE_TTL_MS) return cache;

  const result = { isGitRepo: false, currentSha: null, behind: 0, branch: null, error: null };
  try {
    if (!fs.existsSync(path.join(PROJECT_DIR, '.git'))) {
      result.error = 'not a git checkout';
      cache = result; cacheTime = now;
      return result;
    }
    result.isGitRepo = true;
    const sha = (await execFileP('git', ['-C', PROJECT_DIR, 'rev-parse', 'HEAD'])).stdout.trim();
    result.currentSha = sha.slice(0, 7);
    try {
      result.branch = (await execFileP('git', ['-C', PROJECT_DIR, 'rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    } catch {}
    try {
      await execFileP('git', ['-C', PROJECT_DIR, 'fetch', '--quiet'], { timeout: 12000 });
      const cnt = (await execFileP('git', ['-C', PROJECT_DIR, 'rev-list', '--count', 'HEAD..@{u}'])).stdout.trim();
      result.behind = parseInt(cnt, 10) || 0;
    } catch (e) {
      result.error = ('fetch: ' + (e.message || 'unknown')).slice(0, 120);
    }
  } catch (e) {
    result.error = e.message;
  }
  cache = result; cacheTime = now;
  return result;
}

function invalidate() { cache = null; cacheTime = 0; }

module.exports = { checkForUpdates, invalidate };
