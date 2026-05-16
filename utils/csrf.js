const { randomBytes, timingSafeEqual } = require('crypto');

const COOKIE_NAME = 'pd_csrf';
const HEADER_NAME = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function newToken() { return randomBytes(24).toString('base64url'); }

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Origin + double-submit-cookie CSRF guard.
 *
 *  - Issues a `pd_csrf` cookie on any request that doesn't already have one.
 *    The cookie is NOT HttpOnly (the page JS reads it and echoes it in a
 *    request header — that's the second half of the double-submit pattern).
 *  - On state-changing requests (anything but GET/HEAD/OPTIONS), requires:
 *      1. Origin or Referer matches the allow-list, AND
 *      2. For /api/* paths, X-CSRF-Token header matches the cookie.
 *  - Cross-origin attackers cannot read the cookie set on a different origin
 *    and therefore cannot forge the header, blocking classic CSRF and
 *    DNS-rebinding drive-bys against loopback.
 */
function csrfMiddleware({ allowedOrigins, requireTokenForApi = true } = {}) {
  const allowSet = allowedOrigins instanceof Set ? allowedOrigins : new Set(allowedOrigins || []);
  return function csrf(req, res, next) {
    const cookies = parseCookies(req);
    let token = cookies[COOKIE_NAME];
    if (!token) {
      token = newToken();
      // SameSite=Strict so the browser won't ship the cookie cross-site.
      res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; Path=/; SameSite=Strict`);
    }
    req.csrfToken = token;

    const method = req.method.toUpperCase();
    if (SAFE_METHODS.has(method)) return next();

    const origin = req.headers.origin;
    const referer = req.headers.referer;
    if (origin) {
      if (!allowSet.has(origin)) return res.status(403).type('text').send('forbidden origin');
    } else if (referer) {
      try {
        const u = new URL(referer);
        if (!allowSet.has(`${u.protocol}//${u.host}`)) {
          return res.status(403).type('text').send('forbidden referer');
        }
      } catch {
        return res.status(403).type('text').send('bad referer');
      }
    } else {
      return res.status(403).type('text').send('missing origin/referer');
    }

    if (requireTokenForApi && req.path.startsWith('/api/')) {
      const sent = req.headers[HEADER_NAME];
      if (!safeEqual(sent, token)) return res.status(403).type('text').send('csrf token mismatch');
    }
    next();
  };
}

/** Client-side fetch shim — injected into every owner page. */
function fetchShimJs() {
  return `
(function(){
  function getTok(){
    var m = document.cookie.split('; ').find(function(s){ return s.indexOf('${COOKIE_NAME}=') === 0; });
    return m ? decodeURIComponent(m.slice('${COOKIE_NAME}='.length)) : '';
  }
  var orig = window.fetch;
  window.fetch = function(input, init){
    init = init || {};
    var method = (init.method || (typeof input === 'string' ? 'GET' : (input && input.method) || 'GET')).toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var sameOrigin = url.charAt(0) === '/' || url.indexOf(location.origin) === 0;
      if (sameOrigin) {
        var h = new Headers(init.headers || {});
        h.set('X-CSRF-Token', getTok());
        init.headers = h;
        init.credentials = init.credentials || 'same-origin';
      }
    }
    return orig.call(this, input, init);
  };
})();`;
}

module.exports = { csrfMiddleware, fetchShimJs, COOKIE_NAME, HEADER_NAME, newToken };
