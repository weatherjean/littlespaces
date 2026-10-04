import type { ChatLaunch } from '../types';
import { spaceApplets, records, readPhoto } from './storage';

export function validateChatLaunch(spaceId: string, value: unknown): ChatLaunch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Provide a chat task.');
  const v = value as ChatLaunch;
  if (typeof v.task !== 'string' || !v.task.trim() || v.task.length > 2000) throw new Error('Chat task must contain 1–2,000 characters.');
  if (v.title !== undefined && (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 80)) throw new Error('Chat title must contain 1–80 characters.');
  if (v.welcome !== undefined && (typeof v.welcome !== 'string' || v.welcome.length > 2000)) throw new Error('Chat welcome must be at most 2,000 characters.');
  if (JSON.stringify(v.context ?? null).length > 8000) throw new Error('Chat context is too large.');
  for (const field of ['recordKeys', 'photoIds'] as const) {
    if (v[field] !== undefined && (!Array.isArray(v[field]) || v[field]!.length > (field === 'photoIds' ? 4 : 10) || v[field]!.some(x => typeof x !== 'string' || !x || x.length > 200))) throw new Error('Invalid chat context references.');
  }
  const app = spaceApplets(spaceId)[0];
  const keys = new Set(app ? records(app.id).map(row => row.key) : []);
  if (v.recordKeys?.some(key => !keys.has(key))) throw new Error('A selected record is not available in this app.');
  for (const id of v.photoIds || []) readPhoto(spaceId, id);
  return {task:v.task.trim(), ...(v.title ? {title:v.title.trim()} : {}), ...(v.welcome ? {welcome:v.welcome} : {}), context:v.context ?? null, recordKeys:v.recordKeys || [], photoIds:v.photoIds || []};
}

export function liveChatContext(appletId: string | undefined, launch?: ChatLaunch) {
  if (!launch) return undefined;
  const current = appletId ? records(appletId) : [];
  return { task:launch.task, screenContext:launch.context, photoIds:launch.photoIds || [], selectedRecords:(launch.recordKeys || []).map(key => {
    const row = current.find(row => row.key === key);
    if (!row) return {key, missing:true};
    return JSON.stringify(row).length > 12000 ? {key, omitted:'Large record; retrieve through app tools.'} : row;
  }) };
}
