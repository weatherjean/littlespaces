<script lang="ts">
  import { page } from '$app/state';
  import Icon from './Icon.svelte';
  const links = [
    { href: '/', label: 'Apps', icon: 'grid' },
    { href: '/voice', label: 'Voice', icon: 'mic' },
    { href: '/chat', label: 'Chat', icon: 'chat' },
    { href: '/settings', label: 'Settings', icon: 'settings' },
  ];
</script>

<nav class="primary-nav" aria-label="Main navigation">
  {#each links as link}
    <a
      data-sveltekit-preload-data="off"
      href={link.href}
      aria-current={page.url.pathname === link.href ? 'page' : undefined}
    >
      <Icon name={link.icon} size={22} /><span>{link.label}</span>
    </a>
  {/each}
</nav>

<style>
  .primary-nav {
    position: fixed;
    z-index: 20;
    bottom: 0;
    left: 0;
    right: 0;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    padding: 8px max(12px, env(safe-area-inset-right)) calc(8px + env(safe-area-inset-bottom))
      max(12px, env(safe-area-inset-left));
    border-top: var(--border-width) solid var(--line);
    background: var(--panel);
  }
  a {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 5px;
    min-height: 54px;
    border-radius: var(--radius);
    color: var(--muted);
    font-size: 11px;
  }
  a[aria-current='page'] {
    color: var(--accent);
    background: var(--accent-soft);
  }
  a:hover {
    background: var(--hover);
  }
  @media (min-width: 701px) {
    .primary-nav {
      left: 50%;
      right: auto;
      transform: translateX(-50%);
      bottom: 20px;
      width: 400px;
      padding: 8px;
      border: var(--border-width) solid var(--line);
      border-radius: calc(var(--radius) * 1.5);
      box-shadow: var(--shadow);
    }
  }
</style>
