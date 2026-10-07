<script lang="ts">
  import { readBrowserValue } from '$lib/browser-storage';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { notifications } from '$lib/notification-state';
  import { expertMode } from '$lib/preferences';
  import { refreshNotifications } from '$lib/notification-state';
  import type { Snippet } from 'svelte';
  import '$lib/theme.css';
  import '$lib/style.css';
  import '$lib/polish.css';
  import '$lib/mobile.css';
  import PrimaryNav from '$lib/components/PrimaryNav.svelte';
  onMount(() => {
    expertMode.set(readBrowserValue('little-spaces-expert') === 'true');
    const refresh = () => {
      if (page.data.owner) void refreshNotifications().catch(() => {});
      else notifications.set([]);
    };
    const checkHistory = (event: PageTransitionEvent) => {
      if (event.persisted && page.data.owner) window.location.reload();
    };
    window.addEventListener('pageshow', checkHistory);
    refresh();
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    window.addEventListener('notifications-changed', refresh);
    return () => {
      window.removeEventListener('pageshow', checkHistory);
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('notifications-changed', refresh);
    };
  });
  let { children }: { children: Snippet } = $props();
</script>

<div class="shell">{@render children()}</div>
{#if page.data.owner && (page.url.pathname === '/' || page.url.pathname === '/settings')}
  <PrimaryNav />
{/if}
