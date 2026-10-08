use super::{http::MockHttp, owner::now, *};
use rusqlite::params;
use serde_json::{json, Value};
use std::time::Duration;
fn next(expression: &str, after: i64) -> Result<i64> {
    let cron = croner::parser::CronParser::builder()
        .build()
        .parse(expression)
        .map_err(|_| Error::Validation)?;
    let time = chrono::DateTime::from_timestamp(after, 0).ok_or(Error::Validation)?;
    cron.find_next_occurrence(&time, false)
        .map(|t| t.timestamp())
        .map_err(|_| Error::Validation)
}
pub async fn create(store: &Store, v: Value) -> Result<Value> {
    let app = AppId(v["app"].as_str().ok_or(Error::Validation)?.into());
    let revision = RevisionId(v["revision"].as_str().ok_or(Error::Validation)?.into());
    let action = v["action"].as_str().ok_or(Error::Validation)?.to_owned();
    let expression = v["expression"]
        .as_str()
        .filter(|s| s.len() < 128)
        .ok_or(Error::Validation)?
        .to_owned();
    let input = v["input"].clone();
    let due = next(&expression, now())?;
    store
        .blocking(move |store| {
            let rev = store.revision(&app, &revision)?;
            if store.snapshot(&app)?.revision.as_ref() != Some(&revision) {
                return Err(Error::Conflict);
            }
            let contract = rev
                .code
                .actions
                .iter()
                .find(|a| a.name == action)
                .ok_or(Error::Validation)?;
            if !jsonschema::validator_for(&contract.input)
                .map_err(|_| Error::Validation)?
                .is_valid(&input)
            {
                return Err(Error::Validation);
            }
            let id = super::owner::token();
            store.open()?.execute(
                "INSERT INTO schedules VALUES(?,?,?,?,?,?,?,1)",
                params![
                    id,
                    app.0,
                    revision.0,
                    action,
                    input.to_string(),
                    expression,
                    due
                ],
            )?;
            Ok(json!({"id":id,"nextRun":due}))
        })
        .await
}
pub async fn list(store: &Store) -> Result<Value> {
    store.blocking(|store|{let db=store.open()?;let mut q=db.prepare("SELECT id,app,revision,action,expression,next_run,enabled FROM schedules ORDER BY rowid")?;let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"app":r.get::<_,String>(1)?,"revision":r.get::<_,String>(2)?,"action":r.get::<_,String>(3)?,"expression":r.get::<_,String>(4)?,"nextRun":r.get::<_,i64>(5)?,"enabled":r.get::<_,bool>(6)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(json!(rows))}).await
}
async fn tick(runtime: &Runtime) -> Result<()> {
    let due=runtime.store.blocking(|store|{let mut db=store.open()?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;let mut calls=Vec::new();{let mut q=tx.prepare("SELECT id,app,revision,action,input,expression FROM schedules WHERE enabled=1 AND next_run<=? LIMIT 4")?;for row in q.query_map([now()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,String>(5)?)))?{let(id,app,revision,action,input,expression)=row?;calls.push((id,Invocation{id:InvocationId::new(),app:AppId(app),revision:RevisionId(revision),action,input:serde_json::from_str(&input).map_err(|_|Error::Storage)?,mode:ExecutionMode::Commit},expression));}}
        for(id,request,expression)in &calls{let following=next(expression,now())?;tx.execute("UPDATE schedules SET next_run=? WHERE id=?",params![following,id])?;tx.execute("INSERT INTO jobs VALUES(?,?,NULL,'running',?)",params![request.id.0,request.app.0,json!({"schedule":id,"invocation":request}).to_string()])?;}tx.commit()?;Ok(calls)
    }).await?;
    for (id, request, _) in due {
        let job = request.id.0.clone();
        let result = runtime
            .invoke(request, MockHttp::default(), Cancellation::default())
            .await;
        runtime
            .store
            .blocking(move |store| {
                let db = store.open()?;
                if matches!(result, Err(Error::ExternalUncertain | Error::Conflict)) {
                    db.execute("UPDATE schedules SET enabled=0 WHERE id=?", [&id])?;
                }
                db.execute(
                    "UPDATE jobs SET state=?,payload=? WHERE id=?",
                    params![
                        if result.is_ok() {
                            "completed"
                        } else {
                            "failed"
                        },
                        json!({"schedule":id,"result":result.as_ref().ok(),"error":result.err()})
                            .to_string(),
                        job
                    ],
                )?;
                Ok(())
            })
            .await?;
    }
    Ok(())
}
pub async fn run(runtime: Runtime) {
    loop {
        let _ = tick(&runtime).await;
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::super::secrets::Secrets;
    use super::*;
    #[tokio::test]
    async fn scheduled_calls_commit_once_and_stale_revisions_disable_schedule() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets = Secrets::open(store.clone(), &dir.path().join("secrets.key")).unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 4).unwrap();
        let app = store.create_app("Scheduled").unwrap();
        let code = AppCode {
            backend: "fn run(input) { db_set(\"scheduled\",1); 1 }".into(),
            frontend: "".into(),
            actions: vec![ActionContract {
                name: "run".into(),
                read_only: false,
                input: json!({"type":"object"}),
                output: json!({"type":"integer"}),
            }],
            tests: vec![TestCase {
                http: Default::default(),
                action: "run".into(),
                input: json!({}),
                expected: json!(1),
            }],
            frontend_tests: vec![],
        };
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
        let schedule = create(
            &store,
            json!({"app":app,"revision":rev.id,"action":"run","input":{},"expression":"* * * * *"}),
        )
        .await
        .unwrap();
        store
            .open()
            .unwrap()
            .execute("UPDATE schedules SET next_run=?", [now() - 1])
            .unwrap();
        tick(&runtime).await.unwrap();
        assert_eq!(store.snapshot(&app).unwrap().records["scheduled"], json!(1));
        let version = store.snapshot(&app).unwrap().version;
        tick(&runtime).await.unwrap();
        assert_eq!(store.snapshot(&app).unwrap().version, version);
        let next = store.freeze_draft(&draft.id, 1).unwrap();
        runtime
            .test_revision(
                app.clone(),
                next.id.clone(),
                MockHttp::default(),
                Cancellation::default(),
            )
            .await
            .unwrap();
        store.publish(&app, &next.id, Some(&rev.id)).unwrap();
        store
            .open()
            .unwrap()
            .execute("UPDATE schedules SET next_run=?", [now() - 1])
            .unwrap();
        tick(&runtime).await.unwrap();
        assert_eq!(list(&store).await.unwrap()[0]["enabled"], false);
        assert!(schedule["id"].is_string());
    }
}
