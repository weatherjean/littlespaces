use crate::{
    auth::Auth,
    automation,
    store::{execute, now, query, text, Store},
    vault,
};
use serde_json::json;
mod storage;
struct Fixture(Store);
impl Fixture {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("little-spaces-rust-unit-{}", crate::random_id()));
        Self(Store::new(dir).unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0.directory);
    }
}
#[tokio::test]
async fn remembered_sessions_lockout_and_revocation_survive_restart() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let auth = Auth::new(store).unwrap();
    auth.configure(store,&json!({"token":auth.setup_token,"email":"Test@example.com","password":"correct horse battery fixture","confirmation":"correct horse battery fixture"})).await.unwrap();
    let good = json!({"email":"test@example.com","password":"correct horse battery fixture","remember":true});
    for _ in 0..3 {
        assert!(auth
            .login(
                store,
                &json!({"email":"unknown@example.com","password":"wrong"})
            )
            .await
            .is_err());
    }
    assert!(auth
        .login(store, &good)
        .await
        .unwrap_err()
        .contains("locked"));
    let owner = crate::store::open(&store.directory.join("owner.sqlite")).unwrap();
    execute(
        &owner,
        "UPDATE owner SET locked_until=0,failures=0 WHERE id=1",
        &[],
    )
    .unwrap();
    drop(owner);
    let (session, _) = auth.login(store, &good).await.unwrap();
    assert_eq!(
        auth.session(store, &session).unwrap()["email"],
        "test@example.com"
    );
    let restarted = Auth::new(store).unwrap();
    assert!(restarted.session(store, &session).is_some());
    restarted.logout(store, &session, true).unwrap();
    assert!(auth.session(store, &session).is_none());
}
#[test]
fn secrets_are_encrypted_scoped_and_metadata_only() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    vault::save(store,&json!({"name":"SERVICE_KEY","value":"a-private-fixture-credential","description":"Service","origins":["https://api.example.com"]})).unwrap();
    let listed = vault::list(store).unwrap();
    assert!(!listed.to_string().contains("a-private-fixture-credential"));
    assert!(!listed.to_string().contains("ciphertext"));
    assert_eq!(
        vault::for_origin(store, "SERVICE_KEY", "https://api.example.com").unwrap(),
        "a-private-fixture-credential"
    );
    assert!(vault::for_origin(store, "SERVICE_KEY", "https://attacker.example").is_err());
    std::fs::remove_file(store.directory.join("secrets.key")).unwrap();
    assert!(vault::save(
        store,
        &json!({"name":"NEW_KEY","value":"replacement","description":"","origins":[]})
    )
    .is_err());
}
#[test]
fn restore_keeps_current_records_and_creates_new_version() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("Journal", "🌱").unwrap();
    let id = crate::random_uuid();
    let content = json!({"title":"Journal","description":"","source":"source-one","bundle":"source-one","backend":"","backendBundle":"","testReport":"[]","frontendFormat":"preact-htm"});
    let first = store
        .publish(text(&space, "id"), &id, &content, None, 0)
        .unwrap();
    execute(
        &store.applet(&id, false).unwrap(),
        "INSERT INTO records VALUES('entry',?)",
        &[json!(json!({"text":"Saved data"}).to_string())],
    )
    .unwrap();
    let mut changed = content.clone();
    changed["source"] = json!("source-two");
    store
        .publish(text(&space, "id"), &id, &changed, None, 1)
        .unwrap();
    let restored = store
        .publish(text(&space, "id"), &id, &first, Some(1), 2)
        .unwrap();
    assert_eq!(restored["version"], 3);
    assert_eq!(
        store.records(&id).unwrap()[0]["value"]["text"],
        "Saved data"
    );
    assert_eq!(restored["source"], "source-one");
    assert_eq!(store.versions(&id).unwrap().len(), 3);
}
#[test]
fn app_ids_cannot_escape_the_data_directory() {
    let fixture = Fixture::new();
    assert!(fixture.0.applet("../../owner", true).is_err());
    assert!(fixture
        .0
        .applet("00000000-0000-4000-8000-000000000099", false)
        .is_err());
}
#[test]
fn reminders_deduplicate_and_archived_apps_pause_delivery() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("Journal", "grid").unwrap();
    let id = text(&space, "id");
    let note =
        json!({"key":"check","title":"Check your journal","body":"A reminder","dueAt":now()});
    automation::notify(store, id, &note).unwrap();
    automation::notify(store, id, &note).unwrap();
    assert_eq!(
        automation::notifications(store, None, false)
            .unwrap()
            .as_array()
            .unwrap()
            .len(),
        1
    );
    execute(
        &store.workspace().unwrap(),
        "UPDATE spaces SET archived=1 WHERE id=?",
        &[json!(id)],
    )
    .unwrap();
    assert!(automation::notifications(store, None, false)
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn cron_uses_the_requested_timezone() {
    let after = chrono::DateTime::parse_from_rfc3339("2026-10-07T00:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    assert_eq!(
        automation::next_cron("0 9 * * *", "Europe/Ljubljana", after).unwrap(),
        "2026-10-07T07:00:00.000Z"
    );
    assert!(automation::next_cron("invalid", "Europe/Ljubljana", after).is_err());
    assert!(automation::next_cron("0 9 * * *", "Invalid/Zone", after).is_err());
}
#[test]
fn workspace_import_preserves_linked_app_identity() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("Existing", "grid").unwrap();
    let id = crate::random_uuid();
    store
        .publish(
            text(&space, "id"),
            &id,
            &json!({"title":"Existing","description":"","source":"legacy","bundle":"legacy"}),
            None,
            0,
        )
        .unwrap();
    store.import_legacy().unwrap();
    assert_eq!(store.spaces(false).unwrap().len(), 1);
    let rows = query(
        &store.workspace().unwrap(),
        "SELECT * FROM space_applets",
        &[],
    )
    .unwrap();
    assert_eq!(rows[0]["space_id"], space["id"]);
}

#[tokio::test]
async fn importer_preserves_password_records_and_vault_without_modifying_source() {
    let fixture = Fixture::new();
    let source = &fixture.0;
    let auth = Auth::new(source).unwrap();
    let credentials = json!({"token":auth.setup_token,"email":"test@example.com","password":"correct horse battery fixture","confirmation":"correct horse battery fixture"});
    auth.configure(source, &credentials).await.unwrap();
    let space = source.create_space("Original app", "leaf").unwrap();
    let id = crate::random_uuid();
    source.publish(text(&space,"id"),&id,&json!({"title":"Original app","description":"","source":"legacy source","bundle":"legacy bundle"}),None, 0).unwrap();
    execute(
        &source.applet(&id, false).unwrap(),
        "INSERT INTO records VALUES('original',?)",
        &[json!(json!({"text":"Preserve this"}).to_string())],
    )
    .unwrap();
    vault::save(source,&json!({"name":"SERVICE_KEY","value":"a-private-fixture-credential","description":"Service","origins":["https://api.example.com"]})).unwrap();
    let before = source.revision(&id, None).unwrap();
    let destination = source
        .directory
        .with_file_name(format!("little-spaces-imported-{}", crate::random_id()));
    crate::cli::import_into(&source.directory, &destination).unwrap();
    let imported = Fixture(Store::new(destination).unwrap());
    assert_eq!(imported.0.revision(&id, None).unwrap(), before);
    assert_eq!(
        imported.0.records(&id).unwrap(),
        source.records(&id).unwrap()
    );
    assert_eq!(source.revision(&id, None).unwrap(), before);
    let imported_auth = Auth::new(&imported.0).unwrap();
    assert!(imported_auth
        .login(
            &imported.0,
            &json!({"email":"test@example.com","password":"correct horse battery fixture"})
        )
        .await
        .is_ok());
    assert_eq!(
        vault::for_origin(&imported.0, "SERVICE_KEY", "https://api.example.com").unwrap(),
        "a-private-fixture-credential"
    );
    assert!(crate::cli::import_into(&source.directory, &imported.0.directory).is_err());
}
#[test]
fn uncertain_plant_identification_never_becomes_a_watering_instruction() {
    let value=crate::vision::parse_plant(&json!({"identified":false,"name":"Unknown plant","scientificName":"","confidence":"high","explanation":"Unclear image","alternatives":[],"needsAnotherPhoto":false,"intervalDays":7,"wateringAdvice":"Check soil"}).to_string()).unwrap();
    assert_eq!(value["confidence"], "low");
    assert_eq!(value["intervalDays"], serde_json::Value::Null);
    assert_eq!(value["needsAnotherPhoto"], true);
}

#[test]
fn cron_preserves_day_of_week_and_extended_weekday_semantics() {
    let after = chrono::DateTime::parse_from_rfc3339("2026-10-07T00:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    for expression in ["0 9 1 * 1", "0 9 * * 1#2"] {
        assert_eq!(
            automation::next_cron(expression, "Europe/Ljubljana", after).unwrap(),
            "2026-10-12T07:00:00.000Z"
        );
    }
}

#[test]
fn app_http_grants_are_private_persistent_and_independent_of_code_restore() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let a = crate::random_uuid();
    let b = crate::random_uuid();
    let space_a = store.create_space("A", "grid").unwrap();
    let space_b = store.create_space("B", "grid").unwrap();
    let content = json!({"title":"App","description":"","source":"one","bundle":"one"});
    let revision = store
        .publish(text(&space_a, "id"), &a, &content, None, 0)
        .unwrap();
    store
        .publish(text(&space_b, "id"), &b, &content, None, 0)
        .unwrap();
    assert_eq!(crate::capabilities::grants(store, &a).unwrap(), json!([]));
    let policy =
        json!([{"origin":"https://api.example.com","methods":["GET"],"secrets":["SERVICE_KEY"]}]);
    crate::capabilities::save(store, &a, &policy).unwrap();
    assert_eq!(crate::capabilities::grants(store, &b).unwrap(), json!([]));
    let request = json!({"url":"https://api.example.com/items","headers":{"Authorization":{"secret":"SERVICE_KEY","prefix":"Bearer "}}});
    assert!(crate::capabilities::check(&policy, &request).is_ok());
    assert!(
        crate::capabilities::check(&crate::capabilities::grants(store, &b).unwrap(), &request)
            .is_err()
    );
    assert!(crate::capabilities::check(
        &policy,
        &json!({"url":"https://api.example.com/items","method":"POST"})
    )
    .is_err());
    assert!(crate::capabilities::check(&policy,&json!({"url":"https://api.example.com/items","headers":{"Authorization":{"secret":"OTHER_KEY"}}})).is_err());
    crate::capabilities::save(store, &a, &json!([])).unwrap();
    store
        .publish(text(&space_a, "id"), &a, &revision, Some(1), 1)
        .unwrap();
    assert_eq!(crate::capabilities::grants(store, &a).unwrap(), json!([]));
    assert!(crate::capabilities::normalize(
        &json!([{"origin":"http://api.example.com","methods":["GET"],"secrets":[]}])
    )
    .is_err());
}

#[test]
fn diagnostics_are_bounded_sanitized_and_partitioned_by_app_and_revision() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let a = crate::random_uuid();
    let b = crate::random_uuid();
    store.applet(&a, true).unwrap();
    store.applet(&b, true).unwrap();
    for i in 0..105 {
        crate::diagnostics::record(
            store,
            &a,
            1,
            "frontend.error",
            &json!({"message":i,"password":"private"}),
        )
        .unwrap();
    }
    assert_eq!(
        query(
            &store.applet(&a, false).unwrap(),
            "SELECT COUNT(*) AS n FROM app_diagnostics",
            &[]
        )
        .unwrap()[0]["n"],
        100
    );
    let reports = crate::diagnostics::read(store, &a, 1, None, 30).unwrap();
    assert_eq!(reports["reports"].as_array().unwrap().len(), 30);
    assert!(!reports.to_string().contains("private"));
    assert_eq!(
        crate::diagnostics::read(store, &a, 2, None, 30).unwrap()["reports"],
        json!([])
    );
    assert_eq!(
        crate::diagnostics::read(store, &b, 1, None, 30).unwrap()["reports"],
        json!([])
    );
}

#[test]
fn incremental_commits_touch_only_changed_rows_and_reject_stale_snapshots() {
    use std::collections::BTreeMap;
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("Journal", "grid").unwrap();
    let id = crate::random_uuid();
    let content = json!({"title":"Journal","description":"","source":"one","bundle":"one"});
    let revision = store
        .publish(text(&space, "id"), &id, &content, None, 0)
        .unwrap();
    let db = store.applet(&id, false).unwrap();
    db.execute_batch("INSERT INTO records VALUES('untouched','1'),('changed','2'),('removed','3'); CREATE TABLE audit(operation TEXT,key TEXT); CREATE TRIGGER audit_delete AFTER DELETE ON records BEGIN INSERT INTO audit VALUES('delete',old.key); END; CREATE TRIGGER audit_insert AFTER INSERT ON records BEGIN INSERT INTO audit VALUES('insert',new.key); END; CREATE TRIGGER audit_update AFTER UPDATE ON records BEGIN INSERT INTO audit VALUES('update',new.key); END;").unwrap();
    let old = BTreeMap::from([
        ("untouched".into(), json!(1)),
        ("changed".into(), json!(2)),
        ("removed".into(), json!(3)),
    ]);
    let changed = BTreeMap::from([
        ("untouched".into(), json!(1)),
        ("changed".into(), json!(4)),
        ("added".into(), json!(5)),
    ]);
    crate::backend::commit_records(store, &id, &revision["version"], &old, &changed, false)
        .unwrap();
    let audit = query(&db, "SELECT * FROM audit ORDER BY key", &[]).unwrap();
    assert_eq!(audit,json!([{"operation":"insert","key":"added"},{"operation":"update","key":"changed"},{"operation":"delete","key":"removed"}]).as_array().unwrap().clone());
    let before = store.records(&id).unwrap();
    assert!(
        crate::backend::commit_records(store, &id, &revision["version"], &old, &old, false)
            .is_err()
    );
    store
        .publish(text(&space, "id"), &id, &content, None, 1)
        .unwrap();
    let error =
        crate::backend::commit_records(store, &id, &revision["version"], &changed, &old, true)
            .unwrap_err();
    assert!(error.contains("External changes may already have occurred"));
    assert_eq!(store.records(&id).unwrap(), before);
}

#[tokio::test]
async fn action_contracts_are_bound_to_source_and_effects_are_host_checked() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("App", "grid").unwrap();
    let id = crate::random_uuid();
    let source = "const actions={list:{readOnly:true,run:()=>[]}}";
    let action = json!({"name":"list","description":"List","parameters":{"type":"object"},"output":true,"readOnly":true,"http":[],"effects":{"records":"read","http":"none"}});
    let actions = vec![action.clone()];
    let content = json!({"title":"App","description":"","source":"ui","bundle":"ui","backend":source,"actionContract":crate::backend::contract(source,&actions).to_string()});
    let mut revision = store
        .publish(text(&space, "id"), &id, &content, None, 0)
        .unwrap();
    assert_eq!(
        crate::backend::catalog(store, &id, &revision)
            .await
            .unwrap(),
        actions
    );
    revision["backend"] = json!("different source");
    assert!(crate::backend::catalog(store, &id, &revision)
        .await
        .unwrap_err()
        .contains("does not match"));
    let mut forged = action;
    forged["effects"]["records"] = json!("write");
    assert!(crate::backend::validate_catalog(&[forged.clone()]).is_err());
    forged["effects"]["records"] = json!("read");
    forged["effects"]["http"] = json!("write");
    forged["http"] = json!([{"origin":"https://api.example.com","methods":["POST"],"secrets":[]}]);
    assert!(crate::backend::validate_catalog(&[forged]).is_err());
}

#[tokio::test]
async fn debugging_tools_do_not_grant_permissions_or_bypass_turn_restrictions() {
    use std::sync::{Arc, Mutex};
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("App", "grid").unwrap();
    let id = crate::random_uuid();
    store
        .publish(
            text(&space, "id"),
            &id,
            &json!({"title":"App","description":"","source":"ui","bundle":"ui"}),
            None,
            0,
        )
        .unwrap();
    let app = crate::App {
        store: store.clone(),
        assets: std::path::PathBuf::new(),
        origin: "http://localhost".into(),
        secure: false,
        auth: Arc::new(Auth::new(store).unwrap()),
        actions: Arc::new(tokio::sync::Semaphore::new(4)),
        turns: Arc::new(tokio::sync::Semaphore::new(1)),
        codex: Arc::new(tokio::sync::Mutex::new(None)),
        account: Arc::new(Mutex::new(json!({}))),
        models: Arc::new(Mutex::new(json!([]))),
        cancellations: Arc::new(Mutex::new(std::collections::HashMap::new())),
    };
    let mut tools = crate::tools::Tools {
        app,
        space: text(&space, "id").into(),
        chat: crate::random_uuid(),
        mode: "knowledge".into(),
        model: "fixture".into(),
        approved: None,
        skill_loaded: false,
    };
    assert_eq!(
        tools.execute("read_applet_sdk", json!({})).await.unwrap()["sdkVersion"],
        1
    );
    assert!(!tools.skill_loaded);
    assert!(tools
        .execute("save_app_permissions", json!({"grants":[]}))
        .await
        .is_err());
    assert!(tools
        .execute("debug_draft_action", json!({}))
        .await
        .is_err());
    for mode in ["voice", "scheduled"] {
        tools.mode = mode.into();
        for tool in [
            "debug_action",
            "inspect_frontend",
            "read_app_diagnostics",
            "debug_draft_action",
            "read_external_operations",
        ] {
            assert!(tools
                .execute(tool, json!({}))
                .await
                .unwrap_err()
                .contains("unavailable"));
        }
    }
    assert_eq!(crate::capabilities::grants(store, &id).unwrap(), json!([]));
}

#[tokio::test]
async fn permission_and_contract_reads_surface_database_errors() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let id = crate::random_uuid();
    let db = store.applet(&id, true).unwrap();
    assert_eq!(crate::capabilities::grants(store, &id).unwrap(), json!([]));
    db.execute_batch(
        "ALTER TABLE http_grants RENAME COLUMN grants TO broken;
                      ALTER TABLE backend_contracts RENAME COLUMN contract TO broken;",
    )
    .unwrap();
    assert!(crate::capabilities::grants(store, &id)
        .unwrap_err()
        .contains("no such column"));
    let revision = json!({"backend":"const actions={read:{readOnly:true,run:()=>[]}}"});
    // A damaged cache must fail before attempting to inspect untrusted code again.
    assert!(crate::backend::catalog(store, &id, &revision)
        .await
        .unwrap_err()
        .contains("no such column"));
}

#[tokio::test]
async fn host_read_only_authority_rejects_external_writes_before_recording_intent() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let id = crate::random_uuid();
    store.applet(&id, true).unwrap();
    let policy = json!([{"origin":"https://api.example.com","methods":["POST"],"secrets":[]}]);
    crate::capabilities::save(store, &id, &policy).unwrap();
    let authority = crate::broker::Authority {
        store,
        applet_id: &id,
        http: &policy,
        read_only: true,
    };
    let mut diagnostics = vec![];
    let error = crate::broker::request_for_action(
        &authority,
        "read",
        &json!({"url":"https://api.example.com/items","method":"POST"}),
        &mut diagnostics,
    )
    .await
    .unwrap_err();
    assert!(error.contains("cannot use that HTTP method"));
    assert!(diagnostics.is_empty());
    assert!(query(
        &store.applet(&id, false).unwrap(),
        "SELECT * FROM external_operations",
        &[]
    )
    .unwrap()
    .is_empty());
}

#[test]
fn competing_record_commits_save_one_snapshot_and_report_the_conflict() {
    use std::{collections::BTreeMap, sync::Arc, sync::Barrier};
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("App", "grid").unwrap();
    let id = crate::random_uuid();
    let revision = store
        .publish(
            text(&space, "id"),
            &id,
            &json!({"title":"App","description":"","source":"ui","bundle":"ui"}),
            None,
            0,
        )
        .unwrap();
    let barrier = Arc::new(Barrier::new(3));
    let threads: Vec<_> = (1..=2)
        .map(|value| {
            let store = store.clone();
            let id = id.clone();
            let version = revision["version"].clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                crate::backend::commit_records(
                    &store,
                    &id,
                    &version,
                    &BTreeMap::new(),
                    &BTreeMap::from([("winner".into(), json!(value))]),
                    false,
                )
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect();
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let error = results.into_iter().find_map(Result::err).unwrap();
    assert!(
        error.contains("App data changed while the action ran"),
        "{error}"
    );
    let records = store.records(&id).unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["key"], "winner");
    assert!(matches!(records[0]["value"].as_i64(), Some(1 | 2)));
}
