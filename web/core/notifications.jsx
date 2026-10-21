import { h, Fragment } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from './ui.jsx';

export function Notifications({ api, attempt, navigate }) {
  const [items, setItems] = useState([]);
  const refresh = () => api('/api/notifications').then(setItems);
  useEffect(() => {
    let active = true;
    const load = () =>
      api('/api/notifications')
        .then((v) => active && setItems(v))
        .catch(() => {});
    load();
    const timer = setInterval(load, 15000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const unreadItems = items.filter((n) => !n.read);
  const unread = unreadItems.length;
  return (
    <section class="home-notifications" aria-labelledby="notifications-title">
      <div class="apps-heading">
        <h2 id="notifications-title">Notifications</h2>
        {unread > 0 && <span aria-label={`${unread} unread`}>{unread} unread</span>}
      </div>
      <div class="notification-list">
        {unread === 0 ? (
          <p>You’re all caught up.</p>
        ) : (
          <Fragment>
            <button
              class="secondary-button"
              disabled={!unread}
              onClick={() =>
                attempt(async () => {
                  await api('/api/notifications', { all: true });
                  await refresh();
                })
              }
            >
              Mark all read
            </button>
            {unreadItems.map((n) => (
              <button
                key={n.id}
                class="notification-card"
                onClick={() =>
                  attempt(async () => {
                    await api('/api/notifications', { id: n.id });
                    await refresh();
                    navigate(n.href);
                  })
                }
              >
                {!n.read && <span aria-label="Unread">• </span>}
                <strong>{n.title}</strong>
                <p>{n.body}</p>
              </button>
            ))}
          </Fragment>
        )}
      </div>
    </section>
  );
}
export function PushSettings({ api }) {
  const supported =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [delivery, setDelivery] = useState(null);
  useEffect(() => {
    api('/api/settings/push')
      .then((v) => setDelivery(v.delivery))
      .catch(() => {});
  }, []);
  const [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const registration = async () => {
    const reg = await navigator.serviceWorker.register('/service-worker.js');
    if (reg.active) return reg;
    return Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error('Offline support is still starting. Try again.')), 10000),
      ),
    ]);
  };
  const serverKey = async () => {
    const { publicKey } = await api('/api/settings/push');
    return Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (c) =>
      c.charCodeAt(0),
    );
  };
  const matchesKey = (sub, key) => {
    const current = new Uint8Array(sub?.options?.applicationServerKey || []);
    return current.length === key.length && current.every((value, index) => value === key[index]);
  };
  useEffect(() => {
    let active = true;
    // No subscription can be usable before permission is granted. Avoid
    // probing the native push service while simply opening Settings.
    if (supported && Notification.permission === 'granted')
      (async () => {
        const sub = await (await registration()).pushManager.getSubscription();
        if (!sub) return;
        if (!matchesKey(sub, await serverKey())) {
          if (active)
            setMessage('Enable notifications to reconnect this device to this workspace.');
          return;
        }
        await api('/api/settings/push', { subscription: sub.toJSON() });
        if (active) setEnabled(true);
      })().catch((e) => active && setMessage(e.message));
    return () => {
      active = false;
    };
  }, []);
  const toggle = async () => {
    setBusy(true);
    setMessage('');
    try {
      // Ask directly from the click, before network work, for Safari user activation.
      const permission = !enabled ? await Notification.requestPermission() : 'granted';
      if (permission !== 'granted')
        throw Error(
          'Notifications are blocked. Allow them in your browser settings to enable updates.',
        );
      const reg = await registration();
      let old = await reg.pushManager.getSubscription();
      if (enabled) {
        if (old) {
          await api('/api/settings/push', { enabled: false, endpoint: old.endpoint });
          await old.unsubscribe();
        }
        setEnabled(false);
      } else {
        const key = await serverKey();
        if (old && !matchesKey(old, key)) {
          await api('/api/settings/push', { enabled: false, endpoint: old.endpoint });
          await old.unsubscribe();
          old = null;
        }
        const sub =
          old ||
          (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
        try {
          await api('/api/settings/push', { subscription: sub.toJSON() });
        } catch (e) {
          if (!old) await sub.unsubscribe();
          throw e;
        }
        setEnabled(true);
      }
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="setting-card setting-section notification-settings">
      <div class="setting-section-heading">
        <span class="setting-icon">
          <Icon name="bell" size={24} />
        </span>
        <div>
          <h3>Notifications</h3>
          {delivery && (delivery.retrying > 0 || delivery.failed > 0) && (
            <p role="status">
              {delivery.retrying} deliveries retrying · {delivery.failed} failed. Your inbox keeps
              these updates.
            </p>
          )}
          <p>
            {supported
              ? 'Replies and reminders, even when the app is closed.'
              : 'On iPhone or iPad, add LittleSpaces to your Home Screen to enable push.'}
          </p>
        </div>
      </div>
      <div class="setting-section-body notification-settings-body">
        <div class="notification-status">
          <span class={`status-dot${enabled ? ' enabled' : ''}`} />
          <span>
            {enabled
              ? 'On for this device'
              : supported
                ? 'Off for this device'
                : 'Unavailable in this browser'}
          </span>
        </div>
        <div class="setting-actions">
          <button class="secondary-button" disabled={!supported || busy} onClick={toggle}>
            {enabled ? 'Disable notifications' : 'Enable notifications'}
          </button>
          {enabled && (
            <button
              class="secondary-button"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api('/api/settings/push/test', {});
                  setMessage('Test notification queued. It should arrive shortly.');
                } catch (e) {
                  setMessage(e.message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Send test notification
            </button>
          )}
        </div>
        {message && (
          <p class="notification-feedback" role="status">
            {message}
          </p>
        )}
      </div>
    </section>
  );
}
