import { randomUUID } from 'node:crypto';
import { workspace, getSpace, launcherChatId } from './storage';
import { logEvent } from './diagnostics';
import type { Notification } from '../types';
export function notify(spaceId: string, value: unknown) {
  getSpace(spaceId);
  const v = value as Record<string, unknown>;
  if (
    !v ||
    typeof v.key !== 'string' ||
    !v.key ||
    v.key.length > 160 ||
    typeof v.title !== 'string' ||
    !v.title.trim() ||
    v.title.length > 120 ||
    typeof v.body !== 'string' ||
    v.body.length > 2000
  )
    throw Error('Provide a notification key, title, and body.');
  if (
    v.dueAt !== undefined &&
    (typeof v.dueAt !== 'string' || !Number.isFinite(Date.parse(v.dueAt)))
  )
    throw Error('Invalid notification date.');
  const dueAt = v.dueAt ? new Date(String(v.dueAt)).toISOString() : new Date().toISOString();
  const id = randomUUID();
  workspace((db) => {
    const old = db
      .prepare('SELECT id FROM notifications WHERE space_id=? AND key=?')
      .get(spaceId, v.key as string);
    if (
      !old &&
      Number(
        db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE space_id=?').get(spaceId)!.n,
      ) >= 500
    )
      throw Error('This app has reached its notification limit.');
    db.prepare(
      `INSERT INTO notifications(id,space_id,key,title,body,due_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(space_id,key) DO UPDATE SET title=excluded.title,body=excluded.body,due_at=excluded.due_at,
      is_read=CASE WHEN notifications.title=excluded.title AND notifications.body=excluded.body AND notifications.due_at=excluded.due_at THEN notifications.is_read ELSE 0 END`,
    ).run(id, spaceId, v.key as string, v.title as string, v.body as string, dueAt);
  });
  const result = listNotifications(spaceId, true).find((n) => n.key === v.key)!;
  logEvent('notification.saved', { notification: result });
  return result;
}
export function listNotifications(spaceId?: string, includeFuture = false): Notification[] {
  if (spaceId) getSpace(spaceId);
  return workspace((db) =>
    db
      .prepare(
        `SELECT n.*,s.name AS source FROM notifications n JOIN spaces s ON s.id=n.space_id WHERE s.archived=0 AND (? IS NULL OR n.space_id=?) AND (? OR n.due_at<=?) ORDER BY n.due_at DESC`,
      )
      .all(spaceId || null, spaceId || null, includeFuture ? 1 : 0, new Date().toISOString())
      .map((row) => ({
        id: String(row.id),
        spaceId: String(row.space_id),
        key: String(row.key),
        title: String(row.title),
        body: String(row.body),
        dueAt: String(row.due_at),
        read: !!row.is_read,
        source: String(row.source),
        href: row.space_id === launcherChatId ? '/chat' : `/spaces/${row.space_id}/applet`,
      })),
  );
}
export function markNotificationsRead(id?: string) {
  workspace((db) =>
    id
      ? db.prepare('UPDATE notifications SET is_read=1 WHERE id=?').run(id)
      : db
          .prepare('UPDATE notifications SET is_read=1 WHERE due_at<=?')
          .run(new Date().toISOString()),
  );
}
export function cancelNotification(spaceId: string, key: string) {
  getSpace(spaceId);
  workspace((db) =>
    db.prepare('DELETE FROM notifications WHERE space_id=? AND key=?').run(spaceId, key),
  );
  return { cancelled: true };
}
