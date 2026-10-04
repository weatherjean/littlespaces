import {connections,remoteJSON,aliasFor} from './connections';
import type {Notification,Space} from '../types';
export async function remoteNotifications():Promise<Notification[]>{
 return (await Promise.all(connections().map(async server=>{
  try{
   const catalog=await remoteJSON(server,'/v1/catalog'),allowed=new Map<string,Space>(catalog.spaces.map((space:Space)=>[space.id,aliasFor(server.id,space)]));
   const value=await remoteJSON(server,'/v1/notifications');
   return value.notifications.filter((n:Notification)=>allowed.has(n.spaceId)).map((n:Notification)=>{const space=allowed.get(n.spaceId)!;return {...n,id:`${server.id}:${n.id}`,spaceId:space.id,source:`${server.name} · ${n.source}`,href:`/spaces/${space.id}/applet`};});
  }catch{return [];}
 }))).flat();
}
export async function readRemoteNotifications(id?:string){
 for(const server of connections())if(!id||id.startsWith(server.id+':'))await remoteJSON(server,'/v1/notifications',id?{id:id.slice(server.id.length+1)}:{});
}
