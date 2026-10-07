import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataDir } from './config';

// Database opening, schema compatibility, and connection lifetime live here.
// Storage operations remain in storage.ts; neither module caches connections.
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export const appletDir = join(dataDir, 'applets');
mkdirSync(appletDir, { recursive: true, mode: 0o700 });
const photoSchema = `CREATE TABLE IF NOT EXISTS photos (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));`;
const schema = `
  CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS revisions (
    version INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL,
    description TEXT NOT NULL, source TEXT NOT NULL, bundle TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );`;
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function open(path: string) {
  const db = new DatabaseSync(path);
  try {
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function withApplet<T>(id: string, run: (db: DatabaseSync) => T, create = false): T {
  if (!uuid.test(id)) throw new Error('Invalid applet ID.');
  const path = join(appletDir, `${id}.sqlite`);
  if (!create && !existsSync(path)) throw new Error('Applet not found.');
  const db = open(path);
  try {
    if (create) db.exec(schema);
    const columns = db.prepare('PRAGMA table_info(revisions)').all();
    for (const name of [
      'backend',
      'backendBundle',
      'testReport',
      'chatInstructions',
      'changeSummary',
      'requestedChange',
    ]) {
      if (!columns.some((column) => column.name === name))
        db.exec(`ALTER TABLE revisions ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
    }
    if (!columns.some((column) => column.name === 'restoredFrom'))
      db.exec('ALTER TABLE revisions ADD COLUMN restoredFrom INTEGER');
    db.exec(photoSchema);
    return run(db);
  } finally {
    db.close();
  }
}

export function workspace<T>(run: (db: DatabaseSync) => T): T {
  const db = open(join(dataDir, 'workspace.sqlite'));
  try {
    db.exec(
      'CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, thread TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL);',
    );
    db.exec(`CREATE TABLE IF NOT EXISTS spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));
      CREATE TABLE IF NOT EXISTS space_applets (applet_id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id));`);
    db.exec(`CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES spaces(id), title TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')));`);
    db.exec(`CREATE TABLE IF NOT EXISTS chat_tools (id TEXT PRIMARY KEY, thread TEXT NOT NULL, message_id INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, due_at TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, UNIQUE(space_id,key));`);
    db.exec(`CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, description TEXT NOT NULL, ciphertext TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, space_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, cron TEXT, timezone TEXT NOT NULL, model TEXT NOT NULL, next_run TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_run TEXT, last_error TEXT, UNIQUE(space_id,key));
      CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, subscription TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS push_deliveries (endpoint TEXT NOT NULL, notification_id TEXT NOT NULL, fingerprint TEXT NOT NULL, PRIMARY KEY(endpoint,notification_id));`);
    db.exec(
      'CREATE TABLE IF NOT EXISTS build_drafts (chat_id TEXT PRIMARY KEY, data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS build_plans (chat_id TEXT PRIMARY KEY, data TEXT NOT NULL)',
    );
    if (
      !db
        .prepare('PRAGMA table_info(secrets)')
        .all()
        .some((row) => row.name === 'origins')
    )
      db.exec("ALTER TABLE secrets ADD COLUMN origins TEXT NOT NULL DEFAULT '[]'");
    db.exec(`CREATE TABLE IF NOT EXISTS voice_actions (
      id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS voice_actions_chat ON voice_actions(chat_id);`);
    db.exec(photoSchema);
    db.exec(`CREATE INDEX IF NOT EXISTS messages_thread_id ON messages(thread,id);
      CREATE INDEX IF NOT EXISTS chats_space ON chats(space_id);
      CREATE INDEX IF NOT EXISTS space_applets_space ON space_applets(space_id);
      CREATE INDEX IF NOT EXISTS chat_tools_thread_message ON chat_tools(thread,message_id);
      CREATE INDEX IF NOT EXISTS photos_owner ON photos(owner);`);
    if (
      !db
        .prepare('PRAGMA table_info(schedules)')
        .all()
        .some((row) => row.name === 'revision')
    )
      db.exec('ALTER TABLE schedules ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='notification_delete_deliveries'",
        )
        .get()
    )
      db.exec(`BEGIN;
      DELETE FROM push_deliveries WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE id=notification_id)
        OR NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE push_subscriptions.endpoint=push_deliveries.endpoint);
      CREATE TRIGGER notification_delete_deliveries AFTER DELETE ON notifications
      BEGIN DELETE FROM push_deliveries WHERE notification_id=OLD.id; END;
      CREATE TRIGGER IF NOT EXISTS subscription_delete_deliveries AFTER DELETE ON push_subscriptions
      BEGIN DELETE FROM push_deliveries WHERE endpoint=OLD.endpoint; END;
      COMMIT;`);
    if (
      !db
        .prepare('PRAGMA table_info(spaces)')
        .all()
        .some((row) => row.name === 'archived')
    )
      db.exec('ALTER TABLE spaces ADD COLUMN archived INTEGER NOT NULL DEFAULT 0');
    if (
      !db
        .prepare('PRAGMA table_info(chats)')
        .all()
        .some((row) => row.name === 'launch')
    )
      db.exec("ALTER TABLE chats ADD COLUMN launch TEXT NOT NULL DEFAULT '{}'");
    if (
      !db
        .prepare('PRAGMA table_info(messages)')
        .all()
        .some((row) => row.name === 'photos')
    )
      db.exec("ALTER TABLE messages ADD COLUMN photos TEXT NOT NULL DEFAULT '[]'");
    return run(db);
  } finally {
    db.close();
  }
}
