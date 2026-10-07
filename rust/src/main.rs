mod api;
mod auth;
mod automation;
mod backend;
mod broker;
mod cli;
mod codex;
mod diagnostics;
mod jobs;
mod photos;
mod runtime;
mod sandbox;
mod store;
#[cfg(test)]
mod tests;
mod tools;
mod vault;
mod vision;

use rand::RngCore;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::{Mutex as AsyncMutex, Semaphore};
#[derive(Clone)]
struct App {
    store: store::Store,
    assets: PathBuf,
    origin: String,
    secure: bool,
    auth: Arc<auth::Auth>,
    actions: Arc<Semaphore>,
    turns: Arc<Semaphore>,
    codex: Arc<AsyncMutex<Option<codex::Codex>>>,
    account: Arc<Mutex<Value>>,
    models: Arc<Mutex<Value>>,
    cancellations: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
}
impl App {
    async fn rpc(&self) -> store::Result<tokio::sync::MutexGuard<'_, Option<codex::Codex>>> {
        let mut guard = self.codex.lock().await;
        if guard.as_mut().map_or(true, |rpc| !rpc.alive()) {
            *guard = Some(codex::Codex::start(&self.store).await?);
        }
        Ok(guard)
    }
    fn cookie_name(&self) -> &str {
        if self.secure {
            "__Host-little_spaces_session"
        } else {
            "little_spaces_session"
        }
    }
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|arg| arg == "--worker") {
        runtime::worker().map_err(std::io::Error::other)?;
        return Ok(());
    }
    let arguments = std::env::args().collect::<Vec<_>>();
    if let Some(index) = arguments.iter().position(|arg| arg == "--import-workspace") {
        let source = arguments
            .get(index + 1)
            .ok_or("Provide the source workspace directory")?;
        cli::import_workspace(std::path::Path::new(source)).map_err(std::io::Error::other)?;
        return Ok(());
    }
    if std::env::args().any(|arg| arg == "--setup-owner" || arg == "--reset-owner") {
        let reset = std::env::args().any(|arg| arg == "--reset-owner");
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()?
            .block_on(cli::owner(reset))
            .map_err(std::io::Error::other)?;
        return Ok(());
    }
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?
        .block_on(server())
}
async fn server() -> Result<(), Box<dyn std::error::Error>> {
    let address: std::net::SocketAddr = std::env::var("RUST_LISTEN")
        .unwrap_or("127.0.0.1:5180".into())
        .parse()?;
    let data = PathBuf::from(
        std::env::var("RUST_DATA_DIR")
            .or_else(|_| std::env::var("APP_DATA_DIR"))
            .unwrap_or(".data-rust".into()),
    );
    std::fs::create_dir_all(&data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o700))?;
    }
    let store = store::Store::new(data).map_err(std::io::Error::other)?;
    let auth = Arc::new(auth::Auth::new(&store).map_err(std::io::Error::other)?);
    let listener = tokio::net::TcpListener::bind(address).await?;
    let origin = std::env::var("APP_ORIGIN")
        .unwrap_or_else(|_| format!("http://{}", listener.local_addr().unwrap()));
    let url = url::Url::parse(&origin)?;
    if url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("APP_ORIGIN must be an origin without a path".into());
    }
    let secure = url.scheme() == "https";
    if !address.ip().is_loopback() && !secure {
        return Err(
            "Non-loopback binding requires HTTPS APP_ORIGIN and a trusted TLS proxy".into(),
        );
    }
    let app = App {
        store,
        assets: std::env::var("RUST_WEB_DIR")
            .unwrap_or("build-rust/web".into())
            .into(),
        origin: origin.trim_end_matches('/').into(),
        secure,
        auth,
        actions: Arc::new(Semaphore::new(1)),
        turns: Arc::new(Semaphore::new(1)),
        codex: Arc::new(AsyncMutex::new(None)),
        account: Arc::new(Mutex::new(Value::Null)),
        models: Arc::new(Mutex::new(json!([]))),
        cancellations: Arc::new(Mutex::new(HashMap::new())),
    };
    if app.auth.owner(&app.store).is_err() {
        println!(
            "Set up LittleSpaces: {}/setup#token={}",
            app.origin, app.auth.setup_token
        );
    } else {
        println!("LittleSpaces: {}", app.origin);
    }
    jobs::launch_scheduler(app.clone());
    axum::serve(listener, api::router(app)).await?;
    Ok(())
}
