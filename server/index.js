const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { db, getSettings, setSetting, hashPassword, verifyPassword, DEFAULT_SETTINGS } = require('./db');
const sla = require('./sla');

const PORT = Number(process.env.PORT) || 8080;
const SESSION_DAYS = 7;

const STATUSES = ['new', 'in_progress', 'pending_client', 'pending_microsoft', 'resolved', 'closed', 'cancelled'];
const OPEN_STATUSES = ['new', 'in_progress', 'pending_client', 'pending_microsoft'];
const PAUSE_STATUSES = ['pending_client'];
const TYPES = ['incident', 'request', 'change', 'problem'];

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- utilitaires ----------

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const wrap = (fn) => (req, res, next) => {
  try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); }
};

function policies() {
  const map = {};
  for (const p of db.prepare('SELECT * FROM sla_policies ORDER BY priority').all()) map[p.priority] = { ...p };
  return map;
}

function ticketNumber(id, settings) {
  return `${settings.ticket_prefix || 'TCK'}-${String(id).padStart(5, '0')}`;
}

// Bornes UTC d'un mois local 'YYYY-MM' selon le décalage horaire du client.
function monthRange(month, settings) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new HttpError(400, 'Mois invalide (format AAAA-MM)');
  const [y, m] = month.split('-').map(Number);
  const offset = (settings.business_hours?.offset || 0) * 60000;
  return {
    from: Date.UTC(y, m - 1, 1) - offset,
    to: Date.UTC(y, m, 1) - offset,
    dayFrom: `${month}-01`,
    dayTo: new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10),
  };
}

function currentMonth(settings) {
  const offset = (settings.business_hours?.offset || 0) * 60000;
  return new Date(Date.now() + offset).toISOString().slice(0, 7);
}

function decorate(t, pols, settings, now = Date.now()) {
  const pol = pols[t.priority];
  const state = pol ? sla.slaState(t, pol, settings.business_hours, now) : {};
  return {
    ...t,
    number: ticketNumber(t.id, settings),
    sla_response: state.response,
    sla_resolution: state.resolution,
    effective_resolution_due: state.effective_resolution_due,
  };
}

// ---------- authentification ----------

function auth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Non authentifié'));
  const row = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.active, s.expires_at
                          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row || !row.active || row.expires_at < Date.now()) return next(new HttpError(401, 'Session expirée'));
  req.user = { id: row.id, name: row.name, email: row.email, role: row.role };
  req.token = token;
  next();
}

const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'Accès refusé'));
const staff = requireRole('admin', 'engineer');
const admin = requireRole('admin');

app.post('/api/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  if (!user || !user.active || !verifyPassword(String(password || ''), user.password_hash)) {
    throw new HttpError(401, 'Email ou mot de passe incorrect');
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, user.id, Date.now() + SESSION_DAYS * 86400000);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
}));

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api', auth);

app.post('/api/logout', wrap((req, res) => {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.json({ ok: true });
}));

app.get('/api/me', (req, res) => res.json(req.user));

app.post('/api/me/password', wrap((req, res) => {
  const { current, next: pwd } = req.body || {};
  const user = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!verifyPassword(String(current || ''), user.password_hash)) throw new HttpError(400, 'Mot de passe actuel incorrect');
  if (String(pwd || '').length < 8) throw new HttpError(400, 'Le nouveau mot de passe doit contenir au moins 8 caractères');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pwd), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.token);
  res.json({ ok: true });
}));

// ---------- référentiels ----------

app.get('/api/meta', wrap((req, res) => {
  const settings = getSettings();
  res.json({
    settings,
    statuses: STATUSES,
    open_statuses: OPEN_STATUSES,
    types: TYPES,
    policies: Object.values(policies()),
    users: db.prepare("SELECT id, name, role FROM users WHERE active = 1 ORDER BY name").all(),
  });
}));

// ---------- tickets ----------

function logChange(ticketId, userId, field, oldV, newV, now) {
  db.prepare('INSERT INTO ticket_history (ticket_id, user_id, field, old_value, new_value, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(ticketId, userId, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), now);
}

app.get('/api/tickets', wrap((req, res) => {
  const settings = getSettings();
  const where = [];
  const args = [];
  const { status, priority, assignee, q, type, category, month } = req.query;
  if (status === 'open') where.push(`t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`), args.push(...OPEN_STATUSES);
  else if (status) where.push('t.status = ?'), args.push(status);
  if (priority) where.push('t.priority = ?'), args.push(priority);
  if (type) where.push('t.type = ?'), args.push(type);
  if (category) where.push('t.category = ?'), args.push(category);
  if (assignee === 'me') where.push('t.assignee_id = ?'), args.push(req.user.id);
  else if (assignee === 'none') where.push('t.assignee_id IS NULL');
  else if (assignee) where.push('t.assignee_id = ?'), args.push(Number(assignee));
  if (month) {
    const r = monthRange(month, settings);
    where.push('t.created_at >= ? AND t.created_at < ?'); args.push(r.from, r.to);
  }
  if (q) {
    const idMatch = String(q).match(/(\d+)\s*$/);
    where.push('(t.title LIKE ? OR t.description LIKE ? OR t.ms_case LIKE ? OR t.requester_name LIKE ? OR t.id = ?)');
    args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, idMatch ? Number(idMatch[1]) : -1);
  }
  const rows = db.prepare(`
    SELECT t.*, a.name AS assignee_name,
      (SELECT COALESCE(SUM(minutes), 0) FROM time_entries te WHERE te.ticket_id = t.id) AS time_minutes
    FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN t.status IN ('resolved','closed','cancelled') THEN 1 ELSE 0 END, t.priority, t.created_at DESC
    LIMIT 1000`).all(...args);
  const pols = policies();
  const now = Date.now();
  res.json(rows.map((t) => decorate(t, pols, settings, now)));
}));

app.post('/api/tickets', wrap((req, res) => {
  const b = req.body || {};
  const settings = getSettings();
  const pols = policies();
  const title = String(b.title || '').trim();
  if (!title) throw new HttpError(400, 'Le titre est obligatoire');
  const priority = pols[b.priority] ? b.priority : 'P3';
  const type = TYPES.includes(b.type) ? b.type : 'incident';
  const now = Date.now();
  const createdAt = req.user.role !== 'client' && b.created_at ? Number(new Date(b.created_at)) || now : now;
  const dues = sla.computeDues({ created_at: createdAt, paused_minutes: 0 }, pols[priority], settings.business_hours);
  const isClient = req.user.role === 'client';
  const info = db.prepare(`
    INSERT INTO tickets (title, description, type, priority, status, category, requester_name, requester_email,
      assignee_id, created_by, ms_case, created_at, updated_at, response_due, resolution_due)
    VALUES (?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    title, String(b.description || ''), type, priority, String(b.category || ''),
    String(b.requester_name || (isClient ? req.user.name : '')), String(b.requester_email || (isClient ? req.user.email : '')),
    !isClient && b.assignee_id ? Number(b.assignee_id) : null, req.user.id, isClient ? '' : String(b.ms_case || ''),
    createdAt, now, dues.response_due, dues.resolution_due);
  const id = Number(info.lastInsertRowid);
  logChange(id, req.user.id, 'created', null, priority, now);
  res.status(201).json({ id, number: ticketNumber(id, settings) });
}));

function loadTicket(id) {
  const t = db.prepare(`SELECT t.*, a.name AS assignee_name, c.name AS created_by_name
    FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id LEFT JOIN users c ON c.id = t.created_by
    WHERE t.id = ?`).get(Number(id));
  if (!t) throw new HttpError(404, 'Ticket introuvable');
  return t;
}

app.get('/api/tickets/:id', wrap((req, res) => {
  const settings = getSettings();
  const t = loadTicket(req.params.id);
  const isClient = req.user.role === 'client';
  const comments = db.prepare(`SELECT c.*, u.name AS user_name, u.role AS user_role FROM comments c
    LEFT JOIN users u ON u.id = c.user_id WHERE c.ticket_id = ? ${isClient ? 'AND c.internal = 0' : ''}
    ORDER BY c.created_at`).all(t.id);
  const time = db.prepare(`SELECT te.*, u.name AS user_name FROM time_entries te JOIN users u ON u.id = te.user_id
    WHERE te.ticket_id = ? ORDER BY te.work_date DESC, te.id DESC`).all(t.id);
  const history = db.prepare(`SELECT h.*, u.name AS user_name FROM ticket_history h LEFT JOIN users u ON u.id = h.user_id
    WHERE h.ticket_id = ? ORDER BY h.created_at DESC, h.id DESC`).all(t.id);
  res.json({
    ticket: decorate({ ...t, time_minutes: time.reduce((s, e) => s + e.minutes, 0) }, policies(), settings),
    comments, time, history,
  });
}));

app.patch('/api/tickets/:id', staff, wrap((req, res) => {
  const settings = getSettings();
  const pols = policies();
  const t = loadTicket(req.params.id);
  const b = req.body || {};
  const now = Date.now();
  const upd = {};

  for (const f of ['title', 'description', 'category', 'requester_name', 'requester_email', 'ms_case', 'resolution']) {
    if (b[f] !== undefined && String(b[f]) !== t[f]) upd[f] = String(b[f]);
  }
  if (b.type !== undefined && TYPES.includes(b.type) && b.type !== t.type) upd.type = b.type;
  if (b.assignee_id !== undefined) {
    const a = b.assignee_id ? Number(b.assignee_id) : null;
    if (a !== t.assignee_id) upd.assignee_id = a;
  }

  let pausedMinutes = t.paused_minutes;
  let pausedAt = t.paused_at;
  const policy = pols[b.priority && pols[b.priority] ? b.priority : t.priority];

  if (b.status !== undefined && b.status !== t.status) {
    if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Statut invalide');
    upd.status = b.status;
    // Pause / reprise de l'horloge SLA de résolution
    if (PAUSE_STATUSES.includes(b.status) && !pausedAt) pausedAt = now;
    if (!PAUSE_STATUSES.includes(b.status) && pausedAt) {
      pausedMinutes += sla.minutesBetween(pausedAt, now, pols[t.priority], settings.business_hours);
      pausedAt = null;
    }
    upd.paused_at = pausedAt;
    upd.paused_minutes = pausedMinutes;
    if (b.status !== 'new' && !t.first_response_at) upd.first_response_at = now;
    if (['resolved', 'closed', 'cancelled'].includes(b.status)) {
      if (!t.resolved_at) upd.resolved_at = now;
      if (b.status === 'closed' && !t.closed_at) upd.closed_at = now;
    } else {
      upd.resolved_at = null;
      upd.closed_at = null;
    }
  }

  if (b.priority !== undefined && b.priority !== t.priority) {
    if (!pols[b.priority]) throw new HttpError(400, 'Priorité invalide');
    upd.priority = b.priority;
  }
  if (upd.priority || upd.paused_minutes !== undefined) {
    const dues = sla.computeDues({ created_at: t.created_at, paused_minutes: pausedMinutes }, policy, settings.business_hours);
    upd.response_due = dues.response_due;
    upd.resolution_due = dues.resolution_due;
  }

  const keys = Object.keys(upd);
  if (keys.length) {
    upd.updated_at = now;
    const cols = Object.keys(upd);
    db.prepare(`UPDATE tickets SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...cols.map((k) => upd[k]), t.id);
    const tracked = ['title', 'type', 'priority', 'status', 'category', 'assignee_id', 'ms_case'];
    for (const k of keys) if (tracked.includes(k)) logChange(t.id, req.user.id, k, t[k], upd[k], now);
  }
  res.json({ ok: true, changed: keys });
}));

app.delete('/api/tickets/:id', admin, wrap((req, res) => {
  loadTicket(req.params.id);
  db.prepare('DELETE FROM tickets WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
}));

app.post('/api/tickets/:id/comments', wrap((req, res) => {
  const t = loadTicket(req.params.id);
  const body = String(req.body?.body || '').trim();
  if (!body) throw new HttpError(400, 'Commentaire vide');
  const isStaff = req.user.role !== 'client';
  const internal = isStaff && req.body?.internal ? 1 : 0;
  const now = Date.now();
  db.prepare('INSERT INTO comments (ticket_id, user_id, body, internal, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(t.id, req.user.id, body, internal, now);
  // Une réponse publique de l'équipe support compte comme première réponse SLA
  if (isStaff && !internal && !t.first_response_at) {
    db.prepare('UPDATE tickets SET first_response_at = ?, updated_at = ? WHERE id = ?').run(now, now, t.id);
  } else {
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, t.id);
  }
  res.status(201).json({ ok: true });
}));

// ---------- temps passé ----------

function validateEntry(b) {
  const minutes = Math.round(Number(b.minutes));
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) throw new HttpError(400, 'Durée invalide');
  const workDate = String(b.work_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new HttpError(400, 'Date invalide');
  return { minutes, workDate };
}

app.get('/api/time', staff, wrap((req, res) => {
  const settings = getSettings();
  const month = req.query.month || currentMonth(settings);
  const r = monthRange(month, settings);
  const rows = db.prepare(`SELECT te.*, u.name AS user_name, t.title AS ticket_title
    FROM time_entries te JOIN users u ON u.id = te.user_id LEFT JOIN tickets t ON t.id = te.ticket_id
    WHERE te.work_date >= ? AND te.work_date < ? ORDER BY te.work_date DESC, te.id DESC`).all(r.dayFrom, r.dayTo);
  res.json(rows.map((e) => ({ ...e, ticket_number: e.ticket_id ? ticketNumber(e.ticket_id, settings) : null })));
}));

app.post('/api/time', staff, wrap((req, res) => {
  const b = req.body || {};
  const { minutes, workDate } = validateEntry(b);
  const ticketId = b.ticket_id ? loadTicket(b.ticket_id).id : null;
  const userId = req.user.role === 'admin' && b.user_id ? Number(b.user_id) : req.user.id;
  const now = Date.now();
  db.prepare(`INSERT INTO time_entries (ticket_id, user_id, work_date, minutes, description, billable, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ticketId, userId, workDate, minutes, String(b.description || ''), b.billable === false ? 0 : 1, now);
  if (ticketId) db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, ticketId);
  res.status(201).json({ ok: true });
}));

app.patch('/api/time/:id', staff, wrap((req, res) => {
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(Number(req.params.id));
  if (!e) throw new HttpError(404, 'Saisie introuvable');
  if (req.user.role !== 'admin' && e.user_id !== req.user.id) throw new HttpError(403, 'Accès refusé');
  const b = { ...e, ...req.body };
  const { minutes, workDate } = validateEntry(b);
  db.prepare('UPDATE time_entries SET work_date = ?, minutes = ?, description = ?, billable = ? WHERE id = ?')
    .run(workDate, minutes, String(b.description || ''), b.billable === false || b.billable === 0 ? 0 : 1, e.id);
  res.json({ ok: true });
}));

app.delete('/api/time/:id', staff, wrap((req, res) => {
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(Number(req.params.id));
  if (!e) throw new HttpError(404, 'Saisie introuvable');
  if (req.user.role !== 'admin' && e.user_id !== req.user.id) throw new HttpError(403, 'Accès refusé');
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(e.id);
  res.json({ ok: true });
}));

// ---------- tableau de bord & rapports ----------

function hoursByMonth(settings, months = 12) {
  const cur = currentMonth(settings);
  let [y, m] = cur.split('-').map(Number);
  const list = [];
  for (let i = 0; i < months; i++) {
    list.unshift(`${y}-${String(m).padStart(2, '0')}`);
    if (--m === 0) { m = 12; y--; }
  }
  const stmt = db.prepare(`SELECT COALESCE(SUM(minutes),0) AS total,
    COALESCE(SUM(CASE WHEN billable = 1 THEN minutes ELSE 0 END),0) AS billable
    FROM time_entries WHERE work_date >= ? AND work_date < ?`);
  return list.map((month) => {
    const r = monthRange(month, settings);
    const row = stmt.get(r.dayFrom, r.dayTo);
    return { month, minutes: row.total, billable_minutes: row.billable };
  });
}

app.get('/api/dashboard', wrap((req, res) => {
  const settings = getSettings();
  const pols = policies();
  const month = currentMonth(settings);
  const r = monthRange(month, settings);
  const now = Date.now();
  const open = db.prepare(`SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
    WHERE t.status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).all(...OPEN_STATUSES)
    .map((t) => decorate(t, pols, settings, now));
  const used = db.prepare(`SELECT COALESCE(SUM(minutes),0) AS m FROM time_entries
    WHERE billable = 1 AND work_date >= ? AND work_date < ?`).get(r.dayFrom, r.dayTo).m;
  const created = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ? AND created_at < ?').get(r.from, r.to).n;
  const resolved = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE resolved_at >= ? AND resolved_at < ?').get(r.from, r.to).n;
  const byPriority = {};
  for (const p of Object.keys(pols)) byPriority[p] = open.filter((t) => t.priority === p).length;
  const recent = db.prepare(`SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
    ORDER BY t.updated_at DESC LIMIT 8`).all().map((t) => decorate(t, pols, settings, now));
  res.json({
    month,
    contract_minutes: (Number(settings.contract_hours_month) || 0) * 60,
    used_minutes: used,
    open_count: open.length,
    created, resolved,
    by_priority: byPriority,
    breached: open.filter((t) => t.sla_response === 'breached' || t.sla_resolution === 'breached'),
    at_risk: open.filter((t) => t.sla_response === 'at_risk' || t.sla_resolution === 'at_risk'),
    unassigned: open.filter((t) => !t.assignee_id).length,
    recent,
    trend: hoursByMonth(settings, 6),
  });
}));

function monthlyReport(month, settings) {
  const pols = policies();
  const r = monthRange(month, settings);
  const now = Date.now();
  const deco = (t) => decorate(t, pols, settings, now);
  const baseSel = `SELECT t.*, a.name AS assignee_name,
      (SELECT COALESCE(SUM(minutes),0) FROM time_entries te WHERE te.ticket_id = t.id AND te.work_date >= ? AND te.work_date < ?) AS month_minutes,
      (SELECT COALESCE(SUM(minutes),0) FROM time_entries te WHERE te.ticket_id = t.id) AS time_minutes
    FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id`;
  const created = db.prepare(`${baseSel} WHERE t.created_at >= ? AND t.created_at < ? ORDER BY t.created_at`)
    .all(r.dayFrom, r.dayTo, r.from, r.to).map(deco);
  const resolved = db.prepare(`${baseSel} WHERE t.resolved_at >= ? AND t.resolved_at < ? ORDER BY t.resolved_at`)
    .all(r.dayFrom, r.dayTo, r.from, r.to).map(deco);
  // Tous les tickets traités dans le mois : créés, résolus, ou avec du temps saisi
  const worked = db.prepare(`${baseSel} WHERE (t.created_at >= ? AND t.created_at < ?)
      OR (t.resolved_at >= ? AND t.resolved_at < ?)
      OR t.id IN (SELECT ticket_id FROM time_entries WHERE work_date >= ? AND work_date < ? AND ticket_id IS NOT NULL)
      OR (t.created_at < ? AND (t.resolved_at IS NULL OR t.resolved_at >= ?) AND t.status NOT IN ('cancelled'))
    ORDER BY t.id`).all(r.dayFrom, r.dayTo, r.from, r.to, r.from, r.to, r.dayFrom, r.dayTo, r.to, r.from).map(deco);
  const entries = db.prepare(`SELECT te.*, u.name AS user_name, t.title AS ticket_title FROM time_entries te
    JOIN users u ON u.id = te.user_id LEFT JOIN tickets t ON t.id = te.ticket_id
    WHERE te.work_date >= ? AND te.work_date < ? ORDER BY te.work_date, te.id`).all(r.dayFrom, r.dayTo)
    .map((e) => ({ ...e, ticket_number: e.ticket_id ? ticketNumber(e.ticket_id, settings) : null }));

  const count = (list, key) => list.reduce((acc, x) => { const k = x[key] || '—'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
  const sum = (list, key, val) => list.reduce((acc, x) => { const k = x[key] || '—'; acc[k] = (acc[k] || 0) + val(x); return acc; }, {});
  const pct = (ok, total) => (total ? Math.round((ok / total) * 1000) / 10 : null);

  // Conformité SLA : réponse sur les tickets créés dans le mois (hors en cours dans les délais),
  // résolution sur les tickets résolus dans le mois.
  const respEval = created.filter((t) => t.sla_response === 'met' || t.sla_response === 'breached');
  const resEval = resolved.filter((t) => t.status !== 'cancelled');
  const billable = entries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0);
  const total = entries.reduce((s, e) => s + e.minutes, 0);
  const contract = (Number(settings.contract_hours_month) || 0) * 60;

  const catMinutes = {};
  for (const e of entries) {
    const t = e.ticket_id ? worked.find((w) => w.id === e.ticket_id) : null;
    const k = t ? (t.category || '—') : 'Hors ticket';
    catMinutes[k] = (catMinutes[k] || 0) + e.minutes;
  }

  return {
    month,
    settings: {
      company_name: settings.company_name, client_name: settings.client_name,
      contract_name: settings.contract_name, contract_hours_month: settings.contract_hours_month,
    },
    hours: {
      contract_minutes: contract,
      billable_minutes: billable,
      non_billable_minutes: total - billable,
      remaining_minutes: Math.max(0, contract - billable),
      overage_minutes: Math.max(0, billable - contract),
      usage_pct: contract ? Math.round((billable / contract) * 1000) / 10 : null,
      by_user: sum(entries, 'user_name', (e) => e.minutes),
      by_category: catMinutes,
    },
    tickets: {
      created: created.length,
      resolved: resolved.length,
      open_end_of_month: worked.filter((t) => t.created_at < r.to && (!t.resolved_at || t.resolved_at >= r.to) && t.status !== 'cancelled').length,
      by_priority: count(created, 'priority'),
      by_type: count(created, 'type'),
      by_category: count(created, 'category'),
      by_status: count(created, 'status'),
    },
    sla: {
      response_met: respEval.filter((t) => t.sla_response === 'met').length,
      response_total: respEval.length,
      response_pct: pct(respEval.filter((t) => t.sla_response === 'met').length, respEval.length),
      resolution_met: resEval.filter((t) => t.sla_resolution === 'met').length,
      resolution_total: resEval.length,
      resolution_pct: pct(resEval.filter((t) => t.sla_resolution === 'met').length, resEval.length),
      by_priority: Object.keys(pols).map((p) => {
        const rs = resEval.filter((t) => t.priority === p);
        const rp = respEval.filter((t) => t.priority === p);
        return {
          priority: p, name: pols[p].name,
          response_pct: pct(rp.filter((t) => t.sla_response === 'met').length, rp.length), response_total: rp.length,
          resolution_pct: pct(rs.filter((t) => t.sla_resolution === 'met').length, rs.length), resolution_total: rs.length,
        };
      }),
    },
    ticket_list: worked,
    entries,
    trend: hoursByMonth(settings, 12),
  };
}

app.get('/api/reports/monthly', wrap((req, res) => {
  const settings = getSettings();
  const report = monthlyReport(req.query.month || currentMonth(settings), settings);
  if (req.user.role === 'client') {
    // Le client voit la synthèse et les saisies, sans le détail par intervenant
    report.hours.by_user = {};
  }
  res.json(report);
}));

function csv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map((c) => esc(c[0])).join(';'), ...rows.map((r) => columns.map((c) => esc(c[1](r))).join(';'))].join('\r\n');
}

const fmtDate = (ms, settings) => (ms ? new Date(ms + (settings.business_hours?.offset || 0) * 60000).toISOString().slice(0, 16).replace('T', ' ') : '');

app.get('/api/reports/monthly.csv', wrap((req, res) => {
  const settings = getSettings();
  const month = req.query.month || currentMonth(settings);
  const report = monthlyReport(month, settings);
  const kind = req.query.kind === 'tickets' ? 'tickets' : 'time';
  let body;
  if (kind === 'tickets') {
    body = csv(report.ticket_list, [
      ['Numéro', (t) => t.number], ['Titre', (t) => t.title], ['Type', (t) => t.type], ['Priorité', (t) => t.priority],
      ['Statut', (t) => t.status], ['Catégorie', (t) => t.category], ['Demandeur', (t) => t.requester_name],
      ['Assigné', (t) => t.assignee_name], ['Cas Microsoft', (t) => t.ms_case],
      ['Créé le', (t) => fmtDate(t.created_at, settings)], ['1re réponse', (t) => fmtDate(t.first_response_at, settings)],
      ['Résolu le', (t) => fmtDate(t.resolved_at, settings)], ['SLA réponse', (t) => t.sla_response],
      ['SLA résolution', (t) => t.sla_resolution], ['Heures (mois)', (t) => (t.month_minutes / 60).toFixed(2).replace('.', ',')],
      ['Heures (total)', (t) => (t.time_minutes / 60).toFixed(2).replace('.', ',')],
    ]);
  } else {
    body = csv(report.entries, [
      ['Date', (e) => e.work_date], ['Ticket', (e) => e.ticket_number || ''], ['Titre ticket', (e) => e.ticket_title || ''],
      ['Intervenant', (e) => (req.user.role === 'client' ? '' : e.user_name)], ['Description', (e) => e.description],
      ['Minutes', (e) => e.minutes], ['Heures', (e) => (e.minutes / 60).toFixed(2).replace('.', ',')],
      ['Facturable', (e) => (e.billable ? 'Oui' : 'Non')],
    ]);
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="ora-itsm-${kind}-${month}.csv"`);
  res.send(body);
}));

// ---------- administration ----------

app.put('/api/settings', admin, wrap((req, res) => {
  const b = req.body || {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (b[key] === undefined) continue;
    let v = b[key];
    if (key === 'contract_hours_month' || key === 'alert_threshold_pct') {
      v = Number(v);
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Valeur invalide : ${key}`);
    }
    if (key === 'categories' && !Array.isArray(v)) throw new HttpError(400, 'Catégories invalides');
    if (key === 'business_hours') {
      if (!/^\d{2}:\d{2}$/.test(v.start) || !/^\d{2}:\d{2}$/.test(v.end)) throw new HttpError(400, 'Heures ouvrées invalides');
      v = { offset: Number(v.offset) || 0, days: (v.days || []).map(Number).filter((d) => d >= 0 && d <= 6), start: v.start, end: v.end };
    }
    setSetting(key, v);
  }
  res.json(getSettings());
}));

app.put('/api/sla/:priority', admin, wrap((req, res) => {
  const b = req.body || {};
  const p = db.prepare('SELECT * FROM sla_policies WHERE priority = ?').get(req.params.priority);
  if (!p) throw new HttpError(404, 'Priorité inconnue');
  const resp = Math.round(Number(b.response_min ?? p.response_min));
  const reso = Math.round(Number(b.resolution_min ?? p.resolution_min));
  if (!(resp > 0 && reso > 0)) throw new HttpError(400, 'Délais invalides');
  db.prepare('UPDATE sla_policies SET name = ?, response_min = ?, resolution_min = ?, business_hours = ? WHERE priority = ?')
    .run(String(b.name ?? p.name), resp, reso, b.business_hours ? 1 : 0, p.priority);
  if (b.recalculate) recalcOpenTickets();
  res.json({ ok: true });
}));

function recalcOpenTickets() {
  const settings = getSettings();
  const pols = policies();
  const upd = db.prepare('UPDATE tickets SET response_due = ?, resolution_due = ? WHERE id = ?');
  const rows = db.prepare(`SELECT * FROM tickets WHERE status IN (${OPEN_STATUSES.map(() => '?').join(',')})`).all(...OPEN_STATUSES);
  for (const t of rows) {
    const d = sla.computeDues(t, pols[t.priority], settings.business_hours);
    upd.run(d.response_due, d.resolution_due, t.id);
  }
  return rows.length;
}

app.post('/api/sla/recalculate', admin, wrap((req, res) => res.json({ updated: recalcOpenTickets() })));

app.get('/api/users', admin, wrap((req, res) => {
  res.json(db.prepare('SELECT id, name, email, role, active, created_at FROM users ORDER BY name').all());
}));

app.post('/api/users', admin, wrap((req, res) => {
  const b = req.body || {};
  if (!b.name || !b.email) throw new HttpError(400, 'Nom et email obligatoires');
  if (!['admin', 'engineer', 'client'].includes(b.role)) throw new HttpError(400, 'Rôle invalide');
  if (String(b.password || '').length < 8) throw new HttpError(400, 'Mot de passe : 8 caractères minimum');
  try {
    db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(String(b.name), String(b.email).trim(), hashPassword(b.password), b.role, Date.now());
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Cet email existe déjà');
    throw e;
  }
  res.status(201).json({ ok: true });
}));

app.patch('/api/users/:id', admin, wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) throw new HttpError(404, 'Utilisateur introuvable');
  const b = req.body || {};
  if (u.id === req.user.id && (b.active === false || (b.role && b.role !== 'admin'))) {
    throw new HttpError(400, 'Vous ne pouvez pas désactiver ou rétrograder votre propre compte');
  }
  const role = ['admin', 'engineer', 'client'].includes(b.role) ? b.role : u.role;
  const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
  db.prepare('UPDATE users SET name = ?, email = ?, role = ?, active = ? WHERE id = ?')
    .run(String(b.name ?? u.name), String(b.email ?? u.email).trim(), role, active, u.id);
  if (b.password) {
    if (String(b.password).length < 8) throw new HttpError(400, 'Mot de passe : 8 caractères minimum');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
  }
  if (!active || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ ok: true });
}));

// ---------- erreurs ----------

app.use('/api', (req, _res, next) => next(new HttpError(404, 'Route inconnue')));

app.use((err, req, res, _next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Erreur interne du serveur' : err.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`[ora-itsm] Serveur démarré sur http://0.0.0.0:${PORT}`));
}

module.exports = app;
