import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
const dir=resolve(process.env.APP_DATA_DIR || '.data','logs');
const args=process.argv.slice(2);
const option=name=>{const index=args.indexOf(name);return index<0?undefined:args[index+1];};
if(!existsSync(dir)){console.log('No diagnostic logs yet.');process.exit(0);}
const trace=option('--trace'),event=option('--event'),app=option('--app');
const files=readdirSync(dir).filter(name=>/^events(?:\.[1-4])?\.jsonl$/.test(name)).sort((a,b)=>(Number(b.match(/\.(\d)/)?.[1])||0)-(Number(a.match(/\.(\d)/)?.[1])||0));
const rows=files.flatMap(name=>readFileSync(join(dir,name),'utf8').trim().split('\n').filter(Boolean).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}))
.filter(row=>(!trace||row.traceId===trace)&&(!event||row.event.includes(event))&&(!app||row.appletId===app||row.details?.appletId===app));
for(const row of rows.slice(-Math.max(1,Math.min(10000,Number(option('--limit'))||50))))console.log(JSON.stringify(row,null,args.includes('--full')?2:undefined));
