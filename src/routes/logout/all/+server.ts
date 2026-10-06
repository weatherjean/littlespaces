import { redirect } from '@sveltejs/kit';
import { ownerStore } from '$lib/server/owner';
import { sessions } from '$lib/server/sessions';
import { sessionCookie } from '$lib/server/security';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = ({ cookies }) => {
  // Change the durable generation first: even a concurrent/in-flight login with
  // the previous version cannot recreate a valid session after this operation.
  ownerStore().revokeSessions();
  sessions.clear();
  cookies.delete(sessionCookie, { path: '/' });
  cookies.delete('little_spaces_oauth', { path: '/auth' });
  redirect(303, '/login');
};
