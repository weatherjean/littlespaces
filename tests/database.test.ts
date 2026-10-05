import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const directory = mkdtempSync(join(tmpdir(), 'little-database-'));
process.env.APP_DATA_DIR = directory;
const { workspace } = await import('../src/lib/server/database');
after(() => rmSync(directory, { recursive: true, force: true }));

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
