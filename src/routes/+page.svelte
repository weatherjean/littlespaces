<script lang="ts">
  import { readBrowserValue, writeBrowserValue, chatReturnPath } from '$lib/browser-storage';
  import ConnectChatGPT from '$lib/components/ConnectChatGPT.svelte';
  import { appEmoji } from '$lib/app-emoji';
  import Notifications from '$lib/components/Notifications.svelte';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import type { PageData } from './$types';
  import { request } from '$lib/client';
  import BrandMark from '$lib/components/BrandMark.svelte';
  let { data }: { data: PageData } = $props();
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
<main class="launcher">
  {#if data.authError}<p class="error" role="alert">{data.authError}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <section class="launcher-content" aria-label="Your apps">
    <header class="launcher-header">
      <a class="wordmark" href="/" aria-label="LittleSpaces home"
        ><span class="brand-symbol"><BrandMark /></span> LittleSpaces</a
      >
    </header>
    <div class="launcher-intro">
      <h1>Your apps</h1>
    </div>
    {#if !data.account?.canUsePlan}<ConnectChatGPT banner reconnect={!!data.account} />{/if}
    <div class="app-grid">
      <button class="app-tile chat-tile" disabled={creating} onclick={() => openChat(true)}
        ><span class="app-icon icon-chat"><span class="app-emoji" aria-hidden="true">🎙️</span></span
        ><span>Voice</span></button
      >
      <button class="app-tile chat-tile" disabled={creating} onclick={() => openChat()}
        ><span class="app-icon icon-chat"><span class="app-emoji" aria-hidden="true">💬</span></span
        ><span>Chat</span></button
      >
      {#each data.spaces as space, i (space.id)}<a
          class="app-tile"
          href={`/spaces/${space.id}/applet`}
          ><span class={`app-icon icon-tone-${i % 4}`}
            ><span class="app-emoji" aria-hidden="true">{appEmoji(space.name, space.icon)}</span
            ></span
          ><span>{space.name}</span>{#if !space.appletCount}<small>In progress</small>{/if}</a
        >{/each}

      <a class="app-tile" href="/settings"
        ><span class="app-icon icon-settings"
          ><span class="app-emoji" aria-hidden="true">⚙️</span></span
        ><span>Settings</span></a
      >
    </div>
    {#if data.account?.canUsePlan && !data.spaces.length}<p class="launcher-hint">
        Open Chat to create your first app.
      </p>{/if}
    <Notifications home />
  </section>
</main>

<style>
  .launcher {
    max-width: 960px;
    align-items: center;
    padding: clamp(48px, 8vh, 88px) 24px 48px;
  }
  .launcher-content {
    flex: initial;
    max-width: 760px;
    padding: 0;
    text-align: center;
  }
  .launcher-header {
    justify-content: center;
    margin-bottom: 32px;
  }
  .launcher-intro {
    margin-bottom: 40px;
  }
  .launcher-intro h1 {
    font-size: clamp(30px, 3vw, 40px);
  }
  .app-grid {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    align-items: flex-start;
    gap: 28px 24px;
    width: 100%;
    margin: 0 auto;
  }
  .app-tile {
    flex: 0 0 120px;
  }
  .chat-tile {
    background: transparent;
    color: inherit;
    padding: 10px 6px;
  }
  .launcher-hint {
    max-width: 420px;
    margin: 32px auto 0;
  }
  .launcher > .error {
    width: 100%;
    max-width: 640px;
  }
  .launcher-content :global(.home-notifications) {
    max-width: 640px;
    margin: 48px auto 0;
  }
  .launcher-content :global(.home-notifications > header) {
    justify-content: center;
    flex-wrap: wrap;
    gap: 16px;
  }
  .launcher-content :global(.home-notifications h2) {
    margin-top: 0;
  }
  @media (max-width: 700px) {
    .launcher {
      padding: 40px 20px;
    }
    .launcher-header {
      margin-bottom: 28px;
    }
    .launcher-intro {
      margin-bottom: 28px;
    }
    .app-grid {
      gap: 24px 12px;
    }
    .app-tile {
      flex-basis: calc((100% - 24px) / 3);
      max-width: 120px;
    }
    .launcher-content :global(.home-notifications) {
      margin-top: 36px;
    }
  }
</style>
