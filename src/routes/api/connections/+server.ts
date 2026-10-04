import {json} from '@sveltejs/kit';
import {body} from '$lib/server/security';
import {addConnection,connectedCatalog,removeConnection,connection,remoteJSON,aliasFor} from '$lib/server/connections';
import {launcherChatId,createChat} from '$lib/server/storage';
import type {RequestHandler} from './$types';
export const GET:RequestHandler=async()=>json({servers:await connectedCatalog()});
export const POST:RequestHandler=async event=>{
 try{
  const input=await body(event);
  if(input.action==='remove'){removeConnection(String(input.id));return json({ok:true});}
  if(input.action==='build'){
   const server=connection(String(input.id));
   const info=await remoteJSON(server,`/v1/spaces/${launcherChatId}`);
   const space=aliasFor(server.id,{...info.space,name:`Build on ${server.name}`});
   const chat=createChat(space.id,{task:'Create a new app on this connected server. New apps start private.',title:'Create an app',welcome:'What would you like to build on this server?'});
   return json({href:`/spaces/${space.id}/chat/${chat.id}`});
  }
  if(input.action==='guest-key'){const server=connection(String(input.id));return json(await remoteJSON(server,'/v1/keys',{role:'guest'}));}
  return json({server:await addConnection(input)});
 }catch(error){return json({error:error instanceof Error?error.message:'Connection failed.'},{status:400});}
};
