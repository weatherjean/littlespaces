import {json} from '@sveltejs/kit';
import {notify,listNotifications,cancelNotification} from '$lib/server/notifications';
import {body} from '$lib/server/security';
import type {RequestHandler} from './$types';
export const GET:RequestHandler=({params})=>{try{return json({result:listNotifications(params.id,true)});}catch{return json({error:'Space not found.'},{status:404});}};
export const POST:RequestHandler=async event=>{
 const input=await body(event);
 try{
  if(input.action==='cancel'){if(typeof input.key!=='string')throw Error('Provide a key.');return json({result:cancelNotification(event.params.id,input.key)});}
  return json({result:notify(event.params.id,input)});
 }catch(e){return json({error:e instanceof Error?e.message:'Notification failed.'},{status:400});}
};
