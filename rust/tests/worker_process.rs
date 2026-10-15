//! These exercise the actual executable boundary, not the unit-test evaluator shortcut.
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Command, Output},
};
fn run(command: &str, workspace: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_little-spaces"))
        .arg(command)
        .arg(workspace)
        .args(args)
        .env("LITTLESPACES_ACTION_TIMEOUT_SECONDS", "1")
        .output()
        .unwrap()
}
fn fixture(dir: &Path, backend: &str) -> (std::path::PathBuf, Value) {
    let workspace = dir.join("workspace");
    assert!(run("init", &workspace, &[]).status.success());
    let code = json!({"backend":backend,"frontend":"","actions":[{"name":"run","read_only":false,"input":{"type":"object","properties":{"stress":{"type":"boolean"}},"required":["stress"]},"output":{"type":"integer"}}],"tests":[{"action":"run","input":{"stress":false},"expected":1}]});
    let path = dir.join("app.json");
    std::fs::write(&path, code.to_string()).unwrap();
    let created = run(
        "create",
        &workspace,
        &["Worker test", path.to_str().unwrap()],
    );
    assert!(created.status.success(), "{:?}", created);
    let app: Value = serde_json::from_slice(&created.stdout).unwrap();
    let args = [
        app["app"].as_str().unwrap(),
        app["revision"].as_str().unwrap(),
    ];
    assert!(run("test", &workspace, &args).status.success());
    assert!(run("publish", &workspace, &args).status.success());
    (workspace, app)
}
#[test]
fn worker_allocation_failure_does_not_commit_and_host_can_execute_again() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace,app)=fixture(dir.path(),"fn run(input) { if input.stress { let a=[0]; for n in 0..8 { a=[a,a,a,a,a,a,a,a,a,a,a,a,a,a,a,a]; } } db_set(\"kept\",1); 1 }");
    let args = [
        app["app"].as_str().unwrap(),
        app["revision"].as_str().unwrap(),
        "run",
        "{\"stress\":true}",
    ];
    let start = std::time::Instant::now();
    let output = run("run", &workspace, &args);
    assert!(!output.status.success());
    assert!(start.elapsed() < std::time::Duration::from_secs(5));
    let db = rusqlite::Connection::open(workspace.join("workspace.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM records", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    let success = run(
        "run",
        &workspace,
        &[args[0], args[1], "run", "{\"stress\":false}"],
    );
    assert!(success.status.success(), "{:?}", success);
}
#[cfg(feature = "development-fixtures")]
#[test]
fn worker_deadline_preempts_native_callback() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, app) = fixture(
        dir.path(),
        "fn run(input) { if input.stress { test_pause(10000); } db_set(\"kept\",1); 1 }",
    );
    let start = std::time::Instant::now();
    let output = run(
        "run",
        &workspace,
        &[
            app["app"].as_str().unwrap(),
            app["revision"].as_str().unwrap(),
            "run",
            "{\"stress\":true}",
        ],
    );
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("deadline"),
        "{:?}",
        output
    );
    assert!(start.elapsed() < std::time::Duration::from_secs(4));
}

#[cfg(feature = "development-fixtures")]
#[test]
fn worker_native_allocation_is_capped() {
    let dir = tempfile::tempdir().unwrap();
    let (workspace, app) = fixture(
        dir.path(),
        "fn run(input) { if input.stress { test_allocate(); } db_set(\"kept\",1); 1 }",
    );
    let output = run(
        "run",
        &workspace,
        &[
            app["app"].as_str().unwrap(),
            app["revision"].as_str().unwrap(),
            "run",
            "{\"stress\":true}",
        ],
    );
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("script"),
        "{:?}",
        output
    );
    let db = rusqlite::Connection::open(workspace.join("workspace.sqlite")).unwrap();
    assert_eq!(
        db.query_row("SELECT COUNT(*) FROM records", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        db.query_row("SELECT state FROM invocations", [], |r| r
            .get::<_, String>(0))
            .unwrap(),
        "failed"
    );
}
