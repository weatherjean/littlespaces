use super::{
    control::{CancelOnDrop, Control},
    http::{Broker, HttpRequest, MockHttp},
    secrets::Secrets,
    store::{validate_records, Records},
    *,
};
use rhai::{Dynamic, Engine, EvalAltResult, Scope};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    rc::Rc,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

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
#[derive(Debug, Serialize)]
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
    pub browser: Option<super::browser::BrowserConfig>,
    pub(crate) previews: super::browser::Previews,
}
struct Session {
    records: Records,
    error: Option<Error>,
    http_calls: usize,
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
            deadline: Duration::from_millis(750),
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
        let revision = self.store.revision(&request.app, &request.revision)?;
        let action = revision
            .code
            .actions
            .iter()
            .find(|a| a.name == request.action)
            .ok_or(Error::NotFound)?;
        validate_json(&action.input, &request.input)?;
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
            let (result, records) = self.evaluate(
                &revision,
                action,
                request.input,
                &before.records,
                &broker,
                &request.id,
                if live { None } else { Some(&mock) },
                request.mode == ExecutionMode::LiveProbe,
                &control,
            )?;
            control.check()?;
            let committed = request.mode == ExecutionMode::Commit && !action.read_only;
            if committed {
                // Cancellation is linearized with commit. Never retry commit after a conflict.
                let _gate = control.cancel.commit_gate()?;
                self.store
                    .commit(&before, &records, || control.check_deadline())?;
            }
            Ok(Outcome { result, committed })
        })();
        if request.mode == ExecutionMode::Commit {
            // Uncertain evidence remains independently durable when this local action fails.
            self.store.open()?.execute(
                "UPDATE invocations SET state=? WHERE id=?",
                params![
                    if result.is_ok() {
                        "completed"
                    } else {
                        "failed"
                    },
                    request.id.0
                ],
            )?;
        }
        result
    }
    pub(crate) async fn preview_action(
        &self,
        app: AppId,
        revision: RevisionId,
        action: String,
        input: Value,
        records: Records,
        mock: MockHttp,
    ) -> Result<(Value, Records)> {
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
            runtime.evaluate(
                &revision,
                contract,
                input,
                &records,
                &broker,
                &InvocationId::new(),
                Some(&mock),
                false,
                &control,
            )
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
        let control = Control::new(cancel.clone(), self.deadline);
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
            for (index, test) in revision.code.tests.iter().enumerate() {
                let action = revision
                    .code
                    .actions
                    .iter()
                    .find(|a| a.name == test.action)
                    .ok_or(Error::Validation)?;
                let mut fixtures = mock.clone();
                fixtures.0.extend(test.http.clone());
                let (value, next) = runtime.evaluate(
                    &revision,
                    action,
                    test.input.clone(),
                    &records,
                    &broker,
                    &InvocationId::new(),
                    Some(&fixtures),
                    false,
                    &control,
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
        broker: &Broker,
        invocation: &InvocationId,
        mock: Option<&MockHttp>,
        force_readonly: bool,
        control: &Control,
    ) -> Result<(Value, Records)> {
        control.check()?;
        validate_json(&action.input, &input).map_err(|_| {
            self.diagnostic(
                revision,
                &action.name,
                "input",
                json!({"schema":action.input,"input":input}),
            )
        })?;
        let readonly = action.read_only || force_readonly;
        let session = Rc::new(RefCell::new(Session {
            records: records.clone(),
            error: None,
            http_calls: 0,
        }));
        let mut engine = Engine::new();
        engine.set_optimization_level(rhai::OptimizationLevel::None);
        engine.set_max_operations(30000);
        engine.set_max_call_levels(16);
        engine.set_max_expr_depths(32, 32);
        engine.set_max_string_size(16384);
        engine.set_max_array_size(512);
        engine.set_max_map_size(512);
        engine.set_max_variables(32);
        engine.set_max_functions(16);
        for symbol in ["eval", "print", "debug", "import", "export"] {
            engine.disable_symbol(symbol);
        }
        let progress = control.clone();
        engine.on_progress(move |_| progress.check().err().map(|e| Dynamic::from(e.to_string())));
        #[cfg(test)]
        engine.register_fn("test_pause", |ms: i64| {
            std::thread::sleep(Duration::from_millis(ms.clamp(0, 200) as u64));
        });
        let ctx = session.clone();
        engine.register_fn("db_get", move |key: &str| {
            dynamic(ctx.borrow().records.get(key).unwrap_or(&Value::Null))
        });
        let ctx = session.clone();
        engine.register_fn("db_list", move || {
            let values: Vec<_> = ctx
                .borrow()
                .records
                .iter()
                .map(|(key, value)| json!({"key":key,"value":value}))
                .collect();
            dynamic(&json!(values))
        });
        let ctx = session.clone();
        let c = control.clone();
        engine.register_fn(
            "db_set",
            move |key: &str, value: Dynamic| -> std::result::Result<(), Box<EvalAltResult>> {
                let result = (|| {
                    c.check()?;
                    if readonly {
                        return Err(Error::ReadOnly);
                    }
                    let value: Value =
                        rhai::serde::from_dynamic(&value).map_err(|_| Error::Validation)?;
                    let mut state = ctx.borrow_mut();
                    let mut candidate = state.records.clone();
                    candidate.insert(key.into(), value);
                    validate_records(&candidate)?;
                    state.records = candidate;
                    Ok(())
                })();
                if let Err(error) = result {
                    ctx.borrow_mut().error = Some(error);
                }
                result.map_err(failure)
            },
        );
        let ctx = session.clone();
        let c = control.clone();
        engine.register_fn(
            "db_remove",
            move |key: &str| -> std::result::Result<bool, Box<EvalAltResult>> {
                let result = (|| {
                    c.check()?;
                    if readonly {
                        return Err(Error::ReadOnly);
                    }
                    Ok(ctx.borrow_mut().records.remove(key).is_some())
                })();
                if let Err(error) = result {
                    ctx.borrow_mut().error = Some(error);
                }
                result.map_err(failure)
            },
        );
        engine.register_fn("uuid", || format!("{:032x}", rand::random::<u128>()));
        engine.register_fn("now_ms", || {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
        });
        engine.register_fn(
            "json_parse",
            |s: &str| -> std::result::Result<Dynamic, Box<EvalAltResult>> {
                if s.len() > 16384 {
                    return Err(failure(Error::Limit));
                }
                dynamic(&serde_json::from_str(s).map_err(|_| failure(Error::Validation))?)
            },
        );
        engine.register_fn(
            "json_stringify",
            |v: Dynamic| -> std::result::Result<String, Box<EvalAltResult>> {
                let v: Value =
                    rhai::serde::from_dynamic(&v).map_err(|_| failure(Error::Validation))?;
                let s = v.to_string();
                if s.len() > 16384 {
                    return Err(failure(Error::Limit));
                }
                Ok(s)
            },
        );
        let ctx = session.clone();
        let broker = broker.clone();
        let invocation = invocation.clone();
        let mock = mock.cloned();
        let c = control.clone();
        engine.register_fn(
            "http_request",
            move |request: Dynamic| -> std::result::Result<Dynamic, Box<EvalAltResult>> {
                let result = (|| {
                    c.check()?;
                    {
                        let mut state = ctx.borrow_mut();
                        state.http_calls += 1;
                        if state.http_calls > 2 {
                            return Err(Error::Limit);
                        }
                    }
                    let value: Value =
                        rhai::serde::from_dynamic(&request).map_err(|_| Error::Validation)?;
                    let request: HttpRequest =
                        serde_json::from_value(value).map_err(|_| Error::Validation)?;
                    let response =
                        broker.request(&invocation, request, readonly, mock.as_ref(), &c)?;
                    c.check()?;
                    Ok(response)
                })();
                if let Err(error) = &result {
                    ctx.borrow_mut().error = Some(*error);
                }
                dynamic(&result.map_err(failure)?)
            },
        );
        let ast = engine.compile(&revision.code.backend).map_err(|e| {
            self.diagnostic(
                revision,
                &action.name,
                "compile",
                json!({"message":e.to_string().chars().take(4096).collect::<String>()}),
            )
        })?;
        control.check()?;
        let input = dynamic(&input).map_err(|_| Error::Validation)?;
        let result = engine.call_fn::<Dynamic>(&mut Scope::new(), &ast, &action.name, (input,));
        control.check()?;
        if let Some(error) = session.borrow().error {
            return Err(error);
        }
        let result = result.map_err(|e| {
            self.diagnostic(
                revision,
                &action.name,
                "script",
                json!({"message":e.to_string().chars().take(4096).collect::<String>()}),
            )
        })?;
        let result: Value = rhai::serde::from_dynamic(&result).map_err(|_| Error::Validation)?;
        // Secrets are never delivered to scripts; redact again at the tool/UI boundary.
        let result = self.secrets.redact(result)?;
        validate_json(&action.output, &result).map_err(|_| {
            self.diagnostic(
                revision,
                &action.name,
                "output",
                json!({"schema":action.output,"actual":result}),
            )
        })?;
        let state = session.borrow();
        validate_records(&state.records)?;
        if readonly && state.records != *records {
            return Err(Error::ReadOnly);
        }
        Ok((result, state.records.clone()))
    }
}
fn failure(error: Error) -> Box<EvalAltResult> {
    error.to_string().into()
}
fn dynamic(value: &Value) -> std::result::Result<Dynamic, Box<EvalAltResult>> {
    rhai::serde::to_dynamic(value).map_err(|_| failure(Error::Validation))
}
fn validate_json(schema: &Value, value: &Value) -> Result<()> {
    if value.to_string().len() > 65536 {
        return Err(Error::Limit);
    }
    jsonschema::validator_for(schema)
        .map_err(|_| Error::Validation)?
        .validate(value)
        .map_err(|_| Error::Validation)
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
            let dir = tempfile::tempdir().unwrap();
            let store = Store::create(&dir.path().join("workspace.sqlite")).unwrap();
            let secrets = Secrets::open(store.clone(), &dir.path().join("secrets.key")).unwrap();
            let runtime = Runtime::new(store.clone(), secrets, 1).unwrap();
            let app = store.create_app("Tasks").unwrap();
            let draft = store
                .create_draft(
                    &app,
                    AppCode {
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
        assert!(matches!(
            f.runtime
                .invoke(request, MockHttp::default(), Cancellation::default())
                .await,
            Err(Error::DuplicateInvocation)
        ));
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
            start.elapsed() >= Duration::from_millis(90),
            "Rhai cannot preempt a Rust callback"
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
