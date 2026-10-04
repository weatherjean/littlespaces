import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
const directory=mkdtempSync(join(tmpdir(),'little-access-'));process.env.APP_DATA_DIR=directory;
const {appServer}=await import('../src/lib/server/app-server');
const {rotateKey,setShared}=await import('../src/lib/server/access');
const storage=await import('../src/lib/server/storage');
const {publishApp}=await import('../src/lib/server/publish');
const {notify,listNotifications}=await import('../src/lib/server/notifications');
const backend=readFileSync(new URL('../src/lib/templates/plants-backend.ts.txt',import.meta.url),'utf8');
const app=await publishApp({title:'Shared plants',description:'Test',source:'<h1>Plants</h1>',backend,chatInstructions:'Help care for the plants.'});
const hidden=await publishApp({title:'Secret plants',description:'Private',source:'<h1>Private</h1>',backend,chatInstructions:'Private instructions.'});
let owner=rotateKey('owner'),guest=rotateKey('guest');
after(()=>rmSync(directory,{recursive:true,force:true}));
async function call(key:string,path:string,input?:object){return appServer(new Request('http://test'+path,{method:input?'POST':'GET',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(input?{body:JSON.stringify(input)}:{})}));}
const base=`/v1/spaces/${app.id}`;

test('keys are required, apps default private, and guessed private IDs disclose nothing',async()=>{
 assert.equal((await call('', '/v1/catalog')).status,401);
 assert.deepEqual((await (await call(guest,'/v1/catalog')).json()).spaces,[]);
 for(const suffix of ['', '/document','/photos','/actions','/records','/tools','/notifications'])assert.equal((await call(guest,base+suffix)).status,404);
 assert.equal((await call(guest,base+'/context',{})).status,404);
 assert.equal((await call(guest,base+'/tools',{name:'read_draft',input:{}})).status,404);
 const ownerCatalog=await (await call(owner,'/v1/catalog')).json();assert.equal(ownerCatalog.spaces.length,2);
 setShared(app.id,true);
 const catalog=await (await call(guest,'/v1/catalog')).json();assert.deepEqual(catalog.spaces.map((s:any)=>s.id),[app.id]);
});

test('guests can use shared app actions but cannot access source, history or builder operations',async()=>{
 const info=await (await call(guest,base)).json();
 assert.equal(info.chatInstructions,'Help care for the plants.');
 for(const field of ['source','backend','testReport'])assert.equal(info[field],undefined);
 const document=await (await call(guest,base+'/document')).json();assert.ok(document.document);assert.deepEqual(document.versions,[]);
 const definitions=await (await call(guest,base+'/tools')).json();
 assert.ok(!JSON.stringify(definitions).includes('write_draft'));
 const names=['read_draft','write_draft','edit_draft','test_draft','publish_draft'];
 for(const name of names)assert.equal((await call(guest,base+'/tools',{name,input:{revision:0,source:'evil'},session:randomUUID()})).status,400);
 for(const path of ['/sharing','/restore'])assert.equal((await call(guest,base+path,{shared:true,version:1})).status,403);
 assert.equal((await call(guest,'/v1/keys',{role:'guest'})).status,403);
 assert.equal((await call(guest,`/v1/spaces/${storage.launcherChatId}`)).status,403);
 assert.equal((await call(guest,base+'/chats')).status,404);
 assert.equal((await call(guest,base+'/records',{method:'set',key:'bypass',value:1})).status,403);
 const result=await (await call(guest,base+'/actions',{action:'addPlant',input:{name:'Guest fern',interval:7}})).json();assert.equal(result.result.value.name,'Guest fern');
 assert.equal(storage.records(app.id).length,1);assert.equal(storage.records(hidden.id).length,0);assert.equal(storage.revision(app.id).version,1);
});

test('notifications are filtered and marking all read cannot affect private reminders',async()=>{
 notify(app.id,{key:'shared',title:'Shared',body:''});notify(hidden.id,{key:'secret',title:'Secret',body:''});
 const items=(await (await call(guest,'/v1/notifications')).json()).notifications;
 assert.ok(items.every((n:any)=>n.spaceId===app.id));
 await call(guest,'/v1/notifications',{});
 assert.ok(listNotifications(app.id).every(n=>n.read));assert.ok(listNotifications(hidden.id).every(n=>!n.read));
});

test('owner builds use drafts while new apps remain private',async()=>{
 storage.launcherChat();const path=`/v1/spaces/${storage.launcherChatId}/tools`,session=randomUUID();
 async function tool(name:string,input:object){const response=await call(owner,path,{name,input,session});assert.equal(response.status,200,await response.clone().text());return (await response.json()).result;}
 await tool('write_draft',{revision:0,title:'Owner app',description:'',source:'<h1>Owner</h1>',backend});
 const early=await call(owner,path,{name:'publish_draft',input:{revision:1},session});assert.equal(early.status,400);
 await tool('test_draft',{revision:1});const result=await tool('publish_draft',{revision:1});
 assert.ok(result.applet.id);assert.equal((await call(guest,`/v1/spaces/${result.applet.id}`)).status,404);
 assert.equal((await call(owner,base+'/sharing',{shared:false})).status,200);
 assert.equal((await call(guest,base+'/actions',{action:'addPlant',input:{name:'Revoked',interval:7}})).status,404);
 setShared(app.id,true);
});

test('rotating keys revokes old credentials immediately without affecting the other role',async()=>{
 const oldGuest=guest;guest=rotateKey('guest');
 assert.equal((await call(oldGuest,base+'/tools',{name:'describe',input:{}})).status,401);
 assert.equal((await call(guest,base)).status,200);assert.equal((await call(owner,base)).status,200);
 const oldOwner=owner;owner=rotateKey('owner');
 assert.equal((await call(oldOwner,base)).status,401);assert.equal((await call(guest,base)).status,200);
});

test('guest photos remain scoped to the shared app and private chat context is unavailable',async()=>{
 const photo=storage.savePhoto(app.id,{name:'Shared photo',mime:'image/jpeg',width:1,height:1,data:Buffer.from('shared image fixture')});
 const privatePhoto=storage.savePhoto(hidden.id,{name:'Private photo',mime:'image/jpeg',width:1,height:1,data:Buffer.from('private image fixture')});
 const response=await call(guest,base+`/photos/${photo.id}?data=1`);assert.equal(response.status,200);
 assert.equal((await response.json()).name,'Shared photo');
 assert.equal((await call(guest,base+`/photos/${privatePhoto.id}?data=1`)).status,400);
 assert.equal((await call(guest,`/v1/spaces/${hidden.id}/photos/${privatePhoto.id}`)).status,404);
 assert.equal((await call(guest,base+'/context',{launch:{task:'Use private picture',photoIds:[privatePhoto.id]}})).status,400);
});
