const { EventEmitter } = require('events');

// Single in-process pubsub. WebSocket servers subscribe and rebroadcast to clients.
const bus = new EventEmitter();
bus.setMaxListeners(50);

// Convenience publishers — keep payload shapes consistent.
function emitState(state) { bus.emit('state', state); }
function emitChat(message) { bus.emit('chat', message); }
function emitSystem(payload) { bus.emit('system', payload); }

module.exports = { bus, emitState, emitChat, emitSystem };
