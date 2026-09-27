const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'ora-itsm.db');

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
`);

const DEFAULT_SETTINGS = {
  company_name: 'Black Star Iraq',
  client_name: 'ORA',
  contract_name: 'Support Microsoft ORA',
  contract_hours_month: 40,
  contract_start: new Date().toISOString().slice(0, 7),
  ticket_prefix: 'ORA',
  alert_threshold_pct: 80,
  business_hours: { offset: 180, days: [0, 1, 2, 3, 4], start: '08:00', end: '16:00' },
  categories: [
    'Microsoft 365', 'Exchange Online', 'Teams', 'SharePoint / OneDrive', 'Entra ID / Active Directory',
    'Intune / Endpoint', 'Azure', 'Windows Server', 'SQL Server', 'Sécurité / Defender', 'Licences', 'Autre',
  ],
};

const DEFAULT_SLA = [
  ['P1', 'Critique', 30, 240, 0],
  ['P2', 'Haute', 60, 480, 1],
  ['P3', 'Moyenne', 240, 1440, 1],
  ['P4', 'Basse', 480, 2400, 1],
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
  for (const row of db.prepare('SELECT key, value FROM settings').all()) {
    try { out[row.key] = JSON.parse(row.value); } catch { /* ignore valeur corrompue */ }
  }
  return out;
}

function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

function seed() {
  const insertPolicy = db.prepare(
    'INSERT OR IGNORE INTO sla_policies (priority, name, response_min, resolution_min, business_hours) VALUES (?, ?, ?, ?, ?)');
  for (const p of DEFAULT_SLA) insertPolicy.run(...p);

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM users').get();
  if (n === 0) {
    const email = process.env.ADMIN_EMAIL || 'admin@ora-itsm.local';
    const password = process.env.ADMIN_PASSWORD || 'ChangeMe!2026';
    db.prepare('INSERT INTO users (name, email, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('Administrateur', email, hashPassword(password), 'admin', Date.now());
    console.log(`[ora-itsm] Compte admin créé : ${email} (changez le mot de passe après la première connexion)`);
  } else {
    const admins = db.prepare("SELECT email FROM users WHERE role = 'admin' AND active = 1").all().map((u) => u.email);
    console.log(`[ora-itsm] Comptes admin : ${admins.join(', ') || 'aucun'} (ADMIN_EMAIL/ADMIN_PASSWORD ignorés : la base existe déjà)`);
  }
}

seed();

module.exports = { db, DB_FILE, getSettings, setSetting, hashPassword, verifyPassword, DEFAULT_SETTINGS };
