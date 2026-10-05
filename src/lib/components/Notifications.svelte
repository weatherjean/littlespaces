<script lang="ts">
  import Icon from './Icon.svelte';
  import { notifications, readNotifications, refreshNotifications } from '$lib/notification-state';
  let { home = false }: { home?: boolean } = $props();
  let dialog: HTMLDialogElement;
  let error = $state('');
  const unread = $derived($notifications.filter((n) => !n.read));
  async function open() {
    error = '';
    dialog.showModal();
    try {
      await refreshNotifications();
    } catch {
      error = 'Could not load notifications.';
    }
  }
  async function read(id?: string) {
    try {
      await readNotifications(id);
    } catch {
      error = 'Could not mark notifications read.';
    }
  }
</script>

{#if home}
  <section class="home-notifications" aria-label="Notifications">
    <header>
      <div><h2>Notifications <span class="notification-count">{unread.length}</span></h2></div>
      <button class="secondary-button" onclick={open}
        >Open inbox <Icon name="bell" size={16} /></button
      >
    </header>
    {#if unread.length}<div class="notification-preview">
        {#each unread.slice(0, 3) as item}<a
            class="notification-card"
            href={item.href}
            onclick={() => void read(item.id)}
            ><span class="eyebrow">{item.source}</span><strong>{item.title}</strong>
            <p>{item.body}</p></a
          >{/each}
      </div>{:else}<p class="notification-empty">
        All clear. Reminders and app updates will appear here.
      </p>{/if}
  </section>
{:else}
  <button
    class="notification-trigger"
    onclick={open}
    aria-label={`Notifications, ${unread.length} unread`}
    ><Icon name="bell" size={19} /><span class="notification-label">Inbox</span
    >{#if unread.length}<span class="notification-count"
        >{unread.length > 99 ? '99+' : unread.length}</span
      >{/if}</button
  >
{/if}
<dialog
  bind:this={dialog}
  class="notification-dialog"
  aria-label="Notifications"
  oncancel={(event) => {
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  }}
>
  <header class="picker-header">
    <div>
      <h2>Notifications</h2>
      <p>{unread.length} unread · on this computer</p>
    </div>
    <button class="icon-button" aria-label="Close notifications" onclick={() => dialog.close()}
      ><Icon name="close" /></button
    >
  </header>
  <div class="notification-toolbar">
    <button class="secondary-button" disabled={!unread.length} onclick={() => read()}
      >Mark all read</button
    >
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="notification-list">
    {#each $notifications as item}<article class:unread={!item.read}>
        <a
          href={item.href}
          onclick={() => {
            void read(item.id);
            dialog.close();
          }}
          ><span class="eyebrow">{item.source}</span>
          <h3>{item.title}</h3>
          <p>{item.body}</p>
          <small>{new Date(item.dueAt).toLocaleString()}</small></a
        >{#if !item.read}<button
            class="icon-button"
            aria-label={`Mark ${item.title} read`}
            onclick={() => read(item.id)}><Icon name="check" size={17} /></button
          >{/if}
      </article>{:else}<div class="notification-empty">
        <Icon name="bell" size={28} />
        <p>Nothing here yet.</p>
        <small>App updates and reminders will collect here.</small>
      </div>{/each}
  </div>
</dialog>
