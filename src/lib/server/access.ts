import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { workspace, getSpace, launcherChatId } from './storage';
export type AccessRole = 'owner' | 'guest';
export class AccessError extends Error { constructor(public status:number,message:string){super(message);} }
const digest=(key:string)=>createHash('sha256').update(key).digest();
export function accessInfo(){
 return workspace(db=>({configured:!!db.prepare("SELECT 1 FROM settings WHERE key='access:owner'").get(),guestConfigured:!!db.prepare("SELECT 1 FROM settings WHERE key='access:guest'").get()}));
}
export function rotateKey(role:AccessRole){
 if(role!=='owner'&&role!=='guest')throw new AccessError(400,'Invalid key role.');
 const key=`ls_${role}_${randomBytes(32).toString('base64url')}`;
 workspace(db=>db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`access:${role}`,digest(key).toString('hex')));
 return key;
}
export function authenticate(header:string|null):AccessRole {
 if(!header?.startsWith('Bearer ') || header.length>200)throw new AccessError(401,'A server access key is required.');
 const actual=digest(header.slice(7));
 const role=workspace(db=>{
  for(const role of ['owner','guest'] as const){
   const row=db.prepare('SELECT value FROM settings WHERE key=?').get(`access:${role}`);
   if(row && timingSafeEqual(actual,Buffer.from(String(row.value),'hex')))return role;
  }
 });
 if(!role)throw new AccessError(401,'Invalid or revoked server key.');
 return role;
}
export function requireOwner(role:AccessRole){if(role!=='owner')throw new AccessError(403,'Only the owner can change apps or manage access.');}
export function isShared(spaceId:string){
 return workspace(db=>db.prepare('SELECT value FROM settings WHERE key=?').get(`shared:${spaceId}`)?.value==='true');
}
export function setShared(spaceId:string,shared:boolean){
 getSpace(spaceId);
 if(spaceId===launcherChatId)throw new AccessError(400,'The built-in chat cannot be shared.');
 workspace(db=>db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`shared:${spaceId}`,String(shared)));
}
export function requireSpace(role:AccessRole,spaceId:string){
 // Uniform response for missing and private apps, including guessed IDs.
 if(role==='guest' && (spaceId===launcherChatId || !isShared(spaceId)))throw new AccessError(404,'App not found.');
 try{return getSpace(spaceId);}catch{throw new AccessError(404,'App not found.');}
}
