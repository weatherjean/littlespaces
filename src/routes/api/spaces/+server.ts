import { json } from '@sveltejs/kit';
import { createSpace, listSpaces } from '$lib/server/storage';
import { body } from '$lib/server/security';
import type { RequestHandler } from './$types';

export const GET = () => json({ spaces: listSpaces() });
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (typeof input.name !== 'string' || typeof input.icon !== 'string')
    return json({ error: 'Choose a space name and icon.' }, { status: 400 });
  try {
    return json({ space: createSpace(input.name, input.icon) });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : 'Could not create space.' },
      { status: 400 },
    );
  }
};
