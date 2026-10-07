import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync(join(tmpdir(), 'little-database-'));
process.env.APP_DATA_DIR = directory;
const { workspace, withApplet } = await import('../src/lib/server/database');
after(() => rmSync(directory, { recursive: true, force: true }));

test('upgrading an original app database preserves code, records, and custom tables on repeated opens', () => {
  const id = '10000000-0000-4000-8000-000000000001';
  // Create the historical schema directly, without using today's storage initializer.
  const legacy = new DatabaseSync(join(directory, 'applets', `${id}.sqlite`));
  legacy.exec(`
    CREATE TABLE records (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE revisions (
      version INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
      description TEXT NOT NULL, source TEXT NOT NULL, bundle TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO records VALUES ('saved', '{"name":"Fern","waterings":7}');
    INSERT INTO revisions VALUES (1, 'Garden', 'Keep me', '<p>Garden</p>', 'compiled code', '2026-01-01');
    INSERT INTO revisions VALUES (2, 'Garden v2', 'Keep me too', '<p>Updated</p>', 'updated code', '2026-01-02');
    CREATE TABLE journal (id INTEGER PRIMARY KEY, content BLOB NOT NULL);
    INSERT INTO journal VALUES (1, X'000102ff');
  `);
  legacy.close();
  for (let restart = 0; restart < 2; restart++) {
    withApplet(id, (db) => {
      assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check, 'ok');
      const revisions = db.prepare('SELECT * FROM revisions ORDER BY version').all();
      assert.equal(revisions.length, 2);
      assert.equal(revisions[0].source, '<p>Garden</p>');
      assert.equal(revisions[1].bundle, 'updated code');
      assert.equal(revisions[1].created_at, '2026-01-02');
      for (const row of revisions)
        for (const field of ['backend', 'backendBundle', 'testReport', 'chatInstructions'])
          assert.equal(row[field], '');
      assert.equal(
        db.prepare('SELECT value FROM records WHERE key=?').get('saved')!.value,
        '{"name":"Fern","waterings":7}',
      );
      assert.equal(db.prepare('SELECT hex(content) AS data FROM journal').get()!.data, '000102FF');
    });
  }
});

test('existing schedules migrate without losing data and orphan push receipts are removed once', () => {
  workspace((db) => {
    db.exec(`ALTER TABLE schedules DROP COLUMN revision;
      DROP TRIGGER notification_delete_deliveries;
      DROP TRIGGER subscription_delete_deliveries;
      INSERT INTO schedules(id,space_id,key,title,prompt,timezone,model,next_run)
        VALUES('job','space','check','Check','Keep this prompt','UTC','model','2099-01-01T00:00:00.000Z');
      INSERT INTO notifications(id,space_id,key,title,body,due_at) VALUES('kept','space','check','Check','Keep','2000-01-01');
      INSERT INTO push_subscriptions VALUES('device','{}','2000-01-01');
      INSERT INTO push_deliveries VALUES('device','kept','keep');
      INSERT INTO push_deliveries VALUES('device','deleted','orphan');
      INSERT INTO push_deliveries VALUES('deleted-device','kept','orphan');`);
  });
  for (let i = 0; i < 2; i++)
    workspace((db) => {
      const job = db.prepare('SELECT * FROM schedules WHERE id=?').get('job')!;
      assert.equal(job.revision, 1);
      assert.equal(job.prompt, 'Keep this prompt');
      assert.equal(job.next_run, '2099-01-01T00:00:00.000Z');
      const receipts = db.prepare('SELECT * FROM push_deliveries').all();
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].fingerprint, 'keep');
    });
  workspace((db) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run('device');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM push_deliveries').get()!.n, 0);
  });
});
