use crate::{
    auth::Auth,
    automation,
    store::{execute, now, query, text, Store},
    vault,
};
use serde_json::json;
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
        .publish(text(&space, "id"), &id, &content, None)
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
        .publish(text(&space, "id"), &id, &changed, None)
        .unwrap();
    let restored = store
        .publish(text(&space, "id"), &id, &first, Some(1))
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
    source.publish(text(&space,"id"),&id,&json!({"title":"Original app","description":"","source":"legacy source","bundle":"legacy bundle"}),None).unwrap();
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
