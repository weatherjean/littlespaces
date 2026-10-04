import { json } from '@sveltejs/kit';
import { listPhotos } from '$lib/server/storage';
import { importPhoto, maxPhotoBytes } from '$lib/server/photos';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({params}) => {
  try { return json({photos:listPhotos(params.id)}); }
  catch { return json({error:'App not found.'},{status:404}); }
};
export const POST: RequestHandler = async ({params,request}) => {
  try {
    if (Number(request.headers.get('content-length')) > maxPhotoBytes + 10_000) return json({error:'Choose a photo up to 8 MB.'},{status:413});
    const form = await request.formData();
    const file = form.get('photo');
    if (!(file instanceof File) || !file.size || file.size > maxPhotoBytes) return json({error:'Choose a photo up to 8 MB.'},{status:400});
    return json({photo:await importPhoto(params.id,file.name,new Uint8Array(await file.arrayBuffer()))});
  } catch (error) { return json({error:error instanceof Error ? error.message : 'Could not save photo.'},{status:400}); }
};
