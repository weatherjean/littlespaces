<script lang="ts">
  import { request } from '$lib/client';
  import MessageText from './MessageText.svelte';
  import type { BuildPlan } from '$lib/build-plan-types';
  let {
    spaceId,
    chatId,
    refreshKey = 0,
    disabled = false,
    onapprove,
  }: {
    spaceId: string;
    chatId: string;
    refreshKey?: number;
    disabled?: boolean;
    onapprove: (plan: BuildPlan) => void;
  } = $props();
  let plan = $state<BuildPlan | null>(null),
    error = $state(''),
    saving = $state(false);
  $effect(() => {
    const query = new URLSearchParams({ spaceId, chatId });
    void refreshKey;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const value = await request(`/api/build-plans?${query}`);
        if (current) {
          plan = value.plan;
          error = '';
          if (plan?.status === 'running') timer = setTimeout(load, 2000);
        }
      } catch (e) {
        if (current) error = e instanceof Error ? e.message : 'Could not load build plan.';
      }
    }
    void load();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  });
  async function dismiss() {
    if (!plan || disabled || saving) return;
    saving = true;
    error = '';
    try {
      plan = (
        await request('/api/build-plans', { spaceId, chatId, id: plan.id, decision: 'cancel' })
      ).plan;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not dismiss plan.';
    } finally {
      saving = false;
    }
  }
</script>

{#if error}<p class="error" role="alert">{error}</p>{/if}
{#if plan && plan.status !== 'cancelled'}
  <article class="build-plan" aria-label="Build proposal">
    <h3><span aria-hidden="true">{plan.emoji}</span> {plan.title}</h3>
    <div class="plan-summary"><MessageText text={plan.summary} /></div>
    {#if plan.features?.length}<h4>Features</h4>
      <ul>
        {#each plan.features as feature}<li>{feature}</li>{/each}
      </ul>{/if}
    {#if plan.caveats?.length}<h4>Good to know</h4>
      <ul class="caveats">
        {#each plan.caveats as caveat}<li>{caveat}</li>{/each}
      </ul>{/if}
    {#if plan.status === 'pending' || plan.status === 'failed'}
      {#if plan.status === 'failed'}<p>
          Build stopped. You can retry or revise the plan in chat.
        </p>{/if}
      <div class="actions">
        <button
          class="primary-button"
          disabled={disabled || saving}
          onclick={() => plan && onapprove(plan)}
          >{plan.status === 'failed'
            ? 'Retry build'
            : plan.appletId
              ? 'Update app'
              : 'Build app'}</button
        >
        <button class="secondary-button" disabled={disabled || saving} onclick={dismiss}
          >Dismiss</button
        >
      </div>
    {:else if plan.status === 'running'}<p role="status">Building…</p>
    {:else if plan.publishedId}<a class="primary-button" href={`/spaces/${plan.publishedId}/applet`}
        >Open app</a
      >{/if}
  </article>
{/if}

<style>
  .build-plan {
    margin: 18px 0;
    padding: 20px;
    border: var(--border-width) solid var(--line);
    border-radius: var(--radius);
    background: var(--panel);
  }
  h3 {
    margin: 0 0 10px;
    font-size: 15px;
  }
  .plan-summary {
    font-size: 14px;
    line-height: 1.6;
  }
  h4 {
    margin: 16px 0 6px;
    font-size: 12px;
    font-weight: 600;
  }
  ul {
    margin: 0;
    padding-left: 20px;
    font-size: 14px;
    line-height: 1.6;
  }
  li + li {
    margin-top: 4px;
  }
  .caveats {
    color: var(--muted);
  }
  .actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 16px;
  }
  p {
    font-size: 13px;
    color: var(--muted);
    margin: 12px 0;
  }
  a {
    display: inline-flex;
    margin-top: 16px;
  }
</style>
