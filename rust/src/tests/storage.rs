use super::Fixture;
use crate::store::{execute, first, query, text, Store, LAUNCHER};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::sync::{Arc, Barrier};

fn content(title: &str) -> Value {
    json!({"title":title,"description":"","source":"ui","bundle":"ui"})
}

fn together<T: Send + 'static>(tasks: Vec<impl FnOnce() -> T + Send + 'static>) -> Vec<T> {
    let barrier = Arc::new(Barrier::new(tasks.len() + 1));
    let threads: Vec<_> = tasks
        .into_iter()
        .map(|task| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                task()
            })
        })
        .collect();
    barrier.wait();
    threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect()
}

#[test]
fn concurrent_legacy_applet_upgrades_preserve_data_and_stop_repeating_ddl() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let id = crate::random_uuid();
    let db =
        Connection::open(store.directory.join("applets").join(format!("{id}.sqlite"))).unwrap();
    db.execute_batch("PRAGMA journal_mode=WAL;
        CREATE TABLE records(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE revisions(version INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT NOT NULL,source TEXT NOT NULL,bundle TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT 'legacy');
        INSERT INTO records VALUES('kept','42');
        INSERT INTO revisions(title,description,source,bundle) VALUES('Legacy','','source','bundle');").unwrap();
    drop(db);
    let tasks: Vec<_> = (0..4)
        .map(|_| {
            let store = store.clone();
            let id = id.clone();
            move || store.applet(&id, false).map(|_| ())
        })
        .collect();
    for result in together(tasks) {
        result.unwrap();
    }
    assert_eq!(
        store.records(&id).unwrap(),
        json!([{"key":"kept","value":42}])
            .as_array()
            .unwrap()
            .clone()
    );
    assert_eq!(store.revision(&id, None).unwrap()["actionContract"], "");
    let db = store.applet(&id, false).unwrap();
    let schema: i64 = db
        .pragma_query_value(None, "schema_version", |row| row.get(0))
        .unwrap();
    drop(db);
    let db = store.applet(&id, false).unwrap();
    assert_eq!(
        db.pragma_query_value(None, "schema_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        schema
    );
    assert_eq!(
        db.pragma_query_value(None, "journal_mode", |row| row.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
}

#[test]
fn concurrent_workspace_upgrades_recheck_columns_under_the_write_lock() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let db = store.workspace().unwrap();
    db.execute_batch("DROP INDEX space_applets_one_per_space; ALTER TABLE spaces DROP COLUMN archived; PRAGMA user_version=0; PRAGMA journal_mode=WAL;").unwrap();
    drop(db);
    let tasks: Vec<_> = (0..4)
        .map(|_| {
            let directory = store.directory.clone();
            move || Store::new(directory).map(|_| ())
        })
        .collect();
    for result in together(tasks) {
        result.unwrap();
    }
    assert_eq!(store.space(LAUNCHER).unwrap()["archived"], 0);
    let db = store.workspace().unwrap();
    assert!(execute(
        &db,
        "INSERT INTO space_applets VALUES(?,?)",
        &[json!(crate::random_uuid()), json!("same")]
    )
    .is_ok());
    assert!(execute(
        &db,
        "INSERT INTO space_applets VALUES(?,?)",
        &[json!(crate::random_uuid()), json!("same")]
    )
    .is_err());
}

#[test]
fn incompatible_legacy_links_roll_back_the_entire_upgrade() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let db = store.workspace().unwrap();
    db.execute_batch("DROP INDEX space_applets_one_per_space; ALTER TABLE spaces DROP COLUMN archived; PRAGMA user_version=0;
        INSERT INTO space_applets VALUES('first','same'),('second','same');").unwrap();
    drop(db);
    let error = Store::new(store.directory.clone()).err().unwrap();
    assert!(error.contains("multiple applets"));
    let db = store.workspace().unwrap();
    assert_eq!(
        query(&db, "SELECT * FROM space_applets", &[])
            .unwrap()
            .len(),
        2
    );
    assert!(!query(&db, "PRAGMA table_info(spaces)", &[])
        .unwrap()
        .iter()
        .any(|row| text(row, "name") == "archived"));
    assert_eq!(
        db.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
}

#[test]
fn future_applet_schema_is_rejected_without_schema_changes() {
    let fixture = Fixture::new();
    let id = crate::random_uuid();
    let db = fixture.0.applet(&id, true).unwrap();
    db.execute_batch("PRAGMA user_version=999;").unwrap();
    let schema: i64 = db
        .pragma_query_value(None, "schema_version", |row| row.get(0))
        .unwrap();
    assert!(fixture
        .0
        .applet(&id, false)
        .err()
        .unwrap()
        .contains("newer"));
    assert_eq!(
        db.pragma_query_value(None, "schema_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        schema
    );
}

#[test]
fn concurrent_publications_require_the_same_base_version_under_lock() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("Original", "grid").unwrap();
    let space = text(&space, "id").to_string();
    let id = crate::random_uuid();
    store
        .publish(&space, &id, &content("Original"), None, 0)
        .unwrap();
    execute(
        &store.applet(&id, false).unwrap(),
        "INSERT INTO records VALUES('kept','42')",
        &[],
    )
    .unwrap();
    let tasks: Vec<_> = ["First", "Second"]
        .into_iter()
        .map(|title| {
            let store = store.clone();
            let space = space.clone();
            let id = id.clone();
            move || store.publish(&space, &id, &content(title), None, 1)
        })
        .collect();
    let results = together(tasks);
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    assert!(results
        .iter()
        .find_map(|result| result.as_ref().err())
        .unwrap()
        .contains("changed"));
    let winner = results.into_iter().find_map(Result::ok).unwrap();
    assert_eq!(winner["version"], 2);
    assert_eq!(store.revision(&id, None).unwrap()["title"], winner["title"]);
    assert_eq!(store.space(&space).unwrap()["name"], winner["title"]);
    assert_eq!(store.versions(&id).unwrap().len(), 2);
    assert_eq!(store.records(&id).unwrap()[0]["value"], 42);
}

#[test]
fn concurrent_new_applets_cannot_claim_the_same_space() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("App", "grid").unwrap();
    let space = text(&space, "id").to_string();
    let ids = [crate::random_uuid(), crate::random_uuid()];
    let tasks: Vec<_> = ids
        .iter()
        .map(|id| {
            let store = store.clone();
            let space = space.clone();
            let id = id.clone();
            move || store.publish(&space, &id, &content("App"), None, 0)
        })
        .collect();
    let results = together(tasks);
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let linked = store.applet_id(&space).unwrap();
    for id in ids {
        assert_eq!(
            store.versions(&id).unwrap().len(),
            usize::from(id == linked)
        );
    }
}

#[test]
fn workspace_update_failure_rolls_back_the_revision_and_link() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let space = store.create_space("Original", "grid").unwrap();
    let space = text(&space, "id");
    let id = crate::random_uuid();
    store.workspace().unwrap().execute_batch("CREATE TRIGGER fail_publication BEFORE UPDATE ON spaces BEGIN SELECT RAISE(ABORT,'injected workspace failure'); END;").unwrap();
    let error = store
        .publish(space, &id, &content("Changed"), None, 0)
        .unwrap_err();
    assert!(error.contains("injected workspace failure"));
    assert!(store.versions(&id).unwrap().is_empty());
    assert!(store.applet_id(space).is_err());
    assert_eq!(store.space(space).unwrap()["name"], "Original");
}

#[test]
fn draft_outcome_failure_rolls_back_new_space_and_code_then_retries_once() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let id = crate::random_uuid();
    let chat = crate::random_uuid();
    let plan = json!({"id":crate::random_uuid(),"spaceId":LAUNCHER,"chatId":chat,"status":"running","title":"New app","emoji":"grid"});
    let draft = json!({"target":id,"baseVersion":0,"revision":3,"content":content("New app"),"prepared":content("New app")});
    store.json_save("build_plans", &chat, &plan).unwrap();
    store.json_save("build_drafts", &chat, &draft).unwrap();
    let db = store.workspace().unwrap();
    db.execute_batch("CREATE TRIGGER fail_draft_outcome BEFORE UPDATE ON build_drafts BEGIN SELECT RAISE(ABORT,'injected draft outcome failure'); END;").unwrap();
    let error = store
        .publish_draft(LAUNCHER, &chat, &plan, &draft)
        .unwrap_err();
    assert!(error.contains("injected draft outcome failure"));
    assert!(store.spaces(false).unwrap().is_empty());
    assert!(store.versions(&id).unwrap().is_empty());
    assert_eq!(store.json_row("build_plans", &chat).unwrap(), plan);
    assert_eq!(store.json_row("build_drafts", &chat).unwrap(), draft);
    db.execute_batch("DROP TRIGGER fail_draft_outcome").unwrap();
    let result = store.publish_draft(LAUNCHER, &chat, &plan, &draft).unwrap();
    assert_eq!(store.spaces(false).unwrap().len(), 1);
    assert_eq!(
        store.json_row("build_plans", &chat).unwrap()["status"],
        "complete"
    );
    assert_eq!(
        store.json_row("build_drafts", &chat).unwrap()["published"],
        result["applet"]
    );
    assert_eq!(store.applet_id(text(&result, "spaceId")).unwrap(), id);
    assert!(store.publish_draft(LAUNCHER, &chat, &plan, &draft).is_err());
    assert_eq!(store.versions(&id).unwrap().len(), 1);
}

#[test]
fn changed_draft_or_revoked_approval_cannot_publish() {
    let fixture = Fixture::new();
    let store = &fixture.0;
    let id = crate::random_uuid();
    let chat = crate::random_uuid();
    let mut plan = json!({"id":crate::random_uuid(),"spaceId":LAUNCHER,"chatId":chat,"status":"running","title":"App","emoji":"grid"});
    let draft = json!({"target":id,"baseVersion":0,"revision":1,"prepared":content("App")});
    store.json_save("build_plans", &chat, &plan).unwrap();
    let mut changed = draft.clone();
    changed["revision"] = json!(2);
    store.json_save("build_drafts", &chat, &changed).unwrap();
    assert!(store
        .publish_draft(LAUNCHER, &chat, &plan, &draft)
        .unwrap_err()
        .contains("Draft changed"));
    plan["status"] = json!("failed");
    store.json_save("build_plans", &chat, &plan).unwrap();
    assert!(store
        .publish_draft(LAUNCHER, &chat, &plan, &changed)
        .unwrap_err()
        .contains("approval"));
    assert!(store.spaces(false).unwrap().is_empty());
    assert!(store.versions(&id).unwrap().is_empty());
    assert!(first(
        &store.workspace().unwrap(),
        "SELECT applet_id FROM space_applets",
        &[]
    )
    .is_err());
}
