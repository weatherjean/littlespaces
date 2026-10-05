import { error, type RequestEvent } from '@sveltejs/kit';
import { origin, secureCookies } from './config';
import { sessions, SESSION_SECONDS } from './sessions';
import { ownerStore } from './owner';

export const sessionCookie = secureCookies ? '__Host-little_spaces_session' : 'little_spaces_session';
export const cookieOptions = {path:'/', httpOnly:true, sameSite:'lax' as const, secure:secureCookies, maxAge:SESSION_SECONDS};
export function authenticated(event: Pick<RequestEvent,'cookies'>) {
  return sessions.get(event.cookies.get(sessionCookie), ownerStore().get()?.version);
}
export function requireSameOrigin(event: Pick<RequestEvent,'request'>) {
  if (!['GET','HEAD','OPTIONS'].includes(event.request.method) && event.request.headers.get('origin') !== origin) {
    error(403, 'Requests must come from this app.');
  }
}
export function requireLocalSession(event: RequestEvent) {
  if (!authenticated(event)) error(401, 'Sign in to continue.');
  requireSameOrigin(event);
}
export async function boundedText(request: Request, limit: number) {
  if (Number(request.headers.get('content-length')) > limit) error(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {await reader.cancel();error(413, 'Request is too large.');}
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {reader.releaseLock();}
}
export async function body(event: RequestEvent): Promise<Record<string, unknown>> {
  const text = await boundedText(event.request, 150_000);
  let value: unknown;
  try { value = JSON.parse(text); } catch { error(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) error(400, 'Expected an object.');
  return value as Record<string, unknown>;
}
