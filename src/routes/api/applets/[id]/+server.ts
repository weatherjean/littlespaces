import { randomBytes } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { revision, saveApplet, versions, appletSpaceId } from '$lib/server/storage';
import { body } from '$lib/server/security';
import { appletDocument } from '$lib/sandbox';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
  try {
    const current = revision(params.id);
    return json({ spaceId: appletSpaceId(params.id), document: appletDocument(current.bundle, randomBytes(24).toString('base64')), versions: versions(params.id) });
  } catch { return json({ error: 'Applet not found.' }, { status: 404 }); }
};

export const POST: RequestHandler = async (event) => {
  const input = await body(event);
  if (input.action !== 'restore' || !Number.isSafeInteger(input.version) || Number(input.version) < 1) return json({ error: 'Invalid revision.' }, { status: 400 });
  try {
    const old = revision(event.params.id, Number(input.version));
    const applet = saveApplet(old, event.params.id);
    return json({ applet });
  } catch { return json({ error: 'Could not restore that revision.' }, { status: 400 }); }
};
