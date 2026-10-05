import { json } from '@sveltejs/kit';
import { appActions, callApp } from '$lib/server/backend';
import { body } from '$lib/server/security';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = async ({ params }) => {
  try {
    return json({ actions: await appActions(params.id) });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : 'Could not list actions.' },
      { status: 400 },
    );
  }
};
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (typeof input.action !== 'string')
    return json({ error: 'Missing action name.' }, { status: 400 });
  try {
    return json({ result: await callApp(event.params.id, input.action, input.input ?? {}) });
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : 'App action failed.' }, { status: 400 });
  }
};
