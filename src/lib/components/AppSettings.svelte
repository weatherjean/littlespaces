<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { request } from '$lib/client';
  import { appEmoji } from '$lib/app-emoji';
  import type { Space } from '$lib/types';
  let { apps }: { apps: Space[] } = $props();
  let pending = $state(''),
    error = $state(''),
    status = $state('');
  let active = $derived(apps.filter((app) => !app.archived));
  let archived = $derived(apps.filter((app) => app.archived));
  async function toggle(app: Space) {
    pending = app.id;
    error = '';
    status = '';
    try {
      await request('/api/settings/apps', { id: app.id, archived: !app.archived });
      await invalidateAll();
      window.dispatchEvent(new Event('notifications-changed'));
      status = `${app.name} ${app.archived ? 'restored to Home' : 'archived'}.`;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not update app.';
    } finally {
      pending = '';
    }
  }
</script>

<section class="setting-card app-settings" id="apps">
  <h3>Apps</h3>
  <p>Archiving hides apps and pauses reminders. Data stays saved.</p>
  {#each active as app (app.id)}
    <div class="app-row">
      <span class="app-symbol" aria-hidden="true">{appEmoji(app.name, app.icon)}</span>
      <div class="app-copy">
        <strong>{app.name}</strong><span>{app.appletCount ? 'On Home' : 'In progress'}</span>
      </div>
      <button
        class="secondary-button"
        disabled={!!pending}
        onclick={() => toggle(app)}
        aria-label={`Archive ${app.name}`}>{pending === app.id ? 'Archiving…' : 'Archive'}</button
      >
    </div>
  {:else}<p class="empty-apps">No active apps.</p>{/each}
  {#if archived.length}
    <details class="archived-apps">
      <summary>Archived <span>{archived.length}</span></summary>
      {#each archived as app (app.id)}
        <div class="app-row">
          <span class="app-symbol" aria-hidden="true">{appEmoji(app.name, app.icon)}</span>
          <div class="app-copy">
            <strong>{app.name}</strong><span>Data saved · reminders paused</span>
          </div>
          <button
            class="secondary-button"
            disabled={!!pending}
            onclick={() => toggle(app)}
            aria-label={`Restore ${app.name}`}
            >{pending === app.id ? 'Restoring…' : 'Restore'}</button
          >
        </div>
      {/each}
    </details>
  {/if}
  {#if status}<p class="success" role="status">{status}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>

<style>
  .app-settings {
    display: block;
    scroll-margin-top: 24px;
  }
  .app-settings > p {
    max-width: 60ch;
  }
  .app-row {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 16px;
    margin-top: 12px;
    border: var(--border-width) solid var(--line);
    border-radius: var(--radius);
    background: var(--hover);
  }
  .app-symbol {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    font-size: 24px;
    border-radius: calc(var(--radius) * 0.917);
    background: var(--accent-soft);
    flex-shrink: 0;
  }
  .app-copy {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 4px;
  }
  strong {
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .app-copy > span {
    font-size: 11px;
    color: var(--muted);
  }
  button {
    flex-shrink: 0;
  }
  .archived-apps {
    margin-top: 22px;
  }
  summary {
    cursor: pointer;
    font-size: 12px;
    color: var(--accent);
    padding: 8px 0;
  }
  summary span {
    margin-left: 6px;
    font-size: 11px;
    color: var(--muted);
  }
  .empty-apps {
    margin-top: 18px;
  }
  .app-settings .success {
    margin-top: 14px;
    color: var(--success);
  }
  .app-settings .error {
    margin-top: 14px;
    color: var(--danger);
  }
  @media (max-width: 450px) {
    .app-row {
      padding: 12px;
      gap: 10px;
    }
    .app-symbol {
      width: 32px;
      height: 32px;
      font-size: 21px;
    }
    button {
      padding: 9px 12px;
    }
  }
</style>
