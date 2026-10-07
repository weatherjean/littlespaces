<script lang="ts">
  import { readBrowserValue, writeBrowserValue, chatReturnPath } from '$lib/browser-storage';
  import ConnectChatGPT from '$lib/components/ConnectChatGPT.svelte';
  import { appEmoji } from '$lib/app-emoji';
  import Notifications from '$lib/components/Notifications.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import { request } from '$lib/client';
  import Icon from '$lib/components/Icon.svelte';
  import BrandMark from '$lib/components/BrandMark.svelte';
  let { data }: { data: PageData } = $props();
  let search = $state('');
  let visibleSpaces = $derived(
    data.spaces.filter((space) => space.name.toLowerCase().includes(search.trim().toLowerCase())),
  );
  let creating = $state(false),
    error = $state('');
  async function openChat(voice = false) {
    if (!data.account?.canUsePlan) {
      await goto(voice ? '/voice' : '/chat');
      return;
    }
    if (creating) return;
    creating = true;
    error = '';
    try {
      const { chat } = await request(`/api/spaces/${data.chatSpaceId}/chats`, {});
      await goto(`${voice ? '/voice' : '/chat'}/${chat.id}`, {
        invalidateAll: true,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not open a new chat.';
    } finally {
      creating = false;
    }
  }
  onMount(() => {
    const returnTo = chatReturnPath(readBrowserValue('little-spaces-return', 'session'));
    if (data.account?.canUsePlan && !data.authError && returnTo) {
      writeBrowserValue('little-spaces-return', null, 'session');
      void goto(returnTo);
    }
  });
</script>

<svelte:head><title>LittleSpaces</title></svelte:head>
<main class="launcher" class:has-apps={data.spaces.length > 0}>
  {#if data.authError}<p class="error" role="alert">{data.authError}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <section class="launcher-content" aria-label="Your apps">
    <header class="launcher-header">
      <a class="wordmark" href="/" aria-label="LittleSpaces home"
        ><span class="brand-symbol"><BrandMark /></span> LittleSpaces</a
      >
    </header>
    <div class="launcher-intro">
      <p class="eyebrow">YOUR LITTLE CORNER</p>
      <h1>Made for your everyday.</h1>
      <p>Your apps, ideas, and a little help. All in one place.</p>
    </div>
    {#if !data.account?.canUsePlan}<ConnectChatGPT banner reconnect={!!data.account} />{/if}
    <div class="quick-actions">
      <button class="quick-action voice-action" disabled={creating} onclick={() => openChat(true)}>
        <span class="action-icon"><Icon name="mic" size={24} /></span>
        <span><strong>Let’s talk</strong><small>Start with your voice</small></span>
        <Icon name="plus" />
      </button>
      <button class="quick-action" disabled={creating} onclick={() => openChat()}>
        <span class="action-icon"><Icon name="chat" size={24} /></span>
        <span><strong>Start a chat</strong><small>Ask, plan, or create an app</small></span>
        <Icon name="plus" />
      </button>
    </div>
    <div class="apps-heading">
      <h2>Your apps</h2>
      <span>{data.spaces.length}</span>
      <button
        type="button"
        class="reload-home"
        aria-label="Reload home"
        title="Reload home"
        onclick={() => window.location.reload()}><Icon name="reload" size={17} /></button
      >
    </div>
    {#if data.spaces.length > 6}
      <label class="app-search"
        ><Icon name="search" /><input
          aria-label="Find an app"
          type="search"
          placeholder="Find an app"
          bind:value={search}
        /></label
      >
    {/if}
    <div class="app-grid">
      {#each visibleSpaces as space, i (space.id)}
        <a class="app-tile" href={`/spaces/${space.id}/applet`}>
          <span class={`app-icon icon-tone-${i % 4}`}
            ><span class="app-emoji" aria-hidden="true">{appEmoji(space.name, space.icon)}</span
            ></span
          >
          <span>{space.name}</span>{#if !space.appletCount}<small>In progress</small>{/if}
        </a>
      {/each}
      {#if data.spaces.length}
        <button class="app-tile create-tile" disabled={creating} onclick={() => openChat()}
          ><span class="app-icon"><Icon name="plus" size={28} /></span><span>Create an app</span
          ></button
        >
      {/if}
    </div>
    {#if !data.spaces.length}
      <div class="launcher-empty">
        <span class="empty-symbol"><Icon name="grid" size={28} /></span>
        <h3>A home for your own apps</h3>
        <p>
          A plant tracker, a meal planner, a place for your ideas. What would make your day easier?
        </p>
        <button class="primary-button" disabled={creating} onclick={() => openChat()}
          ><Icon name="plus" size={18} />Create your first app</button
        >
      </div>
    {:else if !visibleSpaces.length}<p class="launcher-hint" role="status">
        No apps match “{search}”.
      </p>{/if}
    <Notifications home />
  </section>
</main>

<style>
  .launcher {
    max-width: 960px;
    padding: max(24px, env(safe-area-inset-top)) 20px calc(112px + env(safe-area-inset-bottom));
  }
  .launcher-content {
    width: 100%;
    max-width: 760px;
    padding: 0;
  }
  .launcher-header {
    margin-bottom: 40px;
  }
  .launcher-header .wordmark {
    font-size: 21px;
  }
  .launcher-intro {
    margin-bottom: 28px;
  }
  .launcher-intro .eyebrow {
    font-size: 10px;
    margin-bottom: 14px;
  }
  .launcher-intro h1 {
    max-width: 340px;
    font-size: clamp(32px, 7vw, 44px);
    line-height: 1.12;
    letter-spacing: -1.3px;
    margin-bottom: 14px;
  }
  .launcher-intro > p:last-child {
    max-width: 290px;
    font-size: 14px;
  }
  .quick-actions {
    display: grid;
    gap: 12px;
    margin: 28px 0 36px;
  }
  .quick-action {
    display: flex;
    align-items: center;
    gap: 14px;
    width: 100%;
    padding: 18px;
    border: var(--border-width) solid var(--line);
    border-radius: calc(var(--radius) * 1.5);
    background: var(--panel);
    color: var(--ink);
    text-align: left;
  }
  .voice-action {
    background: var(--accent-soft);
  }
  .action-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--accent);
    flex-shrink: 0;
  }
  .quick-action > span:nth-child(2) {
    flex: 1;
  }
  .quick-action strong,
  .quick-action small {
    display: block;
  }
  .quick-action strong {
    font-size: 16px;
    font-weight: 550;
  }
  .quick-action small {
    font-size: 12px;
    color: var(--muted);
    margin-top: 5px;
  }
  .apps-heading {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 20px;
  }
  .reload-home {
    display: inline-grid;
    place-items: center;
    width: 32px;
    height: 32px;
    padding: 0;
    border: 1px solid var(--line);
    border-radius: 10px;
    color: var(--muted);
    background: var(--hover);
  }
  .reload-home:hover {
    color: var(--ink);
    background: var(--accent-soft);
    border-color: var(--accent);
  }
  @media (pointer: coarse) {
    .reload-home {
      width: 44px;
      height: 44px;
    }
  }
  .apps-heading h2 {
    font-size: 20px;
    font-weight: 550;
    letter-spacing: -0.4px;
  }
  .apps-heading > span {
    font-size: 12px;
    color: var(--muted);
    background: var(--hover);
    padding: 4px 9px;
    border-radius: 20px;
  }
  .app-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 20px 8px;
  }
  .app-tile {
    padding: 8px 2px;
    gap: 10px;
  }
  .app-tile > span:not(.app-icon) {
    font-size: 13px;
    line-height: 1.4;
  }
  .app-tile small {
    display: block;
  }
  .create-tile {
    background: transparent;
    color: var(--muted);
  }
  .create-tile .app-icon {
    border-style: dashed;
    box-shadow: none;
    background: var(--hover);
  }
  .app-search {
    display: flex;
    align-items: center;
    gap: 10px;
    border: var(--border-width) solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
    padding: 0 14px;
    margin-bottom: 20px;
    color: var(--muted);
  }
  .app-search input {
    width: 100%;
    min-width: 0;
    min-height: 48px;
    background: transparent;
    border: 0;
    color: var(--ink);
    font-size: 16px;
  }
  .launcher-empty {
    padding: 28px 20px;
    text-align: center;
    border: var(--border-width) dashed var(--line);
    border-radius: calc(var(--radius) * 1.5);
  }
  .empty-symbol {
    color: var(--accent);
  }
  .launcher-empty h3 {
    font-size: 17px;
    font-weight: 550;
    margin: 16px 0 8px;
  }
  .launcher-empty p {
    max-width: 350px;
    margin: 0 auto 20px;
    font-size: 14px;
    color: var(--muted);
  }
  .launcher-hint {
    margin-top: 20px;
    font-size: 14px;
  }
  .launcher-content :global(.home-notifications) {
    margin-top: 36px;
    text-align: left;
  }
  @media (max-width: 700px) {
    .has-apps .launcher-header {
      margin-bottom: 24px;
    }
    .has-apps .launcher-intro .eyebrow {
      display: none;
    }
    .has-apps .launcher-intro h1 {
      font-size: 28px;
      max-width: none;
    }
    .has-apps .launcher-intro > p:last-child {
      display: none;
    }
    .has-apps .quick-actions {
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin: 20px 0 28px;
    }
    .has-apps .quick-action {
      flex-direction: column;
      align-items: flex-start;
      gap: 12px;
      padding: 14px;
    }
    .has-apps .quick-action :global(> svg) {
      display: none;
    }
    .has-apps .quick-action strong {
      font-size: 14px;
    }
    .has-apps .quick-action small {
      font-size: 11px;
      line-height: 1.4;
    }
    .has-apps .action-icon {
      width: 36px;
      height: 36px;
    }
  }
  @media (min-width: 701px) {
    .launcher {
      padding: 48px 32px 120px;
    }
    .launcher-header {
      margin-bottom: 56px;
    }
    .launcher-intro h1,
    .launcher-intro > p:last-child {
      max-width: none;
    }
    .quick-actions {
      grid-template-columns: 1fr 1fr;
    }
    .app-grid {
      grid-template-columns: repeat(5, minmax(0, 1fr));
      gap: 24px;
    }
  }
</style>
