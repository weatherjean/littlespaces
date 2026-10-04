import { connection, remoteJSON, remoteInfo, aliasFor, type RemoteSpace } from './connections';
import type { Message, ChatLaunch, Space } from '../types';
export async function remoteRuntime(alias:RemoteSpace,chatId:string,history:Message[],launch?:ChatLaunch){
 const server=connection(alias.connectionId),base=`/v1/spaces/${alias.spaceId}`;
 const info=await remoteInfo(alias),canBuild=info.role==='owner';
 const {definitions}=await remoteJSON(server,`${base}/tools?session=${encodeURIComponent(chatId)}`);
 const {context}=await remoteJSON(server,`${base}/context`,{launch});
 let remaining=8;const selected=new Set<string>();
 for(const message of [...history].reverse())for(const id of [...(message.photos||[])].reverse())if(remaining&&!selected.has(id)){selected.add(id);remaining--;}
 const photos=new Map<string,string>();
 for(const id of selected){
  if(!/^[0-9a-f-]{36}$/.test(id))throw Error('Invalid photo reference.');
  photos.set(id,(await remoteJSON(server,`${base}/photos/${id}?data=1`)).dataUrl);
 }
 const emitted=new Set<string>();
 const inputHistory=history.map(message=>{
  if(!message.photos?.length)return {role:message.role,content:message.content};
  const content:Record<string,unknown>[]=[{type:'input_text',text:`${message.content}\nAttached photo IDs: ${message.photos.join(', ')}`}];
  for(const id of message.photos)if(photos.has(id)&&!emitted.has(id)){content.push({type:'input_image',image_url:photos.get(id),detail:'auto'});emitted.add(id);}
  return {role:message.role,content};
 });
 return {canBuild,source:canBuild?info.source:undefined,backend:canBuild?info.backend:undefined,chatInstructions:info.chatInstructions,history:inputHistory,context,
  tools:{definitions,async execute(name:string,input:Record<string,unknown>){
   const {result}=await remoteJSON(server,`${base}/tools`,{name,input,session:chatId});
   if(name.replace(/^app\./,'')==='publish_draft'&&result?.applet){
    const catalog=await remoteJSON(server,'/v1/catalog');
    const space=catalog.spaces.find((s:Space&{applet:{id:string}})=>s.applet.id===result.applet.id);
    if(!space)throw Error('Published app was not found in the server catalog.');
    result.applet.id=aliasFor(server.id,space).id;
   }
   return result;
  }}
 };
}
