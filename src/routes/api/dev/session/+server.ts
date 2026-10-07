import { dev } from '$app/environment';
import { error, json } from '@sveltejs/kit';
import { devControlAuthorized } from '../../../../../scripts/dev-control.mjs';
import { origin } from '$lib/server/config';
import { ownerStore } from '$lib/server/owner';
import { sessions } from '$lib/server/sessions';
import { cookieOptions, sessionCookie } from '$lib/server/security';
import type { RequestHandler } from './$types';

// Exchange the local capability for an ordinary session in an automated browser.
// Never available from a production build or with only a normal owner session.
export const POST: RequestHandler = ({ request, cookies }) => {
  if (!devControlAuthorized(request, origin, dev, process.env.APP_DEV_CONTROL_TOKEN))
    error(404, 'Not found.');
  const owner = ownerStore().requireOwner();
  sessions.delete(cookies.get(sessionCookie));
  cookies.set(sessionCookie, sessions.create(owner.email, owner.version), cookieOptions);
  return json({ ready: true });
};
