import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { workspace, getSpace } from './storage';
export type Schedule = {
  id: string;
  space_id: string;
  key: string;
  title: string;
  prompt: string;
  cron: string | null;
  timezone: string;
  model: string;
  next_run: string | null;
  enabled: number;
  last_run: string | null;
  last_error: string | null;
  revision: number;
};
export function nextCron(cron: string, timezone: string, after = new Date()) {
  if (cron.trim().split(/\s+/).length !== 5) throw Error('Use a five-field cron expression.');
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
  return CronExpressionParser.parse(cron, { tz: timezone, currentDate: after })
    .next()
    .toISOString()!;
}
export function listSchedules(spaceId?: string): Schedule[] {
  if (spaceId) getSpace(spaceId);
  return workspace((db) =>
    db
      .prepare('SELECT * FROM schedules WHERE (? IS NULL OR space_id=?) ORDER BY next_run')
      .all(spaceId || null, spaceId || null),
  ) as unknown as Schedule[];
}
export function saveSchedule(spaceId: string, input: Record<string, unknown>) {
  getSpace(spaceId);
  for (const [name, max] of [
    ['key', 160],
    ['title', 120],
    ['prompt', 4000],
    ['model', 150],
    ['timezone', 100],
  ] as const)
    if (
      typeof input[name] !== 'string' ||
      !String(input[name]).trim() ||
      String(input[name]).length > max
    )
      throw Error(`Provide a valid ${name}.`);
  if (
    Boolean(input.cron) === Boolean(input.dueAt) ||
    (input.cron !== undefined && (typeof input.cron !== 'string' || input.cron.length > 200)) ||
    (input.dueAt !== undefined && typeof input.dueAt !== 'string')
  )
    throw Error('Provide either cron or dueAt as a string.');
  new Intl.DateTimeFormat('en', { timeZone: String(input.timezone) }).format();
  const next = input.cron
    ? nextCron(String(input.cron), String(input.timezone))
    : new Date(String(input.dueAt)).toISOString();
  if (Date.parse(next) <= Date.now()) throw Error('Choose a future time.');
  workspace((db) => {
    if (
      !db
        .prepare('SELECT id FROM schedules WHERE space_id=? AND key=?')
        .get(spaceId, String(input.key)) &&
      Number(db.prepare('SELECT COUNT(*) AS n FROM schedules').get()!.n) >= 100
    )
      throw Error('Schedule limit reached.');
    db.prepare(
      `INSERT INTO schedules(id,space_id,key,title,prompt,cron,timezone,model,next_run) VALUES(?,?,?,?,?,?,?,?,?)
      ON CONFLICT(space_id,key) DO UPDATE SET title=excluded.title,prompt=excluded.prompt,cron=excluded.cron,timezone=excluded.timezone,model=excluded.model,next_run=excluded.next_run,enabled=1,last_error=NULL,revision=schedules.revision+1`,
    ).run(
      randomUUID(),
      spaceId,
      String(input.key),
      String(input.title),
      String(input.prompt),
      input.cron ? String(input.cron) : null,
      String(input.timezone),
      String(input.model),
      next,
    );
  });
  return listSchedules(spaceId).find((item) => item.key === input.key)!;
}
export function cancelSchedule(spaceId: string, key: string) {
  getSpace(spaceId);
  workspace((db) =>
    db.prepare('DELETE FROM schedules WHERE space_id=? AND key=?').run(spaceId, key),
  );
  return { cancelled: true };
}
