//! Owner-confirmed conversational proposals, persisted in the existing job store.
use super::{http::MockHttp, *};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Proposal {
    Update {
        app: AppId,
        summary: String,
    },
    Archive {
        app: AppId,
        archived: bool,
        summary: String,
    },
    App {
        title: String,
        purpose: String,
        #[serde(default)]
        emoji: String,
    },
    Action {
        app: AppId,
        revision: RevisionId,
        action: String,
        input: Value,
        summary: String,
    },
}
pub async fn propose(
    store: &Store,
    conversation: ConversationId,
    proposal: Proposal,
) -> Result<Value> {
    if serde_json::to_vec(&proposal)
        .map_err(|_| Error::Validation)?
        .len()
        > 65536
    {
        return Err(Error::Limit);
    }
    store
        .blocking(move |store| {
            let app = match &proposal {
                Proposal::Update { app, summary } | Proposal::Archive { app, summary, .. } => {
                    if summary.trim().is_empty() || summary.len() > 8000 {
                        return Err(Error::Validation);
                    }
                    store.snapshot(app)?;
                    Some(app.clone())
                }
                Proposal::App {
                    title,
                    purpose,
                    emoji,
                } => {
                    if title.trim().is_empty()
                        || title.len() > 200
                        || purpose.trim().is_empty()
                        || purpose.len() > 8000
                        || emoji.len() > 64
                        || emoji.chars().any(char::is_control)
                    {
                        return Err(Error::Validation);
                    }
                    None
                }
                Proposal::Action {
                    app,
                    revision,
                    action,
                    input,
                    summary,
                } => {
                    if summary.len() > 2000 {
                        return Err(Error::Limit);
                    }
                    let rev = store.revision(app, revision)?;
                    let contract = rev
                        .code
                        .actions
                        .iter()
                        .find(|a| a.name == *action)
                        .ok_or(Error::NotFound)?;
                    if !jsonschema::validator_for(&contract.input)
                        .map_err(|_| Error::Validation)?
                        .is_valid(input)
                    {
                        return Err(Error::Validation);
                    }
                    Some(app.clone())
                }
            };
            let id = super::owner::token();
            store.open()?.execute(
                "INSERT INTO jobs VALUES(?,?,?,'pending',?)",
                params![
                    id,
                    app.map(|a| a.0),
                    conversation.0,
                    serde_json::to_string(&proposal).map_err(|_| Error::Storage)?
                ],
            )?;
            Ok(json!({"proposal":id,"status":"pending","details":proposal}))
        })
        .await
}
pub async fn list(store: &Store, conversation: ConversationId) -> Result<Value> {
    store.blocking(move|store|{let db=store.open()?;let mut q=db.prepare("SELECT id,state,payload FROM jobs WHERE conversation=? AND json_extract(payload,'$.kind') IN ('app','action','update','archive') ORDER BY rowid LIMIT 100")?;let rows=q.query_map([conversation.0],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(json!(rows.into_iter().map(|(id,state,payload)|Ok(json!({"id":id,"state":state,"details":serde_json::from_str::<Value>(&payload).map_err(|_|Error::Storage)?}))).collect::<Result<Vec<_>>>()?))}).await
}
pub async fn decide(
    runtime: Runtime,
    conversation: ConversationId,
    id: String,
    confirm: bool,
) -> Result<Value> {
    // An accepted owner decision must finish saving its outcome even if the
    // browser disconnects while the action is running. Never resubmit the write.
    tokio::spawn(async move { decide_durable(runtime, conversation, id, confirm).await })
        .await
        .map_err(|_| Error::Storage)?
}
async fn decide_durable(
    runtime: Runtime,
    conversation: ConversationId,
    id: String,
    confirm: bool,
) -> Result<Value> {
    let cid = conversation.clone();
    let pid = id.clone();
    let proposal = runtime
        .store
        .blocking(move |store| {
            let mut db = store.open()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (state, payload): (String, String) = tx
                .query_row(
                    "SELECT state,payload FROM jobs WHERE id=? AND conversation=?",
                    params![pid, cid.0],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or(Error::NotFound)?;
            if state != "pending" {
                return Err(Error::DuplicateInvocation);
            }
            let proposal: Proposal =
                serde_json::from_str(&payload).map_err(|_| Error::Validation)?;
            tx.execute(
                "UPDATE jobs SET state=? WHERE id=? AND state='pending'",
                params![if confirm { "running" } else { "cancelled" }, pid],
            )?;
            tx.commit()?;
            Ok(proposal)
        })
        .await?;
    if !confirm {
        return Ok(json!({"status":"cancelled"}));
    }
    let result = match proposal.clone() {
        Proposal::Archive { app, archived, .. } => {
            runtime
                .store
                .blocking(move |store| {
                    store.archive_app(&app, archived)?;
                    Ok(json!({"status":"completed","app":app,"archived":archived}))
                })
                .await
        }
        Proposal::Update { app, summary } => {
            let old = conversation.clone();
            runtime.store.blocking(move |store| {
                let mut db = store.open()?;
                let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                let published: Option<String> = tx.query_row(
                    "SELECT published_revision FROM apps WHERE id=?", [&app.0], |r| r.get(0),
                )?;
                let raw: String = if let Some(revision) = &published {
                    tx.query_row("SELECT code FROM revisions WHERE app=? AND id=?", params![app.0, revision], |r| r.get(0))?
                } else {
                    tx.query_row("SELECT code FROM drafts WHERE app=? ORDER BY rowid DESC LIMIT 1", [&app.0], |r| r.get(0))?
                };
                let code: AppCode = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
                code.validate()?;
                let draft = DraftId::new();
                let session = ConversationId::new();
                tx.execute("INSERT INTO drafts VALUES(?,?,1,?)", params![draft.0, app.0, raw])?;
                tx.execute("INSERT INTO conversations(id,app) VALUES(?,?)", params![session.0, app.0])?;
                tx.execute("INSERT INTO authoring_sessions VALUES(?,?,1,?)", params![session.0, draft.0, published])?;
                let messages = {
                    let mut q = tx.prepare("SELECT payload FROM messages WHERE conversation=? AND json_extract(payload,'$.role') IN ('user','assistant') ORDER BY rowid DESC LIMIT 50")?;
                    let rows = q.query_map([old.0], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
                    drop(q);
                    rows
                };
                for payload in messages.iter().rev() {
                    let value: Value = serde_json::from_str(payload).map_err(|_| Error::Storage)?;
                    for image in value["images"].as_array().into_iter().flatten().filter_map(Value::as_str) {
                        tx.execute("INSERT OR IGNORE INTO app_images(app,image) VALUES(?,?)", params![app.0, image])?;
                    }
                    tx.execute("INSERT INTO messages VALUES(?,?,?)", params![owner::token(), session.0, payload])?;
                }
                tx.execute("INSERT INTO messages VALUES(?,?,?)", params![owner::token(), session.0, json!({"role":"user","content":format!("Approved app update: {summary}")}).to_string()])?;
                tx.commit()?;
                Ok(json!({"status":"completed","app":app,"conversation":session,"purpose":summary}))
            }).await
        }
        Proposal::Action {
            app,
            revision,
            action,
            input,
            ..
        } => runtime
            .invoke(
                Invocation {
                    id: InvocationId(id.clone()),
                    app,
                    revision,
                    action,
                    input,
                    mode: ExecutionMode::Commit,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .map(|o| json!({"status":"completed","result":o})),
        Proposal::App {
            title,
            purpose,
            emoji,
        } => {
            let old = conversation.clone();
            runtime.store.blocking(move|store|{
                let code=AppCode { sqlite: false, backend:"fn list(input) { db_list() }".into(),frontend:"".into(),actions:vec![ActionContract{name:"list".into(),read_only:true,input:json!({"type":"object","additionalProperties":false}),output:json!({"type":"array"})}],tests:vec![TestCase{http:Default::default(),action:"list".into(),input:json!({}),expected:json!([])}],frontend_tests:vec![]};code.validate()?;
                let app=AppId::new();let draft=DraftId::new();let session=old.clone();let mut db=store.open()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                tx.execute("INSERT INTO apps(id,title) VALUES(?,?)",params![app.0,title])?;
                if !emoji.is_empty() { tx.execute("INSERT INTO app_identity(app,emoji) VALUES(?,?)",params![app.0,emoji])?; }
                tx.execute("INSERT INTO drafts VALUES(?,?,1,?)",params![draft.0,app.0,serde_json::to_string(&code).map_err(|_|Error::Storage)?])?;
                if tx.execute("UPDATE conversations SET app=? WHERE id=? AND app IS NULL",params![app.0,session.0])? != 1 { return Err(Error::Conflict); }
                tx.execute("INSERT INTO authoring_sessions VALUES(?,?,1,NULL)",params![session.0,draft.0])?;
                let messages={let mut q=tx.prepare("SELECT payload FROM messages WHERE conversation=? AND json_extract(payload,'$.role') IN ('user','assistant') ORDER BY rowid LIMIT 50")?;let rows=q.query_map([old.0],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;drop(q);rows};
                for message in messages{let value:Value=serde_json::from_str(&message).map_err(|_|Error::Storage)?;if let Some(images)=value["images"].as_array(){for image in images.iter().filter_map(Value::as_str){tx.execute("INSERT OR IGNORE INTO app_images(app,image) VALUES(?,?)",params![app.0,image])?;}}}
                tx.execute("INSERT INTO messages VALUES(?,?,?)",params![super::owner::token(),session.0,json!({"role":"user","content":format!("Approved app: {title}. Build: {purpose}")}).to_string()])?;tx.commit()?;Ok(json!({"status":"completed","app":app,"conversation":session,"purpose":purpose}))
            }).await
        }
    };
    let state = if result.is_ok() {
        "completed"
    } else {
        "failed"
    };
    let saved = id.clone();
    let outcome = json!({"result":result.as_ref().ok(),"error":result.as_ref().err()});
    runtime
        .store
        .blocking(move |store| {
            let db = store.open()?;
            let raw: String =
                db.query_row("SELECT payload FROM jobs WHERE id=?", [&saved], |r| {
                    r.get(0)
                })?;
            let mut payload: Value = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
            payload["outcome"] = outcome;
            db.execute(
                "UPDATE jobs SET state=?,payload=? WHERE id=?",
                params![state, payload.to_string(), saved],
            )?;
            Ok(())
        })
        .await?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn disconnected_owner_decision_finishes_without_replaying() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("workspace.sqlite")).unwrap();
        let secrets = secrets::Secrets::open(store.clone(), &dir.path().join("key")).unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 1).unwrap();
        let app = store.create_app("Archive me").unwrap();
        let conversation = ConversationId::new();
        let mut db = store.open().unwrap();
        db.execute(
            "INSERT INTO conversations(id,app) VALUES(?,?)",
            params![conversation.0, app.0],
        )
        .unwrap();
        let proposal = propose(
            &store,
            conversation.clone(),
            Proposal::Archive {
                app: app.clone(),
                archived: true,
                summary: "Owner requested archive".into(),
            },
        )
        .await
        .unwrap();
        let id = proposal["proposal"].as_str().unwrap().to_owned();
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let rt = runtime.clone();
        let c = conversation.clone();
        let p = id.clone();
        let request = tokio::spawn(async move { decide(rt, c, p, true).await });
        tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        request.abort();
        tx.commit().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let state: String = db
                    .query_row("SELECT state FROM jobs WHERE id=?", [&id], |r| r.get(0))
                    .unwrap();
                if state == "completed" {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert!(db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM archived_apps WHERE app=?)",
                [&app.0],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
        assert_eq!(
            decide(runtime, conversation, id, true).await,
            Err(Error::DuplicateInvocation)
        );
    }
    #[tokio::test]
    async fn voice_changes_require_owner_confirmation_and_cannot_run_twice() {
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
        let draft = store.create_draft(&app, code).unwrap();
        let rev = store.freeze_draft(&draft.id, 1).unwrap();
        runtime
            .test_revision(
                app.clone(),
                rev.id.clone(),
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        store.publish(&app, &rev.id, None).unwrap();
        let conversation = ConversationId::new();
        store
            .open()
            .unwrap()
            .execute(
                "INSERT INTO conversations(id,app) VALUES(?,?)",
                params![conversation.0, app.0],
            )
            .unwrap();
        let p = propose(
            &store,
            conversation.clone(),
            Proposal::Action {
                app: app.clone(),
                revision: rev.id,
                action: "add".into(),
                input: json!({"key":"voice","title":"Requested by voice"}),
                summary: "Add a task".into(),
            },
        )
        .await
        .unwrap();
        let id = p["proposal"].as_str().unwrap().to_owned();
        assert!(store.snapshot(&app).unwrap().records.is_empty());
        decide(runtime.clone(), conversation.clone(), id.clone(), true)
            .await
            .unwrap();
        assert_eq!(store.snapshot(&app).unwrap().records.len(), 1);
        assert_eq!(
            decide(runtime, conversation, id, true).await,
            Err(Error::DuplicateInvocation)
        );
    }
    #[tokio::test]
    async fn agent_names_app_and_owner_approval_preserves_conversation_context() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets =
            super::super::secrets::Secrets::open(store.clone(), &dir.path().join("secrets.key"))
                .unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 4).unwrap();
        let conversation = ConversationId::new();
        let db = store.open().unwrap();
        db.execute("INSERT INTO conversations(id) VALUES(?)", [&conversation.0])
            .unwrap();
        for i in 0..2 {
            db.execute(
                "INSERT INTO messages VALUES(?,?,?)",
                params![
                    format!("message-{i}"),
                    conversation.0,
                    json!({"role":"user","content":"Make a meal planner"}).to_string()
                ],
            )
            .unwrap();
        }
        let p = propose(
            &store,
            conversation.clone(),
            Proposal::App {
                title: "Pantry".into(),
                purpose: "Plan meals".into(),
                emoji: "🥗".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM apps", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        let approved = decide(
            runtime,
            conversation,
            p["proposal"].as_str().unwrap().into(),
            true,
        )
        .await
        .unwrap();
        let app = approved["app"].as_str().unwrap();
        assert_eq!(
            db.query_row("SELECT title FROM apps WHERE id=?", [app], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Pantry"
        );
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM messages WHERE conversation=?",
                [approved["conversation"].as_str().unwrap()],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
    }
    #[tokio::test]
    async fn update_and_archive_require_single_use_confirmation_and_preserve_data() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets =
            secrets::Secrets::open(store.clone(), &dir.path().join("secrets.key")).unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 1).unwrap();
        let app = store.create_app("Existing app").unwrap();
        let mut code: AppCode =
            serde_json::from_str(include_str!("../../../examples/tasks-rhai.json")).unwrap();
        code.sqlite = true;
        store.create_draft(&app, code.clone()).unwrap();
        let snapshot = store.snapshot(&app).unwrap();
        let records = [("keep".to_owned(), json!("existing data"))]
            .into_iter()
            .collect();
        store.commit(&snapshot, &records, &[], || Ok(())).unwrap();
        let conversation = ConversationId::new();
        store
            .open()
            .unwrap()
            .execute("INSERT INTO conversations(id) VALUES(?)", [&conversation.0])
            .unwrap();
        let proposal = propose(
            &store,
            conversation.clone(),
            Proposal::Update {
                app: app.clone(),
                summary: "Add search".into(),
            },
        )
        .await
        .unwrap();
        let id = proposal["proposal"].as_str().unwrap().to_owned();
        assert_eq!(
            store
                .open()
                .unwrap()
                .query_row("SELECT count(*) FROM authoring_sessions", [], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        let result = decide(runtime.clone(), conversation.clone(), id.clone(), true)
            .await
            .unwrap();
        assert_eq!(
            decide(runtime.clone(), conversation.clone(), id, true).await,
            Err(Error::DuplicateInvocation)
        );
        let session = authoring::AuthoringSession::resume(
            runtime.clone(),
            serde_json::from_value(result["conversation"].clone()).unwrap(),
        )
        .unwrap();
        let draft = session
            .dispatch(
                authoring::AuthoringTool::ReadDraft,
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        assert_eq!(draft["code"]["backend"], code.backend);
        assert_eq!(draft["code"]["sqlite"], true);
        for archived in [true, false] {
            let proposal = propose(
                &store,
                conversation.clone(),
                Proposal::Archive {
                    app: app.clone(),
                    archived,
                    summary: "Change launcher visibility".into(),
                },
            )
            .await
            .unwrap();
            let id = proposal["proposal"].as_str().unwrap().to_owned();
            decide(runtime.clone(), conversation.clone(), id.clone(), true)
                .await
                .unwrap();
            assert_eq!(
                store
                    .open()
                    .unwrap()
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM archived_apps WHERE app=?)",
                        [&app.0],
                        |r| r.get::<_, bool>(0)
                    )
                    .unwrap(),
                archived
            );
            assert_eq!(
                decide(runtime.clone(), conversation.clone(), id, true).await,
                Err(Error::DuplicateInvocation)
            );
        }
        assert_eq!(store.snapshot(&app).unwrap().records, records);
    }
}
