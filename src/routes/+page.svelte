<script lang="ts">
  import {appEmoji} from '$lib/app-emoji';
  import Notifications from '$lib/components/Notifications.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import { request } from '$lib/client';
  import Icon from '$lib/components/Icon.svelte';
  let { data }: { data: PageData } = $props();
  let creating = $state(false), error = $state('');
  async function addApp() {
    if (creating) return;
    creating = true; error = '';
    try {
      const { chat } = await request(`/api/spaces/${data.chatSpaceId}/chats`, { launch: {
        title: 'Create an app',
        task: 'New app creation from the home launcher. Help the user shape and build a personal app from their own description.',
        welcome: 'What would you like to make? Describe what you want to track, organize, or get done. We’ll shape it together, and your new app will appear on Home.'
      } });
      await goto(`/chat/${chat.id}`, { invalidateAll: true });
    } catch (e) { error = e instanceof Error ? e.message : 'Could not open a new chat.'; }
    finally { creating = false; }
  }
  onMount(() => {
    const returnTo = sessionStorage.getItem('little-spaces-return');
    if (data.account && returnTo) {
      sessionStorage.removeItem('little-spaces-return');
      if (returnTo.startsWith('/spaces/') || returnTo.startsWith('/chat')) void goto(returnTo);
    }
  });
</script>
<svelte:head><title>Little Spaces</title></svelte:head>
<main class="launcher">
  <header class="launcher-header"><a class="wordmark" href="/" aria-label="Little Spaces home"><span class="brand-symbol"><Icon name="grid" size={20} /></span> little spaces<span class="beta-dot"></span></a><span class="local-indicator"><span></span> On this computer</span></header>
  {#if data.authError}<p class="error" role="alert">{data.authError}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <section class="launcher-content" aria-label="Your apps">
    <div class="launcher-intro"><h1>Your apps.</h1><p>Small tools. Built around you.</p></div>
    <div class="app-grid">
      <a class="app-tile" href="/chat"><span class="app-icon icon-chat"><span class="app-emoji" aria-hidden="true">💬</span></span><span>Chat</span></a>
      {#each data.spaces as space, i (space.id)}<a class="app-tile" href={`/spaces/${space.id}/applet`}><span class={`app-icon icon-tone-${i % 4}`}><span class="app-emoji" aria-hidden="true">{appEmoji(space.name,space.icon)}</span></span><span>{space.name}</span>{#if space.serverName}<small>{space.serverName}</small>{/if}{#if !space.appletCount}<small>In progress</small>{/if}</a>{/each}
      <button class="app-tile add-app" disabled={creating} onclick={addApp}><span class="app-icon icon-chat"><span class="app-emoji" aria-hidden="true">✨</span></span><span>{creating ? 'Opening…' : 'Add new'}</span></button>
      <a class="app-tile" href="/settings"><span class="app-icon icon-settings"><span class="app-emoji" aria-hidden="true">⚙️</span></span><span>Settings</span></a>
    </div>
    {#if !data.spaces.length}<p class="launcher-hint">Choose Add new and describe an app. It will find a home here.</p>{/if}
    {#each data.servers.filter(server=>server.error) as server}<p class="error">{server.name}: {server.error}</p>{/each}
    <Notifications home/>
  </section>
</main>

<style>.add-app{background:transparent;color:inherit;padding:10px 6px}</style>
