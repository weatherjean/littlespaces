import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OwnerStore,LOCK_MS} from '../scripts/owner-store.mjs';
import {Sessions,SESSION_SECONDS} from '../src/lib/server/sessions';
import {serverConfig} from '../scripts/server-config.mjs';
const password='correct horse battery staple';

test('owner setup has no default, stores a hash, and requires explicit reset',()=>{
  const dir=mkdtempSync(join(tmpdir(),'little-owner-')),store=new OwnerStore(dir);
  try {
    assert.throws(()=>store.requireOwner(),/setup/);
    assert.throws(()=>store.configure('owner@example.com','123456'),/15/);
    store.configure(' OWNER@Example.COM ',password);
    assert.equal(store.requireOwner().email,'owner@example.com');
    assert.equal(statSync(join(dir,'owner.sqlite')).mode&0o777,0o600);
    assert.equal(readFileSync(join(dir,'owner.sqlite')).includes(Buffer.from(password)),false);
    assert.throws(()=>store.configure('other@example.com',password),/already exists/);
    assert.equal(store.authenticate('OWNER@example.com',password).ok,true);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('three failed pairs lock all login for exactly five minutes, across connections and restarts',()=>{
  const dir=mkdtempSync(join(tmpdir(),'little-lock-'));let store=new OwnerStore(dir);
  try {
    store.configure('owner@example.com',password);
    const now=1_000_000;
    assert.deepEqual(store.authenticate('owner@example.com','wrong',now),{ok:false,retryAfter:0});
    assert.deepEqual(store.authenticate('unknown@example.com',password,now),{ok:false,retryAfter:0});
    const other=new OwnerStore(dir);
    try {assert.deepEqual(other.authenticate('owner@example.com','wrong',now),{ok:false,retryAfter:300});} finally {other.close();}
    store.close();store=new OwnerStore(dir);
    assert.deepEqual(store.authenticate('owner@example.com',password,now+1000),{ok:false,retryAfter:299});
    assert.equal(store.requireOwner().locked_until,now+LOCK_MS);
    assert.equal(store.authenticate('owner@example.com',password,now+LOCK_MS).ok,true);
    assert.equal(store.requireOwner().failures,0);
    store.authenticate('owner@example.com','wrong',now+LOCK_MS);
    store.authenticate('owner@example.com',password,now+LOCK_MS);
    assert.equal(store.requireOwner().failures,0);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('sessions are distinct, revoked on logout/reset, expire, and never survive a new process store',()=>{
  const dir=mkdtempSync(join(tmpdir(),'little-session-')),store=new OwnerStore(dir);
  try {
    store.configure('owner@example.com',password);
    const owner=store.requireOwner(),sessions=new Sessions(),now=1000;
    const a=sessions.create(owner.email,owner.version,now),b=sessions.create(owner.email,owner.version,now);
    assert.notEqual(a,b);
    assert.ok(sessions.get(a,owner.version,now));
    assert.equal(sessions.get('forged',owner.version,now),null);
    assert.equal(new Sessions().get(a,owner.version,now),null);
    sessions.delete(a);assert.equal(sessions.get(a,owner.version,now),null);
    assert.equal(sessions.get(b,owner.version,now+SESSION_SECONDS*1000),null);
    const c=sessions.create(owner.email,owner.version,now);
    store.authenticate(owner.email,'wrong');store.authenticate(owner.email,'wrong');store.authenticate(owner.email,'wrong');
    store.configure(owner.email,'a different long password',true);
    assert.equal(sessions.get(c,store.requireOwner().version,now),null);
    assert.equal(store.requireOwner().locked_until,0);
    assert.equal(store.authenticate(owner.email,password).ok,false);
    assert.equal(store.authenticate(owner.email,'a different long password').ok,true);
  } finally {store.close();rmSync(dir,{recursive:true,force:true});}
});

test('arbitrary HTTPS domains and IPs are supported; public plaintext and malformed origins fail closed',()=>{
  for(const origin of ['https://apps.example.org','https://203.0.113.7','https://custom-tunnel.example.org']) assert.equal(serverConfig({APP_ORIGIN:origin}).secureCookies,true);
  assert.equal(serverConfig({APP_ORIGIN:'http://127.0.0.1:5173'}).localOAuth,true);
  for(const origin of ['http://203.0.113.7','http://example.org','https://example.org/path','https://example.org/','https://user:pass@example.org','file:///tmp']) assert.throws(()=>serverConfig({APP_ORIGIN:origin}));
});

test('setup and reset commands accept stdin secrets without printing or storing plaintext',()=>{
  const dir=mkdtempSync(join(tmpdir(),'little-setup-'));
  const run=(args:string[],secret:string)=>spawnSync(process.execPath,['scripts/setup.mjs',...args,'--email=owner@example.com','--password-stdin'],{env:{...process.env,APP_DATA_DIR:dir},input:secret+'\n',encoding:'utf8'});
  try {
    const first=run([],password);assert.equal(first.status,0,first.stderr);assert.equal((first.stdout+first.stderr).includes(password),false);
    const duplicate=run([],password);assert.notEqual(duplicate.status,0);
    const replacement='replacement passphrase for test';const reset=run(['--reset'],replacement);assert.equal(reset.status,0,reset.stderr);assert.equal((reset.stdout+reset.stderr).includes(replacement),false);
    const store=new OwnerStore(dir);
    try {assert.equal(store.authenticate('owner@example.com',replacement).ok,true);assert.equal(store.authenticate('owner@example.com',password).ok,false);}finally{store.close();}
  } finally {rmSync(dir,{recursive:true,force:true});}
});
