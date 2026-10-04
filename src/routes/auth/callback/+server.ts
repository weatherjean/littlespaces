import { redirect } from '@sveltejs/kit';
import { finishSignIn } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
  let message = '';
  try { await finishSignIn(url.searchParams, cookies.get('little_spaces_oauth')); }
  catch (error) { message = error instanceof Error ? error.message : 'Sign-in failed.'; }
  cookies.delete('little_spaces_oauth', { path: '/auth' });
  redirect(303, message ? `/?auth_error=${encodeURIComponent(message)}` : '/');
};
