const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const {
  db, DB_FILE, UPLOAD_DIR, getSettings, setSetting, hashPassword, verifyPassword, DEFAULT_SETTINGS,
} = require('./db');
const sla = require('./sla');

const PORT = Number(process.env.PORT) || 8080;
const SESSION_DAYS = 7;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 20;

const STATUSES = ['new', 'in_progress', 'pending_client', 'pending_microsoft', 'resolved', 'closed', 'cancelled'];
const OPEN_STATUSES = ['new', 'in_progress', 'pending_client', 'pending_microsoft'];
const PAUSE_STATUSES = ['pending_client'];
const TYPES = ['incident', 'request', 'change', 'problem'];

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- helpers ----------

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

// UTC bounds of a local month 'YYYY-MM', using the client's UTC offset.
function monthRange(month, settings) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new HttpError(400, 'Invalid month (expected YYYY-MM)');
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

// ---------- authentication ----------

// Simple brute-force protection: 10 failed attempts per IP+email in 15 minutes.
const failedLogins = new Map();
const LOGIN_WINDOW = 15 * 60000;
const LOGIN_MAX = 10;

function loginKey(req, email) {
  return `${req.ip}|${String(email || '').toLowerCase()}`;
}

function auth(req, _res, next) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(new HttpError(401, 'Not authenticated'));
  const row = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.active, s.expires_at
                          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!row || !row.active || row.expires_at < Date.now()) return next(new HttpError(401, 'Session expired'));
  req.user = { id: row.id, name: row.name, email: row.email, role: row.role };
  req.token = token;
  next();
}

const requireRole = (...roles) => (req, _res, next) =>
  roles.includes(req.user.role) ? next() : next(new HttpError(403, 'Access denied'));
const staff = requireRole('admin', 'engineer');
const admin = requireRole('admin');

app.post('/api/login', wrap((req, res) => {
  const { email, password } = req.body || {};
  const key = loginKey(req, email);
  const now = Date.now();
  const attempts = (failedLogins.get(key) || []).filter((t) => now - t < LOGIN_WINDOW);
  if (attempts.length >= LOGIN_MAX) {
    throw new HttpError(429, 'Too many failed attempts. Please wait 15 minutes and try again.');
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email || '').trim());
  if (!user || !user.active || !verifyPassword(String(password || ''), user.password_hash)) {
    attempts.push(now);
    failedLogins.set(key, attempts);
    throw new HttpError(401, 'Incorrect email or password');
  }
  failedLogins.delete(key);
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)')
    .run(token, user.id, now + SESSION_DAYS * 86400000);
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
  if (!verifyPassword(String(current || ''), user.password_hash)) throw new HttpError(400, 'Current password is incorrect');
  if (String(pwd || '').length < 8) throw new HttpError(400, 'New password must be at least 8 characters');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(pwd), req.user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token <> ?').run(req.user.id, req.token);
  res.json({ ok: true });
}));

// ---------- reference data ----------

app.get('/api/meta', wrap((req, res) => {
  const settings = getSettings();
  res.json({
    settings,
    statuses: STATUSES,
    open_statuses: OPEN_STATUSES,
    types: TYPES,
    policies: Object.values(policies()),
    users: db.prepare('SELECT id, name, role FROM users WHERE active = 1 ORDER BY name').all(),
    max_upload_mb: MAX_UPLOAD_MB,
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
      (SELECT COALESCE(SUM(minutes), 0) FROM time_entries te WHERE te.ticket_id = t.id) AS time_minutes,
      (SELECT COUNT(*) FROM attachments at WHERE at.ticket_id = t.id) AS attachment_count
    FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY CASE WHEN t.status IN ('resolved','closed','cancelled') THEN 1 ELSE 0 END, t.priority, t.created_at DESC
    LIMIT 2000`).all(...args);
  const pols = policies();
  const now = Date.now();
  res.json(rows.map((t) => decorate(t, pols, settings, now)));
}));

app.post('/api/tickets', wrap((req, res) => {
  const b = req.body || {};
  const settings = getSettings();
  const pols = policies();
  const title = String(b.title || '').trim();
  if (!title) throw new HttpError(400, 'Title is required');
  const priority = pols[b.priority] ? b.priority : 'P3';
  const type = TYPES.includes(b.type) ? b.type : 'incident';
  const now = Date.now();
  const isClient = req.user.role === 'client';
  let createdAt = now;
  if (!isClient && b.created_at) {
    createdAt = Number(new Date(b.created_at)) || now;
    if (createdAt > now) throw new HttpError(400, 'Opening date cannot be in the future');
  }
  const dues = sla.computeDues({ created_at: createdAt, paused_minutes: 0 }, pols[priority], settings.business_hours);
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
  if (!t) throw new HttpError(404, 'Ticket not found');
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
  const attachments = db.prepare(`SELECT a.id, a.filename, a.mime, a.size, a.user_id, a.created_at, u.name AS user_name
    FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.ticket_id = ? ORDER BY a.created_at`).all(t.id);
  res.json({
    ticket: decorate({ ...t, time_minutes: time.reduce((s, e) => s + e.minutes, 0) }, policies(), settings),
    comments,
    time: isClient ? [] : time,
    history: isClient ? [] : history,
    attachments,
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
  if (upd.title !== undefined && !upd.title.trim()) throw new HttpError(400, 'Title is required');
  if (b.type !== undefined && TYPES.includes(b.type) && b.type !== t.type) upd.type = b.type;
  if (b.assignee_id !== undefined) {
    const a = b.assignee_id ? Number(b.assignee_id) : null;
    if (a !== t.assignee_id) upd.assignee_id = a;
  }

  let pausedMinutes = t.paused_minutes;
  let pausedAt = t.paused_at;
  const policy = pols[b.priority && pols[b.priority] ? b.priority : t.priority];

  if (b.status !== undefined && b.status !== t.status) {
    if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Invalid status');
    upd.status = b.status;
    // Pause / resume the resolution SLA clock
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
    if (!pols[b.priority]) throw new HttpError(400, 'Invalid priority');
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
  const t = loadTicket(req.params.id);
  const files = db.prepare('SELECT stored_as FROM attachments WHERE ticket_id = ?').all(t.id);
  db.prepare('DELETE FROM tickets WHERE id = ?').run(t.id);
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_as), { force: true }, () => {});
  res.json({ ok: true });
}));

app.post('/api/tickets/:id/comments', wrap((req, res) => {
  const t = loadTicket(req.params.id);
  const body = String(req.body?.body || '').trim();
  if (!body) throw new HttpError(400, 'Comment is empty');
  const isStaff = req.user.role !== 'client';
  const internal = isStaff && req.body?.internal ? 1 : 0;
  const now = Date.now();
  db.prepare('INSERT INTO comments (ticket_id, user_id, body, internal, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(t.id, req.user.id, body, internal, now);
  // A public reply from the support team counts as the SLA first response
  if (isStaff && !internal && !t.first_response_at) {
    db.prepare('UPDATE tickets SET first_response_at = ?, updated_at = ? WHERE id = ?').run(now, now, t.id);
  } else {
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, t.id);
  }
  res.status(201).json({ ok: true });
}));

// ---------- attachments ----------

app.post('/api/tickets/:id/attachments',
  express.raw({ type: () => true, limit: `${MAX_UPLOAD_MB}mb` }),
  wrap((req, res) => {
    const t = loadTicket(req.params.id);
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Empty file');
    let filename = 'file';
    try { filename = decodeURIComponent(req.get('x-filename') || 'file'); } catch { /* keep default */ }
    filename = path.basename(filename).replace(/[\u0000-\u001f"\\/]/g, '_').slice(0, 200) || 'file';
    const mime = String(req.get('x-mime') || 'application/octet-stream').split(';')[0].slice(0, 100);
    const storedAs = `${t.id}-${crypto.randomBytes(12).toString('hex')}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, storedAs), req.body);
    const now = Date.now();
    db.prepare(`INSERT INTO attachments (ticket_id, user_id, filename, mime, size, stored_as, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(t.id, req.user.id, filename, mime, req.body.length, storedAs, now);
    db.prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now, t.id);
    res.status(201).json({ ok: true });
  }));

function loadAttachment(id) {
  const a = db.prepare('SELECT * FROM attachments WHERE id = ?').get(Number(id));
  if (!a) throw new HttpError(404, 'Attachment not found');
  return a;
}

app.get('/api/attachments/:id', wrap((req, res) => {
  const a = loadAttachment(req.params.id);
  const file = path.join(UPLOAD_DIR, a.stored_as);
  if (!fs.existsSync(file)) throw new HttpError(404, 'File missing on disk');
  // Only images are rendered inline; everything else is forced to download
  const inline = /^image\/(png|jpe?g|gif|webp)$/.test(a.mime) && req.query.inline === '1';
  res.set('Content-Type', inline ? a.mime : 'application/octet-stream');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
  res.sendFile(file);
}));

app.delete('/api/attachments/:id', staff, wrap((req, res) => {
  const a = loadAttachment(req.params.id);
  if (req.user.role !== 'admin' && a.user_id !== req.user.id) throw new HttpError(403, 'Access denied');
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  fs.rm(path.join(UPLOAD_DIR, a.stored_as), { force: true }, () => {});
  res.json({ ok: true });
}));

// ---------- time tracking ----------

function validateEntry(b) {
  const minutes = Math.round(Number(b.minutes));
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 24 * 60) throw new HttpError(400, 'Invalid duration');
  const workDate = String(b.work_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new HttpError(400, 'Invalid date');
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
  if (!e) throw new HttpError(404, 'Time entry not found');
  if (req.user.role !== 'admin' && e.user_id !== req.user.id) throw new HttpError(403, 'Access denied');
  const b = { ...e, ...req.body };
  const { minutes, workDate } = validateEntry(b);
  db.prepare('UPDATE time_entries SET work_date = ?, minutes = ?, description = ?, billable = ? WHERE id = ?')
    .run(workDate, minutes, String(b.description || ''), b.billable === false || b.billable === 0 ? 0 : 1, e.id);
  res.json({ ok: true });
}));

app.delete('/api/time/:id', staff, wrap((req, res) => {
  const e = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(Number(req.params.id));
  if (!e) throw new HttpError(404, 'Time entry not found');
  if (req.user.role !== 'admin' && e.user_id !== req.user.id) throw new HttpError(403, 'Access denied');
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(e.id);
  res.json({ ok: true });
}));

// ---------- dashboard & reports ----------

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
  const byStatus = {};
  for (const t of open) byStatus[t.status] = (byStatus[t.status] || 0) + 1;
  const recent = db.prepare(`SELECT t.*, a.name AS assignee_name FROM tickets t LEFT JOIN users a ON a.id = t.assignee_id
    ORDER BY t.updated_at DESC LIMIT 8`).all().map((t) => decorate(t, pols, settings, now));
  const mine = req.user.role === 'client' ? [] : open.filter((t) => t.assignee_id === req.user.id);
  const report = monthlyReport(month, settings);
  // Linear projection of billable hours to the end of the month
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = Number(new Date(now + (settings.business_hours?.offset || 0) * 60000).toISOString().slice(8, 10));
  res.json({
    month,
    contract_minutes: (Number(settings.contract_hours_month) || 0) * 60,
    used_minutes: used,
    projected_minutes: Math.round((used / Math.max(1, today)) * daysInMonth),
    open_count: open.length,
    created, resolved,
    by_priority: byPriority,
    by_status: byStatus,
    sla_response_pct: report.sla.response_pct,
    sla_resolution_pct: report.sla.resolution_pct,
    breached: open.filter((t) => t.sla_response === 'breached' || t.sla_resolution === 'breached'),
    at_risk: open.filter((t) => t.sla_response !== 'breached' && t.sla_resolution !== 'breached'
      && (t.sla_response === 'at_risk' || t.sla_resolution === 'at_risk')),
    unassigned: open.filter((t) => !t.assignee_id).length,
    mine,
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
  // Every ticket handled during the month: created, resolved, time logged, or still open over the period
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

  // SLA compliance: response on tickets created this month (only once met or breached),
  // resolution on tickets resolved this month.
  const respEval = created.filter((t) => t.sla_response === 'met' || t.sla_response === 'breached');
  const resEval = resolved.filter((t) => t.status !== 'cancelled');
  const billable = entries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0);
  const total = entries.reduce((s, e) => s + e.minutes, 0);
  const contract = (Number(settings.contract_hours_month) || 0) * 60;

  const catMinutes = {};
  const byId = new Map(worked.map((w) => [w.id, w]));
  for (const e of entries) {
    const t = e.ticket_id ? byId.get(e.ticket_id) : null;
    const k = t ? (t.category || '—') : 'Non-ticket work';
    catMinutes[k] = (catMinutes[k] || 0) + e.minutes;
  }
  const resolvedTimes = resEval.map((t) => (t.resolved_at - t.created_at) / 60000);

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
      avg_resolution_minutes: resolvedTimes.length ? Math.round(resolvedTimes.reduce((a, b) => a + b, 0) / resolvedTimes.length) : null,
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
    // Clients see the summary and entries, without the per-engineer breakdown
    report.hours.by_user = {};
    report.entries = report.entries.map(({ user_name, ...e }) => e);
  }
  res.json(report);
}));

function csv(rows, columns) {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map((c) => esc(c[0])).join(','), ...rows.map((r) => columns.map((c) => esc(c[1](r))).join(','))].join('\r\n');
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
      ['Number', (t) => t.number], ['Title', (t) => t.title], ['Type', (t) => t.type], ['Priority', (t) => t.priority],
      ['Status', (t) => t.status], ['Category', (t) => t.category], ['Requester', (t) => t.requester_name],
      ['Assignee', (t) => t.assignee_name], ['Microsoft case', (t) => t.ms_case],
      ['Created', (t) => fmtDate(t.created_at, settings)], ['First response', (t) => fmtDate(t.first_response_at, settings)],
      ['Resolved', (t) => fmtDate(t.resolved_at, settings)], ['Response SLA', (t) => t.sla_response],
      ['Resolution SLA', (t) => t.sla_resolution], ['Hours (month)', (t) => (t.month_minutes / 60).toFixed(2)],
      ['Hours (total)', (t) => (t.time_minutes / 60).toFixed(2)],
    ]);
  } else {
    body = csv(report.entries, [
      ['Date', (e) => e.work_date], ['Ticket', (e) => e.ticket_number || ''], ['Ticket title', (e) => e.ticket_title || ''],
      ['Engineer', (e) => (req.user.role === 'client' ? '' : e.user_name)], ['Description', (e) => e.description],
      ['Minutes', (e) => e.minutes], ['Hours', (e) => (e.minutes / 60).toFixed(2)],
      ['Billable', (e) => (e.billable ? 'Yes' : 'No')],
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
      if (!Number.isFinite(v) || v < 0) throw new HttpError(400, `Invalid value: ${key}`);
    }
    if (key === 'categories' && !Array.isArray(v)) throw new HttpError(400, 'Invalid categories');
    if (key === 'business_hours') {
      if (!/^\d{2}:\d{2}$/.test(v.start) || !/^\d{2}:\d{2}$/.test(v.end)) throw new HttpError(400, 'Invalid business hours');
      v = { offset: Number(v.offset) || 0, days: (v.days || []).map(Number).filter((d) => d >= 0 && d <= 6), start: v.start, end: v.end };
    }
    setSetting(key, v);
  }
  res.json(getSettings());
}));

app.put('/api/sla/:priority', admin, wrap((req, res) => {
  const b = req.body || {};
  const p = db.prepare('SELECT * FROM sla_policies WHERE priority = ?').get(req.params.priority);
  if (!p) throw new HttpError(404, 'Unknown priority');
  const resp = Math.round(Number(b.response_min ?? p.response_min));
  const reso = Math.round(Number(b.resolution_min ?? p.resolution_min));
  if (!(resp > 0 && reso > 0)) throw new HttpError(400, 'Invalid targets');
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
  if (!b.name || !b.email) throw new HttpError(400, 'Name and email are required');
  if (!['admin', 'engineer', 'client'].includes(b.role)) throw new HttpError(400, 'Invalid role');
  if (String(b.password || '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  try {
    db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(String(b.name), String(b.email).trim(), hashPassword(b.password), b.role, Date.now());
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'This email already exists');
    throw e;
  }
  res.status(201).json({ ok: true });
}));

app.patch('/api/users/:id', admin, wrap((req, res) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!u) throw new HttpError(404, 'User not found');
  const b = req.body || {};
  if (u.id === req.user.id && (b.active === false || (b.role && b.role !== 'admin'))) {
    throw new HttpError(400, 'You cannot deactivate or demote your own account');
  }
  const role = ['admin', 'engineer', 'client'].includes(b.role) ? b.role : u.role;
  const active = b.active === undefined ? u.active : (b.active ? 1 : 0);
  try {
    db.prepare('UPDATE users SET name = ?, email = ?, role = ?, active = ? WHERE id = ?')
      .run(String(b.name ?? u.name), String(b.email ?? u.email).trim(), role, active, u.id);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'This email already exists');
    throw e;
  }
  if (b.password) {
    if (String(b.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(b.password), u.id);
  }
  if (!active || b.password) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
  res.json({ ok: true });
}));

function dirSize(dir) {
  let total = 0;
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    if (f.isFile()) total += fs.statSync(path.join(dir, f.name)).size;
  }
  return total;
}

app.get('/api/admin/system', admin, wrap((req, res) => {
  const size = (f) => (fs.existsSync(f) ? fs.statSync(f).size : 0);
  const n = (sql) => db.prepare(sql).get().n;
  res.json({
    db_file: DB_FILE,
    db_bytes: size(DB_FILE) + size(`${DB_FILE}-wal`),
    upload_dir: UPLOAD_DIR,
    upload_bytes: dirSize(UPLOAD_DIR),
    counts: {
      tickets: n('SELECT COUNT(*) AS n FROM tickets'),
      time_entries: n('SELECT COUNT(*) AS n FROM time_entries'),
      users: n('SELECT COUNT(*) AS n FROM users'),
      attachments: n('SELECT COUNT(*) AS n FROM attachments'),
    },
    node: process.version,
    host: os.hostname(),
  });
}));

// Consistent hot copy of the SQLite database, downloaded by the browser
app.get('/api/admin/backup', admin, wrap((req, res) => {
  const tmp = path.join(os.tmpdir(), `ora-itsm-backup-${crypto.randomBytes(6).toString('hex')}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  res.download(tmp, `ora-itsm-backup-${stamp}.db`, () => fs.rm(tmp, { force: true }, () => {}));
}));

// ---------- errors ----------

app.use('/api', (req, _res, next) => next(new HttpError(404, 'Unknown route')));

app.use((err, req, res, _next) => {
  let status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  let message = err.message;
  if (err.type === 'entity.too.large') { status = 413; message = `File too large (max ${MAX_UPLOAD_MB} MB)`; }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`[ora-itsm] Server running at http://localhost:${PORT}`));
}

module.exports = app;
