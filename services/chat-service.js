const crypto = require('crypto');
const { randomUUID } = crypto;
const { emitChat, bus } = require('./event-bus');

const MAX_HISTORY = 200;
let messages = [];

// AES-256-GCM session key. Regenerated on each session start so chat ciphertext
// from a previous session is undecryptable by participants in a new one.
let sessionKey = crypto.randomBytes(32);

function rotateKey() {
  sessionKey = crypto.randomBytes(32);
  bus.emit('chat-key', sessionKey.toString('base64'));
}
function getKeyBase64() { return sessionKey.toString('base64'); }

function encryptText(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', sessionKey, iv);
  const ct = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Wire format: iv (12) || tag (16) || ciphertext
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

function snapshot() {
  return messages.slice();
}

function reset() {
  messages = [];
}

function push({ fromEmail, fromNickname, text, type = 'user', image = null, encrypted = null }) {
  const msg = {
    id: randomUUID(),
    ts: Date.now(),
    type,
    fromEmail: fromEmail || null,
    fromNickname: fromNickname || (type === 'system' ? 'system' : 'unknown'),
  };
  // Client-supplied ciphertext (visitor) takes precedence. Otherwise server
  // encrypts the plaintext it has (owner posts via loopback / system messages).
  if (encrypted && typeof encrypted === 'string') {
    msg.encrypted = encrypted.slice(0, 4000);
  } else if (text) {
    msg.encrypted = encryptText(String(text).slice(0, 2000));
  }
  if (image && typeof image.encrypted === 'string') {
    // Client-supplied ciphertext (visitor-side image, future).
    msg.image = { encrypted: image.encrypted.slice(0, 2_500_000) };
    msg.type = 'image';
  } else if (image && typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/')) {
    // Server-side: owner posted plaintext data URL over loopback; encrypt before broadcast.
    msg.image = { encrypted: encryptText(image.dataUrl.slice(0, 1_500_000)) };
    msg.type = 'image';
  }
  messages.push(msg);
  if (messages.length > MAX_HISTORY) messages = messages.slice(-MAX_HISTORY);
  emitChat(msg);
  return msg;
}

function system(text) {
  return push({ type: 'system', text, fromNickname: 'system' });
}

module.exports = { snapshot, reset, push, system, rotateKey, getKeyBase64 };
