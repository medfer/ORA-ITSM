// Microsoft Entra ID single sign-on.
// The browser runs the SPA authorization-code + PKCE flow and sends the resulting
// ID token here; this module verifies its signature and claims before a session
// is opened. No external dependency: keys are fetched from Entra's JWKS endpoint
// and checked with node:crypto.

const crypto = require('node:crypto');

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JWKS_TTL = 6 * 3600 * 1000;
const CLOCK_SKEW = 5 * 60;

const DEFAULT_SSO = {
  enabled: false,
  client_id: '',
  tenant: 'organizations', // tenant GUID, verified domain, or "organizations" for several tenants
  allowed_tenants: [], // [{ id: '<tenant guid>', role: 'engineer' | 'client' | '' }]
  auto_provision: false,
  default_role: 'client',
  password_login: true,
};

function normalizeConfig(raw = {}) {
  const cfg = { ...DEFAULT_SSO, ...raw };
  cfg.client_id = String(cfg.client_id || '').trim();
  cfg.tenant = String(cfg.tenant || 'organizations').trim();
  cfg.allowed_tenants = (Array.isArray(cfg.allowed_tenants) ? cfg.allowed_tenants : [])
    .map((t) => ({ id: String(t.id || '').trim().toLowerCase(), role: ['admin', 'engineer', 'client'].includes(t.role) ? t.role : '' }))
    .filter((t) => GUID.test(t.id));
  if (!['engineer', 'client'].includes(cfg.default_role)) cfg.default_role = 'client';
  cfg.enabled = !!cfg.enabled && GUID.test(cfg.client_id);
  // Never lock everyone out: without working SSO, password login stays on
  cfg.password_login = cfg.enabled ? cfg.password_login !== false : true;
  return cfg;
}

// Tenants whose users may sign in (empty = any work account, only when tenant is not a GUID)
function allowedTenantIds(cfg) {
  const ids = cfg.allowed_tenants.map((t) => t.id);
  if (GUID.test(cfg.tenant)) ids.push(cfg.tenant.toLowerCase());
  return [...new Set(ids)];
}

function publicConfig(rawCfg) {
  const cfg = normalizeConfig(rawCfg);
  return {
    enabled: cfg.enabled,
    client_id: cfg.enabled ? cfg.client_id : '',
    authority: cfg.enabled ? `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}` : '',
    password_login: cfg.password_login,
  };
}

let jwksCache = { at: 0, keys: [] };
const usedTokens = new Map();

async function defaultFetchKeys() {
  const res = await fetch('https://login.microsoftonline.com/common/discovery/v2.0/keys');
  if (!res.ok) throw new Error(`Unable to download Microsoft signing keys (${res.status})`);
  return (await res.json()).keys || [];
}

let fetchKeys = defaultFetchKeys;

async function getKey(kid) {
  const fresh = Date.now() - jwksCache.at < JWKS_TTL;
  let jwk = fresh && jwksCache.keys.find((k) => k.kid === kid);
  if (!jwk) {
    // Unknown kid: Microsoft rotated its keys, refresh once
    jwksCache = { at: Date.now(), keys: await fetchKeys() };
    jwk = jwksCache.keys.find((k) => k.kid === kid);
  }
  if (!jwk) throw new Error('Token signed with an unknown key');
  return crypto.createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
}

const b64json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

async function verifyIdToken(idToken, rawCfg, expectedNonce) {
  const cfg = normalizeConfig(rawCfg);
  if (!cfg.enabled) throw new Error('Microsoft sign-in is not enabled');
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const header = b64json(parts[0]);
  const claims = b64json(parts[1]);
  if (header.alg !== 'RS256') throw new Error('Unsupported token algorithm');

  const key = await getKey(header.kid);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], 'base64url'));
  if (!ok) throw new Error('Invalid token signature');

  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== cfg.client_id) throw new Error('Token was issued for another application');
  if (!claims.exp || claims.exp < now - CLOCK_SKEW) throw new Error('Token expired');
  if (claims.nbf && claims.nbf > now + CLOCK_SKEW) throw new Error('Token not yet valid');
  const tid = String(claims.tid || '').toLowerCase();
  if (!GUID.test(tid) || claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`) throw new Error('Invalid token issuer');
  const allowed = allowedTenantIds(cfg);
  if (allowed.length && !allowed.includes(tid)) throw new Error('Your organization is not allowed to sign in to this application');
  if (!expectedNonce || claims.nonce !== expectedNonce) throw new Error('Invalid sign-in request (nonce mismatch), please try again');

  // Each ID token can open only one session (replay protection)
  const nowMs = Date.now();
  for (const [sig, exp] of usedTokens) if (exp < nowMs) usedTokens.delete(sig);
  if (usedTokens.has(parts[2])) throw new Error('This sign-in was already used, please sign in again');
  usedTokens.set(parts[2], (claims.exp + CLOCK_SKEW) * 1000);

  const email = String(claims.email || claims.preferred_username || claims.upn || '').trim().toLowerCase();
  if (!claims.oid) throw new Error('Token has no user identifier');
  const tenantRule = cfg.allowed_tenants.find((t) => t.id === tid);
  return {
    oid: claims.oid,
    tid,
    email,
    name: claims.name || email,
    role: (tenantRule && tenantRule.role) || cfg.default_role,
    autoProvision: cfg.auto_provision,
  };
}

module.exports = {
  DEFAULT_SSO,
  normalizeConfig,
  publicConfig,
  verifyIdToken,
  // tests only
  _setKeyFetcher(fn) { fetchKeys = fn || defaultFetchKeys; jwksCache = { at: 0, keys: [] }; },
};
