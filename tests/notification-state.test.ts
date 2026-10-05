import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'svelte/store';
import {
  notifications,
  refreshNotifications,
  readNotifications,
} from '../src/lib/notification-state';

function deferred() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const snapshot = (read: boolean) => Response.json({ notifications: [{ id: 'one', read }] });

test('an old inbox poll cannot resurrect unread notifications after marking them read', async (t) => {
  const poll = deferred();
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, options?: RequestInit) =>
    options?.method === 'POST' ? snapshot(true) : poll.promise,
  );
  const refresh = refreshNotifications();
  await readNotifications('one');
  poll.resolve(snapshot(false));
  await refresh;
  assert.equal(get(notifications)[0].read, true);
});

test('overlapping refreshes keep the latest requested inbox', async (t) => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => (++calls === 1 ? first.promise : second.promise));
  const old = refreshNotifications(),
    latest = refreshNotifications();
  second.resolve(snapshot(true));
  await latest;
  first.resolve(snapshot(false));
  await old;
  assert.equal(get(notifications)[0].read, true);
});

test('mark-read actions serialize, suppress polling, and recover after a failed write', async (t) => {
  const first = deferred();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () =>
    ++calls === 1 ? first.promise : Promise.resolve(snapshot(true)),
  );
  const old = readNotifications('one');
  const rejected = assert.rejects(old, /Request failed/);
  const latest = readNotifications();
  await refreshNotifications();
  await Promise.resolve();
  assert.equal(calls, 1);
  first.resolve(new Response('', { status: 503 }));
  await rejected;
  await latest;
  assert.equal(calls, 2);
  assert.equal(get(notifications)[0].read, true);
  await refreshNotifications();
  assert.equal(calls, 3);
});
