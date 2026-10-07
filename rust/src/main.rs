mod runtime;
mod sandbox;

use axum::{
    extract::{Path, Query, Request, State},
    http::{HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{Html, IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use rand::RngCore;
use rusqlite::{params, Connection};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use tower_http::{
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};

#[derive(Clone)]
struct App {
    db: PathBuf,
    assets: PathBuf,
    token: String,
    origin: String,
    actions: Arc<Semaphore>,
}
fn random_id() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes
        .iter()
        .fold(String::with_capacity(64), |mut output, byte| {
            use std::fmt::Write;
            write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
            output
        })
}
fn random_uuid() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    bytes
        .iter()
        .enumerate()
        .fold(String::with_capacity(36), |mut output, (index, byte)| {
            use std::fmt::Write;
            if [4, 6, 8, 10].contains(&index) {
                output.push('-');
            }
            write!(&mut output, "{byte:02x}").expect("writing to a String cannot fail");
            output
        })
}
fn error(status: StatusCode, message: impl Into<String>) -> Response {
    (status, Json(json!({"error": message.into()}))).into_response()
}
fn connect(path: &PathBuf) -> Result<Connection, String> {
    Connection::open(path).map_err(|e| e.to_string())
}
fn initialize(path: &PathBuf) -> Result<(), String> {
    let connection = connect(path)?;
    connection.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS records(applet_id TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(applet_id,key));").map_err(|e| e.to_string())
}
fn load(path: &PathBuf) -> Result<BTreeMap<String, Value>, String> {
    let db = connect(path)?;
    let mut statement = db
        .prepare("SELECT key,value FROM records WHERE applet_id='journal' ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut result = BTreeMap::new();
    for row in rows {
        let (key, value) = row.map_err(|e| e.to_string())?;
        result.insert(
            key,
            serde_json::from_str(&value).map_err(|e| e.to_string())?,
        );
    }
    Ok(result)
}
fn save(path: &PathBuf, records: &BTreeMap<String, Value>) -> Result<(), String> {
    let mut db = connect(path)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM records WHERE applet_id='journal'", [])
        .map_err(|e| e.to_string())?;
    for (key, value) in records {
        tx.execute(
            "INSERT INTO records VALUES('journal',?1,?2)",
            params![key, value.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}
async fn authorize(State(app): State<App>, request: Request, next: Next) -> Response {
    let cookie = request
        .headers()
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let authorized = cookie.split(';').any(|pair| {
        pair.trim().strip_prefix("little_spaces_migration=") == Some(app.token.as_str())
    });
    if !authorized {
        return error(
            StatusCode::UNAUTHORIZED,
            "Open the private sign-in link printed by the Rust server.",
        );
    }
    if request.method() != axum::http::Method::GET
        && request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            != Some(&app.origin)
    {
        return error(StatusCode::FORBIDDEN, "Invalid request origin");
    }
    next.run(request).await
}
#[derive(Deserialize)]
struct Login {
    token: String,
}
async fn login(State(app): State<App>, Query(login): Query<Login>) -> Response {
    if login.token != app.token {
        return error(StatusCode::UNAUTHORIZED, "Invalid sign-in link");
    }
    let mut response = Redirect::to("/").into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&format!(
            "little_spaces_migration={}; HttpOnly; SameSite=Strict; Path=/",
            app.token
        ))
        .unwrap(),
    );
    response
}
async fn spaces() -> Json<Value> {
    Json(json!({"spaces":[{"id":"journal","name":"Little Journal","icon":"🌱","appletCount":1}]}))
}
#[derive(Deserialize)]
struct ActionRequest {
    action: String,
    #[serde(default = "empty_input")]
    input: Value,
}
fn empty_input() -> Value {
    json!({})
}
async fn action(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(input): Json<ActionRequest>,
) -> Response {
    if id != "journal" {
        return error(StatusCode::NOT_FOUND, "Unknown applet");
    }
    if !["list", "add"].contains(&input.action.as_str()) {
        return error(StatusCode::BAD_REQUEST, "Unknown action");
    }
    if input.action == "add"
        && (input.input["text"]
            .as_str()
            .map_or(true, |s| s.trim().is_empty() || s.chars().count() > 1000))
    {
        return error(StatusCode::BAD_REQUEST, "Enter 1–1000 characters.");
    }
    // One admitted action, no unbounded waiting requests. Protects memory and serializes writes.
    let Ok(_permit) = app.actions.try_acquire() else {
        return error(
            StatusCode::TOO_MANY_REQUESTS,
            "The app server is busy. Please retry.",
        );
    };
    let records = match load(&app.db) {
        Ok(records) => records,
        Err(_) => return error(StatusCode::INTERNAL_SERVER_ERROR, "Could not read app data"),
    };
    let request = runtime::Request {
        source: include_str!("journal.js").into(),
        action: input.action.clone(),
        input: input.input,
        records: records.clone(),
        now: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_millis()
            .to_string(),
    };
    match sandbox::run(&request).await {
        Ok(output) => {
            if output.records.len() > 2000
                || output.records.keys().any(|k| k.is_empty() || k.len() > 200)
            {
                return error(StatusCode::BAD_REQUEST, "Invalid records");
            }
            if input.action == "list" && output.records != records {
                return error(
                    StatusCode::BAD_REQUEST,
                    "Read-only action attempted to write",
                );
            }
            if input.action == "add" && save(&app.db, &output.records).is_err() {
                return error(StatusCode::INTERNAL_SERVER_ERROR, "Could not save app data");
            }
            Json(json!({"result": output.result})).into_response()
        }
        Err(message) => error(StatusCode::BAD_REQUEST, message),
    }
}
async fn applet(State(app): State<App>, Path(id): Path<String>) -> Response {
    if id != "journal" {
        return error(StatusCode::NOT_FOUND, "Unknown applet");
    }
    let runtime = match std::fs::read_to_string(app.assets.join("applet-runtime.js")) {
        Ok(value) => value,
        Err(_) => {
            return error(
                StatusCode::SERVICE_UNAVAILABLE,
                "Build the Preact assets first",
            )
        }
    };
    let css = std::fs::read_to_string(app.assets.join("applet.css")).unwrap_or_default();
    let nonce = random_id();
    let script = format!(
        "{}\n{}\n{}",
        include_str!("bridge.js"),
        runtime,
        include_str!("../../web/applets/journal.js")
    )
    .replace("</script", "<\\/script");
    let html = format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'nonce-{nonce}';style-src 'unsafe-inline';img-src data: blob:;connect-src 'none';frame-src 'none';form-action 'none';base-uri 'none';"><style>{css}</style></head><body><div id="app"></div><script nonce="{nonce}">{script}</script></body></html>"#
    );
    Html(html).into_response()
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|arg| arg == "--worker") {
        runtime::worker().map_err(std::io::Error::other)?;
        return Ok(());
    }
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?
        .block_on(server())
}
async fn server() -> Result<(), Box<dyn std::error::Error>> {
    let address: SocketAddr = std::env::var("RUST_LISTEN")
        .unwrap_or("127.0.0.1:5180".into())
        .parse()?;
    if !matches!(address.ip(), IpAddr::V4(ip) if ip.is_loopback()) {
        return Err(
            "Migration server only supports IPv4 loopback until production auth is ported".into(),
        );
    }
    let data = PathBuf::from(std::env::var("RUST_DATA_DIR").unwrap_or(".data-rust".into()));
    std::fs::create_dir_all(&data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700))?;
    }
    let db = data.join("migration.sqlite");
    initialize(&db).map_err(std::io::Error::other)?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    let origin = format!("http://{}", listener.local_addr()?);
    let app = App {
        db,
        assets: PathBuf::from("build-rust/web"),
        token: random_id(),
        origin: origin.clone(),
        actions: Arc::new(Semaphore::new(1)),
    };
    let protected = Router::new()
        .route("/api/spaces", get(spaces))
        .route("/api/applets/:id/document", get(applet))
        .route("/api/applets/:id/actions", post(action))
        .route_layer(middleware::from_fn_with_state(app.clone(), authorize));
    let router = Router::new()
        .merge(protected)
        .route("/auth", get(login))
        .route(
            "/health",
            get(|| async { Json(json!({"ok":true,"stack":"rust-preact-quickjs"})) }),
        )
        .fallback_service(
            ServeDir::new(&app.assets)
                .not_found_service(ServeFile::new(app.assets.join("index.html"))),
        )
        .layer(axum::extract::DefaultBodyLimit::max(16_384))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .with_state(app.clone());
    println!("LittleSpaces migration: {origin}/auth?token={}", app.token);
    axum::serve(listener, router).await?;
    Ok(())
}
