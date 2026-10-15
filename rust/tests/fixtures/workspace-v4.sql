-- Frozen prerelease workspace-v4 fixture. Do not update when the current schema changes.
PRAGMA application_id = 1280528978;
PRAGMA user_version = 4;
CREATE TABLE apps(id TEXT PRIMARY KEY, title TEXT NOT NULL, published_revision TEXT,
    record_version INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(id,published_revision) REFERENCES revisions(app,id));
CREATE TABLE drafts(id TEXT PRIMARY KEY, app TEXT NOT NULL REFERENCES apps(id), version INTEGER NOT NULL, code TEXT NOT NULL);
CREATE TABLE revisions(id TEXT PRIMARY KEY, app TEXT NOT NULL REFERENCES apps(id), digest TEXT NOT NULL, code TEXT NOT NULL, UNIQUE(app,id));
CREATE TABLE revision_tests(revision TEXT PRIMARY KEY REFERENCES revisions(id), digest TEXT NOT NULL);
CREATE TABLE records(app TEXT NOT NULL REFERENCES apps(id), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(app,key));
CREATE TABLE conversations(id TEXT PRIMARY KEY, app TEXT REFERENCES apps(id), title TEXT NOT NULL DEFAULT 'Conversation');
CREATE TABLE authoring_sessions(conversation TEXT PRIMARY KEY REFERENCES conversations(id), draft TEXT NOT NULL REFERENCES drafts(id), approved INTEGER NOT NULL CHECK(approved IN (0,1)), base_revision TEXT REFERENCES revisions(id));
CREATE TABLE messages(id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), payload TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, app TEXT REFERENCES apps(id), conversation TEXT REFERENCES conversations(id), state TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE schedules(id TEXT PRIMARY KEY, app TEXT NOT NULL, revision TEXT NOT NULL, action TEXT NOT NULL, input TEXT NOT NULL, expression TEXT NOT NULL, next_run INTEGER NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY(app,revision) REFERENCES revisions(app,id));
CREATE TABLE secrets(name TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL);
CREATE TABLE owner_auth(id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0, locked_until INTEGER NOT NULL DEFAULT 0);
CREATE TABLE owner_sessions(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, csrf TEXT NOT NULL);
CREATE TABLE chatgpt_auth(id INTEGER PRIMARY KEY CHECK(id=1), ciphertext BLOB NOT NULL);
CREATE TABLE invocations(id TEXT PRIMARY KEY, app TEXT NOT NULL, revision TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL,
    FOREIGN KEY(app,revision) REFERENCES revisions(app,id));
CREATE TABLE external_operations(id TEXT PRIMARY KEY, invocation TEXT NOT NULL REFERENCES invocations(id), method TEXT NOT NULL, state TEXT NOT NULL, status INTEGER);
CREATE TABLE external_resolutions(operation TEXT PRIMARY KEY REFERENCES external_operations(id), decision TEXT NOT NULL CHECK(decision IN ('applied','not_applied','accept_unknown')));
CREATE TABLE host_identity(id INTEGER PRIMARY KEY CHECK(id=1), host_id TEXT NOT NULL);
CREATE TABLE diagnostics(id TEXT PRIMARY KEY, app TEXT NOT NULL REFERENCES apps(id), revision TEXT NOT NULL REFERENCES revisions(id), payload TEXT NOT NULL);
CREATE TABLE agent_calls(job TEXT NOT NULL REFERENCES jobs(id), call_id TEXT NOT NULL, state TEXT NOT NULL, payload TEXT, PRIMARY KEY(job,call_id));
CREATE TABLE frontend_checks(revision TEXT PRIMARY KEY REFERENCES revisions(id), digest TEXT NOT NULL, report TEXT NOT NULL);
CREATE TABLE uploads(id TEXT PRIMARY KEY, name TEXT NOT NULL, media_type TEXT NOT NULL, size INTEGER NOT NULL);
CREATE TABLE chatgpt_registration(id INTEGER PRIMARY KEY CHECK(id=1), subject TEXT NOT NULL, client_id TEXT NOT NULL, email TEXT);

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

CREATE TABLE IF NOT EXISTS archived_apps (
 app TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
 archived_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_identity (
 app TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
 emoji TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS app_images (
 app TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 image TEXT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
 PRIMARY KEY(app,image)
);

CREATE TABLE IF NOT EXISTS app_releases(
 id TEXT PRIMARY KEY, app TEXT NOT NULL REFERENCES apps(id), revision TEXT NOT NULL REFERENCES revisions(id),
 previous_revision TEXT, before_records TEXT NOT NULL, before_sqlite BLOB NOT NULL,
 after_records TEXT NOT NULL, after_sqlite BLOB NOT NULL, metadata TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS release_plans(
 id TEXT PRIMARY KEY, app TEXT NOT NULL REFERENCES apps(id), conversation TEXT REFERENCES conversations(id),
 revision TEXT NOT NULL REFERENCES revisions(id), base_revision TEXT, data_version INTEGER NOT NULL,
 draft TEXT, draft_version INTEGER, records TEXT NOT NULL, sqlite BLOB NOT NULL,
 report TEXT NOT NULL, needs_approval INTEGER NOT NULL, applied_release TEXT REFERENCES app_releases(id), created_at INTEGER NOT NULL
);

CREATE TABLE app_sqlite(app TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,image BLOB NOT NULL);
CREATE TABLE agent_checkpoints(job TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,payload TEXT NOT NULL);
CREATE TABLE model_request_events(id INTEGER PRIMARY KEY,job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,payload TEXT NOT NULL);
CREATE INDEX model_request_events_job ON model_request_events(job,id);
