use super::Fixture;
use crate::{
    backend,
    broker::{
        self,
        operations::{self, Operation},
    },
    store::{execute, text},
};
use serde_json::json;
use std::collections::BTreeMap;

fn app(fixture: &Fixture) -> (String, serde_json::Value) {
    let space = fixture.0.create_space("App", "grid").unwrap();
    let id = crate::random_uuid();
    let revision = fixture
        .0
        .publish(
            text(&space, "id"),
            &id,
            &json!({"title":"App","description":"","source":"ui","bundle":"ui"}),
            None,
            0,
        )
        .unwrap();
    (id, revision)
}

#[tokio::test]
async fn response_headers_survive_redirect_and_body_failures() {
    let fixture = Fixture::new();
    let (id, revision) = app(&fixture);
    let failed_body = reqwest::Body::wrap_stream(futures_util::stream::iter([Err::<Vec<u8>, _>(
        std::io::Error::other("synthetic body failure"),
    )]));
    let cases = [
        (302, reqwest::Body::from("redirect"), "redirect_blocked"),
        (
            200,
            reqwest::Body::from(vec![b'x'; 1_000_001]),
            "body_too_large",
        ),
        (200, failed_body, "body_failed"),
    ];
    for (status, body, state) in cases {
        let operation = Operation::begin(
            &fixture.0,
            &id,
            revision["version"].as_i64().unwrap(),
            "send",
            "https://api.example.com",
            "POST",
        )
        .unwrap();
        operation.dispatched().unwrap();
        let response = reqwest::Response::from(
            axum::http::Response::builder()
                .status(status)
                .body(body)
                .unwrap(),
        );
        assert!(broker::read_response(response, &[], Some(&operation))
            .await
            .is_err());
        let evidence = operation.evidence().unwrap();
        assert_eq!(evidence["version"], revision["version"]);
        assert_eq!(evidence["status"], "response_received");
        assert_eq!(evidence["http_status"], status);
        assert_eq!(evidence["response_state"], state);
        assert_eq!(evidence["local_status"], "pending");
    }
}

#[tokio::test]
async fn local_commit_evidence_is_atomic_with_record_writes() {
    let fixture = Fixture::new();
    let (id, revision) = app(&fixture);
    let operation = Operation::begin(
        &fixture.0,
        &id,
        1,
        "send",
        "https://api.example.com",
        "POST",
    )
    .unwrap();
    operation.dispatched().unwrap();
    let response = reqwest::Response::from(
        axum::http::Response::builder()
            .status(500)
            .body("{\"error\":\"synthetic rejection\"}")
            .unwrap(),
    );
    let result = broker::read_response(response, &[], Some(&operation))
        .await
        .unwrap();
    assert_eq!(result["ok"], false);
    assert_eq!(
        operation.evidence().unwrap()["response_state"],
        "body_received"
    );
    let records = BTreeMap::from([("outcome".into(), json!("recorded"))]);
    let db = fixture.0.applet(&id, false).unwrap();
    db.execute_batch("CREATE TRIGGER fail_outcome BEFORE UPDATE OF local_status ON external_operations WHEN NEW.local_status='committed' BEGIN SELECT RAISE(ABORT,'injected outcome failure'); END;").unwrap();
    assert!(backend::commit_records(
        &fixture.0,
        &id,
        &revision["version"],
        &BTreeMap::new(),
        &records,
        std::slice::from_ref(&operation.id)
    )
    .is_err());
    assert!(fixture.0.records(&id).unwrap().is_empty());
    assert_eq!(operation.evidence().unwrap()["local_status"], "pending");
    db.execute_batch("DROP TRIGGER fail_outcome").unwrap();
    backend::commit_records(
        &fixture.0,
        &id,
        &revision["version"],
        &BTreeMap::new(),
        &records,
        std::slice::from_ref(&operation.id),
    )
    .unwrap();
    operations::uncommitted(&fixture.0, &id, std::slice::from_ref(&operation.id)).unwrap();
    assert_eq!(operation.evidence().unwrap()["local_status"], "committed");
    assert_eq!(operation.evidence().unwrap()["http_status"], 500);
    assert_eq!(fixture.0.records(&id).unwrap()[0]["value"], "recorded");
}

#[test]
fn interrupted_operations_remain_uncertain_and_inspection_is_scoped() {
    let fixture = Fixture::new();
    let (id, _) = app(&fixture);
    let operation = Operation::begin(
        &fixture.0,
        &id,
        1,
        "send",
        "https://api.example.com",
        "POST",
    )
    .unwrap();
    let operation_id = operation.id.clone();
    operation.dispatched().unwrap();
    assert!(
        operation.dispatched().is_err(),
        "A single intent must never be dispatched twice"
    );
    drop(operation);
    let restarted = crate::store::Store::new(fixture.0.directory.clone()).unwrap();
    let evidence = operations::read(&restarted, &id, Some(&operation_id), Some(1), 1).unwrap();
    assert_eq!(evidence["operations"][0]["status"], "uncertain");
    assert_eq!(evidence["operations"][0]["local_status"], "pending");
    assert_eq!(evidence["automaticRetry"], false);
    let other = crate::random_uuid();
    restarted.applet(&other, true).unwrap();
    assert_eq!(
        operations::read(&restarted, &other, Some(&operation_id), None, 1).unwrap()["operations"],
        json!([])
    );
    operations::uncommitted(&restarted, &id, std::slice::from_ref(&operation_id)).unwrap();
    assert_eq!(
        operations::read(&restarted, &id, Some(&operation_id), None, 1).unwrap()["operations"][0]
            ["local_status"],
        "not_committed"
    );
}

#[test]
fn old_operations_gain_unknown_metadata_without_inventing_a_revision() {
    let fixture = Fixture::new();
    let (id, _) = app(&fixture);
    let db = fixture.0.applet(&id, false).unwrap();
    db.execute_batch(
        "ALTER TABLE external_operations DROP COLUMN version;
        ALTER TABLE external_operations DROP COLUMN response_state;
        ALTER TABLE external_operations DROP COLUMN local_status;
        PRAGMA user_version=1;",
    )
    .unwrap();
    execute(&db,"INSERT INTO external_operations VALUES('old','send','https://api.example.com','POST','uncertain',NULL,'old','old')",&[]).unwrap();
    drop(db);
    let old = operations::read(&fixture.0, &id, Some("old"), None, 1).unwrap();
    assert_eq!(old["operations"][0]["version"], serde_json::Value::Null);
    assert_eq!(old["operations"][0]["response_state"], "unknown");
    assert_eq!(old["operations"][0]["local_status"], "unknown");
    assert_eq!(old["operations"][0]["status"], "uncertain");
}
