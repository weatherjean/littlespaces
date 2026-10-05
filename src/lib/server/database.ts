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
  chmodSync(path, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  return db;
}

export function withApplet<T>(id: string, run: (db: DatabaseSync) => T, create = false): T {
  if (!uuid.test(id)) throw new Error('Invalid applet ID.');
  const path = join(appletDir, `${id}.sqlite`);
  if (!create && !existsSync(path)) throw new Error('Applet not found.');
  const db = open(path);
  try {
    if (create) db.exec(schema);
    const columns = db.prepare('PRAGMA table_info(revisions)').all();
    for (const name of ['backend', 'backendBundle', 'testReport', 'chatInstructions']) {
      if (!columns.some((column) => column.name === name))
        db.exec(`ALTER TABLE revisions ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
    }
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
    db.exec(photoSchema);
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
