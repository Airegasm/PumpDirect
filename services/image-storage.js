/**
 * Image Storage Service
 * Handles saving images to disk instead of embedding base64 in JSON
 *
 * Folder structure:
 * backend/data/
 * ├── personas/
 * │   ├── default/{id}/persona.json + img/
 * │   └── custom/{id}/persona.json + img/
 * ├── chars/
 * │   ├── default/{id}/char.json + img/
 * │   └── custom/{id}/char.json + img/
 */

const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * Check if a string is a base64 data URI
 */
function isBase64DataUri(str) {
  return str && typeof str === 'string' && str.startsWith('data:image/');
}

/**
 * Check if a string is an image path (not base64)
 */
function isImagePath(str) {
  return str && typeof str === 'string' && str.startsWith('/api/images/');
}

/**
 * Extract image format and data from base64 data URI
 */
function parseBase64DataUri(dataUri) {
  const match = dataUri.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!match) return null;
  return {
    format: match[1] === 'jpeg' ? 'jpg' : match[1],
    data: match[2]
  };
}

/**
 * Ensure directory exists
 */
async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * Get persona directory path
 */
function getPersonaDir(personaId, isDefault = false) {
  const folder = isDefault ? 'default' : 'custom';
  return path.join(DATA_DIR, 'personas', folder, personaId);
}

/**
 * Get character directory path
 */
function getCharacterDir(charId, isDefault = false) {
  const folder = isDefault ? 'default' : 'custom';
  return path.join(DATA_DIR, 'chars', folder, charId);
}

/**
 * Save a base64 image to disk for a persona
 * @param {string} personaId - The persona ID
 * @param {string} base64Data - The base64 data URI
 * @param {string} imageType - 'avatar' or 'staged-{index}'
 * @param {boolean} isDefault - Whether this is a default persona
 * @returns {string} The relative URL path to the image
 */
async function savePersonaImage(personaId, base64Data, imageType = 'avatar', isDefault = false) {
  if (!isBase64DataUri(base64Data)) {
    return base64Data;
  }

  const parsed = parseBase64DataUri(base64Data);
  if (!parsed) {
    console.error('Failed to parse base64 data URI for persona image');
    return base64Data;
  }

  const personaDir = getPersonaDir(personaId, isDefault);
  const imgDir = path.join(personaDir, 'img');
  await ensureDir(imgDir);

  const filename = `${imageType}.${parsed.format}`;
  const filePath = path.join(imgDir, filename);

  const buffer = Buffer.from(parsed.data, 'base64');
  await fs.writeFile(filePath, buffer);

  const folder = isDefault ? 'default' : 'custom';
  return `/api/images/personas/${folder}/${personaId}/${filename}`;
}

/**
 * Save a base64 image to disk for a character
 * @param {string} charId - The character ID
 * @param {string} base64Data - The base64 data URI
 * @param {string} imageType - 'avatar' or other type
 * @param {boolean} isDefault - Whether this is a default character
 * @returns {string} The relative URL path to the image
 */
async function saveCharacterImage(charId, base64Data, imageType = 'avatar', isDefault = false) {
  if (!isBase64DataUri(base64Data)) {
    return base64Data;
  }

  const parsed = parseBase64DataUri(base64Data);
  if (!parsed) {
    console.error('Failed to parse base64 data URI for character image');
    return base64Data;
  }

  const charDir = getCharacterDir(charId, isDefault);
  const imgDir = path.join(charDir, 'img');
  await ensureDir(imgDir);

  const filename = `${imageType}.${parsed.format}`;
  const filePath = path.join(imgDir, filename);

  const buffer = Buffer.from(parsed.data, 'base64');
  await fs.writeFile(filePath, buffer);

  const folder = isDefault ? 'default' : 'custom';
  return `/api/images/chars/${folder}/${charId}/${filename}`;
}

/**
 * Delete persona directory (including images)
 */
async function deletePersonaDir(personaId, isDefault = false) {
  const personaDir = getPersonaDir(personaId, isDefault);
  try {
    await fs.rm(personaDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to delete persona dir for ${personaId}:`, err);
  }
}

/**
 * Delete character directory (including images)
 */
async function deleteCharacterDir(charId, isDefault = false) {
  const charDir = getCharacterDir(charId, isDefault);
  try {
    await fs.rm(charDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`Failed to delete character dir for ${charId}:`, err);
  }
}

/**
 * Process persona data and save any embedded images
 * @param {Object} persona - The persona object
 * @param {boolean} isDefault - Whether this is a default persona
 * @returns {Object} Persona with image paths instead of base64
 */
async function processPersonaImages(persona, isDefault = false) {
  if (!persona || !persona.id) return persona;

  const processed = { ...persona };

  // Process avatar
  if (processed.avatar && isBase64DataUri(processed.avatar)) {
    processed.avatar = await savePersonaImage(persona.id, processed.avatar, 'avatar', isDefault);
  }

  // Process staged portraits
  if (processed.stagedPortraits && Array.isArray(processed.stagedPortraits)) {
    processed.stagedPortraits = await Promise.all(
      processed.stagedPortraits.map(async (portrait, index) => {
        if (portrait && isBase64DataUri(portrait)) {
          return await savePersonaImage(persona.id, portrait, `staged-${index}`, isDefault);
        }
        return portrait;
      })
    );
  }

  return processed;
}

/**
 * Process character data and save any embedded images
 * @param {Object} character - The character object
 * @param {boolean} isDefault - Whether this is a default character
 * @returns {Object} Character with image paths instead of base64
 */
async function processCharacterImages(character, isDefault = false) {
  if (!character || !character.id) return character;

  const processed = { ...character };

  // Process avatar
  if (processed.avatar && isBase64DataUri(processed.avatar)) {
    processed.avatar = await saveCharacterImage(character.id, processed.avatar, 'avatar', isDefault);
  }

  return processed;
}

/**
 * Save persona JSON to its own directory
 */
async function savePersonaJson(persona, isDefault = false) {
  const personaDir = getPersonaDir(persona.id, isDefault);
  await ensureDir(personaDir);
  const filePath = path.join(personaDir, 'persona.json');
  await fs.writeFile(filePath, JSON.stringify(persona, null, 2));
}

/**
 * Save character JSON to its own directory
 */
async function saveCharacterJson(character, isDefault = false) {
  const charDir = getCharacterDir(character.id, isDefault);
  await ensureDir(charDir);
  const filePath = path.join(charDir, 'char.json');
  await fs.writeFile(filePath, JSON.stringify(character, null, 2));
}

/**
 * Load persona from its directory
 */
async function loadPersonaJson(personaId, isDefault = false) {
  const personaDir = getPersonaDir(personaId, isDefault);
  const filePath = path.join(personaDir, 'persona.json');
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
}

/**
 * Load character from its directory
 */
async function loadCharacterJson(charId, isDefault = false) {
  const charDir = getCharacterDir(charId, isDefault);
  const filePath = path.join(charDir, 'char.json');
  try {
    const data = await fs.readFile(filePath, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    return null;
  }
}

/**
 * List all personas (both default and custom)
 */
async function listAllPersonas() {
  const personas = [];

  // Load default personas
  const defaultDir = path.join(DATA_DIR, 'personas', 'default');
  try {
    const defaultIds = await fs.readdir(defaultDir);
    for (const id of defaultIds) {
      const persona = await loadPersonaJson(id, true);
      if (persona) {
        persona._isDefault = true;
        personas.push(persona);
      }
    }
  } catch (err) {
    // Directory may not exist yet
  }

  // Load custom personas
  const customDir = path.join(DATA_DIR, 'personas', 'custom');
  try {
    const customIds = await fs.readdir(customDir);
    for (const id of customIds) {
      const persona = await loadPersonaJson(id, false);
      if (persona) {
        persona._isDefault = false;
        personas.push(persona);
      }
    }
  } catch (err) {
    // Directory may not exist yet
  }

  return personas;
}

/**
 * List all characters (both default and custom)
 */
async function listAllCharacters() {
  const characters = [];

  // Load default characters
  const defaultDir = path.join(DATA_DIR, 'chars', 'default');
  try {
    const defaultIds = await fs.readdir(defaultDir);
    for (const id of defaultIds) {
      const char = await loadCharacterJson(id, true);
      if (char) {
        char._isDefault = true;
        characters.push(char);
      }
    }
  } catch (err) {
    // Directory may not exist yet
  }

  // Load custom characters
  const customDir = path.join(DATA_DIR, 'chars', 'custom');
  try {
    const customIds = await fs.readdir(customDir);
    for (const id of customIds) {
      const char = await loadCharacterJson(id, false);
      if (char) {
        char._isDefault = false;
        characters.push(char);
      }
    }
  } catch (err) {
    // Directory may not exist yet
  }

  return characters;
}

/**
 * Get the file system path for serving an image
 */
function getImageFilePath(type, folder, id, filename) {
  if (type === 'personas') {
    return path.join(DATA_DIR, 'personas', folder, id, 'img', filename);
  } else if (type === 'chars') {
    return path.join(DATA_DIR, 'chars', folder, id, 'img', filename);
  }
  return null;
}

/**
 * Check if a persona exists in either default or custom
 */
async function findPersonaLocation(personaId) {
  // Check custom first
  const customPath = path.join(getPersonaDir(personaId, false), 'persona.json');
  try {
    await fs.access(customPath);
    return { exists: true, isDefault: false };
  } catch {}

  // Check default
  const defaultPath = path.join(getPersonaDir(personaId, true), 'persona.json');
  try {
    await fs.access(defaultPath);
    return { exists: true, isDefault: true };
  } catch {}

  return { exists: false, isDefault: false };
}

/**
 * Check if a character exists in either default or custom
 */
async function findCharacterLocation(charId) {
  // Check custom first
  const customPath = path.join(getCharacterDir(charId, false), 'char.json');
  try {
    await fs.access(customPath);
    return { exists: true, isDefault: false };
  } catch {}

  // Check default
  const defaultPath = path.join(getCharacterDir(charId, true), 'char.json');
  try {
    await fs.access(defaultPath);
    return { exists: true, isDefault: true };
  } catch {}

  return { exists: false, isDefault: false };
}

module.exports = {
  isBase64DataUri,
  isImagePath,
  savePersonaImage,
  saveCharacterImage,
  deletePersonaDir,
  deleteCharacterDir,
  processPersonaImages,
  processCharacterImages,
  savePersonaJson,
  saveCharacterJson,
  loadPersonaJson,
  loadCharacterJson,
  listAllPersonas,
  listAllCharacters,
  getImageFilePath,
  getPersonaDir,
  getCharacterDir,
  findPersonaLocation,
  findCharacterLocation,
  ensureDir,
  DATA_DIR
};
