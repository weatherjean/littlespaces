import { isHttpError, json } from '@sveltejs/kit';
import { boundedBytes } from '$lib/server/security';
import { listPhotos } from '$lib/server/storage';
import { importPhoto, maxPhotoBytes } from '$lib/server/photos';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({ params }) => {
  try {
    return json({ photos: listPhotos(params.id) });
  } catch {
    return json({ error: 'App not found.' }, { status: 404 });
  }
};
export const POST: RequestHandler = async ({ params, request }) => {
  try {
    const bytes = await boundedBytes(request, maxPhotoBytes + 10_000);
    const form = await new Response(new Uint8Array(bytes), {
      headers: { 'Content-Type': request.headers.get('content-type') || '' },
    }).formData();
    const file = form.get('photo');
    if (!(file instanceof File) || !file.size || file.size > maxPhotoBytes)
      return json({ error: 'Choose a photo up to 8 MB.' }, { status: 400 });
    return json({
      photo: await importPhoto(params.id, file.name, new Uint8Array(await file.arrayBuffer())),
    });
  } catch (error) {
    if (isHttpError(error)) throw error;
    return json(
      { error: error instanceof Error ? error.message : 'Could not save photo.' },
      { status: 400 },
    );
  }
};
