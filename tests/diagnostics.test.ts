import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,statSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'little-diagnostics-'));
process.env.APP_DATA_DIR=directory;
const {logEvent,trace}=await import('../src/lib/server/diagnostics');
const path=join(directory,'logs','events.jsonl');
after(()=>rmSync(directory,{recursive:true,force:true}));
const rows=()=>readFileSync(path,'utf8').trim().split('\n').map(line=>JSON.parse(line));

test('deep traces retain useful context while removing credentials, image bytes and reasoning',async()=>{
 await trace('request',{chatId:'chat-one'},async()=>{
  logEvent('model.request',{instructions:'Prefer add with chat.',history:[{role:'user',content:'Add my lunch'}],accessToken:'private-token',headers:{Authorization:'Bearer secret',cookie:'private-cookie'},arguments:JSON.stringify({client_secret:'private-client',date:'2026-10-04'}),input:[{type:'input_image',image_url:'data:image/png;base64,private-image'}]});
  await trace('tool',{action:'add'},async()=>logEvent('tool.result',{calories:400,usage:{input_tokens:123,output_tokens:45},output:[{type:'reasoning',encrypted_content:'private-reasoning',summary:'private-summary'},{type:'response.reasoning_summary_text.done',text:'private-summary'}]}));
 });
 const text=readFileSync(path,'utf8');
 for(const secret of ['private-token','private-cookie','private-client','private-image','private-reasoning','private-summary'])assert.ok(!text.includes(secret));
 assert.ok(text.includes('Add my lunch'));assert.ok(text.includes('"input_tokens":123'));
 const events=rows();assert.equal(new Set(events.map(row=>row.traceId)).size,1);
 assert.ok(events.find(row=>row.event==='tool.start').parentSpanId);
 assert.equal(statSync(path).mode & 0o777,0o600);
 assert.equal(statSync(join(directory,'logs')).mode & 0o777,0o700);
});

test('concurrent traces remain isolated and errors include a stack without swallowing the failure',async()=>{
 await Promise.all(['a','b'].map(chatId=>trace('parallel',{chatId},async()=>{await new Promise(resolve=>setTimeout(resolve,5));logEvent('inside',{chatId});})));
 const events=rows().filter(row=>row.event==='inside');assert.equal(events.length,2);assert.notEqual(events[0].traceId,events[1].traceId);
 for(const row of events)assert.equal(row.chatId,row.details.chatId);
 await assert.rejects(()=>trace('failed',{},async()=>{throw Error('test failure');}),/test failure/);
 const error=rows().find(row=>row.event==='failed.error');assert.ok(error.details.error.stack.includes('test failure'));
});

test('rotation retains bounded archives and logging failure cannot break an operation',async()=>{
 writeFileSync(path,'x'.repeat(10*1024*1024));logEvent('after.rotation');
 assert.ok(existsSync(join(directory,'logs','events.1.jsonl')));assert.equal(rows()[0].event,'after.rotation');
 const logs=join(directory,'logs');rmSync(logs,{recursive:true});writeFileSync(logs,'not a directory');
 const old=console.error;console.error=()=>{};
 try{assert.equal(await trace('still.works',{},async()=>42),42);}finally{console.error=old;}
});
