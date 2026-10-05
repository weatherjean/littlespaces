import { redirect } from '@sveltejs/kit';
import { sessions } from '$lib/server/sessions';
import { sessionCookie } from '$lib/server/security';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = ({ cookies }) => {
  sessions.delete(cookies.get(sessionCookie));
  cookies.delete(sessionCookie, { path: '/' });
  cookies.delete('little_spaces_oauth', { path: '/auth' });
  redirect(303, '/login');
};
