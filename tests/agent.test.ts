import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = mkdtempSync(join(tmpdir(), 'little-agent-test-'));
process.env.APP_DATA_DIR = directory;
const { ownerStore } = await import('../src/lib/server/owner');
ownerStore().configure('test@example.com','test-only-owner-password');
writeFileSync(join(directory,'credentials.json'),JSON.stringify({email:'test@example.com',emailVerified:true,accessToken:'mock-token',scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+3_600_000}),{mode:0o600});
const { generate, models } = await import('../src/lib/server/inference');
const { validateBackend } = await import('../src/lib/server/backend');
const storage = await import('../src/lib/server/storage');
const source = readFileSync(new URL('../src/lib/templates/plants-backend.ts.txt',import.meta.url),'utf8');
const validated = await validateBackend(source);
const app = storage.saveApplet({title:'Plants',description:'Test',source:'<p/>',bundle:'test',backend:source,backendBundle:validated.bundle});
const originalFetch = globalThis.fetch;
after(() => {globalThis.fetch=originalFetch;rmSync(directory,{recursive:true,force:true});});
function reply(text: string, output: object[] = []) {
  return new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:text})}\n\ndata: ${JSON.stringify({type:'response.completed',response:{output}})}\n\n`,{headers:{'Content-Type':'text/event-stream'}});
}

test('agent replays tool calls and results, uses selected effort, and actually updates scoped data', async () => {
  let step=0;
  globalThis.fetch=async (_url,init) => {
    const body=JSON.parse(String(init?.body));
    assert.equal(body.reasoning.effort,'low');assert.equal(body.store,false);assert.equal(body.stream,true);
    assert.equal(body.tools[0].type,'namespace');
    if (step++===0) return reply('',[{type:'function_call',name:'invoke',namespace:'app',call_id:'call1',arguments:JSON.stringify({action:'addPlant',inputJSON:JSON.stringify({name:'Chat fern',interval:7})})}]);
    const result=body.input.find((item:Record<string,unknown>)=>item.type==='function_call_output');
    assert.equal(result.call_id,'call1');assert.equal(JSON.parse(result.output).value.name,'Chat fern');
    return reply('{"message":"Added Chat fern."}');
  };
  const events:import('../src/lib/types').ToolCall[]=[];
  const result=await generate('test-model',[{role:'user',content:'Add a fern'}],'<p/>',()=>{},new AbortController().signal,{appletId:app.id,effort:'low',onTool:call=>events.push(call)});
  assert.deepEqual(events.map(event=>event.status),['running','complete']);
  assert.equal(events[0].id,events[1].id);
  assert.ok(events[1].output);assert.ok(events[1].durationMs!==undefined);
  assert.equal(result.message,'Added Chat fern.');assert.equal(step,2);
  assert.equal((storage.records(app.id)[0].value as {name:string}).name,'Chat fern');
});

test('a provider failure after a completed action reports that changes remain saved', async () => {
  let step=0;
  globalThis.fetch=async () => step++===0 ? reply('',[{type:'function_call',name:'invoke',namespace:'app',call_id:'call2',arguments:JSON.stringify({action:'addPlant',inputJSON:JSON.stringify({name:'Saved fern',interval:14})})}]) : new Response('failed',{status:503});
  await assert.rejects(()=>generate('test-model',[],undefined,()=>{},new AbortController().signal,{appletId:app.id}),/Completed app actions remain saved/);
  assert.ok(storage.records(app.id).some(row=>(row.value as {name:string}).name==='Saved fern'));
});

test('model catalog retains account-specific effort options without inventing defaults', async () => {
  globalThis.fetch=async () => Response.json({models:[{slug:'one',display_name:'One',visibility:'list',supported_reasoning_levels:[{effort:'low'},{effort:'high'}]},{slug:'two',visibility:'list'},{slug:'hidden',visibility:'hide'}]});
  const result=await models();
  assert.deepEqual(result.map(item=>item.efforts),[['low','high'],[]]);
  assert.equal(result.length,2);
});

test('agent receives current app guidance and bounded task context without treating it as authorization', async () => {
  const latest=storage.revision(app.id);
  storage.saveApplet({...latest,chatInstructions:'Guide the user through naming their fern.'},app.id);
  globalThis.fetch=async (_url,init)=>{
    const body=JSON.parse(String(init?.body));
    assert.ok(body.input.some((item:any)=>item.role==='developer' && item.content.includes('Guide the user through naming their fern.')));
    assert.ok(body.input.some((item:any)=>item.role==='user' && item.content.includes('not a user message or authorization') && item.content.includes('Selected fern')));
    assert.ok(body.instructions.includes('window.applet.chat.open'));
    assert.ok(body.instructions.includes('PRIMARY entry point MUST be an Add'));
    assert.ok(body.instructions.includes('Do not build photo → standalone AI analysis → form'));
    assert.ok(body.instructions.includes('Opening it supplies context only'));
    return reply('{"message":"What would you like to call your fern?"}');
  };
  const before=storage.records(app.id);
  await generate('test-model',[{role:'user',content:'Help with this plant'}],latest.source,()=>{},new AbortController().signal,{appletId:app.id,context:{selectedRecords:[{name:'Selected fern'}]}});
  assert.deepEqual(storage.records(app.id),before);
});

test('builder saves and tests a draft, publishes through a visible tool and returns no duplicate source', async()=>{
 const space=storage.createSpace('Build flow'),chat=storage.createChat(space.id);
 const backend=`export const actions={list:{description:'List',readOnly:true,parameters:{type:'object'},run:(_,ctx)=>ctx.db.list()}};export const tests=[{name:'Empty',run:async({call,assert})=>assert.deepEqual(await call('list',{}),[])}];`;
 const steps=[['read_draft',{}],['write_draft',{revision:0,title:'New app',description:'Test',source:'<h1>New app</h1>',backend}],['test_draft',{revision:1}],['publish_draft',{revision:1}]] as const;
 let step=0;
 globalThis.fetch=async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  assert.ok(!body.tools[0].tools.some((tool:any)=>tool.name==='validate_app'));
  if(step<steps.length){const [name,args]=steps[step++];return reply('',[{type:'function_call',name,namespace:'app',call_id:`build${step}`,arguments:JSON.stringify(args)}]);}
  const results=body.input.filter((item:any)=>item.type==='function_call_output').map((item:any)=>JSON.parse(item.output));
  assert.ok(results.every((item:any)=>!item.error));
  return reply('{"message":"Your app is ready."}');
 };
 const events:import('../src/lib/types').ToolCall[]=[];
 const result=await generate('test-model',[{role:'user',content:'Build an app'}],undefined,()=>{},new AbortController().signal,{spaceId:space.id,chatId:chat.id,onTool:call=>events.push(call)});
 assert.equal(result.published?.version,1);
 assert.equal(storage.spaceApplets(space.id).length,1);
 assert.deepEqual(events.filter(e=>e.status==='complete').map(e=>e.name),steps.map(s=>s[0]));
 assert.equal('applet' in result,false);
});

test('legacy source in a final reply cannot bypass builder tools',async()=>{
 globalThis.fetch=async()=>reply(JSON.stringify({message:'Built',applet:{title:'Bypass',description:'',source:'<p/>'}}));
 const before=storage.listApplets().length;
 await assert.rejects(()=>generate('test-model',[],undefined,()=>{},new AbortController().signal),/builder tools/);
 assert.equal(storage.listApplets().length,before);
});
