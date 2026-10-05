<script lang="ts">
  import Notifications from '$lib/components/Notifications.svelte';
  import type { PageData } from './$types';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import Icon from '$lib/components/Icon.svelte';
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Chat · LittleSpaces</title></svelte:head>
<main class="builtin-app">
  <header class="builtin-header">
    <a class="back-link" href="/" aria-label="Back to Home"><Icon name="back" /></a>
    <h1>Chat</h1>
    <Notifications /><a class="icon-button" href="/settings" aria-label="Settings"
      ><Icon name="settings" /></a
    >
  </header>
  <ChatPanel {...data} applet={null} base="/chat" />
</main>
