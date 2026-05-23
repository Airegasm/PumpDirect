// Read a JSON file, seeding it if it doesn't exist yet. Critically, we only
// treat ENOENT as "missing - use seed". Any other error (EIO, EACCES, EPERM,
// JSON parse failure, etc.) is rethrown - the previous blanket `try/catch`
// at every load site would treat ALL errors as missing-file and the next
// save() would happily overwrite real user data with defaults.

const fs = require('fs');

function loadJsonOrSeed(filePath, seed, opts = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      // File doesn't exist yet — seed.
      if (opts.onSeed) opts.onSeed();
      return JSON.parse(JSON.stringify(seed));
    }
    // Any other read error means we'd be guessing — refuse rather than wipe.
    throw new Error(`load ${filePath} failed: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`parse ${filePath} failed (file exists but is malformed): ${e.message}`);
  }
}

module.exports = { loadJsonOrSeed };
