use super::{
    control::{CancelOnDrop, Control},
    http::{Broker, HttpRequest, MockHttp},
    secrets::Secrets,
    store::Records,
    *,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Commit,
    DryRun,
    LiveProbe,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Invocation {
    pub id: InvocationId,
    pub app: AppId,
    pub revision: RevisionId,
    pub action: String,
    pub input: Value,
    pub mode: ExecutionMode,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Outcome {
    pub result: Value,
    pub committed: bool,
}
#[derive(Clone)]
pub struct Runtime {
    pub store: Store,
    secrets: Secrets,
    admission: Arc<tokio::sync::Semaphore>,
    pub(crate) authoring_admission: Arc<tokio::sync::Semaphore>,
    pub deadline: Duration,
    pub(crate) offline_actions: bool,
    pub browser: Option<super::browser::BrowserConfig>,
    pub(crate) previews: super::browser::Previews,
}

impl Runtime {
    pub fn new(store: Store, secrets: Secrets, slots: usize) -> Result<Self> {
        if slots == 0 || slots > 16 {
            return Err(Error::Validation);
        }
        Ok(Self {
            store,
            secrets,
            admission: Arc::new(tokio::sync::Semaphore::new(slots)),
            authoring_admission: Arc::new(tokio::sync::Semaphore::new(slots)),
            deadline: Duration::from_secs(
                std::env::var("LITTLESPACES_ACTION_TIMEOUT_SECONDS")
                    .ok()
                    .map(|s| s.parse::<u64>().map_err(|_| Error::Validation))
                    .transpose()?
                    .unwrap_or(60)
                    .clamp(1, 300),
            ),
            offline_actions: false,
            browser: None,
            previews: Default::default(),
        })
    }
    pub fn secret_names(&self) -> Result<Vec<super::secrets::SecretName>> {
        self.secrets.list()
    }
    pub(crate) async fn redact_public(&self, value: Value) -> Result<Value> {
        let secrets = self.secrets.clone();
        self.store.blocking(move |_| secrets.redact(value)).await
    }
    pub(crate) fn diagnostic(
        &self,
        revision: &Revision,
        action: &str,
        phase: &str,
        details: Value,
    ) -> Error {
        let payload = self
            .secrets
            .redact(json!({"action":action,"phase":phase,"details":details}));
        if let Ok(payload) = payload {
            let _ = self.store.open().and_then(|db| {
                db.execute(
                    "INSERT INTO diagnostics VALUES(?,?,?,?)",
                    rusqlite::params![
                        format!("{:032x}", rand::random::<u128>()),
                        revision.app.0,
                        revision.id.0,
                        payload.to_string()
                    ],
                )?;
                Ok(())
            });
        }
        if phase == "compile" || phase == "script" {
            Error::Script
        } else {
            Error::Validation
        }
    }
    /// Every caller (UI/chat/schedule/dry run) supplies an immutable revision and unique invocation.
    pub async fn invoke(
        &self,
        request: Invocation,
        mock: MockHttp,
        cancel: Cancellation,
    ) -> Result<Outcome> {
        let permit = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Saturated)?;
        let control = Control::new(cancel.clone(), self.deadline);
        let mut guard = CancelOnDrop(Some(cancel));
        let runtime = self.clone();
        let handle = tokio::runtime::Handle::current();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            runtime.invoke_blocking(request, mock, control, handle)
        })
        .await
        .map_err(|_| Error::Script)?;
        guard.0 = None;
        result
    }
    fn invoke_blocking(
        &self,
        request: Invocation,
        mock: MockHttp,
        control: Control,
        handle: tokio::runtime::Handle,
    ) -> Result<Outcome> {
        control.check()?;
        if request.mode == ExecutionMode::Commit {
            if let Some(outcome) = self.store.invocation_outcome(&request)? {
                return outcome;
            }
        }
        let revision = self.store.revision(&request.app, &request.revision)?;
        let action = revision
            .code
            .actions
            .iter()
            .find(|a| a.name == request.action)
            .ok_or(Error::NotFound)?;
        let before = self.store.snapshot(&request.app)?;
        if request.mode != ExecutionMode::DryRun
            && before.revision.as_ref() != Some(&request.revision)
        {
            return Err(Error::Conflict);
        }
        if request.mode == ExecutionMode::Commit {
            // No implicit restart/replay, even when a prior call has incomplete local results.
            self.store.begin_invocation(&request)?;
        }
        let broker = Broker {
            store: self.store.clone(),
            secrets: self.secrets.clone(),
            handle,
        };
        let live = request.mode != ExecutionMode::DryRun;
        let result = (|| {
            let (result, records, sqlite, notices) = self.evaluate(
                &revision,
                action,
                request.input,
                &before.records,
                &before.sqlite,
                &broker,
                &request.id,
                if live && !self.offline_actions {
                    None
                } else {
                    Some(&mock)
                },
                request.mode == ExecutionMode::LiveProbe,
                &control,
            )?;
            control.check()?;
            let committed = request.mode == ExecutionMode::Commit && !action.read_only;
            let outcome = Outcome { result, committed };
            if committed {
                // Cancellation is linearized with commit. Never retry commit after a conflict.
                let _gate = control.cancel.commit_gate()?;
                self.store.commit_action(
                    &before,
                    &records,
                    &sqlite,
                    &notices,
                    Some((&request.id, &outcome)),
                    || control.check_deadline(),
                )?;
            }
            Ok(outcome)
        })();
        if request.mode == ExecutionMode::Commit && !result.as_ref().is_ok_and(|o| o.committed) {
            let mut reported = false;
            while self.store.finish_invocation(&request.id, &result).is_err() {
                if !reported {
                    super::telemetry::error("invocation.finish", Error::Storage);
                    reported = true;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        }
        result
    }
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn preview_action(
        &self,
        app: AppId,
        revision: RevisionId,
        action: String,
        input: Value,
        records: Records,
        sqlite: Vec<u8>,
        mock: MockHttp,
    ) -> Result<(Value, Records, Vec<u8>)> {
        let permit = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Saturated)?;
        let control = Control::new(Cancellation::default(), self.deadline);
        let runtime = self.clone();
        let handle = tokio::runtime::Handle::current();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let revision = runtime.store.revision(&app, &revision)?;
            let contract = revision
                .code
                .actions
                .iter()
                .find(|a| a.name == action)
                .ok_or(Error::Validation)?;
            let broker = Broker {
                store: runtime.store.clone(),
                secrets: runtime.secrets.clone(),
                handle,
            };
            runtime
                .evaluate(
                    &revision,
                    contract,
                    input,
                    &records,
                    &sqlite,
                    &broker,
                    &InvocationId::new(),
                    Some(&mock),
                    false,
                    &control,
                )
                .map(|(value, records, sqlite, _)| (value, records, sqlite))
        })
        .await
        .map_err(|_| Error::Script)?
    }
    /// Backend assertions use generated, persisted tests against an isolated record snapshot.
    /// This is backend evidence only; frontend verification belongs to the browser harness.
    pub async fn test_revision(
        &self,
        app: AppId,
        id: RevisionId,
        mock: MockHttp,
        cancel: Cancellation,
    ) -> Result<()> {
        let permit = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Saturated)?;
        let control = Control::new(cancel.clone(), self.deadline * 64);
        let mut guard = CancelOnDrop(Some(cancel));
        let runtime = self.clone();
        let handle = tokio::runtime::Handle::current();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            let revision = runtime.store.revision(&app, &id)?;
            if revision.code.tests.is_empty()
                || revision
                    .code
                    .actions
                    .iter()
                    .any(|a| !revision.code.tests.iter().any(|t| t.action == a.name))
            {
                return Err(Error::Untested);
            }
            let broker = Broker {
                store: runtime.store.clone(),
                secrets: runtime.secrets.clone(),
                handle,
            };
            let mut records = Records::new();
            let mut sqlite = Vec::new();
            for (index, test) in revision.code.tests.iter().enumerate() {
                let action = revision
                    .code
                    .actions
                    .iter()
                    .find(|a| a.name == test.action)
                    .ok_or(Error::Validation)?;
                let mut fixtures = mock.clone();
                fixtures.0.extend(test.http.clone());
                let case_control = Control::new(control.cancel.clone(), runtime.deadline);
                let (value, next, next_sqlite, _) = runtime.evaluate(
                    &revision,
                    action,
                    test.input.clone(),
                    &records,
                    &sqlite,
                    &broker,
                    &InvocationId::new(),
                    Some(&fixtures),
                    false,
                    &case_control,
                )?;
                if value != test.expected {
                    return Err(runtime.diagnostic(
                        &revision,
                        &test.action,
                        "assertion",
                        json!({"index":index,"expected":test.expected,"actual":value}),
                    ));
                }
                records = next;
                sqlite = next_sqlite;
            }
            let _gate = control.cancel.commit_gate()?;
            control.check_deadline()?;
            runtime.store.tested(&revision)
        })
        .await
        .map_err(|_| Error::Script)?;
        guard.0 = None;
        result
    }
    #[allow(clippy::too_many_arguments)]
    fn evaluate(
        &self,
        revision: &Revision,
        action: &ActionContract,
        input: Value,
        records: &Records,
        sqlite: &[u8],
        broker: &Broker,
        invocation: &InvocationId,
        mock: Option<&MockHttp>,
        force_readonly: bool,
        control: &Control,
    ) -> Result<(Value, Records, Vec<u8>, Vec<notifications::Change>)> {
        let host = EvaluationBroker {
            runtime: self.clone(),
            revision: revision.clone(),
            action: action.name.clone(),
            broker: broker.clone(),
            invocation: invocation.clone(),
            mock: mock.cloned(),
            readonly: action.read_only || force_readonly,
            control: control.clone(),
        };
        #[cfg(test)]
        {
            super::evaluator::evaluate(
                revision,
                action,
                input,
                records,
                sqlite,
                std::rc::Rc::new(host),
                force_readonly,
                control,
            )
        }
        #[cfg(not(test))]
        {
            super::worker::evaluate(
                revision,
                action,
                input,
                records,
                sqlite,
                host,
                force_readonly,
                control,
            )
        }
    }
}
pub(crate) struct EvaluationBroker {
    runtime: Runtime,
    revision: Revision,
    action: String,
    broker: Broker,
    invocation: InvocationId,
    mock: Option<MockHttp>,
    readonly: bool,
    control: Control,
}
impl super::evaluator::EvaluationHost for EvaluationBroker {
    fn request(&self, request: HttpRequest) -> Result<Value> {
        self.broker.request(
            &self.invocation,
            request,
            self.readonly,
            self.mock.as_ref(),
            &self.control,
        )
    }
    fn diagnostic(&self, phase: &str, details: Value) -> Error {
        self.runtime
            .diagnostic(&self.revision, &self.action, phase, details)
    }
    fn redact(&self, value: Value) -> Result<Value> {
        self.runtime.secrets.redact(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    struct Fixture {
        _dir: tempfile::TempDir,
        runtime: Runtime,
        app: AppId,
        revision: Revision,
    }
    impl Fixture {
        async fn new(source: &str, readonly: bool, output: Value, expected: Value) -> Self {
            Self::with_sqlite(source, readonly, output, expected, false).await
        }
        async fn with_sqlite(
            source: &str,
            readonly: bool,
            output: Value,
            expected: Value,
            sqlite: bool,
        ) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let store = Store::create(&dir.path().join("workspace.sqlite")).unwrap();
            let secrets = Secrets::open(store.clone(), &dir.path().join("secrets.key")).unwrap();
            let runtime = Runtime::new(store.clone(), secrets, 1).unwrap();
            let app = store.create_app("Tasks").unwrap();
            let draft = store
                .create_draft(
                    &app,
                    AppCode {
                        sqlite,
                        backend: source.into(),
                        frontend: "".into(),
                        actions: vec![ActionContract {
                            name: "run".into(),
                            read_only: readonly,
                            input: json!({"type":"object","additionalProperties":false}),
                            output,
                        }],
                        tests: vec![TestCase {
                            http: Default::default(),
                            action: "run".into(),
                            input: json!({}),
                            expected,
                        }],
                        frontend_tests: vec![],
                    },
                )
                .unwrap();
            let revision = store.freeze_draft(&draft.id, 1).unwrap();
            Self {
                _dir: dir,
                runtime,
                app,
                revision,
            }
        }
        async fn publish(&self) {
            self.runtime
                .test_revision(
                    self.app.clone(),
                    self.revision.id.clone(),
                    MockHttp::default(),
                    Cancellation::default(),
                )
                .await
                .unwrap();
            self.runtime
                .store
                .publish(&self.app, &self.revision.id, None)
                .unwrap();
        }
        fn request(&self, mode: ExecutionMode) -> Invocation {
            Invocation {
                id: InvocationId::new(),
                app: self.app.clone(),
                revision: self.revision.id.clone(),
                action: "run".into(),
                input: json!({}),
                mode,
            }
        }
        async fn invoke(&self, mode: ExecutionMode) -> Result<Outcome> {
            self.runtime
                .invoke(
                    self.request(mode),
                    MockHttp::default(),
                    Cancellation::default(),
                )
                .await
        }
    }
    #[tokio::test]
    async fn sqlite_is_isolated_and_commits_atomically_with_records() {
        let source = r#"fn run(input) {
            sql_execute("CREATE TABLE IF NOT EXISTS items(id INTEGER PRIMARY KEY, title TEXT)", []);
            sql_execute("INSERT INTO items(title) VALUES (?)", ["hello"]);
            db_set("count", sql_query("SELECT count(*) AS n FROM items", [])[0].n);
            db_get("count")
        }"#;
        let f =
            Fixture::with_sqlite(source, false, json!({"type":"integer"}), json!(1), true).await;
        f.publish().await;
        assert!(f.runtime.store.snapshot(&f.app).unwrap().sqlite.is_empty());
        let request = f.request(ExecutionMode::DryRun);
        f.runtime
            .invoke(request, MockHttp::default(), Cancellation::default())
            .await
            .unwrap();
        assert!(f.runtime.store.snapshot(&f.app).unwrap().sqlite.is_empty());
        f.runtime
            .invoke(
                f.request(ExecutionMode::Commit),
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        let snapshot = f.runtime.store.snapshot(&f.app).unwrap();
        assert_eq!(snapshot.records["count"], json!(1));
        assert!(!snapshot.sqlite.is_empty());
        f.runtime
            .invoke(
                f.request(ExecutionMode::Commit),
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(
            f.runtime.store.snapshot(&f.app).unwrap().records["count"],
            json!(2)
        );
        let other = f.runtime.store.create_app("Other").unwrap();
        assert!(f.runtime.store.snapshot(&other).unwrap().sqlite.is_empty());
        let preview = f
            .runtime
            .preview_action(
                f.app.clone(),
                f.revision.id.clone(),
                "run".into(),
                json!({}),
                Records::new(),
                vec![],
                MockHttp::default(),
            )
            .await
            .unwrap();
        assert_eq!(preview.0, json!(1));
        let preview = f
            .runtime
            .preview_action(
                f.app.clone(),
                f.revision.id.clone(),
                "run".into(),
                json!({}),
                preview.1,
                preview.2,
                MockHttp::default(),
            )
            .await
            .unwrap();
        assert_eq!(preview.0, json!(2));
        // Publication changes do not clear SQL data; conflicts/cancellation cannot commit it.
        assert_eq!(
            f.runtime
                .store
                .commit_with_sqlite(&snapshot, &snapshot.records, &[], &[], || Ok(())),
            Err(Error::Conflict)
        );
        let snapshot = f.runtime.store.snapshot(&f.app).unwrap();
        assert_eq!(
            f.runtime
                .store
                .commit_with_sqlite(&snapshot, &Records::new(), &[], &[], || Err(
                    Error::Cancelled
                )),
            Err(Error::Cancelled)
        );
        assert_eq!(
            f.runtime.store.snapshot(&f.app).unwrap().sqlite,
            snapshot.sqlite
        );
        let failed =
            Fixture::with_sqlite(source, false, json!({"type":"string"}), json!(1), true).await;
        assert!(failed
            .runtime
            .invoke(
                failed.request(ExecutionMode::DryRun),
                MockHttp::default(),
                Cancellation::default()
            )
            .await
            .is_err());
        assert!(failed
            .runtime
            .store
            .snapshot(&failed.app)
            .unwrap()
            .sqlite
            .is_empty());
        let disabled = Fixture::new(source, false, json!({}), json!(1)).await;
        assert!(disabled
            .runtime
            .invoke(
                disabled.request(ExecutionMode::DryRun),
                MockHttp::default(),
                Cancellation::default()
            )
            .await
            .is_err());
        let readonly = Fixture::with_sqlite(
            r#"fn run(input) { try { sql_execute("CREATE TABLE nope(x)", []); } catch(e) {} 1 }"#,
            true,
            json!({}),
            json!(1),
            true,
        )
        .await;
        assert!(matches!(
            readonly
                .runtime
                .invoke(
                    readonly.request(ExecutionMode::DryRun),
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await,
            Err(Error::ReadOnly)
        ));
    }
    #[tokio::test]
    async fn notifications_follow_atomic_commit_and_readonly_rules() {
        let source = r#"fn run(input) { db_set("task",1); notify(#{key:"task",title:"Task ready",body:"Review it"}); 1 }"#;
        let f = Fixture::new(source, false, json!({"type":"integer"}), json!(1)).await;
        f.publish().await;
        assert_eq!(notifications::list(&f.runtime.store).unwrap(), json!([]));
        f.invoke(ExecutionMode::DryRun).await.unwrap();
        assert_eq!(notifications::list(&f.runtime.store).unwrap(), json!([]));
        f.invoke(ExecutionMode::Commit).await.unwrap();
        assert_eq!(
            notifications::list(&f.runtime.store)
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
        let f = Fixture::new(
            r#"fn run(input) { notify(#{key:"task",title:"Task ready"}); throw "abort"; }"#,
            false,
            json!({"type":"integer"}),
            json!(1),
        )
        .await;
        assert!(f.invoke(ExecutionMode::DryRun).await.is_err());
        assert_eq!(notifications::list(&f.runtime.store).unwrap(), json!([]));
        let f = Fixture::new(
            r#"fn run(input) { try { notify(#{key:"task",title:"Task ready"}); } catch(e) {} 1 }"#,
            true,
            json!({"type":"integer"}),
            json!(1),
        )
        .await;
        assert!(matches!(
            f.invoke(ExecutionMode::DryRun).await,
            Err(Error::ReadOnly)
        ));
    }
    #[tokio::test]
    async fn generated_code_is_tested_bound_and_commits_atomically() {
        let f = Fixture::new(
            "fn run(input) { db_set(\"task\", #{title:\"Keep\"}); db_get(\"task\") }",
            false,
            json!({"type":"object"}),
            json!({"title":"Keep"}),
        )
        .await;
        assert_eq!(
            f.runtime.store.publish(&f.app, &f.revision.id, None),
            Err(Error::Untested)
        );
        f.publish().await;
        assert!(f.runtime.store.snapshot(&f.app).unwrap().records.is_empty());
        assert!(!f.invoke(ExecutionMode::DryRun).await.unwrap().committed);
        assert!(f.runtime.store.snapshot(&f.app).unwrap().records.is_empty());
        let request = f.request(ExecutionMode::Commit);
        assert!(
            f.runtime
                .invoke(
                    request.clone(),
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await
                .unwrap()
                .committed
        );
        let version = f.runtime.store.snapshot(&f.app).unwrap().version;
        assert!(
            f.runtime
                .invoke(request, MockHttp::default(), Cancellation::default())
                .await
                .unwrap()
                .committed
        );
        assert_eq!(
            f.runtime.store.snapshot(&f.app).unwrap().version,
            version,
            "replayed outcome must not execute twice"
        );
        let next = f
            .runtime
            .store
            .freeze_draft(
                &f.runtime
                    .store
                    .create_draft(&f.app, f.revision.code.clone())
                    .unwrap()
                    .id,
                1,
            )
            .unwrap();
        f.runtime
            .test_revision(
                f.app.clone(),
                next.id.clone(),
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        f.runtime
            .store
            .publish(&f.app, &next.id, Some(&f.revision.id))
            .unwrap();
        assert!(matches!(
            f.invoke(ExecutionMode::Commit).await,
            Err(Error::Conflict)
        ));
        assert_eq!(
            f.runtime.store.snapshot(&f.app).unwrap().records["task"],
            json!({"title":"Keep"})
        );
    }
    #[tokio::test]
    async fn failed_output_or_script_discards_entire_delta() {
        for source in [
            "fn run(input) { db_set(\"pending\",1); 42 }",
            "fn run(input) { db_set(\"pending\",1); throw \"abort\"; }",
        ] {
            let f = Fixture::new(source, false, json!({"type":"object"}), json!({})).await;
            assert!(f.invoke(ExecutionMode::DryRun).await.is_err());
            assert!(f
                .runtime
                .test_revision(
                    f.app.clone(),
                    f.revision.id.clone(),
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await
                .is_err());
            assert_eq!(
                f.runtime.store.publish(&f.app, &f.revision.id, None),
                Err(Error::Untested)
            );
            assert!(f.runtime.store.snapshot(&f.app).unwrap().records.is_empty());
        }
    }
    #[tokio::test]
    async fn readonly_violations_are_sticky_even_when_caught() {
        for source in ["fn run(input) { try { db_set(\"bad\",1); } catch(e) {} [] }",
            "fn run(input) { try { http_request(#{url:\"https://example.com\",method:\"POST\"}); } catch(e) {} [] }"] {
            let f=Fixture::new(source,true,json!({"type":"array"}),json!([])).await;
            assert!(matches!(f.invoke(ExecutionMode::DryRun).await,Err(Error::ReadOnly)));
            assert!(f.runtime.store.snapshot(&f.app).unwrap().records.is_empty());
        }
    }
    #[tokio::test]
    async fn input_validation_limits_and_ambient_capabilities() {
        for source in [
            "fn run(input) { loop {} }",
            "fn run(input) { eval(\"42\") }",
            "fn run(input) { read_file(\"/etc/hosts\") }",
            "fn run(input) { sql(\"select 1\") }",
            "fn run(input) { import \"file\" as x; [] }",
            "fn run(input) { let x=\"abc\"; loop { x+=x; } }",
            "fn recurse(n) { recurse(n+1) } fn run(input) { recurse(0) }",
        ] {
            let f = Fixture::new(source, true, json!({"type":"array"}), json!([])).await;
            assert!(f.invoke(ExecutionMode::DryRun).await.is_err(), "{source}");
        }
        let f = Fixture::new(
            "fn run(input) { [] }",
            true,
            json!({"type":"array"}),
            json!([]),
        )
        .await;
        let mut request = f.request(ExecutionMode::DryRun);
        request.input = json!({"unknown":1});
        assert!(matches!(
            f.runtime
                .invoke(request, MockHttp::default(), Cancellation::default())
                .await,
            Err(Error::Validation)
        ));
    }
    #[tokio::test]
    async fn two_apps_use_one_secret_without_grants_and_never_receive_plaintext() {
        let source="fn run(input) { http_request(#{url:\"https://example.com\",method:\"GET\",headers:#{token:#{\"$secret\":\"TOKEN\"}}}) }";
        let f = Fixture::new(
            source,
            true,
            json!({"type":"object"}),
            json!({"body":"[redacted]"}),
        )
        .await;
        f.runtime
            .secrets
            .put("TOKEN", "synthetic-private-credential")
            .unwrap();
        let second = f.runtime.store.create_app("Second").unwrap();
        let draft = f
            .runtime
            .store
            .create_draft(&second, f.revision.code.clone())
            .unwrap();
        let revision = f.runtime.store.freeze_draft(&draft.id, 1).unwrap();
        let mock = MockHttp(BTreeMap::from([(
            "https://example.com".into(),
            json!({"body":"synthetic-private-credential"}),
        )]));
        for (app, id) in [
            (f.app.clone(), f.revision.id.clone()),
            (second, revision.id),
        ] {
            f.runtime
                .test_revision(
                    app.clone(),
                    id.clone(),
                    mock.clone(),
                    Cancellation::default(),
                )
                .await
                .unwrap();
            f.runtime.store.publish(&app, &id, None).unwrap();
            let request = Invocation {
                id: InvocationId::new(),
                app,
                revision: id,
                action: "run".into(),
                input: json!({}),
                mode: ExecutionMode::DryRun,
            };
            assert_eq!(
                f.runtime
                    .invoke(request, mock.clone(), Cancellation::default())
                    .await
                    .unwrap()
                    .result,
                json!({"body":"[redacted]"})
            );
        }
    }
    #[tokio::test]
    async fn completion_failure_rolls_back_data_and_releases_invocation() {
        let f = Fixture::new(
            "fn run(input) { db_set(\"x\",1); 1 }",
            false,
            json!({"type":"integer"}),
            json!(1),
        )
        .await;
        f.publish().await;
        let db = f.runtime.store.open().unwrap();
        db.execute_batch("CREATE TRIGGER fail_complete BEFORE UPDATE OF state ON invocations WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        let request = f.request(ExecutionMode::Commit);
        assert!(matches!(
            f.runtime
                .invoke(
                    request.clone(),
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await,
            Err(Error::Storage)
        ));
        assert!(f.runtime.store.snapshot(&f.app).unwrap().records.is_empty());
        assert_eq!(
            db.query_row(
                "SELECT state FROM invocations WHERE id=?",
                [request.id.0],
                |r| r.get::<_, String>(0)
            )
            .unwrap(),
            "failed"
        );
        db.execute_batch("DROP TRIGGER fail_complete").unwrap();
        assert!(f.invoke(ExecutionMode::Commit).await.unwrap().committed);
    }
    #[tokio::test]
    async fn native_callback_deadline_cancellation_and_saturation() {
        let mut f = Fixture::new(
            "fn run(input) { db_set(\"pending\",1); test_pause(100); [] }",
            false,
            json!({"type":"array"}),
            json!([]),
        )
        .await;
        f.publish().await;
        f.runtime.deadline = Duration::from_millis(25);
        let start = std::time::Instant::now();
        assert!(matches!(
            f.invoke(ExecutionMode::Commit).await,
            Err(Error::Deadline)
        ));
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "pure evaluator deadline must prevent a late commit; worker preemption has process-level coverage"
        );
        assert!(f.runtime.store.snapshot(&f.app).unwrap().records.is_empty());
        f.runtime.deadline = Duration::from_secs(1);
        let cancel = Cancellation::default();
        let runtime = f.runtime.clone();
        let request = f.request(ExecutionMode::Commit);
        let c = cancel.clone();
        let pending =
            tokio::spawn(async move { runtime.invoke(request, MockHttp::default(), c).await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(matches!(
            f.invoke(ExecutionMode::Commit).await,
            Err(Error::Saturated)
        ));
        cancel.cancel();
        assert!(matches!(pending.await.unwrap(), Err(Error::Cancelled)));
        assert!(f.runtime.store.snapshot(&f.app).unwrap().records.is_empty());
    }
    #[tokio::test]
    async fn dropping_caller_cancels_pending_commit_and_holds_slot() {
        let f = Fixture::new(
            "fn run(input) { db_set(\"pending\",1); test_pause(100); [] }",
            false,
            json!({"type":"array"}),
            json!([]),
        )
        .await;
        f.publish().await;
        let runtime = f.runtime.clone();
        let request = f.request(ExecutionMode::Commit);
        let pending = tokio::spawn(async move {
            runtime
                .invoke(request, MockHttp::default(), Cancellation::default())
                .await
        });
        tokio::time::sleep(Duration::from_millis(20)).await;
        pending.abort();
        let _ = pending.await;
        assert!(matches!(
            f.invoke(ExecutionMode::Commit).await,
            Err(Error::Saturated)
        ));
        tokio::time::sleep(Duration::from_millis(130)).await;
        assert!(f.runtime.store.snapshot(&f.app).unwrap().records.is_empty());
    }
}
