//! Persisted, conversation-scoped authoring tools. This is not a model transport or agent loop.
use super::{http::MockHttp, *};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// One contract table drives provider schemas and actionable argument feedback.
pub(crate) const TOOL_CONTRACTS: &[(&str, &[&str], &[&str])] = &[
    ("read_sdk", &[], &[]),
    ("read_draft", &[], &[]),
    ("name_app", &["title"], &["emoji"]),
    ("secret_names", &[], &[]),
    ("read_diagnostics", &["revision"], &[]),
    ("edit_draft", &["expected_version", "code"], &[]),
    ("patch_draft", &["expected_version"], &["edits", "fields"]),
    ("test_draft", &["expected_version"], &[]),
    ("test_frontend", &["revision"], &[]),
    ("dry_run", &["revision", "action", "input"], &[]),
    ("publish", &["revision", "expected_version"], &[]),
    ("list_releases", &[], &[]),
    ("inspect_data", &[], &["source", "query"]),
    ("prepare_release", &["plan"], &["expected_version"]),
    ("apply_release", &["plan"], &[]),
    (
        "release",
        &["expected_version"],
        &["records", "sql", "probes"],
    ),
];

pub(crate) fn argument_feedback(args: &Value) -> Option<Value> {
    let failure = match serde_json::from_value::<AuthoringTool>(args.clone()) {
        Ok(_) => return None,
        Err(error) => error,
    };
    if let Some(code) = args.get("code") {
        if let Err(error) = serde_path_to_error::deserialize::<_, AppCode>(code.clone()) {
            return Some(
                json!({"message":error.inner().to_string().chars().take(512).collect::<String>(),"path":format!("code.{}",error.path()),"hint":"Use the declared nested schema. Backend tests require action, input and expected JSON; expected_error is not supported. Preserve input validation rather than weakening contracts to make tests pass."}),
            );
        }
    }
    let contract = TOOL_CONTRACTS
        .iter()
        .find(|(name, _, _)| Some(*name) == args["tool"].as_str());
    Some(match contract {
        Some((name, required, optional)) => json!({
            "message":failure.to_string().chars().take(512).collect::<String>(),
            "tool":name,"required":required,"optional":optional,
            "missing":required.iter().filter(|key| args.get(**key).is_none()).collect::<Vec<_>>(),
            "hint":"test_draft uses expected_version and returns revision. test_frontend and read_diagnostics require that revision, not expected_version."
        }),
        None => {
            json!({"message":"Unknown authoring tool. Choose a tool from the declared schema."})
        }
    })
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftTextEdit {
    pub field: String,
    pub old: String,
    pub new: String,
}

fn patch_code(
    code: AppCode,
    edits: &[DraftTextEdit],
    fields: &std::collections::BTreeMap<String, Value>,
) -> Result<AppCode> {
    if edits.len() > 64 || (edits.is_empty() && fields.is_empty()) {
        return Err(Error::Validation);
    }
    let mut value = serde_json::to_value(code).map_err(|_| Error::Validation)?;
    for edit in edits {
        if !matches!(edit.field.as_str(), "backend" | "frontend") || edit.old.is_empty() {
            return Err(Error::Validation);
        }
        let source = value[&edit.field].as_str().ok_or(Error::Validation)?;
        // Include overlapping matches: never guess which occurrence the model intended.
        let matches = source
            .char_indices()
            .filter(|(i, _)| source[*i..].starts_with(&edit.old))
            .count();
        if matches != 1 {
            return Err(Error::Conflict);
        }
        value[&edit.field] = json!(source.replacen(&edit.old, &edit.new, 1));
    }
    for (field, replacement) in fields {
        if !matches!(
            field.as_str(),
            "actions" | "tests" | "frontend_tests" | "sqlite"
        ) {
            return Err(Error::Validation);
        }
        value[field] = replacement.clone();
    }
    serde_json::from_value(value).map_err(|_| Error::Validation)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "tool", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthoringTool {
    ReadSdk,
    ListReleases,
    InspectData {
        #[serde(default)]
        source: Option<releases::SavedData>,
        #[serde(default)]
        query: Option<releases::Query>,
    },
    PrepareRelease {
        plan: releases::Plan,
        #[serde(default)]
        expected_version: Option<i64>,
    },
    ApplyRelease {
        plan: String,
    },
    Release {
        expected_version: i64,
        #[serde(default)]
        records: std::collections::BTreeMap<String, Option<Value>>,
        #[serde(default)]
        sql: Vec<releases::Query>,
        #[serde(default)]
        probes: Vec<releases::Probe>,
    },
    ReadDraft,
    NameApp {
        title: String,
        #[serde(default)]
        emoji: Option<String>,
    },
    SecretNames,
    TestFrontend {
        revision: RevisionId,
    },
    ReadDiagnostics {
        revision: RevisionId,
    },
    PatchDraft {
        expected_version: i64,
        #[serde(default)]
        edits: Vec<DraftTextEdit>,
        #[serde(default)]
        fields: std::collections::BTreeMap<String, Value>,
    },
    EditDraft {
        expected_version: i64,
        code: AppCode,
    },
    TestDraft {
        expected_version: i64,
    },
    DryRun {
        revision: RevisionId,
        action: String,
        input: Value,
    },
    Publish {
        revision: RevisionId,
        expected_version: i64,
    },
}
#[derive(Clone)]
pub struct AuthoringSession {
    runtime: Runtime,
    pub conversation: ConversationId,
}
impl AuthoringSession {
    /// The authenticated host supplies owner build approval. No tool can approve itself.
    /// This interim API is exercised locally; a remote owner-authenticated host is still pending.
    pub fn begin(
        runtime: Runtime,
        app: &AppId,
        draft: &DraftId,
        owner_approved: bool,
    ) -> Result<Self> {
        runtime.store.draft(app, draft)?;
        let before = runtime.store.snapshot(app)?;
        let conversation = ConversationId::new();
        let mut db = runtime.store.open()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO conversations(id,app) VALUES(?,?)",
            params![conversation.0, app.0],
        )?;
        tx.execute(
            "INSERT INTO authoring_sessions VALUES(?,?,?,?)",
            params![
                conversation.0,
                draft.0,
                owner_approved,
                before.revision.map(|r| r.0)
            ],
        )?;
        tx.commit()?;
        Ok(Self {
            runtime,
            conversation,
        })
    }
    pub fn resume(runtime: Runtime, conversation: ConversationId) -> Result<Self> {
        let session = Self {
            runtime,
            conversation,
        };
        session.scope()?;
        Ok(session)
    }
    fn scope(&self) -> Result<(AppId, DraftId, bool, Option<RevisionId>)> {
        self.runtime.store.open()?.query_row("SELECT c.app,s.draft,s.approved,s.base_revision FROM conversations c JOIN authoring_sessions s ON s.conversation=c.id WHERE c.id=?",[&self.conversation.0],|r| Ok((AppId(r.get(0)?),DraftId(r.get(1)?),r.get(2)?,r.get::<_,Option<String>>(3)?.map(RevisionId)))).optional()?.ok_or(Error::NotFound)
    }
    /// Results and errors are persisted. There is no shell/file/SQL/network tool outside the SDK.
    pub async fn dispatch(
        &self,
        tool: AuthoringTool,
        mock: MockHttp,
        cancel: Cancellation,
    ) -> Result<Value> {
        let permit = self
            .runtime
            .authoring_admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Saturated)?;
        let mut guard = super::control::CancelOnDrop(Some(cancel.clone()));
        let session = self.clone();
        let handle = tokio::runtime::Handle::current();
        let result = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            handle.block_on(session.dispatch_inner(tool, mock, cancel))
        })
        .await
        .map_err(|_| Error::Script)?;
        guard.0 = None;
        result
    }
    async fn dispatch_inner(
        &self,
        tool: AuthoringTool,
        mock: MockHttp,
        cancel: Cancellation,
    ) -> Result<Value> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        if serde_json::to_vec(&tool)
            .map_err(|_| Error::Validation)?
            .len()
            > 256 * 1024
        {
            return Err(Error::Limit);
        }
        let (app, draft, approved, base) = self.scope()?;
        let result = match &tool {
            AuthoringTool::ReadSdk => Ok(
                json!({"sdk":include_str!("../../../docs/rhai/sdk.md"),"example":include_str!("../../../examples/tasks-rhai.json")}),
            ),
            AuthoringTool::ReadDraft => {
                let mut value = serde_json::to_value(self.runtime.store.draft(&app, &draft)?)
                    .map_err(|_| Error::Storage)?;
                let (title, emoji): (String, Option<String>) = self.runtime.store.open()?.query_row("SELECT title,(SELECT emoji FROM app_identity WHERE app=apps.id) FROM apps WHERE id=?", [&app.0], |r| Ok((r.get(0)?,r.get(1)?)))?;
                value["name"] = json!(title);
                value["emoji"] = json!(emoji);
                Ok(value)
            }
            AuthoringTool::SecretNames => {
                serde_json::to_value(self.runtime.secret_names()?).map_err(|_| Error::Storage)
            }
            AuthoringTool::ReadDiagnostics { revision } => {
                self.runtime.store.diagnostics(&app, revision)
            }
            AuthoringTool::ListReleases => Ok(
                json!({"releases":self.runtime.store.releases(&app)?,"plans":self.runtime.store.release_plans(&app)?}),
            ),
            AuthoringTool::InspectData { source, query } => {
                let app = app.clone();
                let source = source.clone();
                let query = query.clone();
                self.runtime
                    .store
                    .blocking(move |store| store.inspect_data(&app, source, query))
                    .await
            }
            _ if !approved => Err(Error::ApprovalRequired),
            AuthoringTool::PrepareRelease {
                plan,
                expected_version,
            } => {
                if self.runtime.store.snapshot(&app)?.revision != base {
                    return Err(Error::Conflict);
                }
                if expected_version.is_none()
                    && !self.runtime.store.open()?.query_row(
                        "SELECT EXISTS(SELECT 1 FROM app_releases WHERE app=? AND (revision=? OR previous_revision=?))",
                        params![app.0, plan.revision.0, plan.revision.0],
                        |r| r.get::<_, bool>(0),
                    )?
                {
                    return Err(Error::Validation);
                }
                let binding =
                    expected_version.map(|v| (self.conversation.clone(), draft.clone(), v));
                let result = self
                    .runtime
                    .prepare_release(app.clone(), plan.clone(), binding, cancel.clone())
                    .await?;
                self.runtime.store.open()?.execute(
                    "UPDATE release_plans SET conversation=? WHERE id=?",
                    params![
                        self.conversation.0,
                        result["plan"].as_str().ok_or(Error::Storage)?
                    ],
                )?;
                Ok(result)
            }
            AuthoringTool::ApplyRelease { plan } => {
                let scoped:bool=self.runtime.store.open()?.query_row("SELECT EXISTS(SELECT 1 FROM release_plans WHERE id=? AND app=? AND conversation=?)",params![plan,app.0,self.conversation.0],|r|r.get(0))?;
                if !scoped {
                    return Err(Error::NotFound);
                }
                self.runtime
                    .store
                    .apply_release(&app, plan, false, cancel.clone())
            }
            AuthoringTool::Release {
                expected_version,
                records,
                sql,
                probes,
            } => {
                if self.runtime.store.snapshot(&app)?.revision != base {
                    return Err(Error::Conflict);
                }
                let revision = self.runtime.store.freeze_draft(&draft, *expected_version)?;
                let plan = releases::Plan {
                    revision: revision.id.clone(),
                    source: None,
                    records: records.clone(),
                    sql: sql.clone(),
                    probes: probes.clone(),
                };
                let prepared = self
                    .runtime
                    .prepare_release(
                        app.clone(),
                        plan,
                        Some((self.conversation.clone(), draft.clone(), *expected_version)),
                        cancel.clone(),
                    )
                    .await;
                let prepared = match prepared {
                    Ok(value) => value,
                    Err(Error::Cancelled) => return Err(Error::Cancelled),
                    Err(error) => {
                        return Ok(
                            json!({"released":false,"error":error,"revision":revision.id,"diagnostics":self.runtime.store.diagnostics(&app, &revision.id)?,"next":"Inspect these diagnostics, patch the affected code or test, then release the new draft version."}),
                        )
                    }
                };
                if prepared["needsApproval"] == true {
                    Ok(prepared)
                } else {
                    self.runtime.store.apply_release(
                        &app,
                        prepared["plan"].as_str().ok_or(Error::Storage)?,
                        false,
                        cancel.clone(),
                    )
                }
            }

            AuthoringTool::NameApp { title, emoji } => {
                if title.trim().is_empty()
                    || title.len() > 200
                    || emoji.as_ref().is_some_and(|e| {
                        e.trim().is_empty() || e.len() > 64 || e.chars().any(char::is_control)
                    })
                {
                    return Err(Error::Validation);
                }
                let _gate = cancel.commit_gate()?;
                let mut db = self.runtime.store.open()?;
                let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let (old_title, old_emoji): (String, Option<String>) = tx.query_row("SELECT title,(SELECT emoji FROM app_identity WHERE app=apps.id) FROM apps WHERE id=?", [&app.0], |r| Ok((r.get(0)?,r.get(1)?)))?;
                let changed = old_title != *title
                    || emoji
                        .as_ref()
                        .is_some_and(|e| Some(e) != old_emoji.as_ref());
                if old_title != *title {
                    tx.execute("UPDATE apps SET title=? WHERE id=?", params![title, app.0])?;
                }
                if let Some(emoji) = emoji {
                    if Some(emoji) != old_emoji.as_ref() {
                        tx.execute("INSERT INTO app_identity(app,emoji) VALUES(?,?) ON CONFLICT(app) DO UPDATE SET emoji=excluded.emoji", params![app.0,emoji])?;
                    }
                }
                tx.commit()?;
                Ok(
                    json!({"name":title,"emoji":emoji.as_ref().or(old_emoji.as_ref()),"changed":changed}),
                )
            }
            AuthoringTool::PatchDraft {
                expected_version,
                edits,
                fields,
            } => {
                let current = self.runtime.store.draft(&app, &draft)?;
                if current.version != *expected_version {
                    return Err(Error::Conflict);
                }
                let code = patch_code(current.code, edits, fields)?;
                let _gate = cancel.commit_gate()?;
                self.runtime
                    .store
                    .edit_draft(&draft, *expected_version, code)?;
                Ok(json!({"version":expected_version+1,"patched":true}))
            }
            AuthoringTool::EditDraft {
                expected_version,
                code,
            } => {
                let _gate = cancel.commit_gate()?;
                self.runtime
                    .store
                    .edit_draft(&draft, *expected_version, code.clone())
                    .map(|()| json!({"version":expected_version+1}))
            }
            AuthoringTool::TestDraft { expected_version } => {
                match self.runtime.store.freeze_draft(&draft, *expected_version) {
                    Ok(revision) => {
                        let result = self
                            .runtime
                            .test_revision(app.clone(), revision.id.clone(), mock, cancel)
                            .await;
                        Ok(
                            json!({"revision":revision.id,"backendTestsPassed":result.is_ok(),"error":result.err(),"diagnostics":self.runtime.store.diagnostics(&app,&revision.id)?}),
                        )
                    }
                    Err(e) => Err(e),
                }
            }
            AuthoringTool::DryRun {
                revision,
                action,
                input,
            } => {
                let request = Invocation {
                    id: InvocationId::new(),
                    app: app.clone(),
                    revision: revision.clone(),
                    action: action.clone(),
                    input: input.clone(),
                    mode: ExecutionMode::DryRun,
                };
                self.runtime
                    .invoke(request, mock, cancel)
                    .await
                    .and_then(|o| serde_json::to_value(o).map_err(|_| Error::Storage))
            }
            AuthoringTool::TestFrontend { revision } => {
                super::browser::test(&self.runtime, app.clone(), revision.clone(), cancel).await
            }
            AuthoringTool::Publish {
                revision,
                expected_version,
            } => {
                // Legacy publish consumes existing evidence; the new release tool runs validation itself.
                let candidate = self.runtime.store.revision(&app, revision)?;
                let db = self.runtime.store.open()?;
                let tested: bool = db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM revision_tests WHERE revision=? AND digest=?)",
                    params![revision.0, candidate.digest],
                    |r| r.get(0),
                )?;
                let frontend:bool=candidate.code.frontend.is_empty() || db.query_row("SELECT EXISTS(SELECT 1 FROM frontend_checks WHERE revision=? AND digest=?)",params![revision.0,candidate.digest],|r|r.get::<_,bool>(0))?;
                if !tested || !frontend {
                    return Err(Error::Untested);
                }
                if self.runtime.store.snapshot(&app)?.revision != base {
                    return Err(Error::Conflict);
                }
                let prepared = self
                    .runtime
                    .prepare_release(
                        app.clone(),
                        releases::Plan {
                            revision: revision.clone(),
                            source: None,
                            records: Default::default(),
                            sql: vec![],
                            probes: vec![],
                        },
                        Some((self.conversation.clone(), draft.clone(), *expected_version)),
                        cancel.clone(),
                    )
                    .await?;
                self.runtime.store.apply_release(
                    &app,
                    prepared["plan"].as_str().ok_or(Error::Storage)?,
                    false,
                    cancel.clone(),
                )
            }
        };
        let payload = json!({"tool":tool,"result":match &result { Ok(v)=>json!({"ok":v}),Err(e)=>json!({"error":e}) }});
        self.runtime.store.open()?.execute(
            "INSERT INTO messages VALUES(?,?,?)",
            params![
                format!("{:032x}", rand::random::<u128>()),
                self.conversation.0,
                payload.to_string()
            ],
        )?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn targeted_patches_preserve_other_fields_and_reject_partial_or_stale_edits() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets =
            super::super::secrets::Secrets::open(store.clone(), &dir.path().join("secrets.key"))
                .unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 4).unwrap();
        let app = store.create_app("Patch test").unwrap();
        let mut code: AppCode =
            serde_json::from_str(include_str!("../../../examples/tasks-rhai.json")).unwrap();
        code.frontend = "// unique αβ marker; repeat repeat; aaa".into();
        let draft = store.create_draft(&app, code.clone()).unwrap();
        let session = AuthoringSession::begin(runtime, &app, &draft.id, true).unwrap();
        let named = session
            .dispatch(
                AuthoringTool::NameApp {
                    title: "Patch test".into(),
                    emoji: Some("🧠".into()),
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(named["changed"], true);
        let unchanged = session
            .dispatch(
                AuthoringTool::NameApp {
                    title: "Patch test".into(),
                    emoji: None,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(unchanged["changed"], false);
        assert_eq!(unchanged["emoji"], "🧠");
        let identity = session
            .dispatch(
                AuthoringTool::ReadDraft,
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(identity["name"], "Patch test");
        assert_eq!(identity["emoji"], "🧠");
        assert_eq!(
            session
                .dispatch(
                    AuthoringTool::NameApp {
                        title: "Unwanted rename".into(),
                        emoji: Some("\n".into())
                    },
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await,
            Err(Error::Validation)
        );
        assert_eq!(
            store
                .open()
                .unwrap()
                .query_row("SELECT title FROM apps WHERE id=?", [&app.0], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "Patch test"
        );
        let patch = |version, edits: Vec<(&str, &str)>| AuthoringTool::PatchDraft {
            expected_version: version,
            edits: edits
                .into_iter()
                .map(|(old, new)| DraftTextEdit {
                    field: "frontend".into(),
                    old: old.into(),
                    new: new.into(),
                })
                .collect(),
            fields: Default::default(),
        };
        for edits in [
            vec![("αβ", "changed"), ("missing", "x")],
            vec![("repeat", "x")],
            vec![("aa", "x")],
            vec![("", "x")],
        ] {
            assert!(session
                .dispatch(
                    patch(1, edits),
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await
                .is_err());
            let current = store.draft(&app, &draft.id).unwrap();
            assert_eq!(current.version, 1);
            assert_eq!(current.code.frontend, code.frontend);
        }
        let mut valid = patch(1, vec![("αβ", "γδ")]);
        if let AuthoringTool::PatchDraft { fields, .. } = &mut valid {
            fields.insert("sqlite".into(), json!(true));
        }
        assert_eq!(
            session
                .dispatch(valid, MockHttp::default(), Cancellation::default())
                .await
                .unwrap()["version"],
            2
        );
        let current = store.draft(&app, &draft.id).unwrap();
        assert_eq!(current.code.frontend, code.frontend.replace("αβ", "γδ"));
        assert_eq!(current.code.backend, code.backend);
        assert_eq!(
            serde_json::to_value(&current.code.tests).unwrap(),
            serde_json::to_value(&code.tests).unwrap()
        );
        assert!(current.code.sqlite);
        assert_eq!(
            session
                .dispatch(
                    patch(1, vec![("γδ", "stale")]),
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await,
            Err(Error::Conflict)
        );
        let invalid = AuthoringTool::PatchDraft {
            expected_version: 2,
            edits: vec![],
            fields: std::collections::BTreeMap::from([("actions".into(), json!("invalid"))]),
        };
        assert!(session
            .dispatch(invalid, MockHttp::default(), Cancellation::default())
            .await
            .is_err());
        assert_eq!(store.draft(&app, &draft.id).unwrap().version, 2);
    }

    #[tokio::test]
    async fn persisted_authoring_fixes_failed_backend_and_rejects_stale_publication() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets =
            super::super::secrets::Secrets::open(store.clone(), &dir.path().join("secrets.key"))
                .unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 4).unwrap();
        let app = store.create_app("Tasks").unwrap();
        let mut code: AppCode =
            serde_json::from_str(include_str!("../../../examples/tasks-rhai.json")).unwrap();
        code.frontend.clear();
        let mut broken = code.clone();
        broken.backend = "fn add(input) { 42 } fn list(input) { [] }".into();
        let draft = store.create_draft(&app, broken).unwrap();
        let session = AuthoringSession::begin(runtime.clone(), &app, &draft.id, true).unwrap();
        assert_eq!(
            session
                .dispatch(
                    AuthoringTool::TestDraft {
                        expected_version: 1
                    },
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await
                .unwrap()["backendTestsPassed"],
            false
        );
        session
            .dispatch(
                AuthoringTool::EditDraft {
                    expected_version: 1,
                    code: code.clone(),
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        let tested = session
            .dispatch(
                AuthoringTool::TestDraft {
                    expected_version: 2,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        let revision: RevisionId = serde_json::from_value(tested["revision"].clone()).unwrap();
        let session = AuthoringSession::resume(runtime.clone(), session.conversation).unwrap();
        session
            .dispatch(
                AuthoringTool::Publish {
                    revision: revision.clone(),
                    expected_version: 2,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        let outcome = runtime
            .invoke(
                Invocation {
                    id: InvocationId::new(),
                    app: app.clone(),
                    revision: revision.clone(),
                    action: "add".into(),
                    input: json!({"key":"keep","title":"Keep"}),
                    mode: ExecutionMode::Commit,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert!(outcome.committed);
        session
            .dispatch(
                AuthoringTool::EditDraft {
                    expected_version: 2,
                    code,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(
            session
                .dispatch(
                    AuthoringTool::Publish {
                        revision,
                        expected_version: 2
                    },
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await,
            Err(Error::Conflict)
        );
        let tested = session
            .dispatch(
                AuthoringTool::TestDraft {
                    expected_version: 3,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        session
            .dispatch(
                AuthoringTool::Publish {
                    revision: serde_json::from_value(tested["revision"].clone()).unwrap(),
                    expected_version: 3,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(
            store.snapshot(&app).unwrap().records["keep"],
            json!({"title":"Keep","done":false})
        );
    }
    #[tokio::test]
    async fn tools_cannot_change_scope_or_approve_their_own_build() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets =
            super::super::secrets::Secrets::open(store.clone(), &dir.path().join("secrets.key"))
                .unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 4).unwrap();
        let app = store.create_app("A").unwrap();
        let other = store.create_app("B").unwrap();
        let code: AppCode =
            serde_json::from_str(include_str!("../../../examples/tasks-rhai.json")).unwrap();
        let draft = store.create_draft(&app, code.clone()).unwrap();
        assert!(AuthoringSession::begin(runtime.clone(), &other, &draft.id, true).is_err());
        let session = AuthoringSession::begin(runtime, &app, &draft.id, false).unwrap();
        assert_eq!(
            session
                .dispatch(
                    AuthoringTool::EditDraft {
                        expected_version: 1,
                        code
                    },
                    MockHttp::default(),
                    Cancellation::default()
                )
                .await,
            Err(Error::ApprovalRequired)
        );
        assert!(serde_json::from_value::<AuthoringTool>(
            json!({"tool":"edit_draft","app":other,"expected_version":1,"code":{}})
        )
        .is_err());
        assert!(session
            .dispatch(
                AuthoringTool::ReadSdk,
                MockHttp::default(),
                Cancellation::default()
            )
            .await
            .is_ok());
    }
}
