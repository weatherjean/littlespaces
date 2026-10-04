import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { account } from '$lib/server/auth';
import { models } from '$lib/server/inference';
import { analyzePhotos } from '$lib/server/vision';
import type { RequestHandler } from './$types';
const active=new Set<string>();
export const POST: RequestHandler = async event => {
  if(!account()?.canUsePlan) return json({error:'Connect ChatGPT in Settings to identify photos.'},{status:401});
  const input=await body(event);
  if(!Array.isArray(input.photoIds)||input.photoIds.length<1||input.photoIds.length>4||input.photoIds.some(id=>typeof id!=='string')||typeof input.prompt!=='string'||input.prompt.length>4000||!['text','plant'].includes(String(input.format||'text'))) return json({error:'Select 1–4 photos and provide a short analysis request.'},{status:400});
  if(active.has(event.params.id)) return json({error:'An image analysis is already running for this app.'},{status:409});
  active.add(event.params.id);
  try {
    const catalog=await models();
    const model=typeof input.model==='string'&&input.model?input.model:catalog[0]?.slug;
    if(!catalog.some(item=>item.slug===model)) throw new Error('Choose a model available to your ChatGPT account.');
    return json({result:await analyzePhotos(event.params.id,input.photoIds as string[],model,input.prompt,(input.format||'text') as 'text'|'plant',event.request.signal)});
  } catch(error) { return json({error:error instanceof Error?error.message:'Could not analyze photo.'},{status:400}); }
  finally {active.delete(event.params.id);}
};
