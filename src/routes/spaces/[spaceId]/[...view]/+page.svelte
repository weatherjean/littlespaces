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
  import type { AppVersion } from '$lib/types';
  let { data }: { data: PageData } = $props();
  let dialog: HTMLDialogElement;
  let error = $state(''),
    busy = $state(false),
    historyOpen = $state(false),
    refresh = $state(0);
  let versions = $state<AppVersion[]>([]);
  let restoreTarget = $state<number | null>(null);
  function testResults(report: string) {
    return JSON.parse(report || '[]') as { name: string; passed: boolean }[];
  }
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
    error = '';
    restoreTarget = null;
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
    error = '';
    try {
      await request(`/api/applets/${data.applet.id}`, {
        action: 'restore',
        version,
        expectedVersion: data.applet.version,
      });
      historyOpen = false;
      restoreTarget = null;
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
      <p class="muted">
        Restoring creates a new version and keeps current records and photos. Older code may expect
        an older data format. External changes are not undone.
      </p>
      {#if restoreTarget !== null}
        <div class="restore-confirmation">
          <p>Restore app code and chat guidance from v{restoreTarget}?</p>
          <button class="primary-button" disabled={busy} onclick={() => restore(restoreTarget!)}
            >{busy ? 'Restoring…' : 'Restore version'}</button
          >
          <button class="secondary-button" disabled={busy} onclick={() => (restoreTarget = null)}
            >Cancel</button
          >
        </div>
      {/if}
      <div class="version-list">
        {#each versions as item}<article class="version-entry">
            <div class="version-heading">
              <strong
                >v{item.version}{item.version === data.applet?.version ? ' · Current' : ''}</strong
              ><time datetime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
            </div>
            <p>{item.changeSummary || 'Published before change summaries were recorded.'}</p>
            {#if item.requestedChange}<details>
                <summary>Requested change</summary>
                <p class="requested-change">{item.requestedChange}</p>
              </details>{/if}
            <details>
              <summary>Tests ({testResults(item.testReport).length})</summary>
              {#each testResults(item.testReport) as test}<p class="test-result">
                  <Icon name={test.passed ? 'check' : 'close'} size={14} />{test.name} · {test.passed
                    ? 'Passed'
                    : 'Failed'}
                </p>{:else}<p class="muted">No saved backend test results.</p>{/each}
            </details>
            <button
              class="secondary-button"
              disabled={busy || item.version === data.applet?.version}
              onclick={() => (restoreTarget = item.version)}
              >{item.version === data.applet?.version
                ? 'Current version'
                : `Restore v${item.version}`}</button
            >
          </article>{/each}
      </div>
    </section>{/if}
  <ChatPanel {...data} base={`/spaces/${data.space.id}/chat`} onupdated={() => refresh++} />
</dialog>

<style>
  .version-list {
    display: grid;
    grid-template-columns: 1fr;
  }
  .version-entry {
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
  }
  .version-heading {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px;
  }
  time {
    font-size: 12px;
    color: var(--muted);
  }
  .version-entry p {
    margin: 8px 0;
  }
  .version-entry button {
    margin-top: 10px;
  }
  .requested-change {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .restore-confirmation {
    margin-bottom: 12px;
  }
</style>
