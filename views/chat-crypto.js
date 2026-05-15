// Browser-side AES-256-GCM helpers for E2EE chat. Wire format matches the
// server's chat-service: iv (12 bytes) || tag (16 bytes) || ciphertext.
function chatCryptoJs() {
  return `
    window.__chat = (function() {
      let key = null;
      const pending = [];

      function b64toBytes(b64) { return Uint8Array.from(atob(b64), c => c.charCodeAt(0)); }
      function bytesTob64(bytes) {
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
      }

      async function setKey(b64) {
        const raw = b64toBytes(b64);
        key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        const buffered = pending.splice(0);
        return buffered;  // caller re-decrypts these
      }
      function ready() { return !!key; }

      async function encrypt(text) {
        if (!key) return null;
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const pt = new TextEncoder().encode(String(text));
        const ctTag = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt));
        // WebCrypto returns ciphertext||tag (16-byte tag at the end).
        const ct = ctTag.slice(0, ctTag.length - 16);
        const tag = ctTag.slice(ctTag.length - 16);
        const out = new Uint8Array(12 + 16 + ct.length);
        out.set(iv, 0); out.set(tag, 12); out.set(ct, 28);
        return bytesTob64(out);
      }

      async function decrypt(b64) {
        if (!key) return null;
        try {
          const bytes = b64toBytes(b64);
          const iv = bytes.slice(0, 12);
          const tag = bytes.slice(12, 28);
          const ct = bytes.slice(28);
          const combined = new Uint8Array(ct.length + tag.length);
          combined.set(ct, 0); combined.set(tag, ct.length);
          const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, combined);
          return new TextDecoder().decode(pt);
        } catch { return null; }
      }

      function bufferIfNotReady(msg) { if (!key) pending.push(msg); return !key; }

      return { setKey, ready, encrypt, decrypt, bufferIfNotReady };
    })();
  `;
}
module.exports = { chatCryptoJs };
