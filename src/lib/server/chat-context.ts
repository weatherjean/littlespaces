import type { ChatLaunch } from '../types';
import { normalizeChatContext } from '../app-chat-context';
import { spaceApplets, records, readPhoto, revision } from './storage';

export function validateChatLaunch(
  spaceId: string,
  value: unknown,
  allowMissingRecords = false,
): ChatLaunch {
  const v = normalizeChatContext(value);
  const app = spaceApplets(spaceId)[0];
  const keys = new Set(app ? records(app.id).map((row) => row.key) : []);
  if (!allowMissingRecords && v.recordKeys?.some((key) => !keys.has(key)))
    throw new Error('A selected record is not available in this app.');
  for (const id of v.photoIds || []) readPhoto(spaceId, id);
  return {
    task: v.task.trim(),
    ...(v.title ? { title: v.title.trim() } : {}),
    ...(v.welcome ? { welcome: v.welcome } : {}),
    context: v.context ?? null,
    recordKeys: v.recordKeys || [],
    photoIds: v.photoIds || [],
  };
}

export function liveChatContext(
  appletId: string | undefined,
  launch?: ChatLaunch,
  view?: ChatLaunch | null,
) {
  if (!appletId && !launch) return undefined;
  const current = appletId ? records(appletId) : [];
  const snapshot = (launch: ChatLaunch) => ({
    task: launch.task,
    screenContext: launch.context,
    photoIds: launch.photoIds || [],
    selectedRecords: (launch.recordKeys || []).map((key) => {
      const row = current.find((row) => row.key === key);
      if (!row) return { key, missing: true };
      return JSON.stringify(row).length > 12000
        ? { key, omitted: 'Large record; retrieve through app tools.' }
        : row;
    }),
  });
  const app = appletId ? revision(appletId) : undefined;
  return {
    ...(app
      ? {
          app: {
            id: appletId,
            title: app.title,
            description: app.description,
            version: app.version,
          },
        }
      : {}),
    ...(launch ? snapshot(launch) : {}),
    ...(view ? { currentView: snapshot(view) } : {}),
  };
}
