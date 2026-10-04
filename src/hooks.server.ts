import { proxyRemote } from '$lib/server/remote-proxy';
import { logEvent, trace } from '$lib/server/diagnostics';
import type { Handle, HandleServerError } from '@sveltejs/kit';
import { origin } from '$lib/server/config';
import { localSession, sessionCookie, requireLocalSession } from '$lib/server/security';

export const handle: Handle = async ({ event, resolve }) => {
const run=async()=>{
  if (event.url.origin !== origin) return new Response('Open the app at ' + origin, { status: 403 });
  if ((event.url.pathname === '/' || event.url.pathname.startsWith('/spaces/') || event.url.pathname.startsWith('/chat') || event.url.pathname === '/settings') && event.request.method === 'GET') {
    event.cookies.set(sessionCookie, localSession, { path: '/', httpOnly: true, sameSite: 'lax', secure: false });
  }
  if (event.url.pathname.startsWith('/api/') || event.url.pathname === '/auth/start' || event.url.pathname === '/auth/logout') {
    requireLocalSession(event);
  }
  const response = await proxyRemote(event) || await resolve(event);
  if(!event.url.pathname.startsWith('/_app/'))logEvent('http.response',{status:response.status});
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  // Native POST forms need a same-origin Origin header for CSRF validation.
  // no-referrer makes browsers send Origin: null for these navigations.
  response.headers.set('Referrer-Policy', 'same-origin');
  if (!event.url.pathname.startsWith('/_app/')) response.headers.set('Cache-Control', 'no-store');
  return response;
};
return event.url.pathname.startsWith('/_app/') ? run() : trace('http',{method:event.request.method,path:event.url.pathname},run);
};

export const handleError: HandleServerError = ({error,event,status}) => {
  logEvent('http.error',{path:event.url.pathname,status,error});
};
