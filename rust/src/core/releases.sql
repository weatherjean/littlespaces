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
