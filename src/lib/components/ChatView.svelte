<script lang="ts">
  import { chatViewport } from '$lib/chat-viewport';
  import { readBrowserValue, writeBrowserValue } from '$lib/browser-storage';
  import { expertMode } from '$lib/preferences';
  import ToolCalls from './ToolCalls.svelte';
  import BuildPlanCard from './BuildPlanCard.svelte';
  import { buildPlanText, type BuildPlan } from '$lib/build-plan-types';
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
  import type {
    Account,
    Space,
    Chat,
    Message,
    Model,
    Applet,
    ToolCall,
    AppChatContext,
  } from '$lib/types';
  let {
    space,
    activeChat,
    messages,
    pendingToolCalls = [],
    account,
    applet,
    appContext,
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
    appContext?: AppChatContext;
    launcher?: boolean;
    voiceMode?: boolean;
    onupdated?: () => void;
    onbusy?: (value: boolean) => void;
  } = $props();
  const currentContext = $derived(appContext?.view ?? activeChat.launch);
  let calls = $state<ToolCall[]>(untrack(() => pendingToolCalls));

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
  let efforts = $derived(models.find((item) => item.slug === model)?.efforts || []);
  let busy = $state(false),
    listening = $state(false),
    readReplies = $state(false),
    voiceAvailable = $state(false);
  $effect(() => onbusy(uploading || listening));
  let jobId = $state('');
  let spaceBlocked = $state(false);
  let initialized = $state(false);
  let pendingInput: Record<string, unknown> | null = null;
  let syncing = false;
  let reconnecting = false;
  let syncController: AbortController | undefined;
  let lastFinished = '';
  const draftKey = $derived(`little-spaces-chat-draft:${activeChat.id}`);
  const pendingKey = $derived(`little-spaces-chat-pending:${activeChat.id}`);
  $effect(() => {
    if (initialized) writeBrowserValue(draftKey, JSON.stringify({ draft, attachments }));
  });
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
  let messageInput = $state<HTMLTextAreaElement>();
  let optionsDialog = $state<HTMLDialogElement>();
  let optionsTrigger = $state<HTMLButtonElement>();
  const optionsId = $props.id();
  function closeOptions() {
    optionsDialog?.close();
    optionsTrigger?.focus();
  }
  function resizeMessage() {
    if (!messageInput) return;
    messageInput.style.height = 'auto';
    const available = window.visualViewport?.height || window.innerHeight;
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, Math.max(44, Math.min(144, available * 0.25)))}px`;
  }
  $effect(() => {
    draft;
    if (messageInput) void tick().then(resizeMessage);
  });
  let following = $state(true);
  let transcript: HTMLDivElement;
  let transcriptContent: HTMLDivElement;
  async function scrollChat(force = false) {
    if (!force && !following) return;
    if (force) following = true;
    await tick();
    transcript?.scrollTo({
      top: transcript.scrollHeight,
      behavior: 'instant',
    });
  }
  beforeNavigate((navigation) => {
    if (uploading || listening) {
      navigation.cancel();
      error = 'Finish dictation or wait for the upload before leaving this chat.';
    }
  });
  async function discardEmptyChat() {
    if (chat.length || busy || uploading || draft.trim() || attachments.length) return;
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
    try {
      const saved = JSON.parse(readBrowserValue(draftKey) || 'null');
      if (saved) {
        draft = typeof saved.draft === 'string' ? saved.draft : '';
        attachments = Array.isArray(saved.attachments) ? saved.attachments.slice(0, 4) : [];
      }
      pendingInput = JSON.parse(readBrowserValue(pendingKey) || 'null');
    } catch {
      pendingInput = null;
    }
    initialized = true;
    busy = !!pendingInput;
    void syncChat();
    const resume = () => {
      if (document.visibilityState === 'visible') void syncChat();
    };
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    const poll = window.setInterval(resume, 2000);
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
    void scrollChat(true);
    const observer = new ResizeObserver(() => {
      resizeMessage();
      if (following) void scrollChat();
    });
    observer.observe(transcript);
    observer.observe(transcriptContent);
    return () => {
      observer.disconnect();
      window.removeEventListener('pagehide', discardEmptyChat);
      window.removeEventListener('pageshow', restoreChat);
      void discardEmptyChat();
      disposed = true;
      stopSpeaking();
      window.clearInterval(poll);
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', resume);
      syncController?.abort();
      stopVoice?.();
      window.speechSynthesis?.cancel();
    };
  });
  async function submitPending() {
    if (!pendingInput) return;
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(pendingInput),
      signal: syncController?.signal,
    });
    if (!response.ok) {
      // Only a server rejection proves the submission was not accepted.
      if (response.status >= 400 && response.status < 500) {
        pendingInput = null;
        writeBrowserValue(pendingKey, null);
        busy = false;
      }
      await responseJson(response);
    }
    const value = await responseJson(response);
    jobId = value.job.id;
    error = '';
    const wasPlan = !!pendingInput?.buildPlanId;
    pendingInput = null;
    writeBrowserValue(pendingKey, null);
    if (!wasPlan) {
      draft = '';
      attachments = [];
      writeBrowserValue(draftKey, null);
    }
  }
  async function syncChat() {
    if (syncing || disposed) return;
    if (!navigator.onLine) {
      if (busy || pendingInput) status = 'Offline. Your reply can continue on the server.';
      return;
    }
    syncing = true;
    syncController = new AbortController();
    const timeout = window.setTimeout(() => syncController?.abort(), 15000);
    let submitted = false;
    try {
      await submitPending();
      submitted = true;
      const response = await fetch(
        `/api/chat?spaceId=${encodeURIComponent(space.id)}&chatId=${encodeURIComponent(activeChat.id)}`,
        { signal: syncController.signal },
      );
      const value = await responseJson(response);
      if (disposed) return;
      chat = value.messages;
      calls = value.tools;
      const job = value.job;
      const wasRunning = !!jobId;
      busy = job?.status === 'running';
      jobId = busy ? job.id : '';
      spaceBlocked = !!value.running && value.running.chatId !== activeChat.id;
      if (reconnecting) error = '';
      reconnecting = false;
      status = busy
        ? job.activity
        : spaceBlocked
          ? 'A reply is running in another conversation in this app.'
          : '';
      if (job && job.status !== 'running' && lastFinished !== job.id) {
        lastFinished = job.id;
        error = job.error || '';
        window.dispatchEvent(new Event('notifications-changed'));
        await invalidateAll();
        voiceRefresh++;
        if (wasRunning) onupdated();
        if (job.status === 'complete' && wasRunning && document.visibilityState === 'visible') {
          if (voiceMode) void speakReply(job.message);
          else if (readReplies && window.speechSynthesis)
            window.speechSynthesis.speak(new SpeechSynthesisUtterance(speechText(job.message)));
        }
      }
      await scrollChat();
    } catch (e) {
      if (!disposed) {
        error = e instanceof Error ? e.message : 'Could not reconnect.';
        reconnecting = submitted || !!pendingInput;
        if (busy || pendingInput) status = 'Reconnecting… Your reply can continue on the server.';
      }
    } finally {
      window.clearTimeout(timeout);
      syncing = false;
      syncController = undefined;
    }
  }
  async function stopReply() {
    if (!jobId) {
      await syncChat();
      return;
    }
    try {
      await responseJson(
        await fetch('/api/chat', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobId, spaceId: space.id, chatId: activeChat.id }),
        }),
      );
      await syncChat();
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not stop reply.';
    }
  }
  async function send(plan?: BuildPlan) {
    if (
      !initialized ||
      busy ||
      spaceBlocked ||
      uploading ||
      (!plan && !draft.trim() && !attachments.length) ||
      !model ||
      !account?.canUsePlan
    )
      return;
    stopSpeaking();
    stopVoice?.();
    listening = false;
    error = '';
    busy = true;
    status = 'Sending your message…';
    pendingInput = {
      requestId: crypto.randomUUID(),
      message: plan ? buildPlanText(plan) : draft.trim() || 'What is in this photo?',
      mode: voiceMode ? 'voice' : undefined,
      buildPlanId: plan?.id,
      photos: plan ? [] : attachments.map((photo) => photo.id),
      model,
      effort,
      spaceId: space.id,
      chatId: activeChat.id,
      appContext,
    };
    writeBrowserValue(pendingKey, JSON.stringify(pendingInput));
    await syncChat();
    await scrollChat(true);
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
  <div class="transcript-wrap">
    <div
      class="transcript"
      bind:this={transcript}
      aria-live="polite"
      aria-relevant="additions text"
      onscroll={() => {
        following = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 80;
      }}
    >
      <div bind:this={transcriptContent}>
        {#if !chat.length}<div class="chat-welcome">
            <span class="card-icon"><Icon name={voiceMode ? 'mic' : 'spark'} size={28} /></span>
            <h2>
              {voiceMode
                ? 'What would you like to do?'
                : launcher
                  ? 'What’s on your mind?'
                  : currentContext?.title ||
                    (applet ? 'How can I help?' : 'What would you like to build?')}
            </h2>
            <p>
              {voiceMode
                ? 'Talk about your apps. Confirm changes before they’re saved.'
                : launcher
                  ? 'Ask a question or describe an app you want.'
                  : currentContext?.welcome ||
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
        {#if status}<p class="status">{status}</p>{/if}
        {#if !voiceMode}<BuildPlanCard
            spaceId={space.id}
            chatId={activeChat.id}
            refreshKey={voiceRefresh}
            disabled={busy ||
              uploading ||
              listening ||
              !model ||
              !!draft.trim() ||
              !!attachments.length}
            onapprove={(plan) => void send(plan)}
          />{/if}
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
    </div>
    {#if !following}<button type="button" class="jump-latest" onclick={() => void scrollChat(true)}
        ><Icon name="chevron" size={18} />Latest messages</button
      >{/if}
  </div>
  {#if currentContext}<details class="chat-context">
      <summary>{currentContext.title || 'App task'} · App context</summary>
      <p>{currentContext.task}</p>
      {#if currentContext.recordKeys?.length}<p>
          {currentContext.recordKeys.length} selected record(s), refreshed each turn.
        </p>{/if}{#if currentContext.photoIds?.length}<p>
          {currentContext.photoIds.length} referenced photo(s).
        </p>{/if}{#if currentContext.context}<pre>{JSON.stringify(
            currentContext.context,
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
          type="button"
          class="composer-options"
          bind:this={optionsTrigger}
          aria-label="Chat options"
          aria-haspopup="dialog"
          onclick={() => optionsDialog?.showModal()}
          ><Icon name="settings" size={18} /><span
            >{models.find((item) => item.slug === model)?.display_name || 'Options'}</span
          ></button
        >
        <button
          class="voice-talk"
          class:listening
          disabled={!busy && (!voiceAvailable || !model || !account?.canUsePlan)}
          aria-pressed={listening}
          onclick={() => (busy ? stopReply() : voice())}
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
          bind:this={messageInput}
          rows="1"
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
            if (
              event.key === 'Enter' &&
              !event.shiftKey &&
              !event.isComposing &&
              (!window.matchMedia('(pointer: coarse)').matches || event.ctrlKey || event.metaKey)
            ) {
              event.preventDefault();
              void send();
            }
          }}></textarea>
        <div class="composer-controls">
          <button
            type="button"
            class="composer-options"
            bind:this={optionsTrigger}
            aria-label="Chat options"
            aria-haspopup="dialog"
            onclick={() => optionsDialog?.showModal()}
          >
            <Icon name="settings" size={18} /><span
              >{models.find((item) => item.slug === model)?.display_name || 'Options'}</span
            >
          </button>
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
                onclick={stopReply}><Icon name="stop" /></button
              >{:else}<button
                class="send-button"
                aria-label="Send message"
                onpointerdown={(event) => {
                  if (event.pointerType === 'touch') event.preventDefault();
                }}
                disabled={!initialized ||
                  spaceBlocked ||
                  uploading ||
                  (!draft.trim() && !attachments.length) ||
                  !model ||
                  !account?.canUsePlan}><Icon name="send" /></button
              >{/if}
          </div>
        </div>
      </form>
    {/if}
  </div>
  <dialog
    class="chat-options-dialog phone-chat-sheet"
    use:chatViewport
    bind:this={optionsDialog}
    aria-labelledby={`${optionsId}-title`}
    oncancel={(event) => {
      event.preventDefault();
      event.stopPropagation();
      closeOptions();
    }}
  >
    <header class="picker-header">
      <div>
        <h2 id={`${optionsId}-title`}>Chat options</h2>
        <p>Used for your next message.</p>
      </div>
      <button
        type="button"
        class="icon-button"
        aria-label="Close chat options"
        onclick={closeOptions}><Icon name="close" /></button
      >
    </header>
    <div class="chat-options-body">
      <label
        >Model<select
          aria-label="Model"
          bind:value={model}
          onchange={(event) => {
            model = event.currentTarget.value;
            writeBrowserValue('little-spaces-model', model);
            restoreEffort();
          }}
          disabled={busy || !models.length}
          >{#if !models.length}<option value="">ChatGPT</option>{/if}{#each models as item}<option
              value={item.slug}>{item.display_name}</option
            >{/each}</select
        ></label
      ><label
        >Reasoning effort<select
          class="effort-select"
          aria-label="Reasoning effort"
          bind:value={effort}
          onchange={(event) =>
            writeBrowserValue(`little-spaces-effort:${model}`, event.currentTarget.value)}
          disabled={busy || !efforts.length}
          ><option value="default">Effort: Default</option>{#each efforts as level}<option
              value={level}>Effort: {level}</option
            >{/each}</select
        ></label
      >
    </div>
  </dialog>
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
