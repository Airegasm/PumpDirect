const { randomUUID } = require('crypto');
const { emitChat } = require('./event-bus');

const MAX_HISTORY = 200;
let messages = [];

function snapshot() {
  return messages.slice();
}

function reset() {
  messages = [];
}

function push({ fromEmail, fromNickname, text, type = 'user', image = null }) {
  const msg = {
    id: randomUUID(),
    ts: Date.now(),
    type,
    fromEmail: fromEmail || null,
    fromNickname: fromNickname || (type === 'system' ? 'system' : 'unknown'),
    text: String(text || '').slice(0, 2000),
  };
  if (image && typeof image.dataUrl === 'string' && image.dataUrl.startsWith('data:image/')) {
    msg.image = { dataUrl: image.dataUrl.slice(0, 1_500_000) };  // cap ~1.5MB base64
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

module.exports = { snapshot, reset, push, system };
