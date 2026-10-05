<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Icon from '$lib/components/Icon.svelte';
  import type { ActionData, PageData } from './$types';
  let { data, form }: { data: PageData; form: ActionData } = $props();
  let token = $state('');
  let unlockForm = $state<HTMLFormElement>();
  onMount(async () => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const value = fragment.get('token');
    if (!value) return;
    // Remove the capability from browser history before rendering a registration form.
    window.history.replaceState(null,'','/setup');
    if (data.canRegister) return;
    token = value;
    await tick();
    unlockForm?.requestSubmit();
  });
</script>
<svelte:head><title>Set up · Little Spaces</title><meta name="robots" content="noindex,nofollow" /></svelte:head>
<main class="setup-page">
  <section class="setup-card" aria-labelledby="setup-title">
    <div class="setup-brand"><Icon name="grid" size={22}/><span>little spaces</span></div>
    <p class="eyebrow">YOUR PRIVATE WORKSPACE</p>
    {#if data.canRegister}
      <h1 id="setup-title">Make yourself at home.</h1>
      <p class="intro">Create the owner account for this workspace.</p>
      <form method="POST" action="?/register">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" autocomplete="username" maxlength="254" required />
        <p class="field-note">Use the email of the ChatGPT account you’ll connect.</p>
        <label for="password">Password</label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="15" maxlength="256" required aria-describedby="password-help" />
        <p class="field-note" id="password-help">Use a unique passphrase of at least 15 characters.</p>
        <label for="confirmation">Confirm password</label>
        <input id="confirmation" name="confirmation" type="password" autocomplete="new-password" minlength="15" maxlength="256" required />
        {#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
        <button class="primary-button" type="submit">Create owner account</button>
      </form>
      <p class="setup-note">Registration closes after your account is created.</p>
    {:else}
      <h1 id="setup-title">Setup required.</h1>
      <p class="intro">Open the private setup link printed in your server terminal to create your owner account.</p>
      <form method="POST" action="?/unlock" bind:this={unlockForm}>
        <label for="token">Or enter your setup code</label>
        <input id="token" name="token" type="password" autocomplete="off" maxlength="43" bind:value={token} required />
        {#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
        <button class="primary-button" type="submit">Continue setup</button>
      </form>
      <p class="setup-note">The link expires after 30 minutes. Restart the server for a new one.</p>
    {/if}
  </section>
</main>
<style>
  .setup-page{min-height:100dvh;display:grid;place-items:center;padding:28px 20px}
  .setup-card{width:100%;max-width:460px;padding:38px;border:1px solid #ffffff13;border-radius:24px;background:#171b29aa;box-shadow:0 24px 80px #0003}
  .setup-brand{display:flex;align-items:center;gap:10px;color:#d5cef4;margin-bottom:32px;font-size:17px}
  h1{font-size:30px;font-weight:500;letter-spacing:-1px;margin:14px 0 10px}.intro{font-size:14px;color:var(--muted)}
  form{display:flex;flex-direction:column;margin-top:28px}label{font-size:12px;color:#c7ccdb;margin:0 0 9px}
  input{width:100%;background:#0c101c;border:1px solid #ffffff24;color:#eff0f8;border-radius:10px;padding:13px;margin-bottom:20px}
  .field-note{font-size:11px;color:var(--muted);margin:-12px 0 20px}button{width:100%;margin-top:6px;min-height:45px}
  .setup-note{font-size:11px;color:var(--muted);text-align:center;margin-top:24px}
  @media(max-width:450px){.setup-card{padding:28px 24px}}
</style>
