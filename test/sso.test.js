const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ora-itsm-sso-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'secret-admin-1';
const app = require('../server/index');
const sso = require('../server/sso');

const CLIENT_ID = '0b5c1d2e-1111-4222-8333-944455556666';
const BLACKSTAR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ORA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig' };
sso._setKeyFetcher(async () => [jwk]);

function makeToken(claims, { kid = 'test-key', key = privateKey } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT', kid };
  const body = { aud: CLIENT_ID, iat: now, nbf: now, exp: now + 3600, nonce: 'n1', ver: '2.0', ...claims };
  body.iss = body.iss || `https://login.microsoftonline.com/${body.tid}/v2.0`;
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc(header)}.${enc(body)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), key).toString('base64url')}`;
}

let server, base, adminToken;
const call = async (method, url, body, tok) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const entra = (claims, nonce = 'n1') => call('POST', '/auth/entra', { id_token: makeToken(claims), nonce });

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  adminToken = (await call('POST', '/login', { email: 'admin@test.local', password: 'secret-admin-1' })).body.token;
});
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('SSO disabled by default', async () => {
  assert.deepStrictEqual((await call('GET', '/auth/config')).body.enabled, false);
  assert.strictEqual((await entra({ tid: BLACKSTAR, oid: 'u1', preferred_username: 'x@y.com' })).status, 401);
});

test('Entra ID sign-in: verification, linking, provisioning, tenant roles', async () => {
  const saved = await call('PUT', '/settings/sso', {
    enabled: true, client_id: CLIENT_ID, tenant: 'organizations',
    allowed_tenants: [{ id: BLACKSTAR, role: 'engineer' }, { id: ORA, role: 'client' }],
    auto_provision: false, default_role: 'client', password_login: true,
  }, adminToken);
  assert.strictEqual(saved.status, 200);
  const cfg = (await call('GET', '/auth/config')).body;
  assert.strictEqual(cfg.enabled, true);
  assert.strictEqual(cfg.authority, 'https://login.microsoftonline.com/organizations');

  // Existing account matched by email, then linked by oid
  const r1 = await entra({ tid: BLACKSTAR, oid: 'oid-admin', preferred_username: 'Admin@Test.local', name: 'Admin' });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.body.user.role, 'admin');
  const once = makeToken({ tid: BLACKSTAR, oid: 'oid-admin', preferred_username: 'admin@test.local', uti: 'replay' });
  assert.strictEqual((await call('POST', '/auth/entra', { id_token: once, nonce: 'n1' })).status, 200);
  assert.strictEqual((await call('POST', '/auth/entra', { id_token: once, nonce: 'n1' })).status, 401);
  const r1b = await entra({ tid: BLACKSTAR, oid: 'oid-admin', preferred_username: 'renamed@test.local' });
  assert.strictEqual(r1b.body.user.email, 'admin@test.local');

  // Unknown user without auto-provisioning
  assert.strictEqual((await entra({ tid: ORA, oid: 'oid-new', preferred_username: 'it@ora.iq' })).status, 403);

  // Rejections
  assert.strictEqual((await entra({ tid: ORA, oid: 'x', preferred_username: 'a@b.c', aud: 'other-app' })).status, 401);
  assert.strictEqual((await entra({ tid: ORA, oid: 'x', preferred_username: 'a@b.c' }, 'wrong-nonce')).status, 401);
  assert.strictEqual((await entra({ tid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', oid: 'x', preferred_username: 'a@b.c' })).status, 401);
  assert.strictEqual((await entra({ tid: ORA, oid: 'x', preferred_username: 'a@b.c', exp: 1000 })).status, 401);
  assert.strictEqual((await entra({ tid: ORA, oid: 'x', preferred_username: 'a@b.c', iss: 'https://evil.example/v2.0' })).status, 401);
  const forged = makeToken({ tid: ORA, oid: 'x', preferred_username: 'a@b.c' }, { key: crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey });
  assert.strictEqual((await call('POST', '/auth/entra', { id_token: forged, nonce: 'n1' })).status, 401);

  // Auto-provisioning uses the tenant's role
  await call('PUT', '/settings/sso', { ...cfg, enabled: true, client_id: CLIENT_ID, tenant: 'organizations',
    allowed_tenants: [{ id: BLACKSTAR, role: 'engineer' }, { id: ORA, role: 'client' }], auto_provision: true,
    default_role: 'client', password_login: false }, adminToken);
  const eng = await entra({ tid: BLACKSTAR, oid: 'oid-eng', preferred_username: 'eng@blackstar.iq', name: 'Engineer One' });
  assert.strictEqual(eng.body.user.role, 'engineer');
  const cli = await entra({ tid: ORA, oid: 'oid-cli', email: 'it@ora.iq', name: 'ORA IT' });
  assert.strictEqual(cli.body.user.role, 'client');

  // Password sign-in disabled: non-admins refused, admin keeps break-glass access
  await call('POST', '/users', { name: 'Pw user', email: 'pw@test.local', role: 'engineer', password: 'password-123' }, adminToken);
  assert.strictEqual((await call('POST', '/login', { email: 'pw@test.local', password: 'password-123' })).status, 403);
  assert.strictEqual((await call('POST', '/login', { email: 'admin@test.local', password: 'secret-admin-1' })).status, 200);

  const users = (await call('GET', '/users', null, adminToken)).body;
  assert.strictEqual(users.find((u) => u.email === 'eng@blackstar.iq').sso_linked, 1);
});
