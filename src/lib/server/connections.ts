import { randomUUID } from 'node:crypto';
import { workspace, createSpace } from './storage';
import type { Space, Applet } from '../types';
import type { AccessRole } from './access';
export type Connection={id:string;name:string;url:string;key:string};
export type RemoteSpace={id:string;connectionId:string;spaceId:string};
export type RemoteInfo={role:AccessRole;space:Space;applet:Applet|null;shared:boolean;source?:string;backend?:string;testReport?:string;chatInstructions:string};
function set(key:string,value:unknown){workspace(db=>db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value)));}
function get<T>(key:string):T|undefined{return workspace(db=>{const row=db.prepare('SELECT value FROM settings WHERE key=?').get(key);return row?JSON.parse(String(row.value)):undefined;});}
export function connections():Connection[]{return workspace(db=>db.prepare("SELECT value FROM settings WHERE key LIKE 'connection:%'").all().map(r=>JSON.parse(String(r.value))));}
export function connection(id:string){const value=get<Connection>(`connection:${id}`);if(!value)throw Error('Server connection not found.');return value;}
export function remoteSpace(id:string){return get<RemoteSpace>(`remote-space:${id}`);}
export function remoteAliases():RemoteSpace[]{return workspace(db=>db.prepare("SELECT value FROM settings WHERE key LIKE 'remote-space:%'").all().map(r=>JSON.parse(String(r.value))));}
export function aliasFor(connectionId:string,space:Space){
 let alias=remoteAliases().find(item=>item.connectionId===connectionId&&item.spaceId===space.id);
 if(!alias){const local=createSpace(space.name);alias={id:local.id,connectionId,spaceId:space.id};set(`remote-space:${alias.id}`,alias);}
 workspace(db=>db.prepare('UPDATE spaces SET name=?,icon=? WHERE id=?').run(space.name,space.icon,alias.id));
 return {...space,id:alias.id};
}
export async function remoteFetch(server:Connection,path:string,init:RequestInit={}){
 if(!path.startsWith('/v1/'))throw Error('Invalid server API path.');
 const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${server.key}`);
 // Never forward browser cookies, ChatGPT tokens, or redirects to another host.
 headers.delete('cookie');
 const response=await fetch(server.url+path,{...init,headers,redirect:'error',signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(path==='/v1/catalog'?5000:120000)]):AbortSignal.timeout(path==='/v1/catalog'?5000:120000)});
 if(!response.ok){const value=await response.json().catch(()=>({}));throw Error(value.error||`Server request failed (${response.status}).`);}
 return response;
}
export async function remoteJSON(server:Connection,path:string,input?:object){return (await remoteFetch(server,path,input===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).json();}
export async function addConnection(value:Record<string,unknown>){
 if(typeof value.name!=='string'||!value.name.trim()||value.name.length>80||typeof value.url!=='string'||typeof value.key!=='string'||value.key.length>200||!value.key.startsWith('ls_'))throw Error('Provide a server name, URL and access key.');
 const url=new URL(value.url);
 if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!['http:','https:'].includes(url.protocol))throw Error('Use a server origin such as https://apps.example.com.');
 if(url.protocol==='http:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw Error('Remote servers require HTTPS. HTTP is allowed only on this computer.');
 const server:Connection={id:randomUUID(),name:value.name.trim(),url:url.origin,key:value.key};
 const catalog=await remoteJSON(server,'/v1/catalog');
 if(!['owner','guest'].includes(catalog.role)||!Array.isArray(catalog.spaces))throw Error('Not a compatible app server.');
 set(`connection:${server.id}`,server);return {id:server.id,name:server.name,url:server.url,role:catalog.role};
}
export function removeConnection(id:string){
 // Keep locally stored conversations for reconnection, but a disconnected mapping can never be used.
 workspace(db=>db.prepare('DELETE FROM settings WHERE key=?').run(`connection:${id}`));
}
export async function connectedCatalog(){
 const results=await Promise.all(connections().map(async server=>{
  const publicServer={id:server.id,name:server.name,url:server.url};
  try{const catalog=await remoteJSON(server,'/v1/catalog');
   return {...publicServer,role:catalog.role as AccessRole,error:'',spaces:catalog.spaces.map((space:Space&{applet:Applet;shared:boolean})=>({...aliasFor(server.id,space),serverName:server.name,shared:space.shared})) as (Space&{serverName:string;shared:boolean})[]};
  }catch(error){return {...publicServer,role:null,error:error instanceof Error?error.message:'Server unavailable.',spaces:[]};}
 }));return results;
}
export async function remoteInfo(alias:RemoteSpace):Promise<RemoteInfo>{
 return remoteJSON(connection(alias.connectionId),`/v1/spaces/${alias.spaceId}`);
}
