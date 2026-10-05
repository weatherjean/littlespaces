<script lang="ts">
  import { request } from '$lib/client';
  import Icon from './Icon.svelte';
  import type { VoiceAction } from '$lib/voice-types';
  let {
    chatId,
    refreshKey = 0,
    disabled = false,
    ondone = (_text: string) => {},
  }: {
    chatId: string;
    refreshKey?: number;
    disabled?: boolean;
    ondone?: (text: string) => void;
  } = $props();
  let actions = $state<VoiceAction[]>([]);
  let busy = $state('');
  let error = $state('');
  $effect(() => {
    const id = chatId;
    void refreshKey;
    let current = true;
    request(`/api/voice/actions?chatId=${encodeURIComponent(id)}`)
      .then((value) => {
        if (current) actions = value.actions;
      })
      .catch((e) => {
        if (current) error = e.message;
      });
    return () => {
      current = false;
    };
  });
  async function decide(id: string, decision: 'confirm' | 'cancel') {
    if (busy || disabled) return;
    busy = id;
    error = '';
    try {
      const { action } = await request('/api/voice/actions', { chatId, id, decision });
      actions = actions.map((item) => (item.id === id ? action : item));
      window.dispatchEvent(new Event('notifications-changed'));
      if (decision === 'confirm')
        ondone(
          action.status === 'complete'
            ? `Done. ${action.summary}`
            : action.error || 'This action is still running. Check the app before trying again.',
        );
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not confirm the action.';
      // Reconcile after a lost response instead of assuming a write did not happen.
      try {
        actions = (await request(`/api/voice/actions?chatId=${encodeURIComponent(chatId)}`))
          .actions;
      } catch {
        /* Keep existing cards available for reconciliation on refresh. */
      }
    } finally {
      busy = '';
    }
  }
</script>

{#if error}<p class="error" role="alert">{error}</p>{/if}
{#each actions as action (action.id)}
  <article
    class="voice-action"
    class:completed={action.status === 'complete'}
    aria-label={`Suggestion for ${action.appName}`}
  >
    <header>
      <span class="app-label"
        ><Icon
          name={action.status === 'complete' ? 'check' : 'spark'}
          size={17}
        />{action.appName}</span
      >
      <span class="status-label"
        >{action.status === 'pending'
          ? 'Awaiting confirmation'
          : action.status === 'complete'
            ? 'Completed'
            : action.status === 'cancelled'
              ? 'Dismissed'
              : action.status === 'running'
                ? 'In progress'
                : 'Not saved'}</span
      >
    </header>
    <p class="suggestion-summary">{action.summary}</p>
    <details>
      <summary>Review exact change</summary>
      <p>{action.action}</p>
      <pre>{JSON.stringify(action.input, null, 2)}</pre>
    </details>
    {#if action.status === 'pending'}
      <div class="decisions">
        <button
          class="primary"
          disabled={disabled || !!busy}
          onclick={() => decide(action.id, 'confirm')}
          ><Icon name="check" size={17} />{busy === action.id ? 'Working…' : 'Confirm'}</button
        >
        <button disabled={disabled || !!busy} onclick={() => decide(action.id, 'cancel')}
          >Dismiss</button
        >
      </div>
    {:else}<p class="action-status" role="status">
        {action.status === 'complete'
          ? 'Done · Saved to your app'
          : action.status === 'cancelled'
            ? 'Dismissed · Nothing changed'
            : action.status === 'running'
              ? 'Execution started. Check the app if this persists; this suggestion will not run twice.'
              : 'Could not complete this change.'}
      </p>{/if}
    {#if action.error}<p class="error">{action.error}</p>{/if}
  </article>
{/each}

<style>
  .voice-action {
    padding: 22px;
    margin: 18px 0;
    border: var(--border-width) solid var(--line);
    border-radius: calc(var(--radius) * 1.333);
    background: var(--panel);
    color: var(--ink);
    box-shadow: var(--shadow);
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
  }
  .app-label {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    color: var(--accent);
    font-size: 13px;
    font-weight: 550;
  }
  .status-label {
    font-size: 11px;
    color: var(--muted);
  }
  .suggestion-summary {
    margin: 16px 0 12px;
    line-height: 1.6;
    font-size: 15px;
    color: var(--ink);
  }
  p {
    margin: 8px 0;
  }
  details {
    font-size: 13px;
    color: var(--muted);
  }
  summary {
    cursor: pointer;
  }
  .completed {
    border-color: var(--line);
  }
  .completed .app-label,
  .completed .action-status {
    color: var(--success);
  }
  .completed .status-label {
    color: var(--success);
  }
  pre {
    background: var(--bg);
    border-radius: calc(var(--radius) * 0.667);
    padding: 12px;
    color: var(--ink);
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    border: var(--border-width) solid var(--line);
    background: transparent;
    color: var(--ink);
    min-height: 42px;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .decisions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
  }
  button {
    padding: 9px 18px;
    border-radius: calc(var(--radius) * 0.833);
  }
  .primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: transparent;
    font-weight: 600;
  }
  .action-status {
    font-size: 13px;
    margin-top: 16px;
  }
  @media (max-width: 600px) {
    .voice-action {
      padding: 16px;
    }
    .decisions button {
      flex: 1;
    }
  }
</style>
