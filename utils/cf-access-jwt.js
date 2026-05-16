/**
 * Cloudflare Access JWT verification.
 *
 * Every request that hits the public origin via Cloudflare Tunnel carries a
 * `Cf-Access-Jwt-Assertion` header. Earlier versions of this server trusted
 * the `Cf-Access-Authenticated-User-Email` header on its own — but anything
 * with loopback access on the box (another local service, a misconfigured
 * sidecar) can set that header arbitrarily.
 *
 * This module verifies the JWT against the team JWKS so impersonation is
 * detected at the edge of the Node process.
 *
 * Standard library only (no jose / jsonwebtoken).
 */

const { createPublicKey, createVerify } = require('crypto');

const JWKS_TTL_MS = 60 * 60 * 1000; // 1h
const CLOCK_SKEW_S = 60;

const jwksCache = new Map(); // teamDomain -> { fetchedAt, keys: Map<kid, KeyObject> }

function _b64urlToBuf(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function _decodeSegment(seg) {
  return JSON.parse(_b64urlToBuf(seg).toString('utf8'));
}

async function _fetchJwks(teamDomain) {
  const url = `https://${teamDomain}/cdn-cgi/access/certs`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`JWKS fetch ${res.status}`);
  const body = await res.json();
  const keys = new Map();
  for (const k of body.keys || []) {
    if (!k.kid || k.kty !== 'RSA') continue;
    try {
      const key = createPublicKey({ key: k, format: 'jwk' });
      keys.set(k.kid, key);
    } catch {}
  }
  return keys;
}

async function _getKeys(teamDomain) {
  const cached = jwksCache.get(teamDomain);
  const now = Date.now();
  if (cached && (now - cached.fetchedAt) < JWKS_TTL_MS) return cached.keys;
  const keys = await _fetchJwks(teamDomain);
  jwksCache.set(teamDomain, { fetchedAt: now, keys });
  return keys;
}

/**
 * Verify a JWT issued by Cloudflare Access for the configured AUD.
 * Resolves with the decoded payload; rejects on any failure.
 */
async function verifyAccessJwt(jwt, { teamDomain, audTag }) {
  if (!jwt || typeof jwt !== 'string') throw new Error('jwt missing');
  if (!teamDomain) throw new Error('teamDomain not configured');
  if (!audTag) throw new Error('audTag not configured');

  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('jwt malformed');

  const header = _decodeSegment(parts[0]);
  const payload = _decodeSegment(parts[1]);
  const sig = _b64urlToBuf(parts[2]);
  const signedInput = `${parts[0]}.${parts[1]}`;

  if (header.alg !== 'RS256') throw new Error(`unsupported alg ${header.alg}`);

  let keys = await _getKeys(teamDomain);
  let key = header.kid ? keys.get(header.kid) : null;
  if (!key) {
    // Cloudflare rotates keys; force-refresh once.
    jwksCache.delete(teamDomain);
    keys = await _getKeys(teamDomain);
    key = header.kid ? keys.get(header.kid) : null;
  }
  if (!key) throw new Error(`unknown kid ${header.kid}`);

  const v = createVerify('RSA-SHA256').update(signedInput).end();
  if (!v.verify(key, sig)) throw new Error('signature invalid');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp + CLOCK_SKEW_S) throw new Error('jwt expired');
  if (payload.nbf && now + CLOCK_SKEW_S < payload.nbf) throw new Error('jwt not yet valid');

  const issExpected = `https://${teamDomain}`;
  if (payload.iss !== issExpected) throw new Error(`bad iss (got ${payload.iss})`);

  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(audTag)) throw new Error('aud mismatch');

  return payload;
}

function invalidate(teamDomain = null) {
  if (teamDomain) jwksCache.delete(teamDomain);
  else jwksCache.clear();
}

module.exports = { verifyAccessJwt, invalidate };
