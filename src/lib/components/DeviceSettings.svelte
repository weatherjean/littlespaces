<script lang="ts">
  import { onMount } from 'svelte';
  import { request } from '$lib/client';
  type InstallEvent = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  let supported = $state(false),
    enabled = $state(false),
    busy = $state(false),
    error = $state('');
  let install = $state<InstallEvent | null>(null),
    installed = $state(false);
  let registration = $state<ServiceWorkerRegistration | null>(null),
    waiting = $state(false);
  onMount(() => {
    installed = matchMedia('(display-mode: standalone)').matches;
    supported =
      isSecureContext &&
      'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window;
    const capture = (event: Event) => {
      event.preventDefault();
      install = event as InstallEvent;
    };
    const didInstall = () => {
      installed = true;
      install = null;
    };
    window.addEventListener('beforeinstallprompt', capture);
    window.addEventListener('appinstalled', didInstall);
    let stopped = false;
    let cleanup = () => {};
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker
        .getRegistration()
        .then(async (reg) => {
          if (!reg || stopped) return;
          registration = reg;
          waiting = !!reg.waiting;
          const update = () => {
            const worker = reg.installing;
            worker?.addEventListener('statechange', () => {
              waiting = !!reg.waiting;
            });
          };
          reg.addEventListener('updatefound', update);
          cleanup = () => reg.removeEventListener('updatefound', update);
          if (supported) {
            const subscription = await reg.pushManager.getSubscription();
            if (subscription)
              enabled =
                (
                  await request('/api/settings/push', {
                    action: 'status',
                    endpoint: subscription.endpoint,
                  })
                ).enabled && Notification.permission === 'granted';
          }
        })
        .catch(() => {
          error = 'Could not check device notification status.';
        });
    return () => {
      stopped = true;
      cleanup();
      window.removeEventListener('beforeinstallprompt', capture);
      window.removeEventListener('appinstalled', didInstall);
    };
  });
  async function toggle() {
    busy = true;
    error = '';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg?.active)
        throw Error('Open the production app and reload once before enabling notifications.');
      let subscription = await reg.pushManager.getSubscription();
      if (enabled) {
        if (subscription) {
          await request('/api/settings/push', {
            action: 'disable',
            endpoint: subscription.endpoint,
          });
          await subscription.unsubscribe();
        }
        enabled = false;
      } else {
        if ((await Notification.requestPermission()) !== 'granted')
          throw Error('Notifications are blocked. Allow them in your browser’s site settings.');
        const { publicKey } = await request('/api/settings/push');
        subscription ||= await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: publicKey,
        });
        await request('/api/settings/push', { subscription: subscription.toJSON() });
        enabled = true;
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not update notifications.';
    } finally {
      busy = false;
    }
  }
  async function installApp() {
    if (!install) return;
    try {
      await install.prompt();
      await install.userChoice;
      install = null;
    } catch {
      error = 'Use your browser menu to install this app.';
    }
  }
  function updateApp() {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
      once: true,
    });
    registration?.waiting?.postMessage({ type: 'SKIP_WAITING' });
  }
</script>

<section class="setting-card">
  <div>
    <h3>Install LittleSpaces</h3>
    <p>
      {installed
        ? 'Installed.'
        : 'Install from your browser menu. On iOS: Share → Add to Home Screen.'}
    </p>
  </div>
  {#if install}<button class="secondary-button" onclick={installApp}>Install app</button>{/if}
  {#if waiting}<button class="secondary-button" onclick={updateApp}>Update and reload</button>{/if}
</section>
<section class="setting-card">
  <div>
    <h3>Device notifications</h3>
    <p>Reminders and reply-ready alerts on this device. Requires the server to stay running.</p>
    {#if !supported}<p>
        Unavailable here. Use a supported browser over HTTPS. On iOS, open the installed app.
      </p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
  <button class="secondary-button" disabled={!supported || busy} onclick={toggle}
    >{busy ? 'Updating…' : enabled ? 'Disable notifications' : 'Enable notifications'}</button
  >
</section>
