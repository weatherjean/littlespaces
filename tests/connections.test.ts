import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'little-connections-'));process.env.APP_DATA_DIR=directory;
writeFileSync(join(directory,'credentials.json'),JSON.stringify({accessToken:'client-only-token',scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+3600000}),{mode:0o600});
const {appServer}=await import('../src/lib/server/app-server');
const {rotateKey,setShared}=await import('../src/lib/server/access');
const storage=await import('../src/lib/server/storage');
const {publishApp}=await import('../src/lib/server/publish');
const {addConnection,connectedCatalog,remoteSpace,connections,removeConnection}=await import('../src/lib/server/connections');
const {remoteRuntime}=await import('../src/lib/server/remote-agent');
const {generate}=await import('../src/lib/server/inference');
const app=await publishApp({title:'Remote counter',description:'Shared',source:'<h1>Counter</h1>',backend:`export const actions={add:{description:'Add one',readOnly:false,parameters:{type:'object',properties:{},additionalProperties:false},run:(_,ctx)=>{const n=(ctx.db.get('count')||0)+1;ctx.db.set('count',n);return n;}}};export const tests=[{name:'Adds',run:async({call,db,assert})=>{assert.equal(await call('add',{}),1);assert.equal(db.get('count'),1);}}];`,chatInstructions:'Help use the counter.'});
setShared(app.id,true);const guest=rotateKey('guest');rotateKey('owner');
const originalFetch=globalThis.fetch;
let modelRequests:any[]=[],apiHeaders:string[]=[];
function reply(text:string,output:object[]=[]){return new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:text})}\n\ndata: ${JSON.stringify({type:'response.completed',response:{output}})}\n\n`);}
globalThis.fetch=async(url,init)=>{
 const target=String(url),headers=new Headers(init?.headers);
 if(target.startsWith('https://apps.example')||target.startsWith('https://second.example')){
  apiHeaders.push(headers.get('Authorization')||'');assert.equal(headers.get('Authorization'),`Bearer ${guest}`);assert.equal(headers.get('cookie'),null);assert.equal(init?.redirect,'error');
  return appServer(new Request(target,init));
 }
 assert.equal(target,'https://api.openai.com/v1/responses');assert.equal(headers.get('Authorization'),'Bearer client-only-token');
 const body=JSON.parse(String(init?.body));modelRequests.push(body);
 if(modelRequests.length===1)return reply('',[{type:'function_call',name:'invoke',namespace:'app',call_id:'add1',arguments:JSON.stringify({action:'add',inputJSON:'{}'})}]);
 return reply('{"message":"Added one."}');
};
after(()=>{globalThis.fetch=originalFetch;rmSync(directory,{recursive:true,force:true});});

test('URL plus key connects multiple servers, keeping identities separate and keys out of the catalog',async()=>{
 await addConnection({name:'First',url:'https://apps.example',key:guest});await addConnection({name:'Second',url:'https://second.example',key:guest});
 const catalog=await connectedCatalog();assert.equal(catalog.length,2);assert.equal(catalog[0].spaces.length,1);
 assert.notEqual(catalog[0].spaces[0].id,catalog[1].spaces[0].id);
 assert.ok(!JSON.stringify(catalog).includes(guest));assert.ok(catalog.every(c=>c.role==='guest'));
 await assert.rejects(()=>addConnection({name:'Unsafe',url:'http://example.com',key:guest}),/HTTPS/);
});

test('guest chat runs inference on the client and forwards only the app key to the app server',async()=>{
 const catalog=await connectedCatalog(),space=catalog[0].spaces[0],alias=remoteSpace(space.id)!;
 const chat=storage.createChat(space.id);
 const history=[{role:'user' as const,content:'Add one'}];
 const runtime=await remoteRuntime(alias,chat.id,history);
 assert.equal(runtime.canBuild,false);assert.equal(runtime.source,undefined);assert.equal(runtime.backend,undefined);
 const result=await generate('test-model',history,undefined,()=>{},new AbortController().signal,{spaceId:space.id,chatId:chat.id,remote:runtime});
 assert.equal(result.message,'Added one.');assert.equal(storage.records(app.id)[0].value,1);
 assert.ok(modelRequests[0].instructions.includes('cannot create apps'));
 assert.ok(!JSON.stringify(modelRequests).includes('export const actions'));
 assert.ok(!JSON.stringify(modelRequests[0].tools).includes('write_draft'));assert.ok(apiHeaders.length>0);
 await assert.rejects(()=>runtime.tools.execute('publish_draft',{revision:1}),/unavailable/);
 setShared(app.id,false);
 await assert.rejects(()=>runtime.tools.execute('invoke',{action:'add',inputJSON:'{}'}),/App not found/);
 assert.equal(storage.records(app.id)[0].value,1);
});

test('disconnecting a server prevents stale aliases from making requests',async()=>{
 const server=connections()[0];removeConnection(server.id);
 const {connection}=await import('../src/lib/server/connections');assert.throws(()=>connection(server.id),/not found/);
});
