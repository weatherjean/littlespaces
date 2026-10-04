import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appServer } from '../src/lib/server/app-server';
import { accessInfo, rotateKey } from '../src/lib/server/access';
import { dataDir } from '../src/lib/server/config';
if(!accessInfo().configured){
 const path=join(dataDir,'server-keys.json');
 writeFileSync(path,JSON.stringify({owner:rotateKey('owner'),guest:accessInfo().guestConfigured?'Use the guest key you previously created.':rotateKey('guest')},null,2),{mode:0o600});
 console.log(`Initial server keys saved to ${path}. Store them securely; keys are not logged.`);
}
const host=process.env.APP_SERVER_HOST||'127.0.0.1',port=Number(process.env.APP_SERVER_PORT||5175);
const server=createServer(async(req,res)=>{
 try{
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>9*1024*1024){res.writeHead(413);res.end('Request too large.');return;}chunks.push(chunk);}
  const request=new Request(`http://app-server${req.url}`,{method:req.method,headers:req.headers as Record<string,string>,...(!['GET','HEAD'].includes(req.method||'GET')?{body:Buffer.concat(chunks)}:{})});
  const response=await appServer(request);
  res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));
 }catch{res.writeHead(500);res.end('Request failed.');}
});
server.requestTimeout=120000;server.headersTimeout=15000;
server.listen(port,host,()=>console.log(`App server listening on ${host}:${port}. ChatGPT runs in each user's local client.`));
