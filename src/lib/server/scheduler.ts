import { listSchedules, nextCron, type Schedule } from './schedules';
import { workspace, spaceApplets, revision, listSpaces } from './storage';
import { notify } from './notifications';
import { generate } from './inference';
import { deliverPush } from './push';

let running = false;
export async function runSchedule(job: Schedule, now = new Date(), turn = generate) {
  // Advance before invoking: missed recurrences coalesce and a restart cannot replay a claimed turn.
  const next = job.cron ? nextCron(job.cron, job.timezone, now) : null;
  const claimed = workspace(
    (db) =>
      db
        .prepare(
          'UPDATE schedules SET next_run=?,enabled=?,last_run=?,last_error=? WHERE id=? AND enabled=1 AND next_run=? AND EXISTS (SELECT 1 FROM spaces WHERE spaces.id=schedules.space_id AND spaces.archived=0)',
        )
        .run(
          next,
          next ? 1 : 0,
          now.toISOString(),
          'Turn interrupted before completion.',
          job.id,
          job.next_run,
        ).changes,
  );
  if (!claimed) return;
  const notificationKey = `schedule:${job.id}`;
  // A durable placeholder means even an interrupted turn leaves a visible notification.
  notify(job.space_id, {
    key: notificationKey,
    title: job.title,
    dueAt: new Date(Date.now() + 180000).toISOString(),
    body: 'Scheduled check started. If this message remains, the server may have restarted before the check completed.',
  });
  let failure: string | null = null;
  try {
    const id = spaceApplets(job.space_id)[0]?.id;
    const result = await turn(
      job.model,
      [
        {
          role: 'user',
          content: `Scheduled task authorized by the owner: ${job.prompt}\nCurrent time: ${now.toISOString()}. Read current app data and produce a concise notification. Do not change records or create schedules.`,
        },
      ],
      id ? revision(id).source : undefined,
      () => {},
      AbortSignal.timeout(120000),
      { spaceId: job.space_id, appletId: id, mode: 'scheduled' },
    );
    notify(job.space_id, {
      key: notificationKey,
      title: job.title,
      body: result.message.slice(0, 2000),
    });
  } catch {
    failure =
      'Scheduled check failed. Check ChatGPT connection and model availability, then recreate the schedule if needed.';
    notify(job.space_id, { key: notificationKey, title: job.title, body: failure });
  }
  workspace((db) =>
    db
      .prepare('UPDATE schedules SET last_error=? WHERE id=? AND last_run=?')
      .run(failure, job.id, now.toISOString()),
  );
}
export async function schedulerTick() {
  if (running) return;
  running = true;
  try {
    const activeSpaces = new Set(listSpaces().map((space) => space.id));
    for (const job of listSchedules()
      .filter(
        (job) =>
          activeSpaces.has(job.space_id) &&
          job.enabled &&
          job.next_run &&
          Date.parse(job.next_run) <= Date.now(),
      )
      .slice(0, 10))
      await runSchedule(job);
  } finally {
    running = false;
  }
}
let pushRunning = false;
async function pushTick() {
  if (pushRunning) return;
  pushRunning = true;
  try {
    await deliverPush();
  } finally {
    pushRunning = false;
  }
}
let timer: ReturnType<typeof setInterval> | undefined;
export function startScheduler() {
  if (timer) return;
  const tick = () => {
    void schedulerTick().catch(() => {});
  };
  timer = setInterval(tick, 30000);
  timer.unref();
  const pushTimer = setInterval(() => {
    void pushTick().catch(() => {});
  }, 30000);
  pushTimer.unref();
  void pushTick().catch(() => {});
  tick();
}
