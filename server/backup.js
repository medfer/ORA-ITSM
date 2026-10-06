// Consistent hot backup of the database (and attachments), safe while the application is running.
// Usage: node --env-file-if-exists=.env server/backup.js [destination] [--keep 30] [--prefix ora-itsm] [--db-only]
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function parseArgs(argv) {
  const opts = { dest: null, keep: 30, prefix: 'ora-itsm', dbOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') opts.keep = Number(argv[++i]);
    else if (a === '--prefix') opts.prefix = argv[++i];
    else if (a === '--db-only') opts.dbOnly = true;
    else if (!opts.dest) opts.dest = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isInteger(opts.keep) || opts.keep < 1) throw new Error('--keep must be a positive integer');
  if (!/^[\w-]+$/.test(opts.prefix || '')) throw new Error('--prefix may only contain letters, digits, - and _');
  return opts;
}

// Same locations as server/db.js
function locations(env = process.env) {
  const dataDir = path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data'));
  return {
    dataDir,
    dbFile: path.resolve(env.DB_FILE || path.join(dataDir, 'ora-itsm.db')),
    uploadDir: path.join(dataDir, 'uploads'),
  };
}

// Keeps the `keep` newest entries named <prefix>-<stamp><suffix>
function prune(dest, prefix, suffix, keep) {
  const re = new RegExp(`^${prefix}-\\d{8}-\\d{6}${suffix.replace('.', '\\.')}$`);
  const old = fs.readdirSync(dest).filter((f) => re.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dest, f), { recursive: true, force: true });
  return old.length;
}

function backup({ dest, keep = 30, prefix = 'ora-itsm', dbOnly = false }, env = process.env, now = new Date()) {
  const loc = locations(env);
  if (!fs.existsSync(loc.dbFile)) throw new Error(`Database not found: ${loc.dbFile}`);
  dest = path.resolve(dest || path.join(loc.dataDir, '..', 'backups'));
  fs.mkdirSync(dest, { recursive: true });

  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const dbOut = path.join(dest, `${prefix}-${stamp}.db`);

  const db = new DatabaseSync(loc.dbFile);
  try {
    db.exec('PRAGMA busy_timeout = 15000');
    db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
  } finally { db.close(); }

  let uploadsOut = null;
  if (!dbOnly && fs.existsSync(loc.uploadDir)) {
    uploadsOut = path.join(dest, `${prefix}-${stamp}-uploads`);
    fs.cpSync(loc.uploadDir, uploadsOut, { recursive: true });
  }

  const removed = prune(dest, prefix, '.db', keep) + prune(dest, prefix, '-uploads', keep);
  return { db: dbOut, uploads: uploadsOut, bytes: fs.statSync(dbOut).size, removed };
}

if (require.main === module) {
  try {
    const r = backup(parseArgs(process.argv.slice(2)));
    console.log(`Backup OK: ${r.db} (${(r.bytes / 1048576).toFixed(2)} MB)`);
    if (r.uploads) console.log(`Attachments: ${r.uploads}`);
    if (r.removed) console.log(`Old backups removed: ${r.removed}`);
  } catch (e) {
    console.error(`Backup FAILED: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { backup, parseArgs };
