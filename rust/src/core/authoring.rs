//! Persisted, conversation-scoped authoring tools. This is not a model transport or agent loop.
use super::{http::MockHttp, *};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "tool", rename_all = "snake_case", deny_unknown_fields)]
pub enum AuthoringTool {
    ReadSdk,
    ReadDraft,
    SecretNames,
    TestFrontend {
        revision: RevisionId,
    },
    ReadDiagnostics {
        revision: RevisionId,
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
                serde_json::to_value(self.runtime.store.draft(&app, &draft)?)
                    .map_err(|_| Error::Storage)
            }
            AuthoringTool::SecretNames => {
                serde_json::to_value(self.runtime.secret_names()?).map_err(|_| Error::Storage)
            }
            AuthoringTool::ReadDiagnostics { revision } => {
                self.runtime.store.diagnostics(&app, revision)
            }
            _ if !approved => Err(Error::ApprovalRequired),
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
                let _gate = cancel.commit_gate()?;
                self.publish(&app, &draft, revision, *expected_version, base.as_ref())
                    .map(|()| json!({"published":revision}))
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
    fn publish(
        &self,
        app: &AppId,
        draft: &DraftId,
        revision: &RevisionId,
        expected_version: i64,
        base: Option<&RevisionId>,
    ) -> Result<()> {
        let mut db = self.runtime.store.open()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (version, code): (i64, String) = tx.query_row(
            "SELECT version,code FROM drafts WHERE app=? AND id=?",
            params![app.0, draft.0],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let code: AppCode = serde_json::from_str(&code).map_err(|_| Error::Storage)?;
        let digest: String = tx
            .query_row(
                "SELECT digest FROM revisions WHERE app=? AND id=?",
                params![app.0, revision.0],
                |r| r.get(0),
            )
            .optional()?
            .ok_or(Error::NotFound)?;
        if version != expected_version || code.digest()? != digest {
            return Err(Error::Conflict);
        }
        Store::publish_in(&tx, app, revision, base)?;
        tx.execute(
            "UPDATE authoring_sessions SET base_revision=? WHERE conversation=?",
            params![revision.0, self.conversation.0],
        )?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
