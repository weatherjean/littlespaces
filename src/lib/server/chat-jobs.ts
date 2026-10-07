import { createHash } from 'node:crypto';
import { workspace } from './database';
import type { ToolCall } from '../types';

export type ChatJob = {
  id: string;
  spaceId: string;
  chatId: string;
  status: 'running' | 'complete' | 'failed' | 'stopped' | 'interrupted';
  activity: string;
  error?: string;
  message?: string;
  tools: ToolCall[];
};
const controllers = new Map<string, AbortController>();
export function fingerprint(input: unknown): string {
  const canonical = (value: any): any =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return createHash('sha256')
    .update(JSON.stringify(canonical(input)))
    .digest('hex');
}
function decode(row: Record<string, unknown> | undefined): ChatJob | null {
  return row ? JSON.parse(String(row.data)) : null;
}
export function findJob(id: string, spaceId: string, chatId: string, hash?: string) {
  return workspace((db) => {
    const row = db.prepare('SELECT * FROM chat_jobs WHERE id=?').get(id);
    if (!row) return null;
    if (row.space_id !== spaceId || row.chat_id !== chatId || (hash && row.fingerprint !== hash))
      throw Error('This request ID was already used for a different message.');
    return decode(row);
  });
}
export function latestJob(chatId: string) {
  return workspace((db) =>
    decode(
      db.prepare('SELECT * FROM chat_jobs WHERE chat_id=? ORDER BY rowid DESC LIMIT 1').get(chatId),
    ),
  );
}
export function runningJob(spaceId: string) {
  return workspace((db) =>
    decode(
      db.prepare("SELECT * FROM chat_jobs WHERE space_id=? AND status='running'").get(spaceId),
    ),
  );
}
export function createJob(job: ChatJob, hash: string, message: string, photos: string[]) {
  workspace((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare(
        'INSERT INTO chat_jobs(id,space_id,chat_id,status,fingerprint,data) VALUES(?,?,?,?,?,?)',
      ).run(job.id, job.spaceId, job.chatId, job.status, hash, JSON.stringify(job));
      db.prepare("INSERT INTO messages(thread,role,content,photos) VALUES(?,'user',?,?)").run(
        job.chatId,
        message,
        JSON.stringify(photos),
      );
      db.prepare(
        "UPDATE chats SET title=CASE WHEN title IN ('New chat','First chat') THEN ? ELSE title END, updated_at=? WHERE id=?",
      ).run(message.replace(/\s+/g, ' ').slice(0, 60), new Date().toISOString(), job.chatId);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}
export function updateJob(job: ChatJob) {
  workspace((db) =>
    db
      .prepare("UPDATE chat_jobs SET status=?,data=? WHERE id=? AND status='running'")
      .run(job.status, JSON.stringify(job), job.id),
  );
}
export function completeJob(job: ChatJob, message: string, tools: ToolCall[]) {
  workspace((db) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const saved = db
        .prepare("INSERT INTO messages(thread,role,content,photos) VALUES(?,'assistant',?,'[]')")
        .run(job.chatId, message);
      for (const tool of tools)
        db.prepare('UPDATE chat_tools SET message_id=? WHERE id=? AND thread=?').run(
          saved.lastInsertRowid,
          tool.id,
          job.chatId,
        );
      db.prepare('UPDATE chats SET updated_at=? WHERE id=?').run(
        new Date().toISOString(),
        job.chatId,
      );
      db.prepare('UPDATE spaces SET updated_at=? WHERE id=?').run(
        new Date().toISOString(),
        job.spaceId,
      );
      job.status = 'complete';
      job.message = message;
      job.activity = 'Reply ready';
      db.prepare("UPDATE chat_jobs SET status=?,data=? WHERE id=? AND status='running'").run(
        job.status,
        JSON.stringify(job),
        job.id,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  });
}
export function registerJob(id: string, controller: AbortController) {
  controllers.set(id, controller);
}
export function releaseJob(id: string) {
  controllers.delete(id);
}
export function stopJob(id: string, spaceId: string, chatId: string) {
  const job = findJob(id, spaceId, chatId);
  if (!job) throw Error('Reply not found.');
  if (job.status === 'running') controllers.get(id)?.abort();
  return job;
}
export function interruptChatJobs() {
  workspace((db) => {
    for (const row of db.prepare("SELECT * FROM chat_jobs WHERE status='running'").all()) {
      const job = decode(row)!;
      job.status = 'interrupted';
      job.error =
        'The server restarted before this reply finished. Completed app actions may remain saved; check the app before sending again.';
      job.activity = 'Reply interrupted';
      db.prepare('UPDATE chat_jobs SET status=?,data=? WHERE id=?').run(
        job.status,
        JSON.stringify(job),
        job.id,
      );
    }
  });
}
