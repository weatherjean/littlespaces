import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { listSecrets, saveSecret, deleteSecret } from '$lib/server/secrets';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = () => json({ secrets: listSecrets() });
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  try {
    if (input.action === 'delete' && typeof input.name === 'string') deleteSecret(input.name);
    else saveSecret(input);
    return json({ secrets: listSecrets() });
  } catch {
    return json(
      {
        error:
          'Could not save secret. Use an uppercase name, nonempty value, and a short description.',
      },
      { status: 400 },
    );
  }
};
