import { randomBytes } from 'node:crypto';
import { error, type RequestEvent } from '@sveltejs/kit';
import { origin } from './config';

export const localSession = randomBytes(32).toString('base64url');
export const sessionCookie = 'little_spaces_session';

export function requireLocalSession(event: RequestEvent) {
  if (event.cookies.get(sessionCookie) !== localSession) error(401, 'Open Little Spaces in this browser first.');
  if (!['GET', 'HEAD'].includes(event.request.method) && event.request.headers.get('origin') !== origin) {
    error(403, 'Requests must come from the local workspace.');
  }
}

export async function body(event: RequestEvent): Promise<Record<string, unknown>> {
  const text = await event.request.text();
  if (text.length > 150_000) error(413, 'Request is too large.');
  let value: unknown;
  try { value = JSON.parse(text); } catch { error(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) error(400, 'Expected an object.');
  return value as Record<string, unknown>;
}
