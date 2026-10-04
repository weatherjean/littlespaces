import { json } from '@sveltejs/kit';
import { readPhoto } from '$lib/server/storage';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = ({params,url}) => {
  try {
    const {data,...photo} = readPhoto(params.id,params.photoId);
    if (url.searchParams.has('data')) return json({...photo,dataUrl:`data:${photo.mime};base64,${data.toString('base64')}`});
    return new Response(new Uint8Array(data),{headers:{'Content-Type':photo.mime,'Content-Length':String(data.length),'Content-Disposition':'inline','Cache-Control':'no-store'}});
  } catch { return json({error:'Photo not found in this app.'},{status:404}); }
};
