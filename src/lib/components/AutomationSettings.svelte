<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from './Icon.svelte';
  import { request } from '$lib/client';
  import { credentialWarnings } from '$lib/secret-validation';
  let { archivedSpaceIds = [] }: { archivedSpaceIds?: string[] } = $props();
  type Secret = { name: string; description: string; origins: string[]; warnings?: string[] };
  type Schedule = {
    space_id: string;
    key: string;
    title: string;
    cron: string | null;
    timezone: string;
    next_run: string | null;
    enabled: number;
    last_error: string | null;
  };
  let secrets = $state<Secret[]>([]),
    schedules = $state<Schedule[]>([]);
  let editing = $state(false);
  let formOpen = $state(false);
  let secretForm = $state<HTMLFormElement>();
  let addButton = $state<HTMLButtonElement>();
  let origins = $state('');
  let valueVisible = $state(false);
  let name = $state(''),
    value = $state(''),
    description = $state(''),
    error = $state(''),
    busy = $state(false),
    status = $state('');
  let valueWarnings = $derived(value ? credentialWarnings(name, value) : []);
  let loading = $state(true),
    loadError = $state(''),
    scheduleError = $state(''),
    scheduleStatus = $state('');
  async function load() {
    loading = true;
    loadError = '';
    try {
      const [a, b] = await Promise.all([
        request('/api/settings/secrets'),
        request('/api/settings/schedules'),
      ]);
      secrets = a.secrets;
      schedules = b.schedules;
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Could not load settings.';
    } finally {
      loading = false;
    }
  }
  onMount(() => {
    void load();
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || loading || loadError) return;
    busy = true;
    error = '';
    status = '';
    try {
      secrets = (
        await request('/api/settings/secrets', {
          name,
          value,
          description,
          origins: origins.split(/[\s,]+/).filter(Boolean),
          ...(editing && !value ? { action: 'configure' } : {}),
        })
      ).secrets;
      closeSecretForm();
      status =
        'Secret saved. Saving does not verify the connection; ask the app’s chat to test it.';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not save.';
    } finally {
      busy = false;
    }
  }
  async function openSecretForm(secret?: Secret) {
    editing = !!secret;
    name = secret?.name || '';
    description = secret?.description || '';
    origins = secret?.origins.join(', ') || '';
    value = '';
    valueVisible = false;
    error = status = '';
    formOpen = true;
    await tick();
    secretForm
      ?.querySelector<HTMLInputElement>(editing ? 'input:not([readonly])' : 'input')
      ?.focus();
  }
  function closeSecretForm() {
    formOpen = editing = valueVisible = false;
    name = value = description = origins = '';
    error = '';
    void tick().then(() => addButton?.focus());
  }
  async function removeSecret(secret: Secret) {
    if (busy || loading) return;
    if (!confirm(`Delete ${secret.name}?`)) return;
    busy = true;
    error = status = '';
    try {
      secrets = (await request('/api/settings/secrets', { action: 'delete', name: secret.name }))
        .secrets;
      status = `${secret.name} deleted.`;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not delete.';
    } finally {
      busy = false;
    }
  }
  async function cancel(schedule: Schedule) {
    if (busy || loading) return;
    busy = true;
    scheduleError = scheduleStatus = '';
    try {
      schedules = (
        await request('/api/settings/schedules', { spaceId: schedule.space_id, key: schedule.key })
      ).schedules;
      scheduleStatus = `${schedule.title} removed.`;
    } catch (e) {
      scheduleError = e instanceof Error ? e.message : 'Could not cancel.';
    } finally {
      busy = false;
    }
  }
</script>

<section class="setting-card automation-card">
  <div class="secrets-heading">
    <div>
      <h3>Secrets</h3>
      <p>Connect apps to external services. Values are hidden from chat.</p>
    </div>
    <button
      bind:this={addButton}
      type="button"
      class="secondary-button add-secret"
      disabled={busy || loading || !!loadError || formOpen}
      aria-expanded={formOpen}
      aria-controls="secret-form"
      onclick={() => openSecretForm()}><Icon name="plus" size={18} />Add secret</button
    >
  </div>
  {#if loading}<p role="status">Loading settings…</p>{/if}
  {#if loadError}<p class="error" role="alert">{loadError}</p>
    <button class="secondary-button" onclick={load}>Retry loading settings</button>{/if}
  {#each secrets as secret}<div class="saved-row">
      <div>
        <strong>{secret.name}</strong>
        <p>{secret.description || secret.origins.join(', ') || 'No API access allowed'}</p>
        {#each secret.warnings || [] as warning}<p class="error">{warning}</p>{/each}
      </div>
      <button
        class="secondary-button"
        disabled={busy || loading || !!loadError}
        onclick={() => openSecretForm(secret)}>Edit</button
      >
      <button
        class="secondary-button"
        disabled={busy || loading || !!loadError}
        onclick={() => removeSecret(secret)}>Delete</button
      >
    </div>{/each}
  {#if formOpen}
    <form id="secret-form" bind:this={secretForm} onsubmit={save}>
      <div class="form-heading">
        <h4>{editing ? `Edit ${name}` : 'Add a secret'}</h4>
        <button type="button" class="secondary-button" disabled={busy} onclick={closeSecretForm}
          >Cancel</button
        >
      </div>
      <label
        >Name<input
          disabled={busy || loading || !!loadError}
          required
          readonly={editing}
          pattern={'[A-Z][A-Z0-9_]{0,63}'}
          maxlength="64"
          placeholder="WEATHER_API_KEY"
          bind:value={name}
        /></label
      >
      <label
        >Description <span class="optional">Optional</span><input
          disabled={busy || loading || !!loadError}
          maxlength="500"
          placeholder="What this credential is for"
          bind:value={description}
        /></label
      >
      <label class="value-field"
        >Secret value<input
          disabled={busy || loading || !!loadError}
          required={!editing}
          type={valueVisible ? 'text' : 'password'}
          autocomplete="new-password"
          spellcheck="false"
          autocapitalize="none"
          maxlength="16000"
          placeholder={editing
            ? 'Leave blank to keep the current value'
            : 'Paste your key or token'}
          bind:value
        /></label
      >
      <div class="secret-visibility">
        <button
          class="secondary-button"
          type="button"
          disabled={busy || loading || !!loadError}
          aria-pressed={valueVisible}
          onclick={() => (valueVisible = !valueVisible)}
          >{valueVisible ? 'Hide entered value' : 'Show entered value'}</button
        >
        <p>Show only reveals what you just entered; stored values are never returned.</p>
      </div>
      {#each valueWarnings as warning}<p class="error" role="status">{warning}</p>{/each}
      <label class="value-field"
        >Allowed API origins<input
          disabled={busy || loading || !!loadError}
          placeholder="https://api.example.com"
          bind:value={origins}
          maxlength="3000"
        /></label
      >
      <div class="form-footer">
        <p>Apps can use this secret at these addresses. Separate origins with commas.</p>
        <button
          class="primary-button"
          disabled={busy || loading || !!loadError || !name.trim() || (!editing && !value)}
          >Save secret</button
        >
      </div>
    </form>
  {/if}
  {#if status}<p class="success" role="status">{status}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
<section class="setting-card automation-card">
  <h3>Scheduled checks</h3>
  <p>Schedule checks in app chat. Uses ChatGPT; requires the server to stay running.</p>
  {#if scheduleError}<p class="error" role="alert">{scheduleError}</p>{/if}
  {#if scheduleStatus}<p class="success" role="status">{scheduleStatus}</p>{/if}
  {#if loading}<p role="status">Loading scheduled checks…</p>{:else if loadError}<p>
      Could not load checks. Retry loading settings above.
    </p>{:else if !schedules.length}<div class="empty-state">
      <strong>No scheduled checks yet</strong>
      <p>Try “Check my plants every morning at 9.”</p>
    </div>{/if}
  {#each schedules as schedule}<div class="saved-row">
      <div>
        <strong>{schedule.title}</strong>
        <p>{schedule.cron || 'One-time'} · {schedule.timezone}</p>
        <p>
          {archivedSpaceIds.includes(schedule.space_id)
            ? 'Paused while app is archived'
            : schedule.enabled && schedule.next_run
              ? `Next: ${new Date(schedule.next_run).toLocaleString()}`
              : 'Completed'}
        </p>
        {#if schedule.last_error}<p class="error">{schedule.last_error}</p>{/if}
      </div>
      <button
        class="secondary-button"
        disabled={busy || loading || !!loadError}
        onclick={() => cancel(schedule)}>Remove</button
      >
    </div>{/each}
</section>

<style>
  .secrets-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
  }
  .secrets-heading > div {
    min-width: 0;
  }
  .add-secret {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  @media (max-width: 540px) {
    .secrets-heading {
      flex-wrap: wrap;
      gap: 16px;
    }
  }

  .automation-card {
    display: block;
    padding: 28px 0;
  }
  .automation-card > p {
    max-width: 62ch;
  }
  form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 20px;
    margin-top: 22px;
    padding: 24px;
    background: var(--hover);
    border: var(--border-width) solid var(--line);
    border-radius: calc(var(--radius) * 1.333);
  }
  .form-heading,
  .form-footer {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .form-heading h4 {
    margin: 0;
    font-size: 13px;
    font-weight: 550;
    color: var(--ink);
  }
  label {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 9px;
    font-size: 12px;
    font-weight: 500;
    color: var(--accent);
  }
  .optional {
    color: var(--muted);
    font-size: 11px;
    font-weight: 400;
  }
  .value-field {
    grid-column: 1 / -1;
  }
  input {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: 44px;
    border: var(--border-width) solid var(--line);
    border-radius: calc(var(--radius) * 0.75);
    background: var(--bg);
    color: var(--ink);
    padding: 11px 13px;
    font-size: 13px;
    line-height: 1.5;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  input::placeholder {
    color: var(--muted);
    opacity: 1;
  }
  input:hover {
    border-color: var(--line);
  }
  input:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
    border-color: var(--accent);
    box-shadow: var(--shadow);
  }
  .form-footer {
    padding-top: 2px;
  }
  .form-footer p {
    font-size: 11px;
    color: var(--muted);
  }
  .form-footer button {
    flex-shrink: 0;
    min-height: 40px;
    padding: 10px 18px;
  }
  .success,
  .error {
    margin-top: 12px;
  }
  .automation-card .success {
    color: var(--success);
  }
  .automation-card .error {
    color: var(--danger);
  }
  .saved-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 16px;
    padding: 16px;
    border: var(--border-width) solid var(--line);
    border-radius: var(--radius);
    background: var(--hover);
    overflow-wrap: anywhere;
  }
  .saved-row > div {
    flex: 1;
    min-width: 0;
  }
  .saved-row strong {
    font-size: 13px;
    font-weight: 500;
  }
  .saved-row button {
    flex-shrink: 0;
  }
  .empty-state {
    margin-top: 18px;
    padding: 22px;
    border: var(--border-width) dashed var(--line);
    border-radius: var(--radius);
  }
  .empty-state strong {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--accent);
    margin-bottom: 4px;
  }
  @media (max-width: 540px) {
    form {
      grid-template-columns: minmax(0, 1fr);
      padding: 18px;
      gap: 18px;
    }
    .form-footer {
      align-items: flex-start;
      flex-direction: column;
      gap: 12px;
    }
    .saved-row {
      align-items: flex-start;
    }
  }
</style>
