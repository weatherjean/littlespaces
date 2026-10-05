<script lang="ts">
  import { messageParts } from '$lib/web-citations';
  let { text }: { text: string } = $props();
  const parts = $derived(messageParts(text));
</script>

{#each parts as part}{#if part.url}<a href={part.url} target="_blank" rel="noopener noreferrer"
      >{part.text}</a
    >{:else}{part.text}{/if}{/each}

<style>
  a {
    color: var(--accent);
    text-decoration: underline;
    text-underline-offset: 3px;
    overflow-wrap: anywhere;
  }
</style>
