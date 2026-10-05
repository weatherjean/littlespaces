<script lang="ts">
  import { readBrowserValue, writeBrowserValue } from '$lib/browser-storage';
  import AppearanceSettings from '$lib/components/AppearanceSettings.svelte';
  import AppSettings from '$lib/components/AppSettings.svelte';
  import DeviceSettings from '$lib/components/DeviceSettings.svelte';
  import AutomationSettings from '$lib/components/AutomationSettings.svelte';
  import { expertMode } from '$lib/preferences';
  import Notifications from '$lib/components/Notifications.svelte';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  import Icon from '$lib/components/Icon.svelte';
  import { request } from '$lib/client';
  let { data }: { data: PageData } = $props();
  let busy = $state(false),
    error = $state(''),
    readReplies = $state(false);
  onMount(() => (readReplies = readBrowserValue('little-spaces-read-replies') === 'true'));
  function savePreference(key: string, value: boolean) {
    error = writeBrowserValue(key, String(value))
      ? ''
      : 'Browser storage is unavailable. This preference could not be saved.';
  }
  async function signIn() {
    busy = true;
    error = '';
    try {
      writeBrowserValue(
        'little-spaces-return',
        page.url.searchParams.get('returnTo') || '/chat',
        'session',
      );
      const value = await request('/auth/start', {});
      window.location.assign(value.url);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Sign-in failed.';
      busy = false;
    }
  }
  async function signOut() {
    busy = true;
    error = '';
    try {
      const response = await fetch('/auth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) throw Error('Could not sign out.');
      await invalidateAll();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Sign-out failed.';
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Settings · LittleSpaces</title></svelte:head>
<main class="settings-page">
  <header class="builtin-header">
    <a class="back-link" href="/" aria-label="Back to Home"><Icon name="back" /></a>
    <h1>Settings</h1>
    <form method="POST" action="/logout"><button class="secondary-button">Log out</button></form>
    <Notifications />
  </header>
  <div class="settings-content">
    <p class="eyebrow">MAKE YOURSELF AT HOME</p>
    <h2>Your space, your way.</h2>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <section class="setting-card">
      <div class="setting-icon"><Icon name="spark" size={24} /></div>
      <div>
        <h3>ChatGPT</h3>
        <p>
          {data.account
            ? `Connected as ${data.account.name}`
            : 'Connect your account to build and use apps with AI.'}
        </p>
        {#if data.account && !data.account.canUsePlan}<p>Reconnect to grant plan access.</p>{/if}
      </div>
      {#if data.account?.canUsePlan}<button
          class="secondary-button"
          disabled={busy}
          onclick={signOut}>Disconnect ChatGPT</button
        >{:else if data.localOAuth}<button class="primary-button" disabled={busy} onclick={signIn}
          >Continue with ChatGPT</button
        >{:else}<p class="muted">
          Connect ChatGPT from the server terminal using the self-hosting guide.
        </p>{/if}
    </section>
    <section class="setting-card">
      <div class="setting-icon"><Icon name="mic" size={24} /></div>
      <div>
        <h3>Read replies aloud</h3>
        <p>Uses your browser’s voice.</p>
      </div>
      <input
        aria-label="Read replies aloud"
        type="checkbox"
        bind:checked={readReplies}
        onchange={(event) =>
          savePreference('little-spaces-read-replies', event.currentTarget.checked)}
      />
    </section>
    <section class="setting-card">
      <div class="setting-icon"><Icon name="code" size={24} /></div>
      <div>
        <h3>Expert mode</h3>
        <p>
          Show every tool call in chat, including inputs, results, errors, and timing. New calls are
          saved with each conversation.
        </p>
      </div>
      <input
        aria-label="Expert mode"
        type="checkbox"
        checked={$expertMode}
        onchange={(event) => {
          expertMode.set(event.currentTarget.checked);
          savePreference('little-spaces-expert', event.currentTarget.checked);
        }}
      />
    </section>
    <AppSettings apps={data.apps} />
    <DeviceSettings />
    <AutomationSettings
      archivedSpaceIds={data.apps.filter((app) => app.archived).map((app) => app.id)}
    />
    <AppearanceSettings />
    <p class="settings-footnote">
      Your apps and their data stay on this server. AI requests are sent through your connected
      ChatGPT account.
    </p>
  </div>
</main>
