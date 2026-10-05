import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { setSpaceArchived } from '$lib/server/storage';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (typeof input.id !== 'string' || typeof input.archived !== 'boolean')
    return json({ error: 'Choose an app and an archive state.' }, { status: 400 });
  try {
    return json({ space: setSpaceArchived(input.id, input.archived) });
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : 'Could not update app.' },
      { status: 400 },
    );
  }
};
