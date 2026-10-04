import type { RequestEvent } from '@sveltejs/kit';
import { remoteSpace, connection, remoteFetch, remoteJSON } from './connections';
import { createChat } from './storage';
import { models } from './inference';
import { analyzeImageInputs } from './vision';

export async function proxyRemote(event:RequestEvent):Promise<Response|undefined>{
 const match=/^\/api\/(spaces|applets)\/([^/]+)(?:\/(.*))?$/.exec(event.url.pathname);
 if(!match)return;
 const [,kind,id,operation='']=match,alias=remoteSpace(id);if(!alias)return;
 try{
  const server=connection(alias.connectionId),base=`/v1/spaces/${alias.spaceId}`;
  const photo=(p:any)=>({...p,url:`/api/spaces/${id}/photos/${p.id}`});
  if(kind==='spaces'&&operation==='chats'&&event.request.method==='POST'){
   const input=await event.request.json();
   const {launch}=await remoteJSON(server,`${base}/context`,{launch:input.launch});
   return Response.json({chat:createChat(id,launch)});
  }
  if(kind==='spaces'&&operation==='vision'&&event.request.method==='POST'){
   const input=await event.request.json();
   if(!Array.isArray(input.photoIds)||!input.photoIds.length||input.photoIds.length>4||input.photoIds.some((p:unknown)=>typeof p!=='string'||!/^[0-9a-f-]{36}$/.test(p))||typeof input.prompt!=='string'||input.prompt.length>4000||(input.model!==undefined&&typeof input.model!=='string')||!['text','plant'].includes(input.format||'text'))throw Error('Invalid photo analysis request.');
   const photos=await Promise.all(input.photoIds.map((p:string)=>remoteJSON(server,`${base}/photos/${p}?data=1`)));
   return Response.json({result:await analyzeImageInputs(photos.map(p=>p.dataUrl),input.model||(await models())[0]?.slug,input.prompt,input.format||'text',event.request.signal)});
  }
  const allowed=kind==='applets'?['','records','actions','diagnostics']:['photos','notifications'];
  if(!allowed.includes(operation)&&!(kind==='spaces'&&/^photos\/[0-9a-f-]{36}$/.test(operation)))throw Error('Unavailable remote operation.');
  let path=base+'/'+(kind==='applets'&&!operation?(event.request.method==='GET'?'document':'restore'):operation);
  path+=event.url.search;
  const headers=new Headers();const contentType=event.request.headers.get('content-type');if(contentType)headers.set('content-type',contentType);
  const response=await remoteFetch(server,path,{method:event.request.method,headers,...(!['GET','HEAD'].includes(event.request.method)?{body:await event.request.arrayBuffer()}:{}),signal:event.request.signal});
  if(response.headers.get('content-type')?.includes('application/json')){
   const value=await response.json();
   if(value.spaceId)value.spaceId=id;
   if(value.photo)value.photo=photo(value.photo);
   if(value.photos)value.photos=value.photos.map(photo);
   if(value.id&&value.mime)return Response.json(photo(value));
   if(operation==='notifications'&&Array.isArray(value.result))value.result=value.result.map((n:any)=>({...n,spaceId:id,href:`/spaces/${id}/applet`}));
   return Response.json(value);
  }
  return new Response(response.body,{headers:{'Content-Type':response.headers.get('content-type')||'application/octet-stream','Cache-Control':'no-store'}});
 }catch(error){return Response.json({error:error instanceof Error?error.message:'Server request failed.'},{status:400});}
}
