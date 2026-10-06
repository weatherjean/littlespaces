<script lang="ts">
  import type { PageData } from './$types';
  import ChatPanel from '$lib/components/ChatPanel.svelte';
  import { chatViewport } from '$lib/chat-viewport';
  let { data }: { data: PageData } = $props();
</script>

<svelte:head><title>Chat · LittleSpaces</title></svelte:head>
<main class="builtin-app mobile-chat" use:chatViewport>
  <ChatPanel {...data} applet={null} base="/chat" standalone />
</main>
