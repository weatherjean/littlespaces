import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
const directory=mkdtempSync(join(tmpdir(),'little-photos-'));
process.env.APP_DATA_DIR=directory;
const storage=await import('../src/lib/server/storage');
const {importPhoto}=await import('../src/lib/server/photos');
const {imageHistory,analyzePhotos,parsePlantIdentification}=await import('../src/lib/server/vision');
const {appTools}=await import('../src/lib/server/app-tools');
const originalFetch=globalThis.fetch;
after(()=>{globalThis.fetch=originalFetch;rmSync(directory,{recursive:true,force:true});});
const source=await sharp({create:{width:2400,height:1200,channels:3,background:'#28a65a'}}).withExif({IFD0:{Artist:'Private camera owner'}}).jpeg().toBuffer();
const space=storage.createSpace('Plant tests','leaf');
const other=storage.createSpace('Other');
const photo=await importPhoto(space.id,'fern.jpg',source);
const content={title:'Test',description:'Test',source:'<p/>',bundle:'test'};

test('uploads decode, resize, strip metadata, and reject disguised or oversized images',async()=>{
  const image=storage.readPhoto(space.id,photo.id);
  assert.equal(image.width,2048);assert.equal(image.height,1024);
  const metadata=await sharp(image.data).metadata();
  assert.equal(metadata.format,'jpeg');assert.equal(metadata.exif,undefined);
  await assert.rejects(()=>importPhoto(space.id,'bad.jpg',Buffer.from('not an image')));
  await assert.rejects(()=>importPhoto(space.id,'svg.png',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')),/JPEG/);
  await assert.rejects(()=>importPhoto(space.id,'huge.jpg',Buffer.alloc(9*1024*1024)),/8 MB/);
});

test('photos remain scoped and move into the app SQLite file when a space becomes an app',()=>{
  assert.throws(()=>storage.readPhoto(other.id,photo.id),/not found/);
  assert.throws(()=>storage.readPhoto(space.id,'../../credentials'),/not found/);
  const app=storage.saveApplet(content,undefined,space.id);
  assert.equal(storage.readPhoto(space.id,photo.id).width,2048);
  const db=new DatabaseSync(join(directory,'applets',`${app.id}.sqlite`));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM photos').get()!.n,1);db.close();
  const workspace=new DatabaseSync(join(directory,'workspace.sqlite'));
  assert.equal(workspace.prepare('SELECT COUNT(*) AS n FROM photos WHERE owner=?').get(space.id)!.n,0);workspace.close();
  storage.saveApplet(content,app.id);
  assert.equal(storage.readPhoto(space.id,photo.id).name,'fern.jpg');
});

test('saved chat attachments survive reload and are sent as actual image inputs',()=>{
  const chat=storage.listChats(space.id)[0];
  storage.saveExchange(chat.id,'What is this?','A tentative suggestion',[photo.id]);
  const messages=storage.messages(chat.id);
  assert.deepEqual(messages[0].photos,[photo.id]);
  const history=imageHistory(space.id,messages);
  const content=history[0].content as Record<string,unknown>[];
  assert.equal(content[1].type,'input_image');assert.match(String(content[1].image_url),/^data:image\/jpeg;base64,/);
  assert.deepEqual(history[1],{role:'assistant',content:'A tentative suggestion'});
});

test('image history bounds retained images and tools cannot read other spaces',async()=>{
  const ids=[];for(let i=0;i<10;i++)ids.push((await importPhoto(space.id,`photo${i}`,source)).id);
  const input=imageHistory(space.id,ids.map(id=>({role:'user' as const,content:'Look',photos:[id]})));
  assert.equal(input.flatMap(item=>Array.isArray(item.content)?item.content:[]).filter(item=>item.type==='input_image').length,8);
  const tools=await appTools(storage.spaceApplets(space.id)[0].id);
  assert.ok(Array.isArray(await tools.execute('list_photos',{})));
  const elsewhere=await importPhoto(other.id,'private.jpg',source);
  await assert.rejects(()=>tools.execute('read_photo',{id:elsewhere.id}),/not found/);
});

test('AI analysis uses inline images and never writes plant records',async()=>{
  writeFileSync(join(directory,'credentials.json'),JSON.stringify({accessToken:'fake-test-token',scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+3_600_000}));
  const plant={identified:true,name:'Fern',scientificName:'Test species',confidence:'medium',explanation:'Tentative identification',alternatives:['Another fern'],needsAnotherPhoto:false,intervalDays:7,wateringAdvice:'Check soil moisture first.'};
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.equal(body.store,false);assert.equal(body.stream,true);
    assert.equal(body.input[0].content[1].type,'input_image');assert.match(body.input[0].content[1].image_url,/^data:image\/jpeg/);
    return new Response(`data: ${JSON.stringify({type:'response.output_text.delta',delta:JSON.stringify(plant)})}\n\ndata: {"type":"response.completed"}\n\n`);
  };
  const before=storage.records(storage.spaceApplets(space.id)[0].id);
  const result=await analyzePhotos(space.id,[photo.id],'test-model','Identify this plant','plant');
  assert.equal(result.plant?.intervalDays,7);
  assert.deepEqual(storage.records(storage.spaceApplets(space.id)[0].id),before);
  assert.equal(parsePlantIdentification(JSON.stringify({...plant,identified:false})).intervalDays,null);
  assert.throws(()=>parsePlantIdentification(JSON.stringify({...plant,intervalDays:0})),/invalid/);
  globalThis.fetch=async()=>new Response('unavailable',{status:503});
  await assert.rejects(()=>analyzePhotos(space.id,[photo.id],'test-model','Identify','plant'),/503/);
});
