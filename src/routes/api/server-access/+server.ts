import {json} from '@sveltejs/kit';
import {body} from '$lib/server/security';
import {accessInfo,rotateKey,isShared,setShared} from '$lib/server/access';
import {listSpaces,launcherChatId,spaceApplets} from '$lib/server/storage';
import {remoteSpace,connection,remoteJSON} from '$lib/server/connections';
import type {RequestHandler} from './$types';
export const GET:RequestHandler=()=>json({...accessInfo(),spaces:listSpaces().filter(space=>space.id!==launcherChatId&&!remoteSpace(space.id)&&spaceApplets(space.id).length).map(space=>({...space,shared:isShared(space.id)}))});
export const POST:RequestHandler=async event=>{
 try{
  const input=await body(event);
  if(input.action==='rotate'){
   if(input.role!=='owner'&&input.role!=='guest')throw Error('Choose owner or guest.');
   return json({key:rotateKey(input.role)});
  }
  if(typeof input.spaceId!=='string'||typeof input.shared!=='boolean')throw Error('Choose an app and visibility.');
  const alias=remoteSpace(input.spaceId);
  if(alias)return json(await remoteJSON(connection(alias.connectionId),`/v1/spaces/${alias.spaceId}/sharing`,{shared:input.shared}));
  setShared(input.spaceId,input.shared);return json({shared:input.shared});
 }catch(error){return json({error:error instanceof Error?error.message:'Access change failed.'},{status:400});}
};
