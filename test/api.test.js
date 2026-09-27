const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ora-itsm-'));
process.env.DATA_DIR = dir;
process.env.ADMIN_EMAIL = 'admin@test.local';
process.env.ADMIN_PASSWORD = 'secret-admin-1';
const app = require('../server/index');

let server, base, token;
const call = async (method, url, body, tok = token) => {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text() };
};

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
test.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('parcours complet : ticket, SLA, temps, rapport', async () => {
  assert.strictEqual((await call('GET', '/me')).status, 401);
  assert.strictEqual((await call('POST', '/login', { email: 'admin@test.local', password: 'bad' })).status, 401);
  const login = await call('POST', '/login', { email: 'admin@test.local', password: 'secret-admin-1' });
  assert.strictEqual(login.status, 200);
  token = login.body.token;

  const created = await call('POST', '/tickets', { title: 'Exchange : messages bloqués', priority: 'P1', category: 'Exchange Online' });
  assert.strictEqual(created.status, 201);
  assert.match(created.body.number, /^ORA-0000\d$/);
  const id = created.body.id;

  let t = (await call('GET', `/tickets/${id}`)).body.ticket;
  assert.strictEqual(t.sla_response, 'running');
  assert.strictEqual(t.resolution_due - t.created_at, 240 * 60000); // P1 = 4h en 24/7

  // Mise en attente client puis reprise
  assert.strictEqual((await call('PATCH', `/tickets/${id}`, { status: 'pending_client' })).status, 200);
  t = (await call('GET', `/tickets/${id}`)).body.ticket;
  assert.ok(t.paused_at);
  assert.ok(t.first_response_at);
  assert.strictEqual(t.sla_resolution, 'paused');
  await call('PATCH', `/tickets/${id}`, { status: 'in_progress' });

  // Client : création et commentaires sans notes internes
  await call('POST', '/users', { name: 'Client ORA', email: 'it@ora.local', role: 'client', password: 'client-pass-1' });
  const ctok = (await call('POST', '/login', { email: 'it@ora.local', password: 'client-pass-1' })).body.token;
  await call('POST', `/tickets/${id}/comments`, { body: 'note interne', internal: true });
  await call('POST', `/tickets/${id}/comments`, { body: 'réponse publique' });
  const seen = (await call('GET', `/tickets/${id}`, null, ctok)).body.comments;
  assert.deepStrictEqual(seen.map((c) => c.body), ['réponse publique']);
  assert.strictEqual((await call('PATCH', `/tickets/${id}`, { status: 'closed' }, ctok)).status, 403);
  assert.strictEqual((await call('GET', '/time', null, ctok)).status, 403);

  // Temps passé
  const today = new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
  assert.strictEqual((await call('POST', '/time', { ticket_id: id, work_date: today, minutes: 90, description: 'Analyse' })).status, 201);
  assert.strictEqual((await call('POST', '/time', { work_date: today, minutes: 60, description: 'Réunion mensuelle', billable: false })).status, 201);
  assert.strictEqual((await call('POST', '/time', { work_date: today, minutes: -5 })).status, 400);

  await call('PATCH', `/tickets/${id}`, { status: 'resolved', resolution: 'Règle de transport corrigée' });
  t = (await call('GET', `/tickets/${id}`)).body.ticket;
  assert.strictEqual(t.sla_resolution, 'met');
  assert.strictEqual(t.time_minutes, 90);

  const month = today.slice(0, 7);
  const rep = (await call('GET', `/reports/monthly?month=${month}`)).body;
  assert.strictEqual(rep.hours.billable_minutes, 90);
  assert.strictEqual(rep.hours.non_billable_minutes, 60);
  assert.strictEqual(rep.hours.remaining_minutes, 40 * 60 - 90);
  assert.strictEqual(rep.tickets.created, 1);
  assert.strictEqual(rep.sla.resolution_pct, 100);

  const csv = await call('GET', `/reports/monthly.csv?kind=time&month=${month}`);
  assert.strictEqual(csv.status, 200);
  assert.match(csv.body, /Analyse/);

  const dash = (await call('GET', '/dashboard')).body;
  assert.strictEqual(dash.used_minutes, 90);
  assert.strictEqual(dash.contract_minutes, 2400);
});
