import { writable } from 'svelte/store';
import type { Notification } from './types';
import { request } from './client';
export const notifications = writable<Notification[]>([]);
export async function refreshNotifications() {
  const value = await request('/api/notifications');
  notifications.set(value.notifications);
}
export async function readNotifications(id?: string) {
  const value = await request('/api/notifications', { action: 'read', ...(id ? { id } : {}) });
  notifications.set(value.notifications);
}
