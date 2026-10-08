//! Owner-confirmed conversational proposals, persisted in the existing job store.
use super::{http::MockHttp, *};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Proposal {
    App {
        title: String,
        purpose: String,
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
                Proposal::App { title, purpose } => {
                    if title.trim().is_empty()
                        || title.len() > 200
                        || purpose.trim().is_empty()
                        || purpose.len() > 8000
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
    store.blocking(move|store|{let db=store.open()?;let mut q=db.prepare("SELECT id,state,payload FROM jobs WHERE conversation=? AND json_extract(payload,'$.kind') IN ('app','action') ORDER BY rowid LIMIT 100")?;let rows=q.query_map([conversation.0],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(json!(rows.into_iter().map(|(id,state,payload)|Ok(json!({"id":id,"state":state,"details":serde_json::from_str::<Value>(&payload).map_err(|_|Error::Storage)?}))).collect::<Result<Vec<_>>>()?))}).await
}
pub async fn decide(
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
        Proposal::App { title, purpose } => {
            let old = conversation.clone();
            runtime.store.blocking(move|store|{
                let code=AppCode{backend:"fn list(input) { db_list() }".into(),frontend:"".into(),actions:vec![ActionContract{name:"list".into(),read_only:true,input:json!({"type":"object","additionalProperties":false}),output:json!({"type":"array"})}],tests:vec![TestCase{http:Default::default(),action:"list".into(),input:json!({}),expected:json!([])}],frontend_tests:vec![]};code.validate()?;
                let app=AppId::new();let draft=DraftId::new();let session=ConversationId::new();let mut db=store.open()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
                tx.execute("INSERT INTO apps(id,title) VALUES(?,?)",params![app.0,title])?;
                tx.execute("INSERT INTO drafts VALUES(?,?,1,?)",params![draft.0,app.0,serde_json::to_string(&code).map_err(|_|Error::Storage)?])?;
                tx.execute("INSERT INTO conversations(id,app) VALUES(?,?)",params![session.0,app.0])?;
                tx.execute("INSERT INTO authoring_sessions VALUES(?,?,1,NULL)",params![session.0,draft.0])?;
                let messages={let mut q=tx.prepare("SELECT payload FROM messages WHERE conversation=? AND json_extract(payload,'$.role') IN ('user','assistant') ORDER BY rowid LIMIT 50")?;let rows=q.query_map([old.0],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;drop(q);rows};
                for message in messages{tx.execute("INSERT INTO messages VALUES(?,?,?)",params![super::owner::token(),session.0,message])?;}
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
}
