<script lang="ts">
  import { onMount } from 'svelte';
  import { APPEARANCE_KEY, applyAppearance, readAppearance } from '$lib/appearance';
  import { page } from '$app/state';
  import { afterNavigate } from '$app/navigation';
  import { notifications } from '$lib/notification-state';
  import { expertMode } from '$lib/preferences';
  import { refreshNotifications } from '$lib/notification-state';
  import type { Snippet } from 'svelte';
  import '$lib/theme.css';
  import '$lib/style.css';
  import '$lib/polish.css';
  afterNavigate(() => applyAppearance(readAppearance()));
  onMount(() => {
    applyAppearance(readAppearance());
    const syncAppearance = (event: StorageEvent) => {
      if (event.key === APPEARANCE_KEY || event.key === null) applyAppearance(readAppearance());
    };
    window.addEventListener('storage', syncAppearance);
    expertMode.set(localStorage.getItem('little-spaces-expert') === 'true');
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
      window.removeEventListener('storage', syncAppearance);
      window.removeEventListener('pageshow', checkHistory);
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('notifications-changed', refresh);
    };
  });
  let { children }: { children: Snippet } = $props();
</script>

<div class="shell">{@render children()}</div>
