CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, app TEXT REFERENCES apps(id), key TEXT NOT NULL,
 title TEXT NOT NULL, body TEXT NOT NULL, href TEXT NOT NULL,
 due_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
 is_read INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(app,key)
);
CREATE TABLE IF NOT EXISTS push_identity (id INTEGER PRIMARY KEY CHECK(id=1), ciphertext BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS push_subscriptions (
 endpoint TEXT PRIMARY KEY, ciphertext BLOB NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS push_deliveries (
 endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
 notification TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, PRIMARY KEY(endpoint,notification)
);
CREATE INDEX IF NOT EXISTS notifications_due ON notifications(is_read,due_at);
