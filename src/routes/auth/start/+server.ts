import { json, redirect } from '@sveltejs/kit';
import { startSignIn } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ cookies, request }) => {
  const attempt = startSignIn();
  cookies.set('little_spaces_oauth', attempt.state, { path: '/auth', httpOnly: true, sameSite: 'lax', secure: false, maxAge: 600 });
  // Fetch must receive the URL rather than following an OAuth redirect across origins.
  if (request.headers.get('accept')?.includes('application/json')) return json({ url: attempt.url });
  redirect(303, attempt.url);
};
