import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { listSecrets, saveSecret, deleteSecret, configureSecret } from '$lib/server/secrets';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = () => json({ secrets: listSecrets() });
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  try {
    if (input.action === 'delete' && typeof input.name === 'string') deleteSecret(input.name);
    else if (input.action === 'configure' && typeof input.name === 'string')
      configureSecret(input.name, input.origins, input.description);
    else saveSecret(input);
    return json({ secrets: listSecrets() });
  } catch (error) {
    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Could not save secret. Check the name, value, and HTTPS API origins (no paths or custom ports).',
      },
      { status: 400 },
    );
  }
};
