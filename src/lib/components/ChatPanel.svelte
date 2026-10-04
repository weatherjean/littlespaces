<script lang="ts">
  import { goto } from '$app/navigation';
  import ChatView from './ChatView.svelte';
  import Icon from './Icon.svelte';
  import { request } from '$lib/client';
  import type { Account, Space, Chat, Message, Applet, ToolCall } from '$lib/types';
  let { space, chats, activeChat, messages, pendingToolCalls = [], account, applet, base, onupdated = () => {} }: { space: Space; chats: Chat[]; activeChat: Chat; messages: Message[]; pendingToolCalls?:ToolCall[]; account: Account | null; applet: Applet | null; base: string; onupdated?: () => void } = $props();
  const pickerId = $props.id();
  let picker: HTMLDialogElement;
  let trigger: HTMLButtonElement;
  let searchInput: HTMLInputElement;
  let query = $state('');
  let filteredChats = $derived(chats.filter(chat => chat.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  let busy = $state(false), error = $state('');
  function openPicker() { query = ''; error = ''; picker.showModal(); searchInput.focus(); }
  function closePicker() { picker.close(); trigger.focus(); }
  async function selectChat(id: string) {
    closePicker(); error = '';
    if (id === activeChat.id) return;
    try { await goto(`${base}/${id}`); }
    catch (e) { error = e instanceof Error ? e.message : 'Could not open chat.'; }
  }

  async function newChat() {
    busy = true; error = '';
    try { const { chat } = await request(`/api/spaces/${space.id}/chats`, {}); closePicker(); await goto(`${base}/${chat.id}`, { invalidateAll: true }); }
    catch (e) { error = e instanceof Error ? e.message : 'Could not create chat.'; }
    finally { busy = false; }
  }
</script>
<div class="chat-panel">
  <div class="conversation-switcher"><button class="conversation-picker-trigger" bind:this={trigger} aria-label={`Choose conversation: ${activeChat.title}`} aria-haspopup="dialog" onclick={openPicker}><Icon name="chat" size={16} /><span>{activeChat.title}</span><Icon name="chevron" size={15} /></button><button class="icon-button" aria-label="New chat" disabled={busy} onclick={newChat}><Icon name="plus" size={18} /></button></div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#key activeChat.id}<ChatView {space} {activeChat} {messages} {pendingToolCalls} {account} {applet} {onupdated} launcher={base === '/chat'} />{/key}
</div>

<dialog class="conversation-picker" bind:this={picker} aria-labelledby={`${pickerId}-title`} oncancel={event => { event.preventDefault(); event.stopPropagation(); closePicker(); }} onkeydown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closePicker(); } }}>
  <header class="picker-header"><div><h2 id={`${pickerId}-title`}>Conversations</h2><p>{base === '/chat' ? 'Your chats' : `In ${space.name}`}</p></div><button class="icon-button" aria-label="Close conversation picker" onclick={closePicker}><Icon name="close" /></button></header>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="picker-search"><Icon name="search" size={19} /><input bind:this={searchInput} bind:value={query} type="search" aria-label="Search conversations" placeholder="Search conversations…" onkeydown={event => { if (event.key === 'Enter' && !event.isComposing && filteredChats.length) { event.preventDefault(); void selectChat(filteredChats[0].id); } }} /></div>
  <button class="picker-new" disabled={busy} onclick={newChat}><Icon name="plus" size={19} />{busy ? 'Creating chat…' : 'New chat'}<span>Start fresh</span></button>
  <div class="picker-results" aria-label="Conversations"><p class="picker-count" aria-live="polite">{filteredChats.length} {filteredChats.length === 1 ? 'conversation' : 'conversations'}</p>
    {#each filteredChats as chat (chat.id)}<button class="picker-chat" class:current={chat.id === activeChat.id} aria-current={chat.id === activeChat.id ? 'true' : undefined} onclick={() => selectChat(chat.id)}><span class="picker-chat-icon"><Icon name="chat" size={18} /></span><span class="picker-chat-copy"><strong>{chat.title}</strong><small>{chat.id === activeChat.id ? 'Current conversation' : 'Open conversation'}</small></span>{#if chat.id === activeChat.id}<Icon name="check" size={18} />{/if}</button>
    {:else}<div class="picker-empty"><Icon name="search" size={27} /><h3>No matching conversations</h3><p>Try a different title or start a new chat.</p></div>{/each}
  </div>
</dialog>
