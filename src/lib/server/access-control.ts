import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { origin, secureCookies } from './config';
import { authenticated, requireSameOrigin } from './security';
import { ownerStore } from './owner';

const publicAssets = new Set([
  '/icon.svg',
  '/favicon.ico',
  '/favicon-16.png',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-maskable-512.png',
  '/appearance.js',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-180.png',
  '/manifest.webmanifest',
  '/offline.html',
  '/service-worker.js',
  '/service-worker.mjs',
]);
export function guard(event: RequestEvent) {
  // adapter-node uses the configured ORIGIN for event.url, even when the browser
  // requested a loopback alias. Redirect safe requests before rendering any forms.
  const configuredOrigin = new URL(origin);
  if (
    configuredOrigin.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(configuredOrigin.hostname) &&
    ['GET', 'HEAD'].includes(event.request.method)
  ) {
    const suffix = configuredOrigin.port ? `:${configuredOrigin.port}` : '';
    const host = event.request.headers.get('host')?.toLowerCase();
    const aliases = ['127.0.0.1', 'localhost', '[::1]'].map((name) => name + suffix);
    if (host && host !== configuredOrigin.host && aliases.includes(host))
      redirect(307, origin + event.url.pathname + event.url.search);
  }

  if (event.url.origin !== origin) error(403, 'Unexpected app origin.');
  requireSameOrigin(event);
  const path = event.url.pathname;
  // Explicit public surface. All new application routes are private by default.
  if (
    ['GET', 'HEAD'].includes(event.request.method) &&
    (path.startsWith('/_app/') || publicAssets.has(path))
  )
    return;
  event.locals.owner = null;
  const configured = Boolean(ownerStore().get());
  if (path === '/setup') {
    if (configured) {
      if (['GET', 'HEAD'].includes(event.request.method)) redirect(303, '/login');
      error(404, 'Setup is closed.');
    }
    return;
  }
  if (!configured) {
    if (
      path.startsWith('/api/') ||
      path.startsWith('/auth/') ||
      !['GET', 'HEAD'].includes(event.request.method)
    )
      error(401, 'Owner setup is required.');
    redirect(303, '/setup');
  }
  const session = authenticated(event);
  event.locals.owner = session ? { email: session.email } : null;
  if (path === '/login') {
    if (session && ['GET', 'HEAD'].includes(event.request.method)) redirect(303, '/');
    return;
  }
  if (!session) {
    if (
      path.startsWith('/api/') ||
      path.startsWith('/auth/') ||
      !['GET', 'HEAD'].includes(event.request.method)
    )
      error(401, 'Sign in to continue.');
    redirect(303, '/login');
  }
}
export function privateHeaders(response: Response) {
  // Oversized bodies may be only partly consumed. Do not reuse that HTTP/1
  // connection for another request after sending the rejection.
  if (response.status === 413) response.headers.set('Connection', 'close');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Vary', [response.headers.get('Vary'), 'Cookie'].filter(Boolean).join(', '));
  if (secureCookies) response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return response;
}
