import { appletDir, uuid, withApplet, workspace } from './database';
export { workspace } from './database';
import { logEvent } from './diagnostics';
import type { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Photo } from '../photo-types';
import type { Applet, Chat, Message, RecordEntry, Revision, Space } from '../types';

export function revision(id: string, version?: number): Revision {
  return withApplet(id, (db) => {
    const row =
      version === undefined
        ? db.prepare('SELECT * FROM revisions ORDER BY version DESC LIMIT 1').get()
        : db.prepare('SELECT * FROM revisions WHERE version = ?').get(version);
    if (!row) throw new Error('Revision not found.');
    return row as unknown as Revision;
  });
}

export function listApplets(): Applet[] {
  return readdirSync(appletDir)
    .filter((name) => name.endsWith('.sqlite') && uuid.test(name.slice(0, -7)))
    .flatMap((name) => appletInfo(name.slice(0, -7)) ?? [])
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function appletInfo(id: string): Applet | undefined {
  return withApplet(id, (db) => {
    const row = db
      .prepare(
        'SELECT title, description, version, created_at AS updatedAt FROM revisions ORDER BY version DESC LIMIT 1',
      )
      .get();
    return row ? ({ ...row, id } as Applet) : undefined;
  });
}

export function saveApplet(
  content: Omit<Revision, 'version'>,
  id: string = randomUUID(),
  spaceId?: string,
): Applet {
  if (spaceId) getSpace(spaceId);
  const existingSpace = workspace((db) =>
    db.prepare('SELECT space_id FROM space_applets WHERE applet_id = ?').get(id),
  );
  if (spaceId && existingSpace && existingSpace.space_id !== spaceId)
    throw new Error('This applet belongs to another space.');
  if (spaceId) {
    const other = workspace((db) =>
      db
        .prepare('SELECT applet_id FROM space_applets WHERE space_id = ? AND applet_id != ?')
        .get(spaceId, id),
    );
    if (other) throw new Error('A space has one applet. Update its existing applet instead.');
  }
  withApplet(
    id,
    (db) => {
      db.prepare(
        'INSERT INTO revisions (title, description, source, bundle, backend, backendBundle, testReport, chatInstructions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(
        content.title,
        content.description,
        content.source,
        content.bundle,
        content.backend || '',
        content.backendBundle || '',
        content.testReport || '',
        content.chatInstructions || '',
      );
    },
    true,
  );
  workspace((db) => {
    const owner = spaceId || (existingSpace ? String(existingSpace.space_id) : id);
    db.prepare('INSERT OR IGNORE INTO spaces (id, name, icon) VALUES (?, ?, ?)').run(
      owner,
      content.title,
      content.title.toLowerCase().includes('plant') ? 'leaf' : 'grid',
    );
    db.prepare('INSERT OR IGNORE INTO space_applets (space_id, applet_id) VALUES (?, ?)').run(
      owner,
      id,
    );
    db.prepare(
      "UPDATE spaces SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    ).run(owner);
  });
  if (spaceId) movePhotosToApplet(spaceId, id);
  const saved = appletInfo(id)!;
  logEvent('app.published', {
    appletId: id,
    version: saved.version,
    title: content.title,
    source: content.source,
    backend: content.backend,
    chatInstructions: content.chatInstructions,
    testReport: content.testReport,
  });
  return saved;
}

export function versions(id: string) {
  return withApplet(id, (db) =>
    db
      .prepare(
        'SELECT version, title, created_at AS createdAt FROM revisions ORDER BY version DESC',
      )
      .all(),
  );
}

export function records(id: string): RecordEntry[] {
  return withApplet(id, (db) =>
    db
      .prepare('SELECT key, value FROM records ORDER BY key LIMIT 2000')
      .all()
      .map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) })),
  );
}

export function putRecord(id: string, key: string, value: unknown) {
  if (!key || key.length > 200) throw new Error('A record key must contain 1–200 characters.');
  const json = JSON.stringify(value);
  if (json === undefined || json.length > 100_000)
    throw new Error('Record is too large or invalid.');
  withApplet(id, (db) => {
    const existing = db.prepare('SELECT 1 FROM records WHERE key = ?').get(key);
    requireLegacyWrites(db);
    const count = db.prepare('SELECT COUNT(*) AS n FROM records').get()!;
    if (!existing && Number(count.n) >= 2000)
      throw new Error('Prototype limit: 2,000 records per applet.');
    db.prepare(
      'INSERT INTO records (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(key, json);
  });
}

export function removeRecord(id: string, key: string) {
  withApplet(id, (db) => {
    requireLegacyWrites(db);
    db.prepare('DELETE FROM records WHERE key = ?').run(key);
  });
}

function requireLegacyWrites(db: DatabaseSync) {
  const current = db
    .prepare('SELECT backendBundle FROM revisions ORDER BY version DESC LIMIT 1')
    .get();
  if (current?.backendBundle)
    throw new Error('This app uses backend actions. Direct record writes are unavailable.');
}

export const spaceIcons = ['grid', 'leaf', 'book', 'check', 'home', 'spark'];

export function listSpaces(includeArchived = false): Space[] {
  // Import previous applets as spaces with the same IDs, retaining their chat threads.
  const legacy = listApplets();
  return workspace((db) => {
    db.exec('BEGIN');
    try {
      for (const applet of legacy) {
        if (db.prepare('SELECT 1 FROM space_applets WHERE applet_id = ?').get(applet.id)) continue;
        db.prepare(
          'INSERT OR IGNORE INTO spaces (id, name, icon, updated_at) VALUES (?, ?, ?, ?)',
        ).run(
          applet.id,
          applet.title,
          applet.title.toLowerCase().includes('plant') ? 'leaf' : 'grid',
          applet.updatedAt,
        );
        db.prepare('INSERT INTO space_applets (applet_id, space_id) VALUES (?, ?)').run(
          applet.id,
          applet.id,
        );
      }
      // Old per-applet threads become their space's first conversation, without copying messages.
      for (const row of db
        .prepare('SELECT id FROM spaces WHERE id NOT IN (SELECT space_id FROM chats)')
        .all()) {
        db.prepare('INSERT OR IGNORE INTO chats (id, space_id, title) VALUES (?, ?, ?)').run(
          row.id,
          row.id,
          'First chat',
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return db
      .prepare(
        `SELECT s.id, s.name, s.icon, s.archived, s.updated_at AS updatedAt, COUNT(a.applet_id) AS appletCount
      FROM spaces s LEFT JOIN space_applets a ON a.space_id = s.id WHERE (? OR s.archived=0) GROUP BY s.id ORDER BY s.updated_at DESC`,
      )
      .all(includeArchived ? 1 : 0)
      .map(spaceFromRow);
  });
}

function spaceFromRow(row: Record<string, unknown>): Space {
  return {
    id: String(row.id),
    name: String(row.name),
    archived: Boolean(row.archived),
    icon: String(row.icon),
    updatedAt: String(row.updatedAt),
    appletCount: Number(row.appletCount),
  };
}

export function getSpace(id: string): Space {
  if (!uuid.test(id)) throw new Error('Space not found.');
  const row = workspace((db) =>
    db
      .prepare(
        `SELECT s.*,s.updated_at AS updatedAt,COUNT(a.applet_id) AS appletCount
     FROM spaces s LEFT JOIN space_applets a ON a.space_id=s.id WHERE s.id=? GROUP BY s.id`,
      )
      .get(id),
  );
  if (row) return spaceFromRow(row);
  // An older app database may not have a workspace entry yet.
  const space = listSpaces(true).find((item) => item.id === id);
  if (!space) throw new Error('Space not found.');
  return space;
}

export function setSpaceArchived(id: string, archived: boolean): Space {
  if (id === launcherChatId) throw new Error('The built-in Chat cannot be archived.');
  getSpace(id);
  workspace((db) =>
    db.prepare('UPDATE spaces SET archived=? WHERE id=?').run(archived ? 1 : 0, id),
  );
  return getSpace(id);
}

export function createSpace(name: string, icon = 'grid'): Space {
  name = name.trim();
  if (!name || name.length > 80 || !spaceIcons.includes(icon))
    throw new Error('Choose a name (1–80 characters) and a valid icon.');
  const id = randomUUID();
  workspace((db) =>
    db.prepare('INSERT INTO spaces (id, name, icon) VALUES (?, ?, ?)').run(id, name, icon),
  );
  return getSpace(id);
}

export function spaceApplets(spaceId: string): Applet[] {
  getSpace(spaceId);
  const ids = workspace((db) =>
    db
      .prepare('SELECT applet_id FROM space_applets WHERE space_id = ?')
      .all(spaceId)
      .map((row) => String(row.applet_id)),
  );
  return ids.flatMap((id) => appletInfo(id) ?? []);
}

// Empty placeholders may exist while a composer is open, but are not history.
export const activeChatTurns = new Set<string>();

export function deleteEmptyChats(chatId?: string): number {
  return workspace((db) => {
    const candidates = db.prepare(`SELECT id FROM chats
      WHERE (? IS NULL OR id = ?)
      AND NOT EXISTS (SELECT 1 FROM messages WHERE thread = chats.id)
      AND NOT EXISTS (SELECT 1 FROM chat_tools WHERE thread = chats.id)
      AND NOT EXISTS (SELECT 1 FROM build_drafts WHERE chat_id = chats.id)
      AND NOT EXISTS (SELECT 1 FROM voice_actions WHERE chat_id = chats.id)`);
    db.exec('BEGIN IMMEDIATE');
    try {
      let deleted = 0;
      for (const row of candidates.all(chatId ?? null, chatId ?? null)) {
        if (!activeChatTurns.has(String(row.id)))
          deleted += Number(db.prepare('DELETE FROM chats WHERE id=?').run(row.id).changes);
      }
      db.exec('COMMIT');
      return deleted;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function listChats(spaceId: string): Chat[] {
  getSpace(spaceId);
  return workspace((db) => {
    // Legacy per-space threads retain their IDs and messages as the first chat.
    db.prepare(
      `INSERT INTO chats(id,space_id,title) SELECT ?,?,'First chat'
      WHERE NOT EXISTS (SELECT 1 FROM chats WHERE space_id=?)`,
    ).run(spaceId, spaceId, spaceId);
    return db
      .prepare(
        'SELECT id, space_id AS spaceId, title, launch, updated_at AS updatedAt FROM chats WHERE space_id = ? ORDER BY updated_at DESC, rowid DESC',
      )
      .all(spaceId)
      .map((row) => {
        const launch = JSON.parse(String(row.launch));
        return {
          id: String(row.id),
          spaceId: String(row.spaceId),
          title: String(row.title),
          updatedAt: String(row.updatedAt),
          ...(launch.task ? { launch } : {}),
        };
      });
  });
}

export function getChat(spaceId: string, chatId: string): Chat {
  const chat = listChats(spaceId).find((item) => item.id === chatId);
  if (!chat) throw new Error('Chat not found in this space.');
  return chat;
}

export function createChat(spaceId: string, launch?: import('../types').ChatLaunch): Chat {
  getSpace(spaceId);
  // Preserve legacy history without manufacturing an unused "First chat".
  workspace((db) =>
    db
      .prepare(
        `INSERT INTO chats(id,space_id,title)
    SELECT ?,?,'First chat' WHERE NOT EXISTS (SELECT 1 FROM chats WHERE space_id=?)
    AND (EXISTS (SELECT 1 FROM messages WHERE thread=?)
      OR EXISTS (SELECT 1 FROM chat_tools WHERE thread=?)
      OR EXISTS (SELECT 1 FROM build_drafts WHERE chat_id=?)
      OR EXISTS (SELECT 1 FROM voice_actions WHERE chat_id=?))`,
      )
      .run(spaceId, spaceId, spaceId, spaceId, spaceId, spaceId, spaceId),
  );
  const id = randomUUID();
  workspace((db) =>
    db
      .prepare('INSERT INTO chats (id, space_id, title, launch) VALUES (?, ?, ?, ?)')
      .run(
        id,
        spaceId,
        launch?.title || launch?.task.slice(0, 60) || 'New chat',
        JSON.stringify(launch || {}),
      ),
  );
  return getChat(spaceId, id);
}

export function hostId(): string {
  return workspace((db) => {
    const found = db.prepare("SELECT value FROM settings WHERE key = 'host'").get();
    if (found) return String(found.value);
    const id = `urn:uuid:${randomUUID()}`;
    db.prepare("INSERT INTO settings VALUES ('host', ?)").run(id);
    return id;
  });
}

export function messages(thread: string): Message[] {
  return workspace((db) =>
    db
      .prepare(
        'SELECT id, role, content, photos FROM (SELECT id, role, content, photos FROM messages WHERE thread = ? ORDER BY id DESC LIMIT 30) ORDER BY id',
      )
      .all(thread)
      .map((row) => {
        const photos = JSON.parse(String(row.photos));
        const toolCalls =
          row.role === 'assistant'
            ? db
                .prepare(
                  'SELECT data FROM chat_tools WHERE message_id=? AND thread=? ORDER BY rowid',
                )
                .all(row.id, thread)
                .map((tool) => JSON.parse(String(tool.data)))
            : [];
        return {
          role: row.role as Message['role'],
          content: String(row.content),
          ...(photos.length ? { photos } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
        };
      }),
  );
}

export function saveExchange(
  thread: string,
  user: string,
  assistant: string,
  photos: string[] = [],
  tools: import('../types').ToolCall[] = [],
) {
  workspace((db) => {
    db.exec('BEGIN');
    try {
      const insert = db.prepare(
        'INSERT INTO messages (thread, role, content, photos) VALUES (?, ?, ?, ?)',
      );
      insert.run(thread, 'user', user, JSON.stringify(photos));
      const saved = insert.run(thread, 'assistant', assistant, '[]');
      for (const tool of tools)
        db.prepare('UPDATE chat_tools SET message_id=? WHERE id=? AND thread=?').run(
          saved.lastInsertRowid,
          tool.id,
          thread,
        );
      db.prepare(
        `UPDATE chats SET title = CASE WHEN title IN ('New chat', 'First chat') THEN ? ELSE title END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
      ).run(user.replace(/\s+/g, ' ').slice(0, 60), thread);
      db.prepare(
        "UPDATE spaces SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id IN (SELECT space_id FROM chats WHERE id = ?)",
      ).run(thread);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

// A reserved local workspace for the built-in Chat app; never displayed as a user app.
export const launcherChatId = '00000000-0000-4000-8000-000000000001';
export function launcherChat(): Space {
  workspace((db) =>
    db
      .prepare('INSERT OR IGNORE INTO spaces (id, name, icon) VALUES (?, ?, ?)')
      .run(launcherChatId, 'Chat', 'spark'),
  );
  return getSpace(launcherChatId);
}

export function commitRecords(
  id: string,
  before: RecordEntry[],
  after: RecordEntry[],
  expectedVersion: number,
) {
  if (after.length > 2000) throw new Error('Too many records.');
  const keys = new Set<string>();
  for (const row of after) {
    if (
      !row ||
      typeof row.key !== 'string' ||
      !row.key ||
      row.key.length > 200 ||
      keys.has(row.key)
    )
      throw new Error('Invalid record key.');
    keys.add(row.key);
    const encoded = JSON.stringify(row.value);
    if (encoded === undefined || encoded.length > 100_000)
      throw new Error('Invalid or oversized record.');
  }
  withApplet(id, (db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = db
        .prepare('SELECT key, value FROM records ORDER BY key')
        .all()
        .map((row) => ({ key: String(row.key), value: JSON.parse(String(row.value)) }));
      const version = Number(
        db.prepare('SELECT MAX(version) AS version FROM revisions').get()!.version,
      );
      if (version !== expectedVersion || JSON.stringify(current) !== JSON.stringify(before))
        throw new Error('The app changed during this action. Please retry.');
      db.exec('DELETE FROM records');
      const insert = db.prepare('INSERT INTO records (key, value) VALUES (?, ?)');
      for (const row of after) insert.run(row.key, JSON.stringify(row.value));
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}

export function appletSpaceId(appletId: string): string {
  revision(appletId);
  const row = workspace((db) =>
    db.prepare('SELECT space_id FROM space_applets WHERE applet_id = ?').get(appletId),
  );
  if (!row) throw new Error('App not found.');
  return String(row.space_id);
}
function photoDatabase<T>(spaceId: string, run: (db: DatabaseSync) => T): T {
  getSpace(spaceId);
  const row = workspace((db) =>
    db.prepare('SELECT applet_id FROM space_applets WHERE space_id = ?').get(spaceId),
  );
  if (!row) return workspace(run);
  const appletId = String(row.applet_id);
  // Publication can stop after linking the app but before moving its photos.
  // Copy-before-delete is idempotent, so the next photo access repairs either stage.
  movePhotosToApplet(spaceId, appletId);
  return withApplet(appletId, run);
}
function movePhotosToApplet(spaceId: string, appletId: string) {
  const pending = workspace((db) =>
    db.prepare('SELECT * FROM photos WHERE owner = ?').all(spaceId),
  );
  if (!pending.length) return;
  withApplet(appletId, (db) => {
    db.exec('BEGIN');
    try {
      const insert = db.prepare(
        'INSERT OR IGNORE INTO photos (id, owner, name, mime, width, height, bytes, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const row of pending)
        insert.run(
          row.id,
          row.owner,
          row.name,
          row.mime,
          row.width,
          row.height,
          row.bytes,
          row.data,
          row.created_at,
        );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
  workspace((db) => {
    const remove = db.prepare('DELETE FROM photos WHERE id = ? AND owner = ?');
    for (const row of pending) remove.run(row.id, spaceId);
  });
}
export function savePhoto(
  spaceId: string,
  photo: { name: string; mime: string; width: number; height: number; data: Buffer },
): Photo {
  return photoDatabase(spaceId, (db) => {
    const size = db
      .prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS total FROM photos WHERE owner = ?',
      )
      .get(spaceId)!;
    if (Number(size.count) >= 500 || Number(size.total) + photo.data.length > 200_000_000)
      throw new Error('This app’s photo storage is full (500 photos or 200 MB).');
    const id = randomUUID();
    db.prepare(
      'INSERT INTO photos (id,owner,name,mime,width,height,bytes,data) VALUES (?,?,?,?,?,?,?,?)',
    ).run(
      id,
      spaceId,
      photo.name,
      photo.mime,
      photo.width,
      photo.height,
      photo.data.length,
      photo.data,
    );
    return {
      id,
      name: photo.name,
      mime: photo.mime,
      width: photo.width,
      height: photo.height,
      bytes: photo.data.length,
      url: `/api/spaces/${spaceId}/photos/${id}`,
    };
  });
}
export function readPhoto(spaceId: string, id: string): Photo & { data: Buffer } {
  if (!uuid.test(id)) throw new Error('Photo not found in this app.');
  return photoDatabase(spaceId, (db) => {
    const row = db.prepare('SELECT * FROM photos WHERE id = ? AND owner = ?').get(id, spaceId);
    if (!row) throw new Error('Photo not found in this app.');
    return {
      id,
      name: String(row.name),
      mime: String(row.mime),
      width: Number(row.width),
      height: Number(row.height),
      bytes: Number(row.bytes),
      data: Buffer.from(row.data as Uint8Array),
      url: `/api/spaces/${spaceId}/photos/${id}`,
    };
  });
}
export function listPhotos(spaceId: string): Photo[] {
  return photoDatabase(spaceId, (db) =>
    db
      .prepare(
        'SELECT id,name,mime,width,height,bytes FROM photos WHERE owner = ? ORDER BY created_at DESC LIMIT 500',
      )
      .all(spaceId)
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        mime: String(row.mime),
        width: Number(row.width),
        height: Number(row.height),
        bytes: Number(row.bytes),
        url: `/api/spaces/${spaceId}/photos/${row.id}`,
      })),
  );
}
export function photoDataUrl(spaceId: string, id: string) {
  const photo = readPhoto(spaceId, id);
  return `data:${photo.mime};base64,${photo.data.toString('base64')}`;
}

export function saveToolCall(thread: string, tool: import('../types').ToolCall) {
  workspace((db) =>
    db
      .prepare(
        'INSERT INTO chat_tools (id,thread,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE thread=excluded.thread',
      )
      .run(tool.id, thread, JSON.stringify(tool)),
  );
}
export function pendingTools(thread: string): import('../types').ToolCall[] {
  return workspace((db) =>
    db
      .prepare('SELECT data FROM chat_tools WHERE thread=? AND message_id IS NULL ORDER BY rowid')
      .all(thread)
      .map((row) => JSON.parse(String(row.data))),
  );
}
