import { interruptChatJobs } from '$lib/server/chat-jobs';
import { startScheduler } from '$lib/server/scheduler';
import { building, dev } from '$app/environment';
import { isHttpError, isRedirect, type Handle, type HandleServerError } from '@sveltejs/kit';
import { guard, privateHeaders } from '$lib/server/access-control';
import { initializeOwnerSetup } from '$lib/server/setup';
import { logEvent } from '$lib/server/diagnostics';
import { deleteEmptyChats } from '$lib/server/storage';

export function init() {
  if (!building) {
    initializeOwnerSetup();
    interruptChatJobs();
    deleteEmptyChats();
    startScheduler();
  }
}
export const handle: Handle = async ({ event, resolve }) => {
  try {
    guard(event, dev);
  } catch (error) {
    if (isRedirect(error))
      return privateHeaders(
        new Response(null, { status: error.status, headers: { Location: error.location } }),
      );
    if (isHttpError(error))
      return privateHeaders(
        Response.json({ message: error.body.message }, { status: error.status }),
      );
    throw error;
  }
  return privateHeaders(await resolve(event));
};
export const handleError: HandleServerError = ({ error, event, status }) => {
  // Never log a submitted password, request body, cookies or OAuth query parameters.
  logEvent('http.error', { path: event.url.pathname, status, error });
  return { message: 'Something went wrong. Please try again.' };
};
