<script lang="ts">
  import type { ActionData } from './$types';
  import Icon from '$lib/components/Icon.svelte';
  let { form }: { form: ActionData } = $props();
</script>

<svelte:head
  ><title>Sign in · Little Spaces</title><meta
    name="robots"
    content="noindex,nofollow"
  /></svelte:head
>
<main class="login-page">
  <section class="login-card" aria-labelledby="login-title">
    <div class="login-brand"><Icon name="grid" size={22} /><span>little spaces</span></div>
    <p class="eyebrow">YOUR PRIVATE WORKSPACE</p>
    <h1 id="login-title">Welcome home.</h1>
    <p class="intro">Sign in to your apps and conversations.</p>
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
    <p class="login-note">Only the owner of this workspace can sign in.</p>
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
    border: 1px solid #ffffff13;
    border-radius: 24px;
    background: #171b29aa;
    box-shadow: 0 24px 80px #0003;
  }
  .login-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    color: #d5cef4;
    margin-bottom: 48px;
    font-size: 17px;
  }
  h1 {
    font-size: 32px;
    font-weight: 500;
    letter-spacing: -1px;
    margin: 14px 0 10px;
  }
  .intro {
    font-size: 14px;
    color: var(--muted);
  }
  form {
    display: flex;
    flex-direction: column;
    margin-top: 28px;
  }
  label {
    font-size: 12px;
    color: #c7ccdb;
    margin: 0 0 9px;
  }
  input {
    width: 100%;
    background: #0c101c;
    border: 1px solid #ffffff24;
    color: #eff0f8;
    border-radius: 10px;
    padding: 13px;
    margin-bottom: 20px;
  }
  button {
    width: 100%;
    margin-top: 6px;
    min-height: 45px;
  }
  .login-note {
    font-size: 11px;
    color: var(--muted);
    text-align: center;
    margin-top: 24px;
  }
  @media (max-width: 450px) {
    .login-card {
      padding: 28px 24px;
    }
    .login-brand {
      margin-bottom: 34px;
    }
  }
</style>
