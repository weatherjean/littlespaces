import { json } from '@sveltejs/kit';
import { records, putRecord, removeRecord } from '$lib/server/storage';
import { body } from '$lib/server/security';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
  try { return json({ result: records(params.id) }); }
  catch { return json({ error: 'Applet not found.' }, { status: 404 }); }
};

export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (typeof input.key !== 'string') return json({ error: 'Missing record key.' }, { status: 400 });
  try {
    if (input.method === 'set') putRecord(event.params.id, input.key, input.value);
    else if (input.method === 'remove') removeRecord(event.params.id, input.key);
    else return json({ error: 'Unsupported storage action.' }, { status: 400 });
    return json({ result: null });
  } catch (error) { return json({ error: error instanceof Error ? error.message : 'Storage operation failed.' }, { status: 400 }); }
};
