<script lang="ts">
  import {onMount} from 'svelte';
  import {expertMode} from '$lib/preferences';
  import {refreshNotifications} from '$lib/notification-state';
  import type { Snippet } from 'svelte';
  import '$lib/style.css';
  import '$lib/polish.css';
  onMount(()=>{
    expertMode.set(localStorage.getItem('little-spaces-expert')==='true');
    const refresh=()=>{void refreshNotifications().catch(()=>{});};
    refresh();const timer=setInterval(refresh,30000);
    window.addEventListener('focus',refresh);window.addEventListener('notifications-changed',refresh);
    return ()=>{clearInterval(timer);window.removeEventListener('focus',refresh);window.removeEventListener('notifications-changed',refresh);};
  });
  let { children }: { children: Snippet } = $props();
</script>
<div class="shell">{@render children()}</div>
