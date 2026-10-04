import { json } from '@sveltejs/kit';
import { body } from '$lib/server/security';
import { revision } from '$lib/server/storage';
import { logEvent } from '$lib/server/diagnostics';
import type { RequestHandler } from './$types';
let windowStart=0,count=0;
export const POST:RequestHandler=async event=>{
  if(Date.now()-windowStart>60000){windowStart=Date.now();count=0;}
  if(++count>60)return json({error:'Too many diagnostic reports.'},{status:429});
  const input=await body(event);
  if(typeof input.message!=='string'||input.message.length>4000|| (input.stack!==undefined && (typeof input.stack!=='string'||input.stack.length>8000)))return json({error:'Invalid report.'},{status:400});
  try{
    const current=revision(event.params.id);
    logEvent('frontend.error',{appletId:event.params.id,version:current.version,message:input.message,stack:input.stack,source:'untrusted applet report'});
    return json({logged:true});
  }catch{return json({error:'App not found.'},{status:404});}
};
