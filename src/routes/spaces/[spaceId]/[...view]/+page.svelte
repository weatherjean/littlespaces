<script lang="ts">
  import { chatViewport } from '$lib/chat-viewport';
  import { appEmoji } from '$lib/app-emoji';
  import Notifications from '$lib/components/Notifications.svelte';
  import { goto, invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import AppletFrame from '$lib/components/AppletFrame.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { request } from '$lib/client';
  let { data }: { data: PageData } = $props();
  let dialog: HTMLDialogElement;
  let error = $state(''),
    busy = $state(false),
    historyOpen = $state(false),
    refresh = $state(0);
  let versions = $state<{ version: number; title: string }[]>([]);
  let tests = $derived(JSON.parse(data.testReport) as { name: string; passed: boolean }[]);
  $effect(() => {
    if (data.tab === 'chat') {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) dialog.close();
  });
  function closeChat() {
    void goto(`/spaces/${data.space.id}/applet`);
  }
  async function history() {
    if (!data.applet) return;
    try {
      versions = (await request(`/api/applets/${data.applet.id}`)).versions;
      historyOpen = !historyOpen;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load versions.';
    }
  }
  async function restore(version: number) {
    if (!data.applet) return;
    busy = true;
    try {
      await request(`/api/applets/${data.applet.id}`, { action: 'restore', version });
      historyOpen = false;
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not restore version.';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>{data.space.name} · LittleSpaces</title></svelte:head>
<main class="mounted-app">
  <div class="app-canvas">
    {#if data.applet}{#key `${data.applet.id}:${refresh}`}<AppletFrame
          id={data.applet.id}
          version={data.applet.version}
        />{/key}{:else}<div class="empty-app">
        <span class="app-icon icon-chat"
          ><span class="app-emoji" aria-hidden="true"
            >{appEmoji(data.space.name, data.space.icon)}</span
          ></span
        >
        <h1>{data.space.name}</h1>
        <p>Your app is ready to take shape.</p>
        <a class="primary-button" href={`/spaces/${data.space.id}/chat`}
          >Build it in chat <Icon name="spark" size={17} /></a
        >
      </div>{/if}
  </div>
  <nav class="app-dock" aria-label="App navigation">
    <a class="dock-back" href="/" aria-label="Back to Home"
      ><Icon name="back" size={21} /><span>Home</span></a
    ><span class="dock-app-name"
      ><span aria-hidden="true">{appEmoji(data.space.name, data.space.icon)}</span>{data.space
        .name}</span
    ><Notifications /><a
      class="dock-chat"
      href={`/spaces/${data.space.id}/chat/${data.activeChat.id}`}
      ><Icon name="chat" size={19} />Chat</a
    >
  </nav>
</main>
<dialog
  class="app-chat-modal"
  use:chatViewport
  bind:this={dialog}
  oncancel={(event) => {
    event.preventDefault();
    closeChat();
  }}
  aria-labelledby="app-chat-title"
>
  <header class="modal-header">
    <span class="modal-app-icon"
      ><span aria-hidden="true">{appEmoji(data.space.name, data.space.icon)}</span></span
    >
    <div>
      <h2 id="app-chat-title">{data.space.name}</h2>
      <p>Chat with your app</p>
    </div>
    <button
      class="icon-button"
      aria-label="App versions and tests"
      onclick={history}
      disabled={!data.applet}><Icon name="history" size={19} /></button
    ><button class="icon-button" aria-label="Close chat" onclick={closeChat}
      ><Icon name="close" /></button
    >
  </header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if historyOpen}<section class="version-panel">
      <h3>Versions & tests</h3>
      <div class="version-list">
        {#each versions as item}<button
            class="secondary-button"
            disabled={busy || item.version === data.applet?.version}
            onclick={() => restore(item.version)}
            >v{item.version}{item.version === data.applet?.version
              ? ' · Current'
              : ' · Restore'}</button
          >{/each}
      </div>
      {#each tests as test}<p class="test-result">
          <Icon name="check" size={14} />{test.name}
        </p>{:else}<p class="muted">This version has no backend tests.</p>{/each}
    </section>{/if}
  <ChatPanel {...data} base={`/spaces/${data.space.id}/chat`} onupdated={() => refresh++} />
</dialog>
