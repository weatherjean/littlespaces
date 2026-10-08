use littlespaces_rhai_prototype::{
    engine::{spec, Runtime},
    store::Store,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    net::TcpListener,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
struct Fixture {
    _directory: tempfile::TempDir,
    runtime: Runtime,
}
impl Fixture {
    fn new(url: Option<String>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let store = Store::new(&directory.path().join("prototype.sqlite")).unwrap();
        Self {
            _directory: directory,
            runtime: Runtime::new(store, url).unwrap(),
        }
    }
    fn call(&self, app: &str, action: &str, input: Value) -> Value {
        self.runtime
            .invoke(
                app,
                action,
                input,
                1,
                true,
                Arc::new(AtomicBool::new(false)),
            )
            .unwrap()["result"]
            .clone()
    }
    fn eval(&self, source: &str, action: &str, app: &str) -> std::result::Result<Value, String> {
        let spec = spec(app).unwrap();
        let metadata = spec.actions.iter().find(|a| a.name == action).unwrap();
        let input = if action == "add" {
            if app == "tasks" {
                json!({"title":"Test"})
            } else {
                json!({"text":"Test"})
            }
        } else {
            json!({})
        };
        self.runtime
            .evaluate(
                &self.runtime.store.snapshot(app).unwrap(),
                source,
                metadata,
                input,
                Arc::new(AtomicBool::new(false)),
            )
            .map(|e| e.result)
    }
}
struct Mock {
    url: String,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}
impl Mock {
    fn new(delay: Duration, body: String) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let signal = stop.clone();
        let thread = std::thread::spawn(move || {
            while !signal.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut request = [0; 4096];
                        let _ = stream.read(&mut request);
                        std::thread::sleep(delay);
                        let message=format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len());
                        let _ = stream.write_all(message.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url,
            stop,
            thread: Some(thread),
        }
    }
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}
#[test]
fn tasks_persist_and_complete_without_a_worker_process() {
    let f = Fixture::new(None);
    let added = f.call("tasks", "add", json!({"title":"  Walk the dog  "}));
    assert_eq!(added["value"]["title"], "Walk the dog");
    let completed = f.call("tasks", "complete", json!({"key":added["key"]}));
    assert_eq!(completed["done"], true);
    assert_eq!(
        f.call("tasks", "list", json!({})).as_array().unwrap().len(),
        1
    );
    let reopened = Store::new(&f._directory.path().join("prototype.sqlite")).unwrap();
    assert_eq!(
        reopened.snapshot("tasks").unwrap().records[added["key"].as_str().unwrap()]["done"],
        true
    );
}
#[test]
fn journal_lists_newest_first_and_is_separate_from_tasks() {
    let f = Fixture::new(None);
    f.call("journal", "add", json!({"text":"First"}));
    std::thread::sleep(Duration::from_millis(2));
    let latest = f.call("journal", "add", json!({"text":"Second"}));
    assert_eq!(
        f.call("journal", "list", json!({}))[0]["key"],
        latest["key"]
    );
    assert!(f
        .call("tasks", "list", json!({}))
        .as_array()
        .unwrap()
        .is_empty());
    assert!(f
        .runtime
        .invoke(
            "tasks",
            "complete",
            json!({"key":latest["key"]}),
            1,
            true,
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
}
#[test]
fn invalid_input_and_domain_errors_do_not_write() {
    let f = Fixture::new(None);
    for input in [
        json!({}),
        json!({"title":42}),
        json!({"title":"   "}),
        json!({"title":"okay","extra":true}),
    ] {
        assert!(f
            .runtime
            .invoke(
                "tasks",
                "add",
                input,
                1,
                true,
                Arc::new(AtomicBool::new(false))
            )
            .is_err());
    }
    assert!(f
        .runtime
        .store
        .snapshot("tasks")
        .unwrap()
        .records
        .is_empty());
}
#[test]
fn dry_run_and_errors_after_mutation_never_commit() {
    let f = Fixture::new(None);
    let result = f
        .runtime
        .invoke(
            "tasks",
            "add",
            json!({"title":"Dry run"}),
            1,
            false,
            Arc::new(AtomicBool::new(false)),
        )
        .unwrap();
    assert_eq!(result["committed"], false);
    assert!(f
        .eval(
            "fn add(input) { db_set(\"pending\",#{title:input.title}); throw \"abort\"; }",
            "add",
            "tasks"
        )
        .is_err());
    assert!(f
        .eval(
            "fn add(input) { db_set(\"pending\",#{title:input.title}); 42 }",
            "add",
            "tasks"
        )
        .is_err());
    assert!(f
        .runtime
        .store
        .snapshot("tasks")
        .unwrap()
        .records
        .is_empty());
}
#[test]
fn read_only_writes_are_blocked_even_when_caught() {
    let f = Fixture::new(None);
    assert!(f
        .eval("fn list(input) { db_set(\"bad\",1); [] }", "list", "tasks")
        .is_err());
    assert_eq!(
        f.eval(
            "fn list(input) { try { db_set(\"bad\",1); } catch(e) {} db_list() }",
            "list",
            "tasks"
        )
        .unwrap(),
        json!([])
    );
}
#[test]
fn no_sql_filesystem_import_or_dynamic_eval_capabilities() {
    let f = Fixture::new(None);
    for source in [
        "fn list(input) { import \"/etc/hosts\" as x; [] }",
        "fn list(input) { eval(\"40+2\") }",
        "fn list(input) { read_file(\"/etc/hosts\") }",
        "fn list(input) { sql(\"SELECT * FROM records\") }",
        "fn list(input) { db_get(\"journal\",\"key\") }",
    ] {
        assert!(f.eval(source, "list", "tasks").is_err(), "{source}");
    }
}
#[test]
fn budgets_stop_loops_recursion_and_oversized_values() {
    let f = Fixture::new(None);
    for source in [
        "fn list(input) { loop {} }",
        "fn recurse(n) { recurse(n+1) } fn list(input) { recurse(0) }",
        "fn list(input) { let x=\"abc\"; loop { x+=x; } }",
        "fn list(input) { let x=[]; loop { x.push(1); } }",
        "fn list(input) { let x=#{x:1}; loop { x.x=x; } }",
    ] {
        let started = Instant::now();
        assert!(f.eval(source, "list", "tasks").is_err(), "{source}");
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
#[test]
fn cancellation_stops_the_script_before_commit() {
    let f = Fixture::new(None);
    let cancelled = Arc::new(AtomicBool::new(true));
    assert!(f
        .runtime
        .invoke(
            "tasks",
            "add",
            json!({"title":"Cancelled"}),
            1,
            true,
            cancelled
        )
        .is_err());
    assert!(f
        .runtime
        .store
        .snapshot("tasks")
        .unwrap()
        .records
        .is_empty());
}
#[test]
fn stale_versions_and_snapshots_cannot_overwrite_data() {
    let f = Fixture::new(None);
    let before = f.runtime.store.snapshot("tasks").unwrap();
    f.call("tasks", "add", json!({"title":"Keep"}));
    assert!(f
        .runtime
        .store
        .commit(&before, &before.records)
        .unwrap_err()
        .contains("Conflict"));
    f.runtime.store.advance_revision("tasks").unwrap();
    assert!(f
        .runtime
        .invoke(
            "tasks",
            "add",
            json!({"title":"Old code"}),
            1,
            true,
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
    assert_eq!(f.runtime.store.snapshot("tasks").unwrap().records.len(), 1);
}
#[test]
fn concurrent_updates_have_one_winner() {
    let f = Fixture::new(None);
    let before = f.runtime.store.snapshot("tasks").unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let threads: Vec<_> = (1..=2)
        .map(|n| {
            let store = f.runtime.store.clone();
            let before = before.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let mut records = before.records.clone();
                records.insert("winner".into(), json!(n));
                store.commit(&before, &records)
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = threads.into_iter().map(|t| t.join().unwrap()).collect();
    assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
    assert_eq!(f.runtime.store.snapshot("tasks").unwrap().records.len(), 1);
}
#[test]
fn local_http_requires_action_declaration_and_owner_grant() {
    let server = Mock::new(
        Duration::ZERO,
        json!({"current":{"temperature_2m":18.5,"time":"fixture"}}).to_string(),
    );
    let f = Fixture::new(Some(server.url.clone()));
    assert!(f
        .runtime
        .invoke(
            "weather",
            "weather",
            json!({}),
            1,
            true,
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
    f.runtime.store.grant("weather", "weather").unwrap();
    assert_eq!(
        f.call("weather", "weather", json!({}))["temperatureC"],
        18.5
    );
    f.runtime.store.grant("tasks", "weather").unwrap();
    assert!(f
        .eval("fn list(input) { http_read(\"weather\") }", "list", "tasks")
        .is_err());
}
#[test]
fn slow_native_http_function_exceeds_the_script_deadline_but_cannot_commit() {
    let server = Mock::new(
        Duration::from_millis(150),
        json!({"current":{"temperature_2m":18.5,"time":"fixture"}}).to_string(),
    );
    let mut f = Fixture::new(Some(server.url.clone()));
    f.runtime.store.grant("weather", "weather").unwrap();
    f.runtime.limits.deadline = Duration::from_millis(40);
    let started = Instant::now();
    assert!(f
        .runtime
        .invoke(
            "weather",
            "weather",
            json!({}),
            1,
            true,
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
    let elapsed = started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(120),
        "The engine cannot preempt a blocking native function"
    );
    assert!(elapsed < Duration::from_secs(1));
    println!(
        "NEGATIVE FINDING: 40 ms script deadline returned after {} ms in host HTTP",
        elapsed.as_millis()
    );
}
#[test]
fn malformed_http_output_is_rejected() {
    let server = Mock::new(
        Duration::ZERO,
        json!({"current":{"temperature_2m":"wrong","time":"fixture"}}).to_string(),
    );
    let f = Fixture::new(Some(server.url.clone()));
    f.runtime.store.grant("weather", "weather").unwrap();
    assert!(f
        .runtime
        .invoke(
            "weather",
            "weather",
            json!({}),
            1,
            true,
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
}
#[test]
fn rejects_unbound_sources_and_nonprototype_databases() {
    let f = Fixture::new(None);
    let separate = f._directory.path().join("unbound.sqlite");
    let store = Store::new(&separate).unwrap();
    store.seed("tasks", "wrong").unwrap();
    let runtime = Runtime::new(store, None).unwrap();
    assert!(runtime
        .invoke(
            "tasks",
            "list",
            json!({}),
            1,
            true,
            Arc::new(AtomicBool::new(false))
        )
        .unwrap_err()
        .contains("unbound"));
    let before = f.runtime.store.snapshot("tasks").unwrap();
    let mut records = before.records.clone();
    records.insert("x".into(), json!(1));
    assert!(f.runtime.store.commit(&before, &records).is_ok());
    let path = f._directory.path().join("foreign.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch(
        "CREATE TABLE private_data(value TEXT); INSERT INTO private_data VALUES('synthetic');",
    )
    .unwrap();
    drop(db);
    assert!(Store::new(&path).is_err());
}
#[test]
fn fresh_calls_do_not_leak_script_globals() {
    let f = Fixture::new(None);
    assert_eq!(
        f.eval(
            "fn list(input) { let secret=42; [secret] }",
            "list",
            "tasks"
        )
        .unwrap(),
        json!([42])
    );
    assert!(f
        .eval("fn list(input) { [secret] }", "list", "tasks")
        .is_err());
}

#[test]
fn deadline_after_host_io_discards_proposed_local_writes() {
    let server = Mock::new(
        Duration::from_millis(150),
        json!({"current":{"temperature_2m":18.5,"time":"fixture"}}).to_string(),
    );
    let mut f = Fixture::new(Some(server.url.clone()));
    f.runtime.store.grant("tasks", "weather").unwrap();
    f.runtime.limits.deadline = Duration::from_millis(40);
    let mut action = spec("tasks").unwrap().actions.remove(0);
    action.http.push("weather".into());
    let before = f.runtime.store.snapshot("tasks").unwrap();
    let source="fn add(input) { db_set(\"pending\",#{title:input.title}); let response=http_read(\"weather\"); #{key:\"pending\",value:response} }";
    assert!(f
        .runtime
        .evaluate(
            &before,
            source,
            &action,
            json!({"title":"Must not persist"}),
            Arc::new(AtomicBool::new(false))
        )
        .is_err());
    assert!(f
        .runtime
        .store
        .snapshot("tasks")
        .unwrap()
        .records
        .is_empty());
}

#[tokio::test]
async fn simulated_ai_rejects_missing_completion_and_unknown_tools() {
    use littlespaces_rhai_prototype::ai;
    let f = Fixture::new(None);
    let missing = Mock::new(
        Duration::ZERO,
        "data: {\"type\":\"response.output_text.delta\",\"delta\":\"not complete\"}\n\n".into(),
    );
    assert!(ai::run(f.runtime.clone(), &missing.url, "Test")
        .await
        .unwrap_err()
        .contains("completion"));
    let unknown = json!({"type":"response.output_item.done","item":{"type":"function_call","namespace":"little_spaces","name":"shell","call_id":"bad","arguments":"{}"}});
    let done = json!({"type":"response.completed","response":{"status":"completed"}});
    let provider = Mock::new(
        Duration::ZERO,
        format!("data: {unknown}\n\ndata: {done}\n\n"),
    );
    assert!(ai::run(f.runtime.clone(), &provider.url, "Test")
        .await
        .unwrap_err()
        .contains("Unknown model tool"));
    assert!(f
        .runtime
        .store
        .snapshot("tasks")
        .unwrap()
        .records
        .is_empty());
}
