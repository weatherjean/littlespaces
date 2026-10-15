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
// Admission advances the clock and persists undispatched work in one transaction.
fn enqueue(store: &Store) -> Result<()> {
    let mut db = store.open()?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let calls = {
        let mut q = tx.prepare("SELECT id,app,revision,action,input,expression FROM schedules WHERE enabled=1 AND NOT EXISTS(SELECT 1 FROM archived_apps a WHERE a.app=schedules.app) AND next_run<=? AND (SELECT COUNT(*) FROM jobs WHERE state='schedule_pending')<64 AND NOT EXISTS(SELECT 1 FROM jobs j WHERE j.state='schedule_pending' AND json_extract(j.payload,'$.schedule')=schedules.id) ORDER BY next_run,id LIMIT 4")?;
        let rows = q
            .query_map([now()], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        drop(q);
        rows
    };
    for (id, app, revision, action, input, expression) in calls {
        let request = Invocation {
            id: InvocationId::new(),
            app: AppId(app),
            revision: RevisionId(revision),
            action,
            input: serde_json::from_str(&input).map_err(|_| Error::Storage)?,
            mode: ExecutionMode::Commit,
        };
        tx.execute(
            "UPDATE schedules SET next_run=? WHERE id=?",
            params![next(&expression, now())?, id],
        )?;
        tx.execute(
            "INSERT INTO jobs VALUES(?,?,NULL,'schedule_pending',?)",
            params![
                request.id.0,
                request.app.0,
                json!({"schedule":id,"invocation":request}).to_string()
            ],
        )?;
    }
    tx.commit()?;
    Ok(())
}
fn complete(store: &Store, id: &str, schedule: &str, result: Result<Outcome>) -> Result<()> {
    let mut db = store.open()?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if matches!(
        result,
        Err(Error::ExternalUncertain | Error::Conflict | Error::RecoveryRequired)
    ) {
        tx.execute("UPDATE schedules SET enabled=0 WHERE id=?", [schedule])?;
    }
    tx.execute("UPDATE jobs SET state=?,payload=json_set(payload,'$.result',json(?),'$.error',json(?)) WHERE id=?",params![
        if result.is_ok() {"completed"} else {"failed"},
        serde_json::to_string(&result.as_ref().ok()).map_err(|_| Error::Storage)?,
        serde_json::to_string(&result.err()).map_err(|_| Error::Storage)?,id])?;
    tx.commit()?;
    Ok(())
}
// Used on startup and after a failed completion write. Only undispatched work is replayed.
fn recover(store: &Store) -> Result<()> {
    let db = store.open()?;
    let mut q = db.prepare("SELECT id,payload FROM jobs WHERE state IN ('running','interrupted') AND json_extract(payload,'$.schedule') IS NOT NULL")?;
    let rows = q
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    for (id, raw) in rows {
        let payload: Value = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
        let request: Invocation =
            serde_json::from_value(payload["invocation"].clone()).map_err(|_| Error::Storage)?;
        if let Some(result) = store.invocation_outcome(&request)? {
            complete(
                store,
                &id,
                payload["schedule"].as_str().ok_or(Error::Storage)?,
                result,
            )?;
        } else if !db.query_row(
            "SELECT EXISTS(SELECT 1 FROM invocations WHERE id=?)",
            [&id],
            |r| r.get::<_, bool>(0),
        )? {
            db.execute("UPDATE jobs SET state='schedule_pending' WHERE id=?", [id])?;
        } else {
            complete(
                store,
                &id,
                payload["schedule"].as_str().ok_or(Error::Storage)?,
                Err(Error::RecoveryRequired),
            )?;
        }
    }
    Ok(())
}
async fn tick(runtime: &Runtime) -> Result<()> {
    let due = runtime
        .store
        .blocking(|store| {
            recover(&store)?;
            enqueue(&store)?;
            let db = store.open()?;
            let mut q = db.prepare(
                "SELECT id,payload FROM jobs WHERE state='schedule_pending' AND NOT EXISTS(SELECT 1 FROM archived_apps a WHERE a.app=jobs.app) ORDER BY rowid LIMIT 4",
            )?;
            let rows = q
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            rows.into_iter()
                .map(|(id, raw)| {
                    let payload: Value = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
                    let request: Invocation = serde_json::from_value(payload["invocation"].clone())
                        .map_err(|_| Error::Storage)?;
                    Ok((
                        id,
                        payload["schedule"]
                            .as_str()
                            .ok_or(Error::Storage)?
                            .to_owned(),
                        request,
                    ))
                })
                .collect::<Result<Vec<_>>>()
        })
        .await?;
    for (id, schedule, request) in due {
        if runtime.operations.stopping() {
            break;
        }
        runtime.operations.scheduler(true);
        let key = id.clone();
        runtime
            .store
            .blocking(move |store| {
                store.open()?.execute(
                    "UPDATE jobs SET state='running' WHERE id=? AND state='schedule_pending'",
                    [key],
                )?;
                Ok(())
            })
            .await?;
        let result = runtime
            .invoke(request, MockHttp::default(), Cancellation::default())
            .await;
        runtime
            .store
            .blocking(move |store| {
                if matches!(result, Err(Error::Saturated)) {
                    store
                        .open()?
                        .execute("UPDATE jobs SET state='schedule_pending' WHERE id=?", [id])?;
                    return Ok(());
                }
                complete(&store, &id, &schedule, result)
            })
            .await?;
    }
    Ok(())
}
pub async fn run(runtime: Runtime) {
    let mut last_error = None;
    while !runtime.operations.stopping() {
        let result = tick(&runtime).await;
        runtime.operations.scheduler(result.is_ok());
        if let Err(error) = result {
            if last_error != Some(error) {
                super::telemetry::error("scheduler.tick", error);
            }
            last_error = Some(error);
        } else {
            last_error = None;
        }
        tokio::select! { _=tokio::time::sleep(Duration::from_secs(1))=>{}, _=runtime.operations.stopped()=>{} }
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
            sqlite: false,
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

#[cfg(test)]
mod durability_tests {
    use super::*;
    #[tokio::test]
    async fn failed_completion_preserves_undispatched_batch_and_recovers_without_replay() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db")).unwrap();
        let secrets = secrets::Secrets::open(store.clone(), &dir.path().join("key")).unwrap();
        let runtime = Runtime::new(store.clone(), secrets, 4).unwrap();
        let app = store.create_app("Schedule").unwrap();
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
        for i in 0..4 {
            create(&store,json!({"app":app,"revision":rev.id,"action":"add","input":{"key":format!("{i}"),"title":"Scheduled"},"expression":"0 0 1 1 *"})).await.unwrap();
        }
        let db = store.open().unwrap();
        db.execute("UPDATE schedules SET next_run=0", []).unwrap();
        db.execute_batch("CREATE TRIGGER fail_job BEFORE UPDATE OF state ON jobs WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'test'); END").unwrap();
        assert_eq!(tick(&runtime).await, Err(Error::Storage));
        assert_eq!(store.snapshot(&app).unwrap().records.len(), 1);
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM jobs WHERE state='schedule_pending'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            3
        );
        db.execute_batch("DROP TRIGGER fail_job").unwrap();
        tick(&runtime).await.unwrap();
        let snapshot = store.snapshot(&app).unwrap();
        assert_eq!(snapshot.records.len(), 4);
        assert_eq!(snapshot.version, 4);
        assert_eq!(
            db.query_row(
                "SELECT COUNT(*) FROM jobs WHERE state='completed'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            4
        );
        tick(&runtime).await.unwrap();
        assert_eq!(store.snapshot(&app).unwrap().version, 4);
    }
}
