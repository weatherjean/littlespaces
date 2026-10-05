import webpush from 'web-push';
import { workspace } from './database';
import { listNotifications } from './notifications';
import { createHash } from 'node:crypto';

function vapid() {
  return workspace((db) => {
    const row = db.prepare("SELECT value FROM settings WHERE key='vapid'").get();
    if (row) return JSON.parse(String(row.value)) as { publicKey: string; privateKey: string };
    const keys = webpush.generateVAPIDKeys();
    db.prepare("INSERT INTO settings(key,value) VALUES('vapid',?)").run(JSON.stringify(keys));
    return keys;
  });
}
export function pushPublicKey() {
  return vapid().publicKey;
}
export function validateSubscription(value: unknown): webpush.PushSubscription {
  const subscription = value as webpush.PushSubscription;
  if (
    !subscription ||
    typeof subscription.endpoint !== 'string' ||
    subscription.endpoint.length > 4096
  )
    throw Error('Invalid push subscription.');
  const url = new URL(subscription.endpoint);
  // Only browser push providers; prevents turning subscription delivery into arbitrary server requests.
  const hosts = [
    'fcm.googleapis.com',
    'updates.push.services.mozilla.com',
    'updates-autopush.stage.mozaws.net',
    'web.push.apple.com',
  ];
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !hosts.includes(url.hostname)
  )
    throw Error('Unsupported push provider.');
  if (
    !subscription.keys ||
    !/^[A-Za-z0-9_-]{87}={0,2}$/.test(subscription.keys.p256dh) ||
    !/^[A-Za-z0-9_-]{22}={0,2}$/.test(subscription.keys.auth)
  )
    throw Error('Invalid push keys.');
  return { endpoint: subscription.endpoint, keys: subscription.keys };
}
export function subscribePush(value: unknown) {
  const subscription = validateSubscription(value);
  workspace((db) => {
    if (
      Number(db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get()!.n) >= 20 &&
      !db
        .prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?')
        .get(subscription.endpoint)
    )
      throw Error('Device limit reached.');
    db.prepare(
      'INSERT INTO push_subscriptions(endpoint,subscription,created_at) VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription',
    ).run(subscription.endpoint, JSON.stringify(subscription), new Date().toISOString());
  });
}
export function unsubscribePush(endpoint: string) {
  workspace((db) => {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint=?').run(endpoint);
    db.prepare('DELETE FROM push_deliveries WHERE endpoint=?').run(endpoint);
  });
}
export function hasPush(endpoint: string) {
  return workspace(
    (db) => !!db.prepare('SELECT endpoint FROM push_subscriptions WHERE endpoint=?').get(endpoint),
  );
}
export async function deliverPush() {
  const subscriptions = workspace((db) => db.prepare('SELECT * FROM push_subscriptions').all());
  if (!subscriptions.length) return;
  const keys = vapid();
  for (const row of subscriptions) {
    const endpoint = String(row.endpoint);
    let attempts = 0;
    for (const notification of listNotifications().filter(
      (item) => !item.read && Date.parse(item.dueAt) >= Date.parse(String(row.created_at)),
    )) {
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([notification.title, notification.body, notification.dueAt]))
        .digest('hex');
      const delivered = workspace((db) =>
        db
          .prepare('SELECT fingerprint FROM push_deliveries WHERE endpoint=? AND notification_id=?')
          .get(endpoint, notification.id),
      );
      if (delivered?.fingerprint === fingerprint) continue;
      if (++attempts > 50) break;
      try {
        await webpush.sendNotification(
          validateSubscription(JSON.parse(String(row.subscription))),
          JSON.stringify({
            title: notification.title,
            body: Array.from(notification.body).slice(0, 500).join(''),
            href: notification.href,
            id: notification.id,
          }),
          {
            vapidDetails: {
              subject: process.env.VAPID_SUBJECT || 'mailto:owner@example.com',
              ...keys,
            },
            TTL: 86400,
            timeout: 10000,
          },
        );
        workspace((db) =>
          db
            .prepare(
              'INSERT INTO push_deliveries(endpoint,notification_id,fingerprint) VALUES(?,?,?) ON CONFLICT(endpoint,notification_id) DO UPDATE SET fingerprint=excluded.fingerprint',
            )
            .run(endpoint, notification.id, fingerprint),
        );
      } catch (e) {
        if ([404, 410].includes((e as { statusCode: number }).statusCode)) {
          unsubscribePush(endpoint);
          break;
        }
        // Retry transient failures on the next tick; never log endpoints or keys.
        break;
      }
    }
  }
}
