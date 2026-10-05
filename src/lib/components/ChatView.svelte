<script lang="ts">
  import { expertMode } from '$lib/preferences';
  import ToolCalls from './ToolCalls.svelte';
  import { onMount, tick, untrack } from 'svelte';
  import { beforeNavigate, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { request, responseJson } from '$lib/client';
  import { canDictate, dictate } from '$lib/voice';
  import PhotoPicker from './PhotoPicker.svelte';
  import { uploadPhoto } from '$lib/photos';
  import type { Photo } from '$lib/photo-types';
  import Icon from './Icon.svelte';
  import type { Account, Space, Chat, Message, Model, Applet, ToolCall } from '$lib/types';
  let {
    space,
    activeChat,
    messages,
    pendingToolCalls = [],
    account,
    applet,
    launcher = false,
    onupdated = () => {},
  }: {
    space: Space;
    activeChat: Chat;
    messages: Message[];
    pendingToolCalls?: ToolCall[];
    account: Account | null;
    applet: Applet | null;
    launcher?: boolean;
    onupdated?: () => void;
  } = $props();
  let calls = $state<ToolCall[]>(untrack(() => pendingToolCalls));
  let activeCalls: ToolCall[] = [];
  let attachments = $state<Photo[]>([]),
    uploading = $state(false),
    photoOptions = $state(false);
  function picked(photo: Photo) {
    if (attachments.length < 4) attachments = [...attachments, photo];
    photoOptions = false;
  }
  async function attachFiles(files: File[]) {
    if (busy || uploading) return;
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (images.length > 4 - attachments.length) {
      error = 'Attach up to four photos per message.';
      return;
    }
    if (!images.length) return;
    uploading = true;
    error = '';
    try {
      for (const file of images) picked(await uploadPhoto(space.id, file));
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not attach photo.';
    } finally {
      uploading = false;
    }
  }
  let chat = $state<Message[]>(untrack(() => messages));
  let draft = $state(''),
    error = $state(''),
    status = $state(''),
    model = $state('');
  let models = $state<Model[]>([]);
  let effort = $state('default');
  let mode = $state<'knowledge' | 'build'>(
    untrack(() =>
      (launcher && page.url.searchParams.get('mode') === 'build') || (!launcher && !applet)
        ? 'build'
        : 'knowledge',
    ),
  );
  let efforts = $derived(models.find((item) => item.slug === model)?.efforts || []);
  let createdApp = $state<string | null>(null);
  let busy = $state(false),
    listening = $state(false),
    readReplies = $state(false),
    voiceAvailable = $state(false);
  let cancelRequest: AbortController | undefined;
  let stopVoice: (() => void) | undefined;
  let transcript: HTMLDivElement;
  async function scrollChat() {
    await tick();
    transcript?.scrollTo({ top: transcript.scrollHeight, behavior: 'smooth' });
  }
  beforeNavigate((navigation) => {
    if (busy || uploading) {
      navigation.cancel();
      error = 'Wait for the upload or stop the current reply before leaving this chat.';
    }
  });
  onMount(() => {
    voiceAvailable = canDictate();
    readReplies = localStorage.getItem('little-spaces-read-replies') === 'true';
    if (account?.canUsePlan)
      request('/api/models')
        .then((value) => {
          models = value.models;
          model = models.some((item) => item.slug === localStorage.getItem('little-spaces-model'))
            ? localStorage.getItem('little-spaces-model')!
            : models[0]?.slug || '';
          effort = localStorage.getItem(`little-spaces-effort:${model}`) || 'default';
          if (!models.find((item) => item.slug === model)?.efforts?.includes(effort))
            effort = 'default';
        })
        .catch((e) => (error = e.message));
    void scrollChat();
    return () => {
      cancelRequest?.abort();
      stopVoice?.();
      window.speechSynthesis?.cancel();
    };
  });
  async function send() {
    if (
      busy ||
      uploading ||
      (!draft.trim() && !attachments.length) ||
      !model ||
      !account?.canUsePlan
    )
      return;
    const message = draft.trim() || 'What is in this photo?';
    const sentPhotos = [...attachments];
    attachments = [];
    activeCalls = [];
    draft = '';
    error = '';
    busy = true;
    chat = [
      ...chat,
      {
        role: 'user',
        content: message,
        ...(sentPhotos.length ? { photos: sentPhotos.map((photo) => photo.id) } : {}),
      },
    ];
    status = 'Connecting to ChatGPT…';
    cancelRequest = new AbortController();
    stopVoice?.();
    listening = false;
    await scrollChat();
    let completed = false;
    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          mode,
          photos: sentPhotos.map((photo) => photo.id),
          model,
          effort,
          spaceId: space.id,
          chatId: activeChat.id,
        }),
        signal: cancelRequest.signal,
      });
      if (!response.ok) await responseJson(response);
      if (!response.body) throw new Error('No response stream.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) !== -1) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const type = block
              .split('\n')
              .find((line) => line.startsWith('event: '))
              ?.slice(7);
            const payload = JSON.parse(
              block
                .split('\n')
                .find((line) => line.startsWith('data: '))
                ?.slice(6) || '{}',
            );
            if (type === 'tool') {
              calls = [...calls.filter((item) => item.id !== payload.id), payload];
              activeCalls = [...activeCalls.filter((item) => item.id !== payload.id), payload];
            }
            if (type === 'status') status = payload.message;
            if (type === 'error') throw new Error(payload.message);
            if (type === 'done') {
              completed = true;
              chat = [
                ...chat,
                { role: 'assistant', content: payload.message, toolCalls: activeCalls },
              ];
              calls = calls.filter((item) => !activeCalls.some((active) => active.id === item.id));
              window.dispatchEvent(new Event('notifications-changed'));
              if (launcher && payload.applet) createdApp = payload.applet.id;
              await invalidateAll();
              if (readReplies && window.speechSynthesis) {
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(new SpeechSynthesisUtterance(payload.message));
              }
              await scrollChat();
            }
          }
          if (done || completed) break;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      if (!completed) throw new Error('The connection ended early. Please retry.');
    } catch (e) {
      error = cancelRequest.signal.aborted
        ? 'Stopped. Completed app actions may remain saved; check the app before retrying.'
        : e instanceof Error
          ? e.message
          : 'Request failed.';
      if (!completed) {
        attachments = sentPhotos;
        draft = message;
        chat = chat.slice(0, -1);
      }
    } finally {
      busy = false;
      status = '';
      cancelRequest = undefined;
      onupdated();
    }
  }
  function voice() {
    if (listening) {
      stopVoice?.();
      return;
    }
    error = '';
    try {
      stopVoice = dictate(
        (text) => (draft = [draft, text].filter(Boolean).join(' ')),
        () => (listening = false),
        (message) => {
          error = message;
          listening = false;
        },
      );
      listening = true;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Voice input failed.';
    }
  }
</script>

<section class="chat-view" aria-label="Conversation">
  <div class="transcript" bind:this={transcript} aria-live="polite">
    {#if !chat.length}<div class="chat-welcome">
        <span class="card-icon"><Icon name="spark" size={28} /></span>
        <h2>
          {launcher
            ? mode === 'build'
              ? 'What would you like to build?'
              : 'What’s on your mind?'
            : activeChat.launch?.title ||
              (applet ? 'What can we do for you?' : 'What would you like to build?')}
        </h2>
        <p>
          {launcher
            ? mode === 'build'
              ? 'Describe an app you wish existed.'
              : 'Ask a question, explore your apps’ data, or connect the dots.'
            : activeChat.launch?.welcome ||
              (applet
                ? 'Ask about your data, get something done, or change how this app works.'
                : 'Describe your app. We’ll build it here, just for you.')}
        </p>
      </div>{/if}
    {#each chat as message}{#if $expertMode && message.toolCalls?.length}<ToolCalls
          calls={message.toolCalls}
        />{/if}
      <article class:from-user={message.role === 'user'} class="message">
        <span class="message-label">{message.role === 'user' ? 'You' : 'ChatGPT'}</span>
        <p>{message.content}</p>
        {#if message.photos?.length}<div class="message-photos">
            {#each message.photos as photoId}<a
                href={`/api/spaces/${space.id}/photos/${photoId}`}
                target="_blank"
                rel="noreferrer"
                ><img src={`/api/spaces/${space.id}/photos/${photoId}`} alt="Attachment" /></a
              >{/each}
          </div>{/if}
      </article>{/each}
    {#if $expertMode && calls.length}<ToolCalls {calls} />{/if}
    {#if createdApp}<a class="created-app-link" href={`/spaces/${createdApp}/applet`}
        >Open your new app <Icon name="grid" size={17} /></a
      >{/if}
    {#if busy}<p class="status">{status}</p>{/if}
  </div>
  {#if activeChat.launch && (!launcher || mode === 'build')}<details class="chat-context">
      <summary>{activeChat.launch.title || 'App task'} · App context</summary>
      <p>{activeChat.launch.task}</p>
      {#if activeChat.launch.recordKeys?.length}<p>
          {activeChat.launch.recordKeys.length} selected record(s), refreshed each turn.
        </p>{/if}{#if activeChat.launch.photoIds?.length}<p>
          {activeChat.launch.photoIds.length} referenced photo(s).
        </p>{/if}{#if activeChat.launch.context}<pre>{JSON.stringify(
            activeChat.launch.context,
            null,
            2,
          )}</pre>{/if}
    </details>{/if}
  <div class="composer-area">
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if !account}<p class="connection-note">
        <a href={`/settings?returnTo=${encodeURIComponent(page.url.pathname)}`}
          >Connect ChatGPT <span aria-hidden="true">↗</span></a
        > to start chatting.
      </p>{:else if !account.canUsePlan}<p class="connection-note">
        <a href={`/settings?returnTo=${encodeURIComponent(page.url.pathname)}`}>Reconnect ChatGPT</a
        > to grant plan access.
      </p>{/if}
    {#if photoOptions}<div class="chat-photo-options">
        <PhotoPicker
          spaceId={space.id}
          onpicked={picked}
          onbusy={(value) => (uploading = value)}
          disabled={busy || attachments.length >= 4}
        />
        <p class="photo-note">Photos are sent to ChatGPT when you send your message.</p>
      </div>{/if}
    <form
      class="composer"
      onsubmit={(event) => {
        event.preventDefault();
        void send();
      }}
    >
      {#if attachments.length}<div class="attachment-tray">
          {#each attachments as photo}<div class="attachment-tile">
              <img src={photo.url} alt={photo.name} /><button
                type="button"
                aria-label={`Remove ${photo.name}`}
                onclick={() => (attachments = attachments.filter((item) => item.id !== photo.id))}
                ><Icon name="close" size={13} /></button
              >
            </div>{/each}
        </div>{/if}
      {#if uploading}<p class="upload-progress" role="status">Saving photo…</p>{/if}
      <textarea
        onpaste={(event) => {
          const files = Array.from(event.clipboardData?.files || []);
          if (files.some((file) => file.type.startsWith('image/'))) {
            event.preventDefault();
            void attachFiles(files);
          }
        }}
        ondragover={(event) => {
          if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
        }}
        ondrop={(event) => {
          event.preventDefault();
          void attachFiles(Array.from(event.dataTransfer?.files || []));
        }}
        aria-label="Message"
        bind:value={draft}
        placeholder={launcher ? 'What’s on your mind?' : 'Ask your app anything…'}
        disabled={busy}
        onkeydown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            void send();
          }
        }}></textarea>
      <div class="composer-controls">
        <div class="model-controls">
          <select aria-label="Chat mode" bind:value={mode} disabled={busy}>
            <option value="knowledge">Knowledge</option><option value="build">Build</option>
          </select>
          <select
            aria-label="Model"
            bind:value={model}
            onchange={() => {
              localStorage.setItem('little-spaces-model', model);
              effort = 'default';
            }}
            disabled={busy || !models.length}
            >{#if !models.length}<option value="">ChatGPT</option>{/if}{#each models as item}<option
                value={item.slug}>{item.display_name}</option
              >{/each}</select
          ><select
            class="effort-select"
            aria-label="Reasoning effort"
            bind:value={effort}
            onchange={() => localStorage.setItem(`little-spaces-effort:${model}`, effort)}
            disabled={busy || !efforts.length}
            ><option value="default">Effort: Default</option>{#each efforts as level}<option
                value={level}>Effort: {level}</option
              >{/each}</select
          >
        </div>
        <div>
          <button
            type="button"
            class="icon-button"
            aria-label="Attach photos"
            disabled={busy || uploading || attachments.length >= 4}
            onclick={() => (photoOptions = !photoOptions)}><Icon name="image" /></button
          ><button
            type="button"
            class="icon-button"
            class:chosen={listening}
            aria-label={listening ? 'Stop dictation' : 'Dictate message'}
            disabled={!voiceAvailable || busy}
            onclick={voice}><Icon name="mic" /></button
          >{#if busy}<button
              type="button"
              class="send-button"
              aria-label="Stop reply"
              onclick={() => cancelRequest?.abort()}><Icon name="stop" /></button
            >{:else}<button
              class="send-button"
              aria-label="Send message"
              disabled={uploading ||
                (!draft.trim() && !attachments.length) ||
                !model ||
                !account?.canUsePlan}><Icon name="send" /></button
            >{/if}
        </div>
      </div>
    </form>
    <p class="composer-note">
      {launcher
        ? mode === 'build'
          ? 'Create a new app with a conversation.'
          : 'Answers with context from your apps.'
        : 'Connected to this app’s data and actions.'}
    </p>
  </div>
</section>
