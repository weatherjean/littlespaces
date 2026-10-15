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
    assert!(created.status.success(), "{created:?}");
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
    assert!(success.status.success(), "{success:?}");
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
        "{output:?}"
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
        "{output:?}"
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

fn sql_worker(request: Value, timeout_ms: u64) -> Value {
    use std::io::{Read, Write};
    use std::process::Stdio;
    let mut child = Command::new(env!("CARGO_BIN_EXE_little-spaces"))
        .arg("--sql-worker")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let bytes = serde_json::to_vec(&json!({"request":request,"timeout_ms":timeout_ms})).unwrap();
    let mut input = child.stdin.take().unwrap();
    input
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .unwrap();
    input.write_all(&bytes).unwrap();
    drop(input);
    let mut output = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output.read_to_end(&mut bytes).unwrap();
        let _ = tx.send(bytes);
    });
    let result = rx.recv_timeout(std::time::Duration::from_secs(5));
    let _ = child.kill();
    let _ = child.wait();
    reader.join().unwrap();
    let bytes = result.expect("SQL worker exceeded wall-clock bound");
    assert!(
        bytes.len() >= 4,
        "SQL worker exited without a bounded result"
    );
    let len = u32::from_be_bytes(bytes[..4].try_into().unwrap()) as usize;
    assert_eq!(len, bytes.len() - 4);
    serde_json::from_slice(&bytes[4..]).unwrap()
}
#[test]
fn sql_worker_caps_sort_memory_and_remains_usable() {
    let output = sql_worker(
        json!({"Inspect":{"sqlite":"","query":{"sql":"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) SELECT x FROM n ORDER BY randomblob(16000)","params":[]}}}),
        10000,
    );
    assert!(output.get("Err").is_some(), "{output}");
    let output = sql_worker(
        json!({"Inspect":{"sqlite":"","query":{"sql":"SELECT 1 AS ok","params":[]}}}),
        1000,
    );
    assert_eq!(output["Ok"]["report"], json!([{"ok":1}]));
}
#[test]
fn sql_worker_migration_and_readonly_inspection() {
    let migrated = sql_worker(
        json!({"Migrate":{"before":"","sqlite":"","queries":[
            {"sql":"CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT)","params":[]},
            {"sql":"INSERT INTO notes VALUES(1,'kept')","params":[]}
        ]}}),
        1000,
    );
    let sqlite = migrated["Ok"]["sqlite"].as_str().expect("migration image");
    let read = sql_worker(
        json!({"Inspect":{"sqlite":sqlite,"query":{"sql":"SELECT body FROM notes","params":[]}}}),
        1000,
    );
    assert_eq!(read["Ok"]["report"], json!([{"body":"kept"}]));
    let write = sql_worker(
        json!({"Inspect":{"sqlite":sqlite,"query":{"sql":"DELETE FROM notes","params":[]}}}),
        1000,
    );
    assert!(write.get("Err").is_some());
    let busy = sql_worker(
        json!({"Inspect":{"sqlite":sqlite,"query":{"sql":"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1000000000) SELECT sum(x) FROM n","params":[]}}}),
        50,
    );
    assert!(busy.get("Err").is_some());
}

#[cfg(all(unix, feature = "development-fixtures"))]
#[tokio::test]
async fn sigterm_drains_an_admitted_action_before_releasing_workspace() {
    use std::io::Write;
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    struct Server(std::process::Child);
    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let (workspace, app) = fixture(
        dir.path(),
        "fn run(input) { if input.stress { test_pause(1500); } db_set(\"kept\",1); 1 }",
    );
    let mut reset = Command::new(env!("CARGO_BIN_EXE_little-spaces"))
        .arg("owner-reset")
        .arg(&workspace)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    reset
        .stdin
        .take()
        .unwrap()
        .write_all(b"synthetic-shutdown-password")
        .unwrap();
    assert!(reset.wait().unwrap().success());
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let origin = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_little-spaces"));
    for (key, _) in std::env::vars().filter(|(key, _)| key.starts_with("LITTLESPACES_")) {
        command.env_remove(key);
    }
    let mut server = Server(
        command
            .arg("serve")
            .arg(&workspace)
            .arg(port.to_string())
            .env("LITTLESPACES_ACTION_TIMEOUT_SECONDS", "5")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let start = Instant::now();
    loop {
        if client
            .get(format!("{origin}/api/session"))
            .send()
            .await
            .is_ok()
        {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(server.0.try_wait().unwrap().is_none());
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    let response = client
        .post(format!("{origin}/api/login"))
        .header("origin", &origin)
        .json(&json!({"password":"synthetic-shutdown-password"}))
        .send()
        .await
        .unwrap();
    assert!(response.status().is_success());
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session: Value = response.json().await.unwrap();
    let request=client.post(format!("{origin}/api/action")).header("origin",&origin)
        .header("cookie",cookie).header("x-csrf-token",session["csrf"].as_str().unwrap())
        .json(&json!({"id":"shutdown-action","app":app["app"],"revision":app["revision"],"action":"run","input":{"stress":true},"mode":"commit"}));
    let response = tokio::spawn(async move { request.send().await.unwrap() });
    let db = rusqlite::Connection::open(workspace.join("workspace.sqlite")).unwrap();
    let start = Instant::now();
    loop {
        let running:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM invocations WHERE id='shutdown-action' AND state='running')",[],|r|r.get(0)).unwrap();
        if running {
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(
        unsafe { libc::kill(server.0.id() as i32, libc::SIGTERM) },
        0
    );
    assert!(response.await.unwrap().status().is_success());
    let start = Instant::now();
    loop {
        if let Some(status) = server.0.try_wait().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(start.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(
        db.query_row("SELECT value FROM records WHERE key='kept'", [], |r| r
            .get::<_, String>(
            0
        ))
        .unwrap(),
        "1"
    );
    assert!(run("storage", &workspace, &[]).status.success());
}
