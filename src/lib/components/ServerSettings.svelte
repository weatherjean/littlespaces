<script lang="ts">
 import {onMount} from 'svelte';
 import {goto,invalidateAll} from '$app/navigation';
 import {request} from '$lib/client';
 import type {Space} from '$lib/types';
 let {servers}:{servers:{id:string;name:string;url:string;role:'owner'|'guest'|null;error:string;spaces:(Space&{shared:boolean})[]}[]}=$props();
 let name=$state(''),url=$state(''),key=$state(''),busy=$state(false),error=$state(''),issuedKey=$state('');
 let localApps=$state<(Space&{shared:boolean})[]>([]);
 async function load(){const value=await request('/api/server-access');localApps=value.spaces;}
 onMount(()=>{void load().catch(e=>error=e.message);});
 async function run(task:()=>Promise<void>){busy=true;error='';try{await task();}catch(e){error=e instanceof Error?e.message:'Request failed.';}finally{busy=false;}}
 async function connect(){await run(async()=>{await request('/api/connections',{name,url,key});name='';url='';key='';await invalidateAll();});}
 async function share(id:string,shared:boolean){await run(async()=>{await request('/api/server-access',{spaceId:id,shared});await load();await invalidateAll();});}
 async function rotate(role:'owner'|'guest'){await run(async()=>{issuedKey=(await request('/api/server-access',{action:'rotate',role})).key;});}
</script>
<section class="server-settings" aria-labelledby="servers-title">
 <h3 id="servers-title">Connected servers</h3><p>Add a server URL and its owner or guest key. Your ChatGPT sign-in and conversations stay on this computer.</p>
 {#if error}<p class="error" role="alert">{error}</p>{/if}
 <form onsubmit={event=>{event.preventDefault();void connect();}}>
  <label>Name<input bind:value={name} maxlength="80" placeholder="Our apps" required/></label>
  <label>Server URL<input bind:value={url} type="url" placeholder="https://apps.example.com" required/></label>
  <label>Access key<input bind:value={key} type="password" autocomplete="off" placeholder="Owner or guest key" required/></label>
  <button class="primary-button" disabled={busy}>Connect server</button>
 </form>
 {#each servers as server}
 <div class="server-entry"><h4>{server.name} <span class="muted">· {server.role||'Unavailable'}</span></h4><p>{server.url}</p>
  {#if server.error}<p class="error">{server.error}</p>{/if}
  <div class="server-buttons">
   {#if server.role==='owner'}<button class="secondary-button" disabled={busy} onclick={()=>run(async()=>{const value=await request('/api/connections',{action:'build',id:server.id});await goto(value.href,{invalidateAll:true});})}>Add app on this server</button>
   <button class="secondary-button" disabled={busy} onclick={()=>run(async()=>{issuedKey=(await request('/api/connections',{action:'guest-key',id:server.id})).key;})}>Rotate guest key</button>{/if}
   <button class="secondary-button" disabled={busy} onclick={()=>run(async()=>{await request('/api/connections',{action:'remove',id:server.id});await invalidateAll();})}>Disconnect</button>
  </div>
  {#if server.role==='owner'}{#each server.spaces as space}<label class="sharing-row"><span>{space.name}<small>{space.shared?'Shared with guests':'Private'}</small></span><input type="checkbox" aria-label={`Share ${space.name}`} checked={space.shared} disabled={busy} onchange={event=>share(space.id,event.currentTarget.checked)}/></label>{/each}{/if}
 </div>
 {/each}
</section>
<section class="server-settings" aria-labelledby="sharing-title"><h3 id="sharing-title">Share apps from this computer</h3>
 <p>The app server is separate from this local client. Its default address is http://127.0.0.1:5175. A VPS needs an HTTPS address. Both keys are secret; a guest key only grants access to apps you share.</p>
 {#each localApps as space}<label class="sharing-row"><span>{space.name}<small>{space.shared?'Shared with guests':'Private'}</small></span><input type="checkbox" aria-label={`Share ${space.name}`} checked={space.shared} disabled={busy} onchange={event=>share(space.id,event.currentTarget.checked)}/></label>{/each}
 <div class="server-buttons"><button class="secondary-button" disabled={busy} onclick={()=>rotate('guest')}>Create / rotate guest key</button><button class="secondary-button" disabled={busy} onclick={()=>rotate('owner')}>Create / rotate owner key</button></div>
 <p class="muted">Rotating a key immediately revokes the previous one. Existing connections using that key will need the new key.</p>
</section>
{#if issuedKey}<section class="server-settings" aria-label="New access key"><h3>Copy your new key</h3><p>This is the only time it is shown here. Store it securely and share it only with the intended person.</p><textarea aria-label="New access key" readonly value={issuedKey}></textarea><button class="secondary-button" onclick={()=>issuedKey=''}>Dismiss key</button></section>{/if}
<style>
 .server-settings{margin:24px 0;padding:24px;border:1px solid var(--border,#303442);border-radius:20px;background:rgba(255,255,255,.025)}h3,h4{margin:0 0 10px}p{line-height:1.6;color:var(--muted,#a6aaba)}form{display:grid;gap:14px;margin:20px 0}label{display:grid;gap:7px}input:not([type=checkbox]),textarea{width:100%;box-sizing:border-box;padding:12px;border:1px solid #42475a;border-radius:10px;background:#171b29;color:#f0f2fa;font:inherit}textarea{min-height:92px;overflow-wrap:anywhere;margin-bottom:12px}.server-entry{padding-top:22px;margin-top:22px;border-top:1px solid #343949}.server-buttons{display:flex;flex-wrap:wrap;gap:10px;margin:16px 0}.sharing-row{display:flex;justify-content:space-between;align-items:center;gap:20px;padding:14px 0;border-bottom:1px solid #303442}.sharing-row small{display:block;color:#a6aaba;margin-top:4px}input[type=checkbox]{width:20px;height:20px}form button{justify-self:start}
</style>
