import { fail, redirect } from '@sveltejs/kit';
import { ownerStore } from '$lib/server/owner';
import { sessions } from '$lib/server/sessions';
import { boundedText, cookieOptions, sessionCookie } from '$lib/server/security';
import type { Actions } from './$types';
export const actions: Actions = {
  default: async ({request,cookies,setHeaders}) => {
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/x-www-form-urlencoded') return fail(400,{message:'Invalid sign-in request.'});
    const fields = new URLSearchParams(await boundedText(request, 4096));
    const result = ownerStore().authenticate(fields.get('email') || '', fields.get('password') || '');
    if (!result.ok) {
      if (result.retryAfter) {
        setHeaders({'Retry-After':String(result.retryAfter)});
        return fail(429,{message:'Sign-in is temporarily locked. Try again in five minutes.'});
      }
      return fail(400,{message:'The email or password is incorrect.'});
    }
    sessions.delete(cookies.get(sessionCookie));
    const token = sessions.create(result.email,result.version);
    cookies.set(sessionCookie, token, cookieOptions);
    redirect(303,'/');
  }
};
