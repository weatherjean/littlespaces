import { error, type RequestEvent } from '@sveltejs/kit';
import { origin, secureCookies } from './config';
import { sessions } from './sessions';
import { ownerStore } from './owner';

export const sessionCookie = secureCookies
  ? '__Host-little_spaces_session'
  : 'little_spaces_session';
export const cookieOptions = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: secureCookies,
};
export function authenticated(event: Pick<RequestEvent, 'cookies'>) {
  return sessions.get(event.cookies.get(sessionCookie), ownerStore().get()?.version);
}
export function requireSameOrigin(event: Pick<RequestEvent, 'request'>) {
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) &&
    event.request.headers.get('origin') !== origin
  ) {
    error(403, 'Requests must come from this app.');
  }
}
export async function boundedBytes(request: Request, limit: number): Promise<Buffer> {
  if (Number(request.headers.get('content-length')) > limit) error(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      // adapter-node cancels IncomingMessage by destroying its socket. Leave
      // transport cleanup to the server so the client can receive the 413.
      if (size > limit) error(413, 'Request is too large.');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    reader.releaseLock();
  }
}
export async function boundedText(request: Request, limit: number) {
  return (await boundedBytes(request, limit)).toString('utf8');
}
export async function body(event: RequestEvent): Promise<Record<string, unknown>> {
  const text = await boundedText(event.request, 150_000);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    error(400, 'Invalid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    error(400, 'Expected an object.');
  return value as Record<string, unknown>;
}
