use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse},
    routing::{get, post},
    Json, Router,
};
use littlespaces_rhai_prototype::{
    ai,
    engine::{spec, Runtime},
    store::Store,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::Semaphore;
#[derive(Clone)]
struct App {
    runtime: Runtime,
    origin: String,
    actions: Arc<Semaphore>,
}
#[derive(Deserialize)]
struct Call {
    input: Value,
    version: i64,
    #[serde(default)]
    dry_run: bool,
}
struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}
fn origin(app: &App, headers: &HeaderMap) -> bool {
    headers
        .get("origin")
        .is_none_or(|origin| origin.to_str().is_ok_and(|value| value == app.origin))
}
async fn invoke(
    State(app): State<App>,
    Path((id, action)): Path<(String, String)>,
    headers: HeaderMap,
    Json(input): Json<Call>,
) -> axum::response::Response {
    if !origin(&app, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"Origin denied"})),
        )
            .into_response();
    }
    let Ok(permit) = app.actions.clone().try_acquire_owned() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error":"Busy"})),
        )
            .into_response();
    };
    let cancel = Arc::new(AtomicBool::new(false));
    let _guard = Cancel(cancel.clone());
    let result = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        app.runtime.invoke(
            &id,
            &action,
            input.input,
            input.version,
            !input.dry_run,
            cancel,
        )
    })
    .await;
    match result {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
        Err(error) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"error":error.to_string()})),
        )
            .into_response(),
    }
}
async fn catalog(State(app): State<App>, Path(id): Path<String>) -> axum::response::Response {
    match spec(&id).and_then(|spec| Ok(json!({"app":id,"version":app.runtime.store.snapshot(&id)?.version,"hash":spec.hash(),"actions":spec.actions}))) {
        Ok(value)=>Json(value).into_response(),Err(error)=>(StatusCode::BAD_REQUEST,Json(json!({"error":error}))).into_response()
    }
}
async fn ai_turn(
    State(app): State<App>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> axum::response::Response {
    if !origin(&app, &headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(_permit) = app.actions.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let message = input["message"].as_str().unwrap_or("Prototype task");
    match ai::run(
        app.runtime.clone(),
        &format!("{}/mock/responses", app.origin),
        message,
    )
    .await
    {
        Ok(value) => Json(value).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
    }
}
// Deterministic admission probe: trusted Rust work, never script-controlled.
async fn hold(State(app): State<App>) -> axum::response::Response {
    let Ok(_permit) = app.actions.clone().try_acquire_owned() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    Json(json!({"held":true})).into_response()
}
async fn provider(Json(input): Json<Value>) -> impl IntoResponse {
    let items = input["input"].as_array().cloned().unwrap_or_default();
    let output = if items
        .iter()
        .any(|item| item["type"] == "function_call_output")
    {
        json!({"type":"response.output_text.delta","delta":"Saved through the Rust-owned tool loop."})
    } else {
        json!({"type":"response.output_item.done","item":{"type":"function_call","namespace":"little_spaces","name":"invoke","call_id":"synthetic-1","arguments":json!({"app":"tasks","action":"add","input":{"title":items.first().and_then(|item|item["content"].as_str()).unwrap_or("Prototype task")}}).to_string()}})
    };
    let done = json!({"type":"response.completed","response":{"status":"completed"}});
    (
        [("content-type", "text/event-stream")],
        format!("data: {output}\n\ndata: {done}\n\n"),
    )
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|arg| arg == "--bench") {
        return bench();
    }
    let path = std::env::temp_dir().join(format!(
        "rhai-prototype-{:032x}.sqlite",
        rand::random::<u128>()
    ));
    let store = Store::new(&path).map_err(std::io::Error::other)?;
    let port = std::env::var("RHAI_PROTO_PORT")
        .unwrap_or("0".into())
        .parse::<u16>()?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let runtime = Runtime::new(store.clone(), Some(format!("{origin}/mock/weather")))
        .map_err(std::io::Error::other)?;
    store
        .grant("weather", "weather")
        .map_err(std::io::Error::other)?;
    let app = App {
        runtime,
        origin: origin.clone(),
        actions: Arc::new(Semaphore::new(4)),
    };
    let router = Router::new().route("/",get(||async {Html(include_str!("index.html"))}))
        .route("/health",get(||async {Json(json!({"ok":true,"prototype":true,"node":false,"codex":false,"execution":"in-process Rhai"}))}))
        .route("/api/apps/:id",get(catalog)).route("/api/apps/:id/actions/:action",post(invoke))
        .route("/api/ai",post(ai_turn)).route("/api/lab/hold",post(hold)).route("/mock/responses",post(provider))
        .route("/mock/weather",get(||async {Json(json!({"current":{"temperature_2m":18.5,"time":"synthetic observation"}}))}))
        .layer(axum::extract::DefaultBodyLimit::max(32*1024)).with_state(app);
    println!("Rhai prototype: {origin}");
    println!("Synthetic-only; temporary database: {}", path.display());
    axum::serve(listener, router).await?;
    Ok(())
}
fn bench() -> Result<(), Box<dyn std::error::Error>> {
    let path = std::env::temp_dir().join(format!(
        "rhai-prototype-bench-{:032x}.sqlite",
        rand::random::<u128>()
    ));
    let result = (|| {
        let store = Store::new(&path)?;
        let runtime = Runtime::new(store, None)?;
        let mut values = Vec::new();
        for _ in 0..200 {
            let started = std::time::Instant::now();
            runtime.invoke(
                "tasks",
                "list",
                json!({}),
                1,
                true,
                Arc::new(AtomicBool::new(false)),
            )?;
            values.push(started.elapsed().as_micros());
        }
        values.sort_unstable();
        println!(
            "{}",
            json!({"scenario":"empty read with fresh engine, AST compile, schema checks and SQLite snapshot","iterations":values.len(),"medianUs":values[values.len()/2],"p95Us":values[values.len()*95/100]})
        );
        Ok::<_, String>(())
    })();
    let _ = std::fs::remove_file(path);
    result.map_err(std::io::Error::other)?;
    Ok(())
}
