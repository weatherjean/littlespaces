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
