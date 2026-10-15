CREATE TABLE invocation_outcomes(
 invocation TEXT PRIMARY KEY REFERENCES invocations(id), request TEXT NOT NULL, outcome TEXT
);
CREATE TABLE push_attempts(
 endpoint TEXT NOT NULL REFERENCES push_subscriptions(endpoint) ON DELETE CASCADE,
 notification TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, attempts INTEGER NOT NULL, next_attempt INTEGER NOT NULL,
 last_status INTEGER, terminal INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(endpoint,notification)
);
CREATE INDEX messages_conversation ON messages(conversation);
CREATE INDEX jobs_conversation_state ON jobs(conversation,state);
CREATE INDEX jobs_state ON jobs(state);
CREATE INDEX invocations_app_state ON invocations(app,state);
CREATE INDEX external_operations_invocation ON external_operations(invocation);
CREATE INDEX revisions_app ON revisions(app);
CREATE INDEX diagnostics_revision ON diagnostics(app,revision);
CREATE INDEX releases_app ON app_releases(app);
CREATE INDEX plans_app ON release_plans(app);
CREATE INDEX schedules_due ON schedules(enabled,next_run);
PRAGMA user_version=5;
