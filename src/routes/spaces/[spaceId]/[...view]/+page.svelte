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
  import type { AppVersion, AppChatContext } from '$lib/types';
  let { data }: { data: PageData } = $props();
  let dialog: HTMLDialogElement;
  let options: HTMLDialogElement;
  let appContext = $state<AppChatContext>();
  let error = $state(''),
    busy = $state(false),
    historyOpen = $state(false),
    refresh = $state(0);
  let dataRevision = $state(0);
  let openingChat = $state(false),
    chatOpenError = $state('');
  async function openAppChat() {
    if (openingChat) return;
    openingChat = true;
    chatOpenError = '';
    try {
      const { chat } = await request(`/api/spaces/${data.space.id}/chats`, {});
      await goto(`/spaces/${data.space.id}/chat/${chat.id}`, { invalidateAll: true });
    } catch (e) {
      chatOpenError = e instanceof Error ? e.message : 'Could not open a fresh chat.';
    } finally {
      openingChat = false;
    }
  }
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
          oncontext={(value) => (appContext = value)}
          {dataRevision}
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
    <a class="dock-home" href="/" aria-label="Home"><Icon name="home" size={23} /></a>
    <a
      class="dock-app-icon"
      href={`/spaces/${data.space.id}/applet`}
      aria-label={`Open app: ${data.space.name}`}
      title={data.space.name}
    >
      <span aria-hidden="true">{appEmoji(data.space.name, data.space.icon)}</span>
    </a><button class="dock-chat" onclick={openAppChat} disabled={openingChat}
      ><Icon name="chat" size={19} />{openingChat ? 'Opening…' : 'Chat with app'}</button
    >
    <button
      class="dock-more"
      aria-label="More app options"
      aria-haspopup="dialog"
      onclick={() => options.showModal()}><Icon name="more" size={24} /></button
    >
  </nav>
  {#if chatOpenError}<p class="error" role="alert">{chatOpenError}</p>{/if}
</main>
<dialog class="app-options" bind:this={options} aria-labelledby="app-options-title">
  <header class="picker-header">
    <h2 id="app-options-title">{data.space.name}</h2>
    <button class="icon-button" aria-label="Close app options" onclick={() => options.close()}
      ><Icon name="close" /></button
    >
  </header>
  <div class="app-options-actions">
    <Notifications />
    <button
      onclick={async () => {
        options.close();
        try {
          await invalidateAll();
          refresh++;
        } catch (e) {
          chatOpenError = e instanceof Error ? e.message : 'Could not refresh the app.';
        }
      }}><Icon name="history" size={19} />Refresh app</button
    >
    <button
      disabled={!data.applet}
      onclick={async () => {
        options.close();
        await goto(`/spaces/${data.space.id}/chat/${data.activeChat.id}`);
        await history();
      }}><Icon name="history" size={19} />Versions & tests</button
    >
    <a href="/settings" onclick={() => options.close()}
      ><Icon name="settings" size={19} />Settings</a
    >
  </div>
</dialog>
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
  <ChatPanel
    {...data}
    {appContext}
    base={`/spaces/${data.space.id}/chat`}
    onupdated={() => dataRevision++}
  />
</dialog>

<style>
  .app-dock {
    gap: 8px;
    padding-left: max(12px, env(safe-area-inset-left));
    padding-right: max(12px, env(safe-area-inset-right));
  }
  .dock-home,
  .dock-app-icon,
  .dock-more {
    display: grid;
    place-items: center;
    width: 44px;
    min-width: 44px;
    height: 44px;
    padding: 0;
    border-radius: var(--radius);
    color: var(--ink);
  }
  .dock-app-icon {
    font-size: 23px;
  }
  .dock-more {
    border: 0;
    background: transparent;
  }
  .dock-chat {
    flex: 1;
    justify-content: center;
    min-width: 0;
    min-height: 44px;
    font-size: 14px;
    white-space: nowrap;
  }
  .app-options {
    padding: 0;
    width: min(420px, calc(100% - 24px));
    border: var(--border-width) solid var(--line);
    border-radius: calc(var(--radius) * 1.5);
    color: var(--ink);
    background: var(--panel);
  }
  .app-options::backdrop {
    background: #0008;
  }
  .app-options-actions {
    display: grid;
    gap: 8px;
    padding: 16px;
  }
  .app-options-actions > button,
  .app-options-actions > a {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 10px 14px;
    color: var(--ink);
    background: var(--surface);
    border: var(--border-width) solid var(--line);
    border-radius: var(--radius);
    text-align: left;
  }
  @media (max-width: 700px) {
    .app-options {
      margin: auto auto calc(12px + env(safe-area-inset-bottom));
    }
  }
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
