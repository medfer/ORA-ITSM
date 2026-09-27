const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, 'ora-itsm.db'));
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','engineer','client')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sla_policies (
  priority       TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  response_min   INTEGER NOT NULL,
  resolution_min INTEGER NOT NULL,
  business_hours INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS tickets (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  type              TEXT NOT NULL DEFAULT 'incident',
  priority          TEXT NOT NULL REFERENCES sla_policies(priority),
  status            TEXT NOT NULL DEFAULT 'new',
  category          TEXT NOT NULL DEFAULT '',
  requester_name    TEXT NOT NULL DEFAULT '',
  requester_email   TEXT NOT NULL DEFAULT '',
  assignee_id       INTEGER REFERENCES users(id),
  created_by        INTEGER REFERENCES users(id),
  ms_case           TEXT NOT NULL DEFAULT '',
  resolution        TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  first_response_at INTEGER,
  resolved_at       INTEGER,
  closed_at         INTEGER,
  response_due      INTEGER NOT NULL,
  resolution_due    INTEGER NOT NULL,
  paused_at         INTEGER,
  paused_minutes    REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created ON tickets(created_at);

CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  internal   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS time_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  work_date   TEXT NOT NULL,
  minutes     INTEGER NOT NULL CHECK (minutes > 0),
  description TEXT NOT NULL DEFAULT '',
  billable    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_time_date ON time_entries(work_date);

CREATE TABLE IF NOT EXISTS ticket_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  field      TEXT NOT NULL,
  old_value  TEXT,
  new_value  TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  size       INTEGER NOT NULL,
  stored_as  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachments_ticket ON attachments(ticket_id);
`);

// Lightweight migrations for databases created by earlier versions
const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
if (!userCols.includes('entra_oid')) db.exec('ALTER TABLE users ADD COLUMN entra_oid TEXT');
if (!userCols.includes('last_login_at')) db.exec('ALTER TABLE users ADD COLUMN last_login_at INTEGER');
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_entra_oid ON users(entra_oid) WHERE entra_oid IS NOT NULL');
if (!userCols.includes('notify')) db.exec('ALTER TABLE users ADD COLUMN notify INTEGER NOT NULL DEFAULT 1');

db.exec(`
CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  event      TEXT NOT NULL,
  ticket_id  INTEGER,
  recipients TEXT NOT NULL,
  subject    TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT
);
CREATE TABLE IF NOT EXISTS notification_flags (
  key        TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
`);

const DEFAULT_SETTINGS = {
  company_name: 'Black Star Iraq',
  client_name: 'ORA',
  contract_name: 'ORA Microsoft Support',
  contract_hours_month: 40,
  contract_start: new Date().toISOString().slice(0, 7),
  ticket_prefix: 'ORA',
  alert_threshold_pct: 80,
  business_hours: { offset: 180, days: [0, 1, 2, 3, 4], start: '08:00', end: '16:00' },
  categories: [
    'Microsoft 365', 'Exchange Online', 'Teams', 'SharePoint / OneDrive', 'Entra ID / Active Directory',
    'Intune / Endpoint', 'Azure', 'Windows Server', 'SQL Server', 'Security / Defender', 'Licensing', 'Other',
  ],
};

const DEFAULT_SLA = [
  ['P1', 'Critical', 30, 240, 0],
  ['P2', 'High', 60, 480, 1],
  ['P3', 'Medium', 240, 1440, 1],
  ['P4', 'Low', 480, 2400, 1],
];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  // Secrets (e.g. the mail client secret) are never part of the settings sent to browsers
  for (const row of db.prepare("SELECT key, value FROM settings WHERE key NOT LIKE 'secret_%'").all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* ignore corrupted value */ }
  }
  return out;
}

function getSecret(name) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`secret_${name}`);
  try { return row ? JSON.parse(row.value) : ''; } catch { return ''; }
}

function setSecret(name, value) {
  setSetting(`secret_${name}`, String(value || ''));
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function seed() {
  const insertPolicy = db.prepare(
    'INSERT OR IGNORE INTO sla_policies (priority, name, response_min, resolution_min, business_hours) VALUES (?, ?, ?, ?, ?)');
  for (const p of DEFAULT_SLA) insertPolicy.run(...p);

  // Databases created by the first (French) version: rename untouched default SLA names
  const legacy = { P1: 'Critique', P2: 'Haute', P3: 'Moyenne', P4: 'Basse' };
  const rename = db.prepare('UPDATE sla_policies SET name = ? WHERE priority = ? AND name = ?');
  for (const [p, name] of DEFAULT_SLA) rename.run(name, p, legacy[p]);

  // Databases created by the first (French) version: translate untouched default values
  db.prepare("UPDATE users SET name = 'Administrator' WHERE name = 'Administrateur'").run();
  const legacyCategories = { 'Sécurité / Defender': 'Security / Defender', Licences: 'Licensing', Autre: 'Other' };
  const renameCategory = db.prepare('UPDATE tickets SET category = ? WHERE category = ?');
  for (const [fr, en] of Object.entries(legacyCategories)) renameCategory.run(en, fr);
  const stored = (key) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    try { return row ? JSON.parse(row.value) : undefined; } catch { return undefined; }
  };
  const categories = stored('categories');
  if (Array.isArray(categories) && categories.some((c) => legacyCategories[c])) {
    setSetting('categories', categories.map((c) => legacyCategories[c] || c));
  }
  if (stored('contract_name') === 'Support Microsoft ORA') setSetting('contract_name', 'ORA Microsoft Support');

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@ora-itsm.local';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
    db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('Administrator', email, hashPassword(password), 'admin', Date.now());
    console.log(`[ora-itsm] Admin account created: ${email} (change the password after first login)`);
  } else {
    const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND active = 1").all().map((u) => u.email);
    console.log(`[ora-itsm] Admin accounts: ${admins.join(', ') || 'none'} (ADMIN_EMAIL/ADMIN_PASSWORD ignored: database already exists)`);
  }
  console.log(`[ora-itsm] Database: ${DB_FILE}`);
}

seed();

module.exports = {
  db, DATA_DIR, DB_FILE, UPLOAD_DIR, getSettings, setSetting, getSecret, setSecret, hashPassword, verifyPassword, DEFAULT_SETTINGS,
};
