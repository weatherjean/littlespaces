<script lang="ts">
  import { readBrowserValue, writeBrowserValue } from '$lib/browser-storage';
  import { expertMode } from '$lib/preferences';
  import ToolCalls from './ToolCalls.svelte';
  import VoiceActions from './VoiceActions.svelte';
  import MessageText from './MessageText.svelte';
  import { speechText } from '$lib/web-citations';
  import { onMount, tick, untrack } from 'svelte';
  import { beforeNavigate, onNavigate, invalidateAll } from '$app/navigation';
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
    voiceMode = false,
    onupdated = () => {},
    onbusy = (_value: boolean) => {},
  }: {
    space: Space;
    activeChat: Chat;
    messages: Message[];
    pendingToolCalls?: ToolCall[];
    account: Account | null;
    applet: Applet | null;
    launcher?: boolean;
    voiceMode?: boolean;
    onupdated?: () => void;
    onbusy?: (value: boolean) => void;
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
  let modelsLoading = $state(false),
    modelError = $state('');
  async function loadModels() {
    if (modelsLoading) return;
    modelsLoading = true;
    modelError = '';
    try {
      const value = await request('/api/models');
      if (disposed) return;
      models = value.models;
      const savedModel = readBrowserValue('little-spaces-model');
      model = models.some((item) => item.slug === savedModel) ? savedModel! : models[0]?.slug || '';
      restoreEffort();
      if (!model)
        modelError = 'No models are available. Try again or reconnect ChatGPT in Settings.';
    } catch (e) {
      if (!disposed) modelError = e instanceof Error ? e.message : 'Could not load models.';
    } finally {
      modelsLoading = false;
    }
  }
  function restoreEffort() {
    const saved = readBrowserValue(`little-spaces-effort:${model}`);
    effort =
      saved && models.find((item) => item.slug === model)?.efforts?.includes(saved)
        ? saved
        : 'default';
  }
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
  $effect(() => onbusy(busy || uploading || listening));
  let cancelRequest: AbortController | undefined;
  let stopVoice: (() => void) | undefined;
  let voiceRefresh = $state(0);
  let speechURL = $state('');
  let speechBusy = $state(false);
  let speechReady = $state(false);
  let speechAudio = $state<HTMLAudioElement>();
  let speechRequest: AbortController | undefined;
  let disposed = false;
  function stopSpeaking() {
    window.speechSynthesis?.cancel();
    speechRequest?.abort();
    speechRequest = undefined;
    speechAudio?.pause();
    if (speechURL) URL.revokeObjectURL(speechURL);
    speechURL = '';
    speechBusy = false;
  }
  async function speakReply(text: string) {
    if (!voiceMode || !readReplies || !speechReady || disposed) return;
    stopSpeaking();
    const controller = new AbortController();
    speechRequest = controller;
    speechBusy = true;
    try {
      const response = await fetch('/api/voice/speech', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: speechText(text).slice(0, 1200) }),
        signal: controller.signal,
      });
      if (!response.ok) await responseJson(response);
      const blob = await response.blob();
      if (controller.signal.aborted || disposed) return;
      speechURL = URL.createObjectURL(blob);
      await tick();
      await speechAudio?.play();
    } catch (e) {
      if (!controller.signal.aborted && !disposed)
        error = speechURL
          ? 'Tap Play to hear the reply.'
          : e instanceof Error
            ? e.message
            : 'Could not read the reply aloud.';
    } finally {
      if (speechRequest === controller) {
        speechBusy = false;
        speechRequest = undefined;
      }
    }
  }
  let transcript: HTMLDivElement;
  async function scrollChat() {
    await tick();
    transcript?.scrollTo({
      top: transcript.scrollHeight,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    });
  }
  beforeNavigate((navigation) => {
    if (busy || uploading || listening) {
      navigation.cancel();
      error = 'Finish dictation, wait for the upload, or stop the reply before leaving this chat.';
    }
  });
  async function discardEmptyChat() {
    if (chat.length || busy || uploading) return;
    await fetch('/api/chat', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: activeChat.id }),
      keepalive: true,
    }).catch(() => {});
  }
  onNavigate((navigation) => {
    // Query-only changes keep the current composer open.
    if (navigation.to?.url.pathname !== navigation.from?.url.pathname)
      return discardEmptyChat().then(() => () => {
        void invalidateAll();
      });
  });
  onMount(() => {
    window.addEventListener('pagehide', discardEmptyChat);
    const restoreChat = (event: PageTransitionEvent) => {
      if (event.persisted) void invalidateAll();
    };
    window.addEventListener('pageshow', restoreChat);
    voiceAvailable = canDictate();
    readReplies = voiceMode || readBrowserValue('little-spaces-read-replies') === 'true';
    if (voiceMode)
      request('/api/voice/speech')
        .then((value) => {
          if (!disposed) speechReady = value.available;
        })
        .catch(() => {});
    if (account?.canUsePlan) void loadModels();
    void scrollChat();
    return () => {
      window.removeEventListener('pagehide', discardEmptyChat);
      window.removeEventListener('pageshow', restoreChat);
      void discardEmptyChat();
      disposed = true;
      stopSpeaking();
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
    stopSpeaking();
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
          mode: voiceMode ? 'voice' : mode,
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
              voiceRefresh++;
              if (voiceMode) void speakReply(payload.message);
              else if (readReplies && window.speechSynthesis) {
                window.speechSynthesis.cancel();
                window.speechSynthesis.speak(
                  new SpeechSynthesisUtterance(speechText(payload.message)),
                );
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
      voiceRefresh++;
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
    stopSpeaking();
    try {
      stopVoice = dictate(
        (text) => {
          if (disposed) return;
          draft = [draft, text].filter(Boolean).join(' ');
          if (voiceMode) void send();
        },
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
        <span class="card-icon"><Icon name={voiceMode ? 'mic' : 'spark'} size={28} /></span>
        <h2>
          {voiceMode
            ? 'What would you like to do?'
            : launcher
              ? mode === 'build'
                ? 'What would you like to build?'
                : 'What’s on your mind?'
              : activeChat.launch?.title ||
                (applet ? 'How can I help?' : 'What would you like to build?')}
        </h2>
        <p>
          {voiceMode
            ? 'Talk about your apps. Confirm changes before they’re saved.'
            : launcher
              ? mode === 'build'
                ? 'Describe an app you wish existed.'
                : 'Ask about your apps and data.'
              : activeChat.launch?.welcome ||
                (applet
                  ? 'Ask a question or change this app.'
                  : 'Describe the app you want to make.')}
        </p>
      </div>{/if}
    {#each chat as message}{#if $expertMode && message.toolCalls?.length}<ToolCalls
          calls={message.toolCalls}
        />{/if}
      <article class:from-user={message.role === 'user'} class="message">
        <span class="message-label">{message.role === 'user' ? 'You' : 'ChatGPT'}</span>
        <p><MessageText text={message.content} /></p>
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
    {#if voiceMode}<VoiceActions
        chatId={activeChat.id}
        refreshKey={voiceRefresh}
        disabled={busy || listening}
        ondone={(text) => {
          void speakReply(text);
          void scrollChat();
        }}
      />{/if}
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
    {#if modelsLoading}<p class="status" role="status">Loading models…</p>{/if}
    {#if modelError}<div role="alert">
        <p class="error">{modelError}</p>
        <button type="button" class="secondary-button" disabled={modelsLoading} onclick={loadModels}
          >Retry loading models</button
        >
      </div>{/if}
    {#if !account}<p class="connection-note">
        <a href={`/settings?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`}
          >Connect ChatGPT <span aria-hidden="true">↗</span></a
        > to start chatting.
      </p>{:else if !account.canUsePlan}<p class="connection-note">
        <a href={`/settings?returnTo=${encodeURIComponent(page.url.pathname + page.url.search)}`}
          >Reconnect ChatGPT</a
        > to grant plan access.
      </p>{/if}
    {#if voiceMode}<div class="voice-controls">
        <button
          class="voice-talk"
          class:listening
          disabled={!busy && (!voiceAvailable || !model || !account?.canUsePlan)}
          aria-pressed={listening}
          onclick={() => (busy ? cancelRequest?.abort() : voice())}
        >
          <Icon name={busy || listening ? 'stop' : 'mic'} size={26} />
          {busy ? 'Stop reply' : listening ? 'Listening… tap to finish' : 'Tap to talk'}
        </button>
        <label
          ><input
            type="checkbox"
            bind:checked={readReplies}
            onchange={(event) => {
              if (!event.currentTarget.checked) stopSpeaking();
            }}
          /> Read replies aloud</label
        >
        {#if !voiceAvailable}<p>Dictation unavailable. Try Chrome or Edge, or type in Chat.</p>{/if}
        {#if !speechReady}<p>Speech needs server setup. Text replies are available.</p>{/if}
        {#if speechBusy}<p role="status">Preparing speech…</p>{/if}
        {#if speechURL}<audio
            bind:this={speechAudio}
            src={speechURL}
            controls
            aria-label="Spoken reply"
          ></audio>{/if}
        {#if speechURL || speechBusy}<button class="stop-speech" onclick={stopSpeaking}
            >Stop audio</button
          >{/if}
      </div>{:else}
      {#if photoOptions}<div class="chat-photo-options">
          <PhotoPicker
            spaceId={space.id}
            onpicked={picked}
            onbusy={(value) => (uploading = value)}
            disabled={busy || uploading || attachments.length >= 4}
          />
          <p class="photo-note">Attached photos are sent to ChatGPT.</p>
        </div>{/if}
      <form
        class="composer"
        class:recording={listening}
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
        <div class="dictation-status" role="status" aria-live="polite">
          {#if listening}
            <span class="recording-dot" aria-hidden="true"></span>
            Listening… tap {voiceMode ? 'the talk button' : 'the stop button'} to finish.
          {/if}
        </div>
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
            {#if !voiceMode}<select aria-label="Chat mode" bind:value={mode} disabled={busy}>
                <option value="knowledge">Knowledge</option><option value="build">Build</option>
              </select>{/if}
            <select
              aria-label="Model"
              bind:value={model}
              onchange={(event) => {
                model = event.currentTarget.value;
                writeBrowserValue('little-spaces-model', model);
                restoreEffort();
              }}
              disabled={busy || !models.length}
              >{#if !models.length}<option value="">ChatGPT</option
                >{/if}{#each models as item}<option value={item.slug}>{item.display_name}</option
                >{/each}</select
            ><select
              class="effort-select"
              aria-label="Reasoning effort"
              bind:value={effort}
              onchange={(event) =>
                writeBrowserValue(`little-spaces-effort:${model}`, event.currentTarget.value)}
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
            >{#if !voiceMode}<button
                type="button"
                class="icon-button"
                class:recording-mic={listening}
                aria-label={listening ? 'Stop dictation' : 'Dictate message'}
                aria-pressed={listening}
                disabled={!voiceAvailable || busy}
                onclick={voice}><Icon name={listening ? 'stop' : 'mic'} /></button
              >{/if}{#if busy}<button
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
    {/if}
  </div>
</section>

<style>
  .voice-controls {
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 10px 18px;
    padding: 16px;
    border-top: var(--border-width) solid var(--line);
  }
  .voice-talk {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 14px 22px;
    border-radius: calc(var(--radius) * 2.333);
    background: var(--accent);
    color: var(--on-accent);
    font-weight: 600;
  }
  .voice-talk.listening {
    background: var(--danger-solid);
    color: var(--on-danger);
  }
  .voice-controls label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .voice-controls p {
    width: 100%;
    text-align: center;
    font-size: 12px;
    margin: 0;
    opacity: 0.7;
  }
  .voice-controls audio {
    max-width: 100%;
    height: 36px;
  }
  .stop-speech {
    font-size: 12px;
    padding: 8px;
  }
  .composer.recording {
    border-color: var(--danger);
  }
  .dictation-status {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--danger);
    font-size: 13px;
  }
  .dictation-status:not(:empty) {
    padding: 4px 0 12px;
  }
  .recording-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--danger-solid);
    animation: recording-pulse 1.2s ease-in-out infinite;
  }
  .icon-button.recording-mic {
    background: var(--danger-solid);
    color: var(--on-danger);
    box-shadow: var(--shadow);
  }
  @keyframes recording-pulse {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .recording-dot {
      animation: none;
    }
  }
</style>
