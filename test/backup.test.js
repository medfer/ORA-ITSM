const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { backup, parseArgs } = require('../server/backup');

test('backup: consistent copy, attachments, rotation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ora-backup-'));
  try {
    const env = { DATA_DIR: path.join(dir, 'data') };
    fs.mkdirSync(path.join(env.DATA_DIR, 'uploads'), { recursive: true });
    fs.writeFileSync(path.join(env.DATA_DIR, 'uploads', 'a.png'), 'img');
    const live = new DatabaseSync(path.join(env.DATA_DIR, 'ora-itsm.db'));
    live.exec("PRAGMA journal_mode = WAL; CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('x')");

    const dest = path.join(dir, 'backups');
    for (let s = 0; s < 4; s++) backup({ dest, keep: 2 }, env, new Date(2026, 0, 1, 2, 0, s));
    const r = backup({ dest, keep: 2, prefix: 'pre-update', dbOnly: true }, env, new Date(2026, 0, 2));
    live.close();

    assert.deepStrictEqual(fs.readdirSync(dest).sort(), [
      'ora-itsm-20260101-020002-uploads', 'ora-itsm-20260101-020002.db',
      'ora-itsm-20260101-020003-uploads', 'ora-itsm-20260101-020003.db',
      'pre-update-20260102-000000.db',
    ]);
    assert.strictEqual(r.uploads, null);
    const copy = new DatabaseSync(r.db);
    assert.strictEqual(copy.prepare('SELECT v FROM t').get().v, 'x');
    copy.close();
    assert.strictEqual(fs.readFileSync(path.join(dest, 'ora-itsm-20260101-020003-uploads', 'a.png'), 'utf8'), 'img');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('backup: argument parsing', () => {
  assert.deepStrictEqual(parseArgs(['D:\\bk', '--keep', '7', '--db-only']),
    { dest: 'D:\\bk', keep: 7, prefix: 'ora-itsm', dbOnly: true });
  assert.throws(() => parseArgs(['--keep', '0']));
  assert.throws(() => parseArgs(['--prefix', '../x']));
});
