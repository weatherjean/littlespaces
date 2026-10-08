use super::*;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};
pub type Records = BTreeMap<String, Value>;
#[derive(Clone)]
pub struct Store {
    path: PathBuf,
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub app: AppId,
    pub revision: Option<RevisionId>,
    pub version: i64,
    pub records: Records,
}
impl Store {
    pub fn create(path: &Path) -> Result<Self> {
        if path.exists() {
            let db = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let marker: i64 = db.query_row("PRAGMA application_id", [], |r| r.get(0))?;
            let version: i64 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
            if marker != 1280528978 || version != 4 {
                return Err(Error::Storage);
            }
        } else {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            options.open(path).map_err(|_| Error::Storage)?;
            let mut db = Connection::open(path)?;
            db.pragma_update(None, "foreign_keys", true)?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(include_str!("schema.sql"))?;
            tx.commit()?;
        }
        Ok(Self { path: path.into() })
    }
    pub(crate) fn open(&self) -> Result<Connection> {
        let db = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_WRITE)?;
        db.busy_timeout(Duration::from_millis(250))?;
        db.pragma_update(None, "foreign_keys", true)?;
        Ok(db)
    }
    pub fn create_app(&self, title: &str) -> Result<AppId> {
        if title.is_empty() || title.len() > 200 {
            return Err(Error::Validation);
        }
        let app = AppId::new();
        self.open()?.execute(
            "INSERT INTO apps(id,title) VALUES(?,?)",
            params![app.0, title],
        )?;
        Ok(app)
    }
    pub fn create_draft(&self, app: &AppId, code: AppCode) -> Result<Draft> {
        code.validate()?;
        let draft = Draft {
            id: DraftId::new(),
            app: app.clone(),
            version: 1,
            code,
        };
        self.open()?.execute(
            "INSERT INTO drafts VALUES(?,?,?,?)",
            params![draft.id.0, app.0, 1, encode(&draft.code)?],
        )?;
        Ok(draft)
    }
    pub fn draft(&self, app: &AppId, id: &DraftId) -> Result<Draft> {
        let (version, code): (i64, String) = self
            .open()?
            .query_row(
                "SELECT version,code FROM drafts WHERE app=? AND id=?",
                params![app.0, id.0],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        Ok(Draft {
            id: id.clone(),
            app: app.clone(),
            version,
            code: serde_json::from_str(&code).map_err(|_| Error::Storage)?,
        })
    }
    pub fn edit_draft(&self, id: &DraftId, expected: i64, code: AppCode) -> Result<()> {
        code.validate()?;
        if self.open()?.execute(
            "UPDATE drafts SET version=version+1,code=? WHERE id=? AND version=?",
            params![encode(&code)?, id.0, expected],
        )? != 1
        {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub fn freeze_draft(&self, id: &DraftId, expected: i64) -> Result<Revision> {
        let mut db = self.open()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (app, version, code): (String, i64, String) = tx
            .query_row(
                "SELECT app,version,code FROM drafts WHERE id=?",
                [&id.0],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        if version != expected {
            return Err(Error::Conflict);
        }
        let code: AppCode = serde_json::from_str(&code).map_err(|_| Error::Storage)?;
        let revision = Revision {
            id: RevisionId::new(),
            app: AppId(app),
            digest: code.digest()?,
            code,
        };
        tx.execute(
            "INSERT INTO revisions VALUES(?,?,?,?)",
            params![
                revision.id.0,
                revision.app.0,
                revision.digest,
                encode(&revision.code)?
            ],
        )?;
        tx.commit()?;
        Ok(revision)
    }
    pub fn revision(&self, app: &AppId, id: &RevisionId) -> Result<Revision> {
        let (digest, code): (String, String) = self
            .open()?
            .query_row(
                "SELECT digest,code FROM revisions WHERE app=? AND id=?",
                params![app.0, id.0],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let code: AppCode = serde_json::from_str(&code).map_err(|_| Error::Storage)?;
        if code.digest()? != digest {
            return Err(Error::Storage);
        }
        Ok(Revision {
            app: app.clone(),
            id: id.clone(),
            digest,
            code,
        })
    }
    pub(crate) fn tested(&self, revision: &Revision) -> Result<()> {
        self.open()?.execute(
            "INSERT OR REPLACE INTO revision_tests VALUES(?,?)",
            params![revision.id.0, revision.digest],
        )?;
        Ok(())
    }
    pub fn publish(
        &self,
        app: &AppId,
        id: &RevisionId,
        expected: Option<&RevisionId>,
    ) -> Result<()> {
        let mut db = self.open()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Self::publish_in(&tx, app, id, expected)?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn publish_in(
        tx: &rusqlite::Transaction<'_>,
        app: &AppId,
        id: &RevisionId,
        expected: Option<&RevisionId>,
    ) -> Result<()> {
        let code: String = tx
            .query_row(
                "SELECT code FROM revisions WHERE app=? AND id=?",
                params![app.0, id.0],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let code: AppCode = serde_json::from_str(&code).map_err(|_| Error::Storage)?;
        if !code.frontend.is_empty() {
            let verified:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM frontend_checks f JOIN revisions r ON r.id=f.revision AND r.digest=f.digest WHERE r.id=?)",[&id.0],|r|r.get(0))?;
            if !verified {
                return Err(Error::Untested);
            }
        }
        let tested: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM revisions r JOIN revision_tests t ON t.revision=r.id AND t.digest=r.digest WHERE r.app=? AND r.id=?)", params![app.0,id.0], |r| r.get(0))?;
        if !tested {
            return Err(Error::Untested);
        }
        if tx.execute(
            "UPDATE apps SET published_revision=? WHERE id=? AND published_revision IS ?",
            params![id.0, app.0, expected.map(|v| &v.0)],
        )? != 1
        {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    pub fn snapshot(&self, app: &AppId) -> Result<Snapshot> {
        let mut db = self.open()?;
        let tx = db.transaction()?;
        let (revision, version): (Option<String>, i64) = tx
            .query_row(
                "SELECT published_revision,record_version FROM apps WHERE id=?",
                [&app.0],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        let mut records = Records::new();
        {
            let mut statement =
                tx.prepare("SELECT key,value FROM records WHERE app=? ORDER BY key")?;
            for row in statement.query_map([&app.0], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })? {
                let (k, v) = row?;
                records.insert(k, serde_json::from_str(&v).map_err(|_| Error::Storage)?);
            }
        }
        validate_records(&records)?;
        tx.commit()?;
        Ok(Snapshot {
            app: app.clone(),
            revision: revision.map(RevisionId),
            version,
            records,
        })
    }
    pub(crate) fn commit(
        &self,
        before: &Snapshot,
        after: &Records,
        check: impl Fn() -> Result<()>,
    ) -> Result<()> {
        validate_records(after)?;
        let mut db = self.open()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if tx.execute("UPDATE apps SET record_version=record_version+1 WHERE id=? AND record_version=? AND published_revision IS ?",params![before.app.0,before.version,before.revision.as_ref().map(|r| &r.0)])? != 1 { return Err(Error::Conflict); }
        for key in before.records.keys().filter(|k| !after.contains_key(*k)) {
            tx.execute(
                "DELETE FROM records WHERE app=? AND key=?",
                params![before.app.0, key],
            )?;
        }
        for (key, value) in after
            .iter()
            .filter(|(k, v)| before.records.get(*k) != Some(*v))
        {
            tx.execute("INSERT INTO records VALUES(?,?,?) ON CONFLICT(app,key) DO UPDATE SET value=excluded.value",params![before.app.0,key,value.to_string()])?;
        }
        check()?;
        tx.commit()?;
        Ok(())
    }
}
pub fn validate_records(records: &Records) -> Result<()> {
    if records.len() > 512
        || records
            .iter()
            .any(|(k, v)| k.is_empty() || k.len() > 64 || v.to_string().len() > 8192)
        || serde_json::to_vec(records)
            .map_err(|_| Error::Validation)?
            .len()
            > 256 * 1024
    {
        return Err(Error::Limit);
    }
    Ok(())
}
fn encode(v: &impl serde::Serialize) -> Result<String> {
    serde_json::to_string(v).map_err(|_| Error::Storage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn code() -> AppCode {
        AppCode {
            backend: "fn list(input) { [] }".into(),
            frontend: "".into(),
            actions: vec![ActionContract {
                name: "list".into(),
                read_only: true,
                input: json!({"type":"object"}),
                output: json!({"type":"array"}),
            }],
            tests: vec![],
            frontend_tests: vec![],
        }
    }
    #[test]
    fn revisions_drafts_publication_and_records_share_one_app() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let app = store.create_app("Tasks").unwrap();
        let draft = store.create_draft(&app, code()).unwrap();
        assert_eq!(store.edit_draft(&draft.id, 0, code()), Err(Error::Conflict));
        let rev = store.freeze_draft(&draft.id, 1).unwrap();
        assert_eq!(store.publish(&app, &rev.id, None), Err(Error::Untested));
        store.tested(&rev).unwrap();
        store.publish(&app, &rev.id, None).unwrap();
        let before = store.snapshot(&app).unwrap();
        let mut records = before.records.clone();
        records.insert("keep".into(), json!(1));
        assert_eq!(
            store.commit(&before, &records, || Err(Error::Cancelled)),
            Err(Error::Cancelled)
        );
        assert!(store.snapshot(&app).unwrap().records.is_empty());
        store.commit(&before, &records, || Ok(())).unwrap();
        assert_eq!(
            store.commit(&before, &Records::new(), || Ok(())),
            Err(Error::Conflict)
        );
        let next = store.freeze_draft(&draft.id, 1).unwrap();
        store.tested(&next).unwrap();
        store.publish(&app, &next.id, Some(&rev.id)).unwrap();
        assert_eq!(store.snapshot(&app).unwrap().records, records);
        assert_eq!(
            store.publish(&app, &rev.id, Some(&rev.id)),
            Err(Error::Conflict)
        );
    }
    #[test]
    fn competing_snapshots_have_exactly_one_winner() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let app = store.create_app("Concurrent").unwrap();
        let before = store.snapshot(&app).unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let threads: Vec<_> = (1..=2)
            .map(|n| {
                let store = store.clone();
                let before = before.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    let mut records = before.records.clone();
                    records.insert("winner".into(), json!(n));
                    store.commit(&before, &records, || Ok(()))
                })
            })
            .collect();
        barrier.wait();
        let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|r| **r == Err(Error::Conflict))
                .count(),
            1
        );
        assert_eq!(store.snapshot(&app).unwrap().records.len(), 1);
    }
    #[test]
    fn foreign_database_is_never_modified() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("foreign.sqlite");
        Connection::open(&path)
            .unwrap()
            .execute_batch("CREATE TABLE private_data(value TEXT);")
            .unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(Store::create(&path).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }
}

#[derive(Debug, serde::Serialize)]
pub struct ExternalEvidence {
    pub id: String,
    pub method: String,
    pub state: String,
    pub status: Option<u16>,
}
impl Store {
    /// No URLs, headers, request bodies or credentials appear in persisted diagnostics.
    pub fn external_evidence(
        &self,
        app: &AppId,
        invocation: &InvocationId,
    ) -> Result<Vec<ExternalEvidence>> {
        let db = self.open()?;
        let mut stmt=db.prepare("SELECT e.id,e.method,e.state,e.status FROM external_operations e JOIN invocations i ON i.id=e.invocation WHERE i.app=? AND i.id=? ORDER BY e.rowid")?;
        let rows = stmt
            .query_map(params![app.0, invocation.0], |r| {
                Ok(ExternalEvidence {
                    id: r.get(0)?,
                    method: r.get(1)?,
                    state: r.get(2)?,
                    status: r.get(3)?,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(rows)
    }
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalDecision {
    Applied,
    NotApplied,
    AcceptUnknown,
}
impl Store {
    pub(crate) fn begin_invocation(&self, request: &super::runtime::Invocation) -> Result<()> {
        let mut db = self.open()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let duplicate: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM invocations WHERE id=?)",
            [&request.id.0],
            |r| r.get(0),
        )?;
        if duplicate {
            return Err(Error::DuplicateInvocation);
        }
        // Fence overlapping live actions and unresolved writes across revisions of the same app.
        // A crash leaves 'running' intentionally blocked until the owner inspects recovery evidence.
        let blocked:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM invocations i WHERE i.app=? AND (i.state='running' OR EXISTS(SELECT 1 FROM external_operations e WHERE e.invocation=i.id AND (e.state='uncertain' OR COALESCE(e.status,0)>=300 OR i.state!='completed') AND NOT EXISTS(SELECT 1 FROM external_resolutions r WHERE r.operation=e.id))))",[&request.app.0],|r| r.get(0))?;
        if blocked {
            return Err(Error::ExternalUncertain);
        }
        tx.execute(
            "INSERT INTO invocations VALUES(?,?,?,?,'running')",
            params![
                request.id.0,
                request.app.0,
                request.revision.0,
                request.action
            ],
        )?;
        tx.commit()?;
        Ok(())
    }
    /// Authenticated owner recovery only. Agent tools and scripts cannot acknowledge effects.
    /// Even a complete response does not prove remote write semantics; retain its evidence.
    pub fn resolve_external(
        &self,
        app: &AppId,
        operation: &str,
        decision: ExternalDecision,
    ) -> Result<()> {
        let decision = match decision {
            ExternalDecision::Applied => "applied",
            ExternalDecision::NotApplied => "not_applied",
            ExternalDecision::AcceptUnknown => "accept_unknown",
        };
        let changed=self.open()?.execute("INSERT INTO external_resolutions SELECT e.id,? FROM external_operations e JOIN invocations i ON i.id=e.invocation WHERE i.app=? AND e.id=? ON CONFLICT(operation) DO UPDATE SET decision=excluded.decision",params![decision,app.0,operation])?;
        if changed != 1 {
            return Err(Error::NotFound);
        }
        Ok(())
    }
}

#[cfg(test)]
mod effect_tests {
    use super::super::runtime::{ExecutionMode, Invocation};
    use super::*;
    use serde_json::json;
    #[test]
    fn fresh_ids_cannot_replay_unresolved_effects_and_acknowledgment_preserves_evidence() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let app = store.create_app("External").unwrap();
        let code = AppCode {
            backend: "fn run(input) { [] }".into(),
            frontend: "".into(),
            actions: vec![ActionContract {
                name: "run".into(),
                read_only: false,
                input: json!({}),
                output: json!({}),
            }],
            tests: vec![],
            frontend_tests: vec![],
        };
        let draft = store.create_draft(&app, code).unwrap();
        let revision = store.freeze_draft(&draft.id, 1).unwrap();
        let mut request = Invocation {
            id: InvocationId::new(),
            app: app.clone(),
            revision: revision.id,
            action: "run".into(),
            input: json!({}),
            mode: ExecutionMode::Commit,
        };
        store.begin_invocation(&request).unwrap();
        assert_eq!(
            store.begin_invocation(&request),
            Err(Error::DuplicateInvocation)
        );
        store
            .open()
            .unwrap()
            .execute(
                "INSERT INTO external_operations VALUES('effect',?,'POST','uncertain',200)",
                [&request.id.0],
            )
            .unwrap();
        store
            .open()
            .unwrap()
            .execute(
                "UPDATE invocations SET state='failed' WHERE id=?",
                [&request.id.0],
            )
            .unwrap();
        request.id = InvocationId::new();
        assert_eq!(
            store.begin_invocation(&request),
            Err(Error::ExternalUncertain)
        );
        store
            .resolve_external(&app, "effect", ExternalDecision::AcceptUnknown)
            .unwrap();
        store.begin_invocation(&request).unwrap();
        let evidence: String = store
            .open()
            .unwrap()
            .query_row(
                "SELECT state FROM external_operations WHERE id='effect'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(evidence, "uncertain");
    }
}

impl Store {
    pub async fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce(Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let store = self.clone();
        tokio::task::spawn_blocking(move || work(store))
            .await
            .map_err(|_| Error::Storage)?
    }
}

impl Store {
    pub fn diagnostics(&self, app: &AppId, revision: &RevisionId) -> Result<Value> {
        self.revision(app, revision)?;
        let db = self.open()?;
        let mut stmt=db.prepare("SELECT payload FROM diagnostics WHERE app=? AND revision=? ORDER BY rowid DESC LIMIT 20")?;
        let rows = stmt.query_map(params![app.0, revision.0], |r| r.get::<_, String>(0))?;
        Ok(Value::Array(
            rows.map(|r| serde_json::from_str(&r?).map_err(|_| Error::Storage))
                .collect::<Result<Vec<_>>>()?,
        ))
    }
}

impl Store {
    pub fn app_effects(&self, app: &AppId) -> Result<Value> {
        let db = self.open()?;
        let mut q=db.prepare("SELECT e.id,e.invocation,i.revision,i.action,e.method,e.state,e.status FROM external_operations e JOIN invocations i ON i.id=e.invocation WHERE i.app=? AND (e.state='uncertain' OR COALESCE(e.status,0)>=300 OR i.state!='completed') AND NOT EXISTS(SELECT 1 FROM external_resolutions r WHERE r.operation=e.id) ORDER BY e.rowid DESC LIMIT 50")?;
        let rows=q.query_map([&app.0],|r|Ok(serde_json::json!({"id":r.get::<_,String>(0)?,"invocation":r.get::<_,String>(1)?,"revision":r.get::<_,String>(2)?,"action":r.get::<_,String>(3)?,"method":r.get::<_,String>(4)?,"state":r.get::<_,String>(5)?,"status":r.get::<_,Option<u16>>(6)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;
        Ok(Value::Array(rows))
    }
}
