import { error, fail, redirect } from '@sveltejs/kit';
import { setupAccess, setupCookie } from '$lib/server/setup';
import { ownerStore } from '$lib/server/owner';
import { boundedText, cookieOptions, sessionCookie } from '$lib/server/security';
import { sessions } from '$lib/server/sessions';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ cookies }) => ({
  canRegister: setupAccess.valid(cookies.get(setupCookie)),
});
async function fields(request: Request) {
  if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded')
    error(400, 'Invalid setup request.');
  return new URLSearchParams(await boundedText(request, 8192));
}
export const actions: Actions = {
  unlock: async ({ request, cookies }) => {
    const input = await fields(request);
    const token = input.get('token') || '';
    if (!setupAccess.valid(token))
      return fail(403, {
        message:
          'This setup link is invalid or expired. Use the current link from the server terminal.',
      });
    cookies.set(setupCookie, token, {
      ...cookieOptions,
      maxAge: Math.max(1, Math.ceil((setupAccess.expiresAt - Date.now()) / 1000)),
    });
    redirect(303, '/setup');
  },
  register: async ({ request, cookies }) => {
    if (!setupAccess.valid(cookies.get(setupCookie)))
      return fail(403, { message: 'Your setup link expired. Restart the server for a new link.' });
    const input = await fields(request);
    // Recheck after reading the request body; it may have arrived slowly.
    if (!setupAccess.valid(cookies.get(setupCookie)))
      return fail(403, { message: 'Your setup link expired. Restart the server for a new link.' });
    const password = input.get('password') || '';
    if (password !== input.get('confirmation'))
      return fail(400, { message: 'Passwords did not match.' });
    try {
      ownerStore().configure(input.get('email') || '', password);
    } catch (cause) {
      if (ownerStore().get())
        return fail(409, { message: 'An owner has already been registered. Sign in instead.' });
      return fail(400, {
        message: cause instanceof Error ? cause.message : 'Could not create the owner account.',
      });
    }
    setupAccess.clear();
    cookies.delete(setupCookie, { path: '/' });
    const owner = ownerStore().requireOwner();
    sessions.delete(cookies.get(sessionCookie));
    cookies.set(sessionCookie, sessions.create(owner.email, owner.version), cookieOptions);
    redirect(303, '/');
  },
};
