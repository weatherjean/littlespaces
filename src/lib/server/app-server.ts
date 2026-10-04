// Transport for app storage and execution only. Never imports auth or inference.
import { randomBytes } from 'node:crypto';
import { AccessError, authenticate, requireOwner, requireSpace, isShared, setShared, rotateKey } from './access';
import { listSpaces, launcherChat, launcherChatId, spaceApplets, revision, versions, saveApplet, records, putRecord, removeRecord, listPhotos, readPhoto, createChat, workspace } from './storage';
import { appActions, callApp } from './backend';
import { appTools } from './app-tools';
import { importPhoto, maxPhotoBytes } from './photos';
import { validateChatLaunch, liveChatContext } from './chat-context';
import { listNotifications, markNotificationsRead, notify, cancelNotification } from './notifications';
import { appletDocument } from '../sandbox';
import { logEvent, trace } from './diagnostics';

function builderChat(spaceId:string,session:unknown){
 if(typeof session!=='string'||!/^[0-9a-f-]{36}$/.test(session))throw new AccessError(400,'Provide a build session ID.');
 const key=`remote-build:${spaceId}:${session}`;
 const existing=workspace(db=>db.prepare('SELECT value FROM settings WHERE key=?').get(key));
 if(existing)return String(existing.value);
 const chat=createChat(spaceId);
 workspace(db=>db.prepare('INSERT INTO settings VALUES(?,?)').run(key,chat.id));
 return chat.id;
}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
async function body(request:Request){
 const text=await request.text();
 if(text.length>1_000_000)throw new AccessError(413,'Request too large.');
 let value;try{value=JSON.parse(text);}catch{throw new AccessError(400,'Invalid JSON.');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new AccessError(400,'Expected an object.');
 return value as Record<string,any>;
}
const locks=new Set<string>();
export async function appServer(request:Request):Promise<Response>{
 const url=new URL(request.url);
 return trace('server.request',{method:request.method,path:url.pathname},async()=>{
 try {
  const role=authenticate(request.headers.get('authorization'));
  const method=request.method,path=url.pathname;
  const visible=()=>listSpaces().filter(s=>s.id!==launcherChatId && (role==='owner'||isShared(s.id)) && spaceApplets(s.id).length>0);
  if(path==='/v1/catalog'&&method==='GET')return json({role,spaces:visible().map(space=>({...space,shared:isShared(space.id),applet:spaceApplets(space.id)[0]}))});
  if(path==='/v1/keys'&&method==='POST'){requireOwner(role);const input=await body(request);if(input.role!=='guest')throw new AccessError(400,'Rotate the guest key here; rotate owner keys on the server.');return json({key:rotateKey('guest')});}
  if(path==='/v1/notifications'){
   const allowed=new Set(visible().map(s=>s.id)),items=listNotifications().filter(n=>allowed.has(n.spaceId));
   if(method==='GET')return json({notifications:items});
   if(method==='POST'){const input=await body(request);for(const item of items)if(!input.id||item.id===input.id)markNotificationsRead(item.id);return json({ok:true});}
  }
  const match=/^\/v1\/spaces\/([0-9a-f-]{36})(?:\/(.*))?$/.exec(path);
  if(!match)throw new AccessError(404,'Not found.');
  const [,spaceId,operation='']=match;
  if(spaceId===launcherChatId){requireOwner(role);launcherChat();}
  const space=requireSpace(role,spaceId),applet=spaceApplets(spaceId)[0];
  const current=applet?revision(applet.id):undefined;
  if(operation===''&&method==='GET')return json({role,space,shared:isShared(spaceId),applet:applet||null,chatInstructions:current?.chatInstructions||'',...(role==='owner'?{source:current?.source,backend:current?.backend,testReport:current?.testReport}:{} )});
  if(operation==='sharing'&&method==='POST'){requireOwner(role);const input=await body(request);if(typeof input.shared!=='boolean')throw new AccessError(400,'Provide shared true or false.');setShared(spaceId,input.shared);return json({shared:input.shared});}
  if(operation==='document'&&method==='GET'){
   if(!current)throw new AccessError(404,'App not found.');
   return json({document:appletDocument(current.bundle,randomBytes(24).toString('base64')),spaceId,versions:role==='owner'?versions(applet.id):[]});
  }
  if(operation==='restore'&&method==='POST'){
   requireOwner(role);if(!applet)throw new AccessError(404,'App not found.');const input=await body(request);
   if(!Number.isSafeInteger(input.version)||input.version<1)throw new AccessError(400,'Invalid version.');
   return json({applet:saveApplet(revision(applet.id,input.version),applet.id)});
  }
  if(operation==='tools'&&method==='GET')return json({definitions:(await appTools(applet?.id,spaceId,role==='owner'?builderChat(spaceId,url.searchParams.get('session')):undefined,{canBuild:role==='owner',visibleSpaces:visible})).definitions});
  if(operation==='tools'&&method==='POST'){
   const input=await body(request);
   // Construct the permitted catalog again on every call. Hidden tools cannot be invoked by name.
   const tools=await appTools(applet?.id,spaceId,role==='owner'?builderChat(spaceId,input.session):undefined,{canBuild:role==='owner',visibleSpaces:visible});
   if(typeof input.name!=='string'||!input.input||typeof input.input!=='object'||Array.isArray(input.input))throw new AccessError(400,'Invalid tool call.');
   const lock=`${spaceId}:${input.session}`;
   if(locks.has(lock))throw new AccessError(409,'This build session is busy.');
   locks.add(lock);
   try{return json({result:await tools.execute(input.name,input.input)});}finally{locks.delete(lock);}
  }
  if(operation==='context'&&method==='POST'){
   const input=await body(request),launch=input.launch===undefined?undefined:validateChatLaunch(spaceId,input.launch);
   return json({launch,context:liveChatContext(applet?.id,launch)});
  }
  if(operation==='actions'&&applet){
   if(method==='GET')return json({actions:await appActions(applet.id)});
   if(method==='POST'){const input=await body(request);return json({result:await callApp(applet.id,input.action,input.input)});}
  }
  if(operation==='records'&&applet){
   if(method==='GET')return json({result:records(applet.id)});
   if(method==='POST'){
    const input=await body(request);if(typeof input.key!=='string')throw new AccessError(400,'Provide a record key.');
    // Modern apps must use their validated actions; legacy apps retain their storage SDK.
    if(role==='guest'&&(await appActions(applet.id)).length)throw new AccessError(403,'Use this app’s actions to change its data.');
    if(input.method==='set')putRecord(applet.id,input.key,input.value);else if(input.method==='remove')removeRecord(applet.id,input.key);else throw new AccessError(400,'Unknown storage operation.');
    return json({result:null});
   }
  }
  if(operation==='photos'){
   if(method==='GET')return json({photos:listPhotos(spaceId)});
   if(method==='POST'){
    const form=await request.formData(),file=form.get('photo');
    if(!(file instanceof File)||file.size>maxPhotoBytes)throw new AccessError(400,'Choose a photo up to 8 MB.');
    return json({photo:await importPhoto(spaceId,file.name,new Uint8Array(await file.arrayBuffer()))});
   }
  }
  if(operation.startsWith('photos/')&&method==='GET'){
   const {data,...photo}=readPhoto(spaceId,operation.slice(7));
   return url.searchParams.has('data')?json({...photo,dataUrl:`data:${photo.mime};base64,${data.toString('base64')}`}):new Response(new Uint8Array(data),{headers:{'Content-Type':photo.mime,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }
  if(operation==='notifications'){
   if(method==='GET')return json({result:listNotifications(spaceId,true)});
   if(method==='POST'){const input=await body(request);if(input.action==='cancel'){if(typeof input.key!=='string')throw new AccessError(400,'Provide a key.');return json({result:cancelNotification(spaceId,input.key)});}return json({result:notify(spaceId,input)});}
  }
  if(operation==='diagnostics'&&method==='POST'){logEvent('remote.frontend',{role,spaceId,report:await body(request)});return json({result:{logged:true}});}
  throw new AccessError(404,'Not found.');
 }catch(error){
  logEvent('server.error',{error});
  return json({error:error instanceof Error?error.message:'Request failed.'},error instanceof AccessError?error.status:400);
 }
 });
}
