//! Version-bound release plans. SQL runs on isolated app images, never on workspace tables.
use super::{
    control::Control,
    http::MockHttp,
    store::{Records, Snapshot},
    *,
};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeMap, time::Duration};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedData {
    pub release: String,
    #[serde(default)]
    pub before: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub sql: String,
    #[serde(default = "empty_params")]
    pub params: Value,
}
fn empty_params() -> Value {
    json!([])
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Probe {
    pub action: String,
    pub input: Value,
    pub expected: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub revision: RevisionId,
    #[serde(default)]
    pub source: Option<SavedData>,
    #[serde(default)]
    pub records: BTreeMap<String, Option<Value>>,
    #[serde(default)]
    pub sql: Vec<Query>,
    #[serde(default)]
    pub probes: Vec<Probe>,
}
fn control(cancel: Cancellation) -> Control {
    Control::new(cancel, Duration::from_secs(60))
}
impl Store {
    pub fn releases(&self, app: &AppId) -> Result<Value> {
        let db = self.open()?;
        let mut q = db.prepare("SELECT id,revision,previous_revision,metadata,created_at FROM app_releases WHERE app=? ORDER BY rowid DESC")?;
        let rows = q
            .query_map([&app.0], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, i64>(4)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter().map(|(id,revision,previous,report,at)| Ok(json!({"id":id,"revision":revision,"previousRevision":previous,"report":serde_json::from_str::<Value>(&report).map_err(|_|Error::Storage)?,"createdAt":at}))).collect::<Result<Vec<_>>>().map(|v|json!(v))
    }
    pub(crate) fn saved_data(&self, app: &AppId, source: &SavedData) -> Result<(Records, Vec<u8>)> {
        let sql = if source.before {
            "SELECT before_records,before_sqlite FROM app_releases WHERE app=? AND id=?"
        } else {
            "SELECT after_records,after_sqlite FROM app_releases WHERE app=? AND id=?"
        };
        let (records, sqlite): (String, Vec<u8>) = self
            .open()?
            .query_row(sql, params![app.0, source.release], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .optional()?
            .ok_or(Error::NotFound)?;
        Ok((
            serde_json::from_str(&records).map_err(|_| Error::Storage)?,
            sqlite,
        ))
    }
    pub fn inspect_data(
        &self,
        app: &AppId,
        source: Option<SavedData>,
        query: Option<Query>,
    ) -> Result<Value> {
        let (records, sqlite) = if let Some(source) = source {
            self.saved_data(app, &source)?
        } else {
            let s = self.snapshot(app)?;
            (s.records, s.sqlite)
        };
        let bytes = sqlite.len();
        let inspection = query.is_some();
        let result = worker::sql(
            worker::SqlRequest::Inspect { sqlite, query },
            &control(Cancellation::default()),
        )?;
        if inspection {
            return Ok(result.report);
        }
        Ok(json!({"records":records,"schema":result.report,"sqliteBytes":bytes}))
    }

    pub fn release_plans(&self, app: &AppId) -> Result<Value> {
        let db = self.open()?;
        let mut q=db.prepare("SELECT id,report,needs_approval,applied_release,data_version,(data_version=(SELECT record_version FROM apps WHERE id=p.app) AND base_revision IS (SELECT published_revision FROM apps WHERE id=p.app)) FROM release_plans p WHERE app=? ORDER BY rowid DESC LIMIT 32")?;
        let rows = q
            .query_map([&app.0], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, bool>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, i64>(4)?,
                    r.get::<_, bool>(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        rows.into_iter().map(|(id,report,approval,applied,version,current)|Ok(json!({"id":id,"report":serde_json::from_str::<Value>(&report).map_err(|_|Error::Storage)?,"needsApproval":approval,"appliedRelease":applied,"dataVersion":version,"current":current}))).collect::<Result<Vec<_>>>().map(|v|json!(v))
    }
    /// Discarding a dry run never changes live code or app data.
    pub fn discard_release_plan(&self, app: &AppId, plan: &str) -> Result<()> {
        let db = self.open()?;
        if db.execute(
            "DELETE FROM release_plans WHERE id=? AND app=? AND applied_release IS NULL",
            params![plan, app.0],
        )? == 0
        {
            return Err(Error::Conflict);
        }
        Ok(())
    }
    /// Called inside every publication transaction, including legacy owner/CLI publication.
    pub(crate) fn record_release(
        tx: &rusqlite::Transaction<'_>,
        app: &AppId,
        revision: &RevisionId,
        after: Option<(&Records, &[u8])>,
        report: &Value,
    ) -> Result<String> {
        let count: i64 = tx.query_row(
            "SELECT count(*) FROM app_releases WHERE app=?",
            [&app.0],
            |r| r.get(0),
        )?;
        if count >= 64 {
            return Err(Error::Limit);
        }
        let (previous, version, title): (Option<String>, i64, String) = tx.query_row(
            "SELECT published_revision,record_version,title FROM apps WHERE id=?",
            [&app.0],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let mut records = Records::new();
        let mut q = tx.prepare("SELECT key,value FROM records WHERE app=?")?;
        for row in q.query_map([&app.0], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })? {
            let (k, v) = row?;
            records.insert(
                k,
                serde_json::from_str::<Value>(&v).map_err(|_| Error::Storage)?,
            );
        }
        let sqlite: Vec<u8> = tx
            .query_row("SELECT image FROM app_sqlite WHERE app=?", [&app.0], |r| {
                r.get(0)
            })
            .optional()?
            .unwrap_or_default();
        let (after_records, after_sqlite) = after.unwrap_or((&records, &sqlite));
        let images: Vec<String> = {
            let mut q = tx.prepare("SELECT image FROM app_images WHERE app=?")?;
            let rows = q
                .query_map([&app.0], |r| r.get(0))?
                .collect::<std::result::Result<_, _>>()?;
            drop(q);
            rows
        };
        let id = owner::token();
        tx.execute(
            "INSERT INTO app_releases VALUES(?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                app.0,
                revision.0,
                previous,
                json!(records).to_string(),
                sqlite,
                json!(after_records).to_string(),
                after_sqlite,
                json!({"validation":report,"dataVersion":version,"title":title,"images":images})
                    .to_string(),
                owner::now()
            ],
        )?;
        Ok(id)
    }
    pub fn apply_release(
        &self,
        app: &AppId,
        plan: &str,
        owner_confirmed: bool,
        cancel: Cancellation,
    ) -> Result<Value> {
        let mut db = self.open()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        type StoredPlan = (
            String,
            Option<String>,
            i64,
            Option<String>,
            Option<i64>,
            String,
            Vec<u8>,
            String,
            bool,
            Option<String>,
            Option<String>,
        );
        let (revision,base,version,draft,draft_version,records,sqlite,report,approval,applied,conversation):StoredPlan=tx.query_row("SELECT revision,base_revision,data_version,draft,draft_version,records,sqlite,report,needs_approval,applied_release,conversation FROM release_plans WHERE app=? AND id=?",params![app.0,plan],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?,r.get(7)?,r.get(8)?,r.get(9)?,r.get(10)?))).optional()?.ok_or(Error::NotFound)?;
        if let Some(release) = applied {
            return Ok(json!({"release":release,"published":revision,"alreadyApplied":true}));
        }
        if approval && !owner_confirmed {
            return Err(Error::ApprovalRequired);
        }
        let current: (Option<String>, i64) = tx.query_row(
            "SELECT published_revision,record_version FROM apps WHERE id=?",
            [&app.0],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        if current != (base.clone(), version) {
            return Err(Error::Conflict);
        }
        if let Some(draft) = draft {
            let (v, code): (i64, String) = tx.query_row(
                "SELECT version,code FROM drafts WHERE app=? AND id=?",
                params![app.0, draft],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            let digest: String = tx.query_row(
                "SELECT digest FROM revisions WHERE app=? AND id=?",
                params![app.0, revision],
                |r| r.get(0),
            )?;
            if Some(v) != draft_version
                || serde_json::from_str::<AppCode>(&code)
                    .map_err(|_| Error::Storage)?
                    .digest()?
                    != digest
            {
                return Err(Error::Conflict);
            }
        }
        let blocked:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM invocations i WHERE i.app=? AND (i.state='running' OR EXISTS(SELECT 1 FROM external_operations e WHERE e.invocation=i.id AND (e.state='uncertain' OR COALESCE(e.status,0)>=300 OR i.state!='completed') AND NOT EXISTS(SELECT 1 FROM external_resolutions r WHERE r.operation=e.id))))",[&app.0],|r|r.get(0))?;
        if blocked {
            return Err(Error::ExternalUncertain);
        }
        let revision = RevisionId(revision);
        let records: Records = serde_json::from_str(&records).map_err(|_| Error::Storage)?;
        let report: Value = serde_json::from_str(&report).map_err(|_| Error::Storage)?;
        let release =
            Self::record_release(&tx, app, &revision, Some((&records, &sqlite)), &report)?;
        Self::publish_checked_in(
            &tx,
            app,
            &revision,
            base.as_ref().map(|v| RevisionId(v.clone())).as_ref(),
        )?;
        tx.execute("DELETE FROM records WHERE app=?", [&app.0])?;
        for (k, v) in records {
            tx.execute(
                "INSERT INTO records VALUES(?,?,?)",
                params![app.0, k, v.to_string()],
            )?;
        }
        tx.execute("INSERT INTO app_sqlite VALUES(?,?) ON CONFLICT(app) DO UPDATE SET image=excluded.image",params![app.0,sqlite])?;
        tx.execute(
            "UPDATE apps SET record_version=record_version+1 WHERE id=?",
            [&app.0],
        )?;
        tx.execute(
            "UPDATE release_plans SET applied_release=? WHERE id=?",
            params![release, plan],
        )?;
        if let Some(conversation) = conversation {
            tx.execute(
                "UPDATE authoring_sessions SET base_revision=? WHERE conversation=?",
                params![revision.0, conversation],
            )?;
        }
        // An old schedule must never run against a different code contract automatically.
        tx.execute(
            "UPDATE schedules SET enabled=0 WHERE app=? AND revision!=?",
            params![app.0, revision.0],
        )?;
        let _gate = cancel.commit_gate()?;
        tx.commit()?;
        Ok(json!({"release":release,"published":revision,"dataVersion":version+1}))
    }
}
impl Runtime {
    pub async fn prepare_release(
        &self,
        app: AppId,
        plan: Plan,
        binding: Option<(ConversationId, DraftId, i64)>,
        cancel: Cancellation,
    ) -> Result<Value> {
        if plan.sql.len() > 64
            || plan.probes.len() > 32
            || serde_json::to_vec(&plan)
                .map_err(|_| Error::Validation)?
                .len()
                > 256 * 1024
        {
            return Err(Error::Limit);
        }
        let runtime = self.clone();
        let diagnostic_runtime = self.clone();
        let a = app.clone();
        let p = plan.clone();
        let c = cancel.clone();
        let (before,records,sqlite,report)=self.store.blocking(move |store| {
            let before=store.snapshot(&a)?;
            let candidate=store.revision(&a,&p.revision)?;
            let (mut records,sqlite)=if let Some(source)=&p.source { store.saved_data(&a,source)? } else { (before.records.clone(),before.sqlite.clone()) };
            for (k,v) in &p.records { if let Some(v)=v { records.insert(k.clone(),v.clone()); } else { records.remove(k); } }
            store::validate_records(&records)?;
            if !candidate.code.sqlite && !p.sql.is_empty() { return Err(Error::Validation); }
            let migrated = worker::sql(worker::SqlRequest::Migrate { before: before.sqlite.clone(), sqlite, queries: p.sql.clone() }, &control(c.clone())).inspect_err(|error| {
                diagnostic_runtime.diagnostic(&candidate,"release","migration",json!({"error":error}));
            })?;
            let preservation=migrated.report;
            let statements=migrated.statements;
            let sqlite=migrated.sqlite;
            let removed:Vec<_>=before.records.iter().filter(|(k,v)|records.get(*k)!=Some(*v)).map(|(k,_)|k.clone()).collect();
            let added:Vec<_>=records.keys().filter(|k|!before.records.contains_key(*k)).cloned().collect();
            let approval=p.source.is_some() || !removed.is_empty() || preservation["preservesData"]!=true;
            let report=json!({"revision":p.revision,"source":p.source,"removedOrChangedRecords":removed,"addedRecords":added,"sql":preservation,"statements":statements,"needsApproval":approval,"probeCount":p.probes.len(),"operations":{"sql":p.sql,"records":p.records}});
            Ok((before,records,sqlite,report))
        }).await?;
        let candidate = self.store.revision(&app, &plan.revision)?;
        let mocks = MockHttp(
            candidate
                .code
                .tests
                .iter()
                .flat_map(|t| t.http.clone())
                .collect(),
        );
        self.test_revision(
            app.clone(),
            plan.revision.clone(),
            mocks.clone(),
            cancel.clone(),
        )
        .await?;
        if !candidate.code.frontend.is_empty() {
            // Previously verified immutable revisions remain valid for code-only reversions.
            let verified: bool = self.store.open()?.query_row(
                "SELECT EXISTS(SELECT 1 FROM frontend_checks WHERE revision=? AND digest=?)",
                params![plan.revision.0, candidate.digest],
                |r| r.get(0),
            )?;
            if !verified {
                let result =
                    browser::test(self, app.clone(), plan.revision.clone(), cancel.clone()).await?;
                if result["passed"] != true {
                    return Err(Error::Untested);
                }
            }
        }
        // Exercise each read-only contract on the migrated copy with its declared test input.
        // Expected fixture outputs do not apply to live data, but schemas and execution must work.
        for action in candidate.code.actions.iter().filter(|a| a.read_only) {
            if let Some(test) = candidate
                .code
                .tests
                .iter()
                .find(|t| t.action == action.name)
            {
                runtime
                    .preview_action(
                        app.clone(),
                        plan.revision.clone(),
                        action.name.clone(),
                        test.input.clone(),
                        records.clone(),
                        sqlite.clone(),
                        mocks.clone(),
                    )
                    .await?;
            }
        }
        for probe in &plan.probes {
            let (actual, _, _) = runtime
                .preview_action(
                    app.clone(),
                    plan.revision.clone(),
                    probe.action.clone(),
                    probe.input.clone(),
                    records.clone(),
                    sqlite.clone(),
                    mocks.clone(),
                )
                .await?;
            if actual != probe.expected {
                return Err(Error::Untested);
            }
        }
        self.store
            .blocking(move |store| {
                save_plan(
                    &store, &app, &plan, &before, records, sqlite, report, binding, cancel,
                )
            })
            .await
    }
}
#[allow(clippy::too_many_arguments)]
fn save_plan(
    store: &Store,
    app: &AppId,
    plan: &Plan,
    before: &Snapshot,
    records: Records,
    sqlite: Vec<u8>,
    report: Value,
    binding: Option<(ConversationId, DraftId, i64)>,
    cancel: Cancellation,
) -> Result<Value> {
    let mut db = store.open()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current: (Option<String>, i64) = tx.query_row(
        "SELECT published_revision,record_version FROM apps WHERE id=?",
        [&app.0],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    if current
        != (
            before.revision.as_ref().map(|v| v.0.clone()),
            before.version,
        )
    {
        return Err(Error::Conflict);
    }
    // Bound storage: discard only unapplied dry runs older than the most recent 16.
    tx.execute("DELETE FROM release_plans WHERE app=? AND applied_release IS NULL AND id NOT IN (SELECT id FROM release_plans WHERE app=? ORDER BY rowid DESC LIMIT 15)",params![app.0,app.0])?;
    let id = owner::token();
    tx.execute(
        "INSERT INTO release_plans VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        params![
            id,
            app.0,
            binding.as_ref().map(|b| &b.0 .0),
            plan.revision.0,
            before.revision.as_ref().map(|r| &r.0),
            before.version,
            binding.as_ref().map(|b| &b.1 .0),
            binding.as_ref().map(|b| b.2),
            json!(records).to_string(),
            sqlite,
            report.to_string(),
            report["needsApproval"] == true,
            Option::<String>::None,
            owner::now()
        ],
    )?;
    let _gate = cancel.commit_gate()?;
    tx.commit()?;
    Ok(
        json!({"plan":id,"report":report,"dataVersion":before.version,"needsApproval":report["needsApproval"]==true}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn code() -> AppCode {
        serde_json::from_value(json!({"sqlite":true,"backend":"fn init(input) { sql_execute(\"CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body TEXT)\", []); true } fn count(input) { sql_query(\"SELECT count(*) AS n FROM notes\", [])[0].n }","frontend":"","actions":[{"name":"init","read_only":false,"input":{"type":"object"},"output":{"type":"boolean"}},{"name":"count","read_only":true,"input":{"type":"object"},"output":{"type":"integer"}}],"tests":[{"action":"init","input":{},"expected":true},{"action":"count","input":{},"expected":0}]})).unwrap()
    }
    fn sql(s: &str) -> Query {
        Query {
            sql: s.into(),
            params: json!([]),
        }
    }
    fn plan(revision: &RevisionId, sql: Vec<Query>) -> Plan {
        Plan {
            revision: revision.clone(),
            source: None,
            records: Default::default(),
            sql,
            probes: vec![],
        }
    }
    #[tokio::test]
    async fn model_can_revert_a_revision_published_before_release_tracking() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets = secrets::Secrets::open(store.clone(), &dir.path().join("key")).unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 4).unwrap();
        let app = store.create_app("Existing notes").unwrap();
        let draft = store.create_draft(&app, code()).unwrap();
        let old = store.freeze_draft(&draft.id, 1).unwrap();
        runtime
            .test_revision(
                app.clone(),
                old.id.clone(),
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        let image =
            app_sqlite::Database::open(&[], false, control(Cancellation::default())).unwrap();
        image
            .run(
                "CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT)",
                &json!([]),
                false,
            )
            .unwrap();
        let before = store.snapshot(&app).unwrap();
        store
            .commit_with_sqlite(
                &before,
                &before.records,
                &image.image().unwrap(),
                &[],
                || Ok(()),
            )
            .unwrap();
        // Simulate an existing installation that predates the release-history table.
        store
            .open()
            .unwrap()
            .execute(
                "UPDATE apps SET published_revision=? WHERE id=?",
                params![old.id.0, app.0],
            )
            .unwrap();
        let next = store.freeze_draft(&draft.id, 1).unwrap();
        let prepared = runtime
            .prepare_release(
                app.clone(),
                plan(&next.id, vec![]),
                None,
                Cancellation::default(),
            )
            .await
            .unwrap();
        store
            .apply_release(
                &app,
                prepared["plan"].as_str().unwrap(),
                false,
                Cancellation::default(),
            )
            .unwrap();
        let session = authoring::AuthoringSession::begin(runtime, &app, &draft.id, true).unwrap();
        let revert = session
            .dispatch(
                authoring::AuthoringTool::PrepareRelease {
                    plan: plan(&old.id, vec![]),
                    expected_version: None,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert!(revert["plan"].is_string());
    }
    #[tokio::test]
    async fn atomic_releases_stale_plans_restore_and_selective_preservation() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets = secrets::Secrets::open(store.clone(), &dir.path().join("key")).unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 4).unwrap();
        let app = store.create_app("Notes").unwrap();
        let draft = store.create_draft(&app, code()).unwrap();
        let v1 = store.freeze_draft(&draft.id, 1).unwrap();
        let mut first = plan(
            &v1.id,
            vec![
                sql("CREATE TABLE notes(id INTEGER PRIMARY KEY,body TEXT)"),
                sql("INSERT INTO notes VALUES(1,'old')"),
            ],
        );
        first.records.insert("kept".into(), Some(json!("original")));
        let prepared = runtime
            .prepare_release(app.clone(), first, None, Cancellation::default())
            .await
            .unwrap();
        assert_eq!(prepared["needsApproval"], false);
        assert!(store.snapshot(&app).unwrap().sqlite.is_empty());
        let released = store
            .apply_release(
                &app,
                prepared["plan"].as_str().unwrap(),
                false,
                Cancellation::default(),
            )
            .unwrap();
        let first_release = released["release"].as_str().unwrap().to_string();
        assert_eq!(
            store
                .apply_release(
                    &app,
                    prepared["plan"].as_str().unwrap(),
                    false,
                    Cancellation::default()
                )
                .unwrap()["alreadyApplied"],
            true
        );
        let v2 = store.freeze_draft(&draft.id, 1).unwrap();
        let changes = plan(
            &v2.id,
            vec![
                sql("ALTER TABLE notes ADD COLUMN tag TEXT"),
                sql("INSERT INTO notes VALUES(2,'new','work')"),
            ],
        );
        let stale = runtime
            .prepare_release(app.clone(), changes.clone(), None, Cancellation::default())
            .await
            .unwrap();
        let before = store.snapshot(&app).unwrap();
        let mut records = before.records.clone();
        records.insert("newer".into(), json!(42));
        store.commit(&before, &records, &[], || Ok(())).unwrap();
        assert_eq!(
            store
                .apply_release(
                    &app,
                    stale["plan"].as_str().unwrap(),
                    false,
                    Cancellation::default()
                )
                .unwrap_err(),
            Error::Conflict
        );
        let prepared = runtime
            .prepare_release(app.clone(), changes, None, Cancellation::default())
            .await
            .unwrap();
        assert_eq!(prepared["needsApproval"], false);
        store
            .apply_release(
                &app,
                prepared["plan"].as_str().unwrap(),
                false,
                Cancellation::default(),
            )
            .unwrap();
        let mut restore = plan(&v1.id, vec![sql("INSERT INTO notes VALUES(2,'new')")]);
        restore.source = Some(SavedData {
            release: first_release.clone(),
            before: false,
        });
        restore.records.insert("newer".into(), Some(json!(42)));
        restore.probes.push(Probe {
            action: "count".into(),
            input: json!({}),
            expected: json!(2),
        });
        let prepared = runtime
            .prepare_release(app.clone(), restore, None, Cancellation::default())
            .await
            .unwrap();
        assert_eq!(prepared["needsApproval"], true);
        assert_eq!(
            store
                .apply_release(
                    &app,
                    prepared["plan"].as_str().unwrap(),
                    false,
                    Cancellation::default()
                )
                .unwrap_err(),
            Error::ApprovalRequired
        );
        store
            .apply_release(
                &app,
                prepared["plan"].as_str().unwrap(),
                true,
                Cancellation::default(),
            )
            .unwrap();
        assert_eq!(store.snapshot(&app).unwrap().revision, Some(v1.id.clone()));
        assert_eq!(store.snapshot(&app).unwrap().records["newer"], json!(42));
        assert_eq!(
            store
                .inspect_data(&app, None, Some(sql("SELECT count(*) AS n FROM notes")))
                .unwrap(),
            json!([{"n":2}])
        );
        assert_eq!(
            store
                .inspect_data(
                    &app,
                    Some(SavedData {
                        release: first_release,
                        before: false
                    }),
                    Some(sql("SELECT count(*) AS n FROM notes"))
                )
                .unwrap(),
            json!([{"n":1}])
        );
        let deletion = runtime
            .prepare_release(
                app.clone(),
                plan(&v1.id, vec![sql("DELETE FROM notes WHERE id=2")]),
                None,
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(deletion["needsApproval"], true);
        assert_eq!(deletion["report"]["sql"]["removedOrChangedRows"], 1);
        assert_eq!(
            store
                .inspect_data(&app, None, Some(sql("SELECT count(*) AS n FROM notes")))
                .unwrap(),
            json!([{"n":2}])
        );
        let cancel = Cancellation::default();
        cancel.cancel();
        assert_eq!(
            store
                .apply_release(&app, deletion["plan"].as_str().unwrap(), true, cancel)
                .unwrap_err(),
            Error::Cancelled
        );
        assert_eq!(store.releases(&app).unwrap().as_array().unwrap().len(), 3);
        let other = store.create_app("Other").unwrap();
        assert_eq!(
            store
                .apply_release(
                    &other,
                    deletion["plan"].as_str().unwrap(),
                    true,
                    Cancellation::default()
                )
                .unwrap_err(),
            Error::NotFound
        );
        assert!(store
            .inspect_data(&app, None, Some(sql("DELETE FROM notes")))
            .is_err());
        assert!(runtime
            .prepare_release(
                app.clone(),
                plan(
                    &v1.id,
                    vec![
                        sql("INSERT INTO notes VALUES(3,'discard')"),
                        sql("INVALID SQL")
                    ]
                ),
                None,
                Cancellation::default()
            )
            .await
            .is_err());
        assert_eq!(
            store
                .inspect_data(&app, None, Some(sql("SELECT count(*) AS n FROM notes")))
                .unwrap(),
            json!([{"n":2}])
        );
        let session =
            authoring::AuthoringSession::begin(runtime.clone(), &app, &draft.id, true).unwrap();
        let bound = runtime
            .prepare_release(
                app.clone(),
                plan(&v1.id, vec![]),
                Some((session.conversation, draft.id.clone(), 1)),
                Cancellation::default(),
            )
            .await
            .unwrap();
        store.edit_draft(&draft.id, 1, code()).unwrap();
        assert_eq!(
            store
                .apply_release(
                    &app,
                    bound["plan"].as_str().unwrap(),
                    false,
                    Cancellation::default()
                )
                .unwrap_err(),
            Error::Conflict
        );
        let fenced = runtime
            .prepare_release(
                app.clone(),
                plan(&v1.id, vec![]),
                None,
                Cancellation::default(),
            )
            .await
            .unwrap();
        store
            .open()
            .unwrap()
            .execute(
                "INSERT INTO invocations VALUES('pending-effect',?,?,'init','running')",
                params![app.0, v1.id.0],
            )
            .unwrap();
        assert_eq!(
            store
                .apply_release(
                    &app,
                    fenced["plan"].as_str().unwrap(),
                    false,
                    Cancellation::default()
                )
                .unwrap_err(),
            Error::ExternalUncertain
        );
        assert_eq!(store.releases(&app).unwrap().as_array().unwrap().len(), 3);
    }
}
