<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { request as hostRequest } from '$lib/client';
  import PhotoPicker from './PhotoPicker.svelte';
  import Icon from './Icon.svelte';
  import type { Photo } from '$lib/photo-types';
  let { id, version }: { id: string; version: number } = $props();
  let owner = $state('');
  let photoDialog: HTMLDialogElement;
  let photoRequest = $state<{ owner: string; resolve: (value: unknown) => void } | null>(null);
  function cancelPhoto() {
    const pending = photoRequest;
    photoRequest = null;
    photoDialog?.close();
    pending?.resolve({ result: null });
  }
  async function acceptPhoto(photo: Photo, pending: NonNullable<typeof photoRequest>) {
    if (photoRequest !== pending) return;
    let reply: object;
    try {
      const response = await fetch(`${photo.url}?data=1`);
      const value = await response.json();
      reply = response.ok ? { result: value } : { error: value.error || 'Could not load photo.' };
    } catch {
      reply = { error: 'Could not load photo. Please try again.' };
    }
    if (photoRequest !== pending) return;
    photoRequest = null;
    photoDialog.close();
    pending.resolve(reply);
  }
  let frame = $state<HTMLIFrameElement>();
  let document = $state('');
  let error = $state('');
  let loading = $state(true);
  $effect(() => {
    const currentId = id;
    void version;
    const controller = new AbortController();
    loading = true;
    error = '';
    document = '';
    fetch(`/api/applets/${currentId}`, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        owner = data.spaceId;
        document = data.document;
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) error = e.message;
      })
      .finally(() => {
        if (!controller.signal.aborted) loading = false;
      });
    return () => controller.abort();
  });
  onMount(() => {
    let inFlight = 0;
    async function handle(event: MessageEvent) {
      if (event.source !== frame?.contentWindow || event.data?.channel !== 'little-spaces') return;
      const request = event.data;
      if (
        !Number.isSafeInteger(request.id) ||
        ![
          'list',
          'set',
          'remove',
          'action',
          'photos.pick',
          'photos.get',
          'photos.list',
          'photos.analyze',
          'chat.open',
          'diagnostics.report',
          'schedules.save',
          'schedules.list',
          'schedules.cancel',
          'notifications.send',
          'notifications.list',
          'notifications.cancel',
        ].includes(request.method)
      )
        return;
      const target = frame.contentWindow;
      const currentId = id;
      const currentOwner = owner;
      const reply = (data: object) => {
        if (currentId === id && target === frame?.contentWindow)
          target?.postMessage({ channel: 'little-spaces-result', id: request.id, ...data }, '*');
      };
      if (inFlight >= 20) {
        reply({ error: 'Too many storage requests.' });
        return;
      }
      inFlight++;
      try {
        if (request.method.startsWith('schedules.')) {
          const response = await hostRequest(
            `/api/spaces/${currentOwner}/schedules`,
            request.method === 'schedules.list'
              ? undefined
              : {
                  ...request.params,
                  action: request.method === 'schedules.cancel' ? 'cancel' : 'save',
                },
          );
          reply(response);
          return;
        } else if (request.method.startsWith('notifications.')) {
          const value = await hostRequest(
            `/api/spaces/${currentOwner}/notifications`,
            request.method === 'notifications.list'
              ? undefined
              : {
                  ...request.params,
                  action: request.method === 'notifications.cancel' ? 'cancel' : 'send',
                },
          );
          reply(value);
          window.dispatchEvent(new Event('notifications-changed'));
          return;
        }
        if (request.method === 'diagnostics.report') {
          const response = await fetch(`/api/applets/${currentId}/diagnostics`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(request.params),
          });
          reply(
            response.ok
              ? { result: { logged: true } }
              : { error: 'Could not record frontend error.' },
          );
          return;
        }
        if (request.method === 'chat.open') {
          const response = await fetch(`/api/spaces/${currentOwner}/chats`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ launch: request.params }),
          });
          const value = await response.json();
          if (!response.ok) throw new Error(value.error || 'Could not open chat.');
          await goto(`/spaces/${currentOwner}/chat/${value.chat.id}`, { invalidateAll: true });
          reply({ result: { id: value.chat.id } });
          return;
        }
        if (request.method === 'photos.pick') {
          if (photoRequest) {
            reply({ error: 'A photo picker is already open.' });
            return;
          }
          const result = await new Promise((resolve) => {
            photoRequest = { owner: currentOwner, resolve };
            photoDialog.showModal();
          });
          reply(result as object);
          return;
        }
        if (request.method.startsWith('photos.')) {
          const method = request.method;
          const path =
            method === 'photos.get'
              ? `photos/${encodeURIComponent(String(request.params?.id))}?data=1`
              : method === 'photos.list'
                ? 'photos'
                : 'vision';
          const response = await fetch(
            `/api/spaces/${currentOwner}/${path}`,
            method === 'photos.analyze'
              ? {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    photoIds: request.params?.photoIds,
                    prompt: request.params?.prompt,
                    format: request.params?.format || 'text',
                    model: localStorage.getItem('little-spaces-model') || undefined,
                  }),
                }
              : {},
          );
          const value = await response.json();
          reply(
            response.ok
              ? {
                  result:
                    method === 'photos.list'
                      ? value.photos
                      : method === 'photos.get'
                        ? value
                        : value.result,
                }
              : { error: value.error || 'Photo operation failed.' },
          );
          return;
        }
        const value = await hostRequest(
          `/api/applets/${currentId}/${request.method === 'action' ? 'actions' : 'records'}`,
          request.method === 'list'
            ? undefined
            : request.method === 'action'
              ? { action: request.params?.action, input: request.params?.input }
              : { method: request.method, key: request.params?.key, value: request.params?.value },
        );
        reply(value);
      } catch (e) {
        reply({ error: e instanceof Error ? e.message : 'Could not reach the app.' });
      } finally {
        inFlight--;
      }
    }
    window.addEventListener('message', handle);
    return () => {
      cancelPhoto();
      window.removeEventListener('message', handle);
    };
  });
</script>

{#if loading}<div class="frame-status">Opening your applet…</div>
{:else if error}<div class="frame-status" role="alert">{error}</div>
{:else}<iframe
    bind:this={frame}
    title="Your applet"
    srcdoc={document}
    sandbox="allow-scripts allow-forms"
    referrerpolicy="no-referrer"
  ></iframe>{/if}

<dialog
  class="host-photo-modal"
  bind:this={photoDialog}
  aria-label="Add a photo"
  oncancel={(event) => {
    event.preventDefault();
    cancelPhoto();
  }}
>
  <header class="picker-header">
    <div>
      <h2>Add a photo</h2>
      <p>Choose a file, or use your device’s camera.</p>
    </div>
    <button class="icon-button" aria-label="Close photo picker" onclick={cancelPhoto}
      ><Icon name="close" /></button
    >
  </header>
  {#if photoRequest}{@const pending = photoRequest}
    <div class="host-photo-body">
      <PhotoPicker spaceId={pending.owner} onpicked={(photo) => void acceptPhoto(photo, pending)} />
      <p class="muted">
        JPEG, PNG or WebP · up to 8 MB. Camera capture depends on your device. Photos stay local
        until you send them to AI.
      </p>
    </div>{/if}
</dialog>

<style>
  iframe {
    width: 100%;
    height: 100%;
    min-height: 100%;
    display: block;
    border: 0;
    background: white;
  }
  .frame-status {
    padding: 40px;
    color: #667085;
  }
</style>
