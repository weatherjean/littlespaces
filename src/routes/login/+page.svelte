<script lang="ts">
  import type { ActionData } from './$types';
  import BrandMark from '$lib/components/BrandMark.svelte';
  let { form }: { form: ActionData } = $props();
</script>

<svelte:head
  ><title>Sign in · LittleSpaces</title><meta
    name="robots"
    content="noindex,nofollow"
  /></svelte:head
>
<main class="login-page">
  <section class="login-card" aria-labelledby="login-title">
    <h1 class="login-brand" id="login-title"><BrandMark size={36} /><span>LittleSpaces</span></h1>
    <form method="POST">
      <label for="email">Email</label>
      <input
        id="email"
        name="email"
        type="email"
        autocomplete="username"
        maxlength="254"
        required
      />
      <label for="password">Password</label>
      <input
        id="password"
        name="password"
        type="password"
        autocomplete="current-password"
        maxlength="256"
        required
      />
      {#if form?.message}<p class="error" role="alert">{form.message}</p>{/if}
      <button class="primary-button" type="submit">Sign in</button>
    </form>
  </section>
</main>

<style>
  .login-page {
    min-height: 100dvh;
    display: grid;
    place-items: center;
    padding: 28px 20px;
  }
  .login-card {
    width: 100%;
    max-width: 420px;
    padding: 38px;
    border: var(--border-width) solid var(--line);
    border-radius: calc(var(--radius) * 2);
    background: var(--panel);
    box-shadow: var(--modal-shadow);
  }
  .login-brand {
    --brand-halo: var(--panel);
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--ink);
    margin: 0 0 28px;
    font-size: 20px;
    font-weight: 500;
  }
  form {
    display: flex;
    flex-direction: column;
    margin-top: 0;
  }
  label {
    font-size: 12px;
    color: var(--accent);
    margin: 0 0 9px;
  }
  input {
    width: 100%;
    background: var(--bg);
    border: var(--border-width) solid var(--line);
    color: var(--ink);
    border-radius: calc(var(--radius) * 0.833);
    padding: 13px;
    margin-bottom: 20px;
  }
  button {
    width: 100%;
    margin-top: 6px;
    min-height: 45px;
  }
  @media (max-width: 450px) {
    .login-card {
      padding: 28px 24px;
    }
  }
</style>
