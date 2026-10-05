<script lang="ts">
  import { page } from '$app/state';
  import Icon from './Icon.svelte';
  let { banner = false, reconnect = false }: { banner?: boolean; reconnect?: boolean } = $props();
</script>

<section class:banner class="connect-chatgpt" aria-label="ChatGPT connection required">
  <span class="connection-symbol"><Icon name="spark" size={24} /></span>
  <div class="connection-copy">
    <h2>{reconnect ? 'Reconnect ChatGPT' : 'Connect ChatGPT'}</h2>
    <p>
      {reconnect
        ? 'Reconnect with plan access to use chat.'
        : 'Connect your account to chat with your apps and build new ones.'}
    </p>
  </div>
  <a
    class="primary-button"
    href={`/settings?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`}
  >
    {reconnect ? 'Reconnect ChatGPT' : 'Connect ChatGPT'} <span aria-hidden="true">↗</span>
  </a>
</section>

<style>
  .connect-chatgpt {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 22px;
    text-align: center;
    padding: 48px 24px;
    min-height: 280px;
  }
  .connection-symbol {
    display: grid;
    place-items: center;
    width: 52px;
    height: 52px;
    border-radius: calc(var(--radius) * 1.333);
    color: var(--accent);
    background: var(--accent-soft);
    border: var(--border-width) solid var(--line);
    flex-shrink: 0;
  }
  h2 {
    font-size: 22px;
    font-weight: 500;
    letter-spacing: -0.5px;
    margin-bottom: 8px;
  }
  p {
    max-width: 330px;
    font-size: 13px;
    color: var(--muted);
    line-height: 1.65;
  }
  a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    min-height: 42px;
    white-space: nowrap;
  }
  .banner {
    min-height: 0;
    flex-direction: row;
    text-align: left;
    justify-content: flex-start;
    gap: 16px;
    padding: 20px;
    border: var(--border-width) solid var(--line);
    background: var(--accent-soft);
    border-radius: calc(var(--radius) * 1.333);
    margin: 0 auto 32px;
  }
  .banner .connection-copy {
    flex: 1;
  }
  .banner .connection-symbol {
    width: 40px;
    height: 40px;
    border-radius: var(--radius);
  }
  .banner h2 {
    font-size: 14px;
    letter-spacing: 0;
    margin-bottom: 4px;
  }
  .banner p {
    font-size: 12px;
    max-width: 380px;
  }
  @media (max-width: 600px) {
    .banner {
      flex-wrap: wrap;
    }
    .banner .connection-copy {
      flex-basis: calc(100% - 56px);
    }
    .banner a {
      margin-left: 56px;
    }
  }
</style>
