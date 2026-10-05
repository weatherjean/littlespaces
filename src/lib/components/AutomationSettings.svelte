<script lang="ts">
  import { onMount } from 'svelte';
  import { request } from '$lib/client';
  let { archivedSpaceIds = [] }: { archivedSpaceIds?: string[] } = $props();
  type Secret = { name: string; description: string };
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
  let name = $state(''),
    value = $state(''),
    description = $state(''),
    error = $state(''),
    busy = $state(false),
    status = $state('');
  onMount(() => {
    void Promise.all([request('/api/settings/secrets'), request('/api/settings/schedules')])
      .then(([a, b]) => {
        secrets = a.secrets;
        schedules = b.schedules;
      })
      .catch((e) => (error = e.message));
  });
  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = '';
    status = '';
    try {
      secrets = (await request('/api/settings/secrets', { name, value, description })).secrets;
      value = '';
      name = '';
      description = '';
      status = 'Secret saved.';
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not save.';
    } finally {
      busy = false;
    }
  }
  async function removeSecret(secret: Secret) {
    if (!confirm(`Delete ${secret.name}?`)) return;
    busy = true;
    error = '';
    try {
      secrets = (await request('/api/settings/secrets', { action: 'delete', name: secret.name }))
        .secrets;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not delete.';
    } finally {
      busy = false;
    }
  }
  async function cancel(schedule: Schedule) {
    busy = true;
    error = '';
    try {
      schedules = (
        await request('/api/settings/schedules', { spaceId: schedule.space_id, key: schedule.key })
      ).schedules;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not cancel.';
    } finally {
      busy = false;
    }
  }
</script>

<section class="setting-card automation-card">
  <h3>Secrets</h3>
  <p>
    Keep API keys and tokens encrypted on your server. Chat sees their names and descriptions only.
  </p>
  {#each secrets as secret}<div class="saved-row">
      <div>
        <strong>{secret.name}</strong>
        <p>{secret.description || 'No description'} · Value hidden</p>
      </div>
      <button class="secondary-button" disabled={busy} onclick={() => removeSecret(secret)}
        >Delete</button
      >
    </div>{/each}
  <form onsubmit={save}>
    <div class="form-heading">
      <h4>Add a secret</h4>
      <span>Stored securely</span>
    </div>
    <label
      >Name<input
        required
        pattern={'[A-Z][A-Z0-9_]{0,63}'}
        maxlength="64"
        placeholder="WEATHER_API_KEY"
        bind:value={name}
      /></label
    >
    <label
      >Description <span class="optional">Optional</span><input
        maxlength="500"
        placeholder="What this credential is for"
        bind:value={description}
      /></label
    >
    <label class="value-field"
      >Secret value<input
        required
        type="password"
        autocomplete="new-password"
        maxlength="16000"
        placeholder="Paste your key or token"
        bind:value
      /></label
    >
    <div class="form-footer">
      <p>Use an existing name to replace its value.</p>
      <button class="primary-button" disabled={busy || !name.trim() || !value}>Save secret</button>
    </div>
  </form>
  <p class="integration-note">
    Using secrets in applets and external integrations is coming later.
  </p>
  {#if status}<p class="success" role="status">{status}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</section>
<section class="setting-card automation-card">
  <h3>Scheduled checks</h3>
  <p>
    Ask an app’s chat to check your data at a specific time and notify you. Checks use your
    connected ChatGPT account and need the server running.
  </p>
  {#if !schedules.length}<div class="empty-state">
      <strong>No scheduled checks yet</strong>
      <p>Try “Check my plants every morning at 9.” in your plant app’s chat.</p>
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
      <button class="secondary-button" disabled={busy} onclick={() => cancel(schedule)}
        >Remove</button
      >
    </div>{/each}
</section>

<style>
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
    background: #ffffff03;
    border: 1px solid #ffffff10;
    border-radius: 16px;
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
    color: #dce5ef;
  }
  .form-heading > span {
    font-size: 11px;
    color: #8eabb0;
  }
  label {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 9px;
    font-size: 12px;
    font-weight: 500;
    color: #c3cedc;
  }
  .optional {
    color: #7f8fa3;
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
    border: 1px solid #ffffff19;
    border-radius: 9px;
    background: #0d141e;
    color: #e3ebf5;
    padding: 11px 13px;
    font-size: 13px;
    line-height: 1.5;
    transition:
      border-color 0.15s,
      box-shadow 0.15s;
  }
  input::placeholder {
    color: #748398;
    opacity: 1;
  }
  input:hover {
    border-color: #ffffff2d;
  }
  input:focus-visible {
    outline: none;
    border-color: #a8c9e38c;
    box-shadow: 0 0 0 3px #a8c9e312;
  }
  .form-footer {
    padding-top: 2px;
  }
  .form-footer p {
    font-size: 11px;
    color: #8697ac;
  }
  .form-footer button {
    flex-shrink: 0;
    min-height: 40px;
    padding: 10px 18px;
  }
  .integration-note {
    margin-top: 12px;
    font-size: 11px;
  }
  .success,
  .error {
    margin-top: 12px;
  }
  .automation-card .success {
    color: #9ccdbd;
  }
  .automation-card .error {
    color: #edaaa9;
  }
  .saved-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    margin-top: 16px;
    padding: 16px;
    border: 1px solid #ffffff10;
    border-radius: 12px;
    background: #ffffff02;
    overflow-wrap: anywhere;
  }
  .saved-row > div {
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
    border: 1px dashed #ffffff1a;
    border-radius: 12px;
  }
  .empty-state strong {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: #bdc9d8;
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
