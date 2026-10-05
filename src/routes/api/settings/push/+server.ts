import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { pushPublicKey, subscribePush, unsubscribePush, hasPush } from '$lib/server/push';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = () => json({ publicKey: pushPublicKey() });
export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  try {
    if (input.action === 'status' && typeof input.endpoint === 'string')
      return json({ enabled: hasPush(input.endpoint) });
    if (input.action === 'disable' && typeof input.endpoint === 'string')
      unsubscribePush(input.endpoint);
    else subscribePush(input.subscription);
    return json({ ok: true });
  } catch {
    return json(
      { error: 'Could not register this device for push notifications.' },
      { status: 400 },
    );
  }
};
