import { writable } from 'svelte/store';
import type { Notification } from './types';
import { request } from './client';
export const notifications = writable<Notification[]>([]);
let revision = 0;
let pendingReads = 0;
let readQueue: Promise<void> = Promise.resolve();

export async function refreshNotifications() {
  // Polls must not undo a mark-read response with an older inbox snapshot.
  if (pendingReads) return;
  const current = ++revision;
  const value = await request('/api/notifications');
  if (current === revision) notifications.set(value.notifications);
}

export async function readNotifications(id?: string) {
  ++revision;
  ++pendingReads;
  const operation = readQueue.then(async () => {
    const value = await request('/api/notifications', { action: 'read', ...(id ? { id } : {}) });
    notifications.set(value.notifications);
  });
  readQueue = operation.catch(() => {});
  try {
    await operation;
  } finally {
    --pendingReads;
  }
}
