import { json, redirect } from '@sveltejs/kit';
import { startDeviceLogin } from '$lib/server/codex';
import { usesCodex } from '$lib/server/connection';
import { secureCookies } from '$lib/server/config';
import { startSignIn } from '$lib/server/auth';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, request }) => {
  if (usesCodex) {
    let attempt;
    try {
      attempt = await startDeviceLogin();
    } catch {
      return json(
        {
          error:
            'Could not start sign-in. Try again. Device-code login may need enabling in ChatGPT Settings → Security.',
        },
        { status: 400 },
      );
    }
    cookies.set('little_spaces_device', attempt.loginId, {
      path: '/auth',
      httpOnly: true,
      sameSite: 'lax',
      secure: secureCookies,
      maxAge: 600,
    });
    return json(attempt);
  }
  const attempt = startSignIn();
  cookies.set('little_spaces_oauth', attempt.state, {
    path: '/auth',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookies,
    maxAge: 600,
  });
  // Fetch must receive the URL rather than following an OAuth redirect across origins.
  if (request.headers.get('accept')?.includes('application/json'))
    return json({ url: attempt.url });
  redirect(303, attempt.url);
};
