PRAGMA application_id = 1280528978;
PRAGMA user_version = 1;
CREATE TABLE apps(id TEXT PRIMARY KEY, title TEXT NOT NULL, published_revision TEXT,
    record_version INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY(id,published_revision) REFERENCES revisions(app,id));
CREATE TABLE drafts(id TEXT PRIMARY KEY, app TEXT NOT NULL REFERENCES apps(id), version INTEGER NOT NULL, code TEXT NOT NULL);
CREATE TABLE revisions(id TEXT PRIMARY KEY, app TEXT NOT NULL REFERENCES apps(id), digest TEXT NOT NULL, code TEXT NOT NULL, UNIQUE(app,id));
CREATE TABLE revision_tests(revision TEXT PRIMARY KEY REFERENCES revisions(id), digest TEXT NOT NULL);
CREATE TABLE records(app TEXT NOT NULL REFERENCES apps(id), key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(app,key));
CREATE TABLE conversations(id TEXT PRIMARY KEY, app TEXT REFERENCES apps(id));
CREATE TABLE messages(id TEXT PRIMARY KEY, conversation TEXT NOT NULL REFERENCES conversations(id), payload TEXT NOT NULL);
CREATE TABLE jobs(id TEXT PRIMARY KEY, app TEXT REFERENCES apps(id), conversation TEXT REFERENCES conversations(id), state TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE schedules(id TEXT PRIMARY KEY, app TEXT NOT NULL, revision TEXT NOT NULL, action TEXT NOT NULL, input TEXT NOT NULL, expression TEXT NOT NULL,
    FOREIGN KEY(app,revision) REFERENCES revisions(app,id));
CREATE TABLE secrets(name TEXT PRIMARY KEY, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL);
CREATE TABLE owner_auth(id INTEGER PRIMARY KEY CHECK(id=1), password_hash TEXT NOT NULL);
CREATE TABLE owner_sessions(id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE TABLE chatgpt_auth(id INTEGER PRIMARY KEY CHECK(id=1), ciphertext BLOB NOT NULL);
CREATE TABLE invocations(id TEXT PRIMARY KEY, app TEXT NOT NULL, revision TEXT NOT NULL, action TEXT NOT NULL, state TEXT NOT NULL,
    FOREIGN KEY(app,revision) REFERENCES revisions(app,id));
CREATE TABLE external_operations(id TEXT PRIMARY KEY, invocation TEXT NOT NULL REFERENCES invocations(id), method TEXT NOT NULL, state TEXT NOT NULL, status INTEGER);
