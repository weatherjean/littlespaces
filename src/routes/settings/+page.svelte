<script lang="ts">
  import { readBrowserValue, writeBrowserValue } from '$lib/browser-storage';
  import AppearanceSettings from '$lib/components/AppearanceSettings.svelte';
  import AppSettings from '$lib/components/AppSettings.svelte';
  import DeviceSettings from '$lib/components/DeviceSettings.svelte';
  import AutomationSettings from '$lib/components/AutomationSettings.svelte';
  import { expertMode } from '$lib/preferences';
  import Notifications from '$lib/components/Notifications.svelte';
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';
  import Icon from '$lib/components/Icon.svelte';
  import { request } from '$lib/client';
  let { data }: { data: PageData } = $props();
  let busy = $state(false),
    error = $state(''),
    readReplies = $state(false);
  let device = $state<{ verificationUrl: string; userCode: string } | null>(null);
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollEpoch = 0;
  onDestroy(() => {
    pollEpoch++;
    clearTimeout(pollTimer);
  });
  async function pollConnection(epoch: number) {
    try {
      const value = await request('/auth/status');
      if (epoch !== pollEpoch) return;
      if (value.status === 'complete') {
        device = null;
        busy = false;
        await invalidateAll();
      } else if (value.status === 'pending') {
        pollTimer = setTimeout(() => void pollConnection(epoch), 2000);
      } else {
        device = null;
        busy = false;
        error = value.error || 'Code expired. Try again.';
      }
    } catch (e) {
      if (epoch !== pollEpoch) return;
      busy = false;
      device = null;
      error = e instanceof Error ? e.message : 'Could not check sign-in. Try again.';
    }
  }
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
      if (value.verificationUrl && value.userCode) {
        device = { verificationUrl: value.verificationUrl, userCode: value.userCode };
        const epoch = ++pollEpoch;
        pollTimer = setTimeout(() => void pollConnection(epoch), 2000);
      } else window.location.assign(value.url);
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
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <section class="setting-card">
      <div class="setting-icon"><Icon name="spark" size={24} /></div>
      <div>
        <h3>ChatGPT</h3>
        <p>
          {data.account ? `Connected as ${data.account.name}` : 'Connect to build apps and chat.'}
        </p>
        {#if data.account && !data.account.canUsePlan}<p>Reconnect to grant plan access.</p>{/if}
      </div>
      {#if data.account?.canUsePlan}<button
          class="secondary-button"
          disabled={busy}
          onclick={signOut}>Disconnect</button
        >{:else if !device}<button class="primary-button" disabled={busy} onclick={signIn}
          >Continue with ChatGPT</button
        >{/if}
      {#if device}
        <div class="device-login" aria-live="polite">
          <p>Enter this code on OpenAI:</p>
          <strong class="device-code">{device.userCode}</strong>
          <a
            class="primary-button"
            href={device.verificationUrl}
            target="_blank"
            rel="noopener noreferrer">Open ChatGPT</a
          >
          <p class="muted">Waiting for sign-in…</p>
          <small>If prompted, enable device-code login in ChatGPT Settings → Security.</small>
        </div>
      {/if}
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
        <p>Show tool calls and results in chat.</p>
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
  </div>
</main>
