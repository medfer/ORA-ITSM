const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ora-itsm-mail-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'secret-admin-1';
const app = require('../server/index');
const mailer = require('../server/mailer');
const { db } = require('../server/db');

const sent = [];
mailer._setTransport(async (m) => { sent.push({ to: m.to, subject: m.subject, html: m.html, sender: m.cfg.sender }); });

let server, base, admin, client, engineer;
const call = async (method, url, body, tok) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};
const login = async (email, password) => (await call('POST', '/login', { email, password })).body.token;
const drain = async () => { await new Promise((r) => setTimeout(r, 20)); await mailer._flush(); const out = sent.splice(0); return out; };
const to = (mails, email) => mails.filter((m) => m.to.includes(email));

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT_ID = '66666666-7777-4888-8999-000000000000';

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  admin = await login('admin@test.local', 'secret-admin-1');
  await call('POST', '/users', { name: 'ORA IT', email: 'it@ora.iq', role: 'client', password: 'client-pass-1' }, admin);
  await call('POST', '/users', { name: 'Eng One', email: 'eng@blackstar.iq', role: 'engineer', password: 'engin-pass-1' }, admin);
  client = await login('it@ora.iq', 'client-pass-1');
  engineer = await login('eng@blackstar.iq', 'engin-pass-1');
});
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('mail settings: validation, secret never exposed', async () => {
  const bad = await call('PUT', '/settings/mail', { enabled: true, sender: 'Med@carthagecloudsolutions.com', tenant_id: TENANT, client_id: CLIENT_ID }, admin);
  assert.strictEqual(bad.status, 400); // no secret yet
  const ok = await call('PUT', '/settings/mail', {
    enabled: true, sender: 'Med@carthagecloudsolutions.com', tenant_id: TENANT, client_id: CLIENT_ID,
    client_secret: 'super-secret-value', app_url: 'https://ora-itsm.duckdns.org/',
  }, admin);
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.body.secret_set, true);
  assert.strictEqual(JSON.stringify(ok.body).includes('super-secret'), false);
  for (const tok of [admin, client]) {
    const meta = await call('GET', '/meta', null, tok);
    assert.strictEqual(JSON.stringify(meta.body).includes('super-secret'), false);
  }
  assert.strictEqual((await call('GET', '/meta', null, client)).body.settings.mail, undefined);
  assert.strictEqual((await call('GET', '/settings/mail', null, client)).status, 403);
  const test1 = await call('POST', '/settings/mail/test', { to: 'admin@test.local' }, admin);
  assert.strictEqual(test1.status, 200);
  const mails = await drain();
  assert.strictEqual(mails.length, 1);
  assert.strictEqual(mails[0].sender, 'Med@carthagecloudsolutions.com');
});

test('ticket lifecycle notifications', async () => {
  // Client opens a ticket: confirmation to client + alert to staff
  const t = (await call('POST', '/tickets', { title: 'Outlook <crash>', priority: 'P2', description: 'Since update' }, client)).body;
  let mails = await drain();
  assert.strictEqual(to(mails, 'it@ora.iq').length, 1);
  assert.match(to(mails, 'it@ora.iq')[0].subject, /We received your request/);
  assert.match(to(mails, 'it@ora.iq')[0].html, /Outlook &lt;crash&gt;/); // escaped
  assert.match(to(mails, 'it@ora.iq')[0].html, /https:\/\/ora-itsm\.duckdns\.org\/#\/tickets\//);
  assert.strictEqual(to(mails, 'eng@blackstar.iq').length, 1);
  assert.strictEqual(to(mails, 'admin@test.local').length, 1);

  // Assignment -> engineer
  const eng = (await call('GET', '/users', null, admin)).body.find((u) => u.email === 'eng@blackstar.iq');
  await call('PATCH', `/tickets/${t.id}`, { assignee_id: eng.id }, admin);
  mails = await drain();
  assert.deepStrictEqual(mails.map((m) => m.to), [['eng@blackstar.iq']]);

  // Internal note -> nobody; public reply -> client
  await call('POST', `/tickets/${t.id}/comments`, { body: 'internal', internal: true }, engineer);
  assert.strictEqual((await drain()).length, 0);
  await call('POST', `/tickets/${t.id}/comments`, { body: 'Please restart Outlook' }, engineer);
  mails = await drain();
  assert.deepStrictEqual(mails.map((m) => m.to), [['it@ora.iq']]);

  // Client reply -> assignee only
  await call('POST', `/tickets/${t.id}/comments`, { body: 'Still broken' }, client);
  mails = await drain();
  assert.deepStrictEqual(mails.map((m) => m.to), [['eng@blackstar.iq']]);

  // Resolved -> client with resolution text
  await call('PATCH', `/tickets/${t.id}`, { status: 'resolved', resolution: 'Repaired Office' }, engineer);
  mails = await drain();
  assert.strictEqual(mails.length, 1);
  assert.match(mails[0].subject, /Resolved/);
  assert.match(mails[0].html, /Repaired Office/);

  // Client opts out
  await call('PATCH', '/me', { notify: false }, client);
  await call('PATCH', `/tickets/${t.id}`, { status: 'closed' }, engineer);
  assert.strictEqual(to(await drain(), 'it@ora.iq').length, 0);
  await call('PATCH', '/me', { notify: true }, client);

  // Disabled event
  const cfg = (await call('GET', '/settings/mail', null, admin)).body;
  await call('PUT', '/settings/mail', { ...cfg, events: { ...cfg.events, staff_new_ticket: false } }, admin);
  await call('POST', '/tickets', { title: 'Second', priority: 'P4' }, client);
  mails = await drain();
  assert.deepStrictEqual(mails.map((m) => m.to), [['it@ora.iq']]);
  await call('PUT', '/settings/mail', { ...cfg }, admin);
});

test('SLA and allowance alerts are sent once', async () => {
  const t = (await call('POST', '/tickets', { title: 'DC down', priority: 'P1' }, admin)).body;
  await drain();
  db.prepare('UPDATE tickets SET created_at = ?, response_due = ?, resolution_due = ? WHERE id = ?')
    .run(Date.now() - 10 * 3600000, Date.now() - 9 * 3600000, Date.now() - 6 * 3600000, t.id);
  app.runSlaCheck();
  let mails = await drain();
  assert.strictEqual(mails.filter((m) => /BREACHED/.test(m.subject)).length, 2); // response + resolution
  app.runSlaCheck();
  assert.strictEqual((await drain()).length, 0);

  const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  assert.strictEqual((await call('POST', '/time', { work_date: today, minutes: 20 * 60, description: 'Migration day 1' }, admin)).status, 201);
  assert.strictEqual((await drain()).length, 0); // 50%: below the 80% threshold
  assert.strictEqual((await call('POST', '/time', { work_date: today, minutes: 13 * 60, description: 'Migration day 2' }, admin)).status, 201);
  mails = await drain();
  assert.strictEqual(mails.length, 1);
  assert.match(mails[0].subject, /80% of the monthly allowance/);
  await call('POST', '/time', { work_date: today, minutes: 8 * 60, description: 'More work' }, admin);
  mails = await drain();
  assert.strictEqual(mails.length, 1);
  assert.match(mails[0].subject, /fully used/);
  await call('POST', '/time', { work_date: today, minutes: 30, description: 'Extra' }, admin);
  assert.strictEqual((await drain()).length, 0);
});
