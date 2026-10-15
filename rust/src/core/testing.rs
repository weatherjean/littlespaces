//! Explicit opt-in real-model API tests. Only ChatGPT transport is shared with the owner workspace.
use super::{
    agent::Agent,
    chatgpt::ChatGpt,
    owner::OwnerAuth,
    secrets::Secrets,
    server::{ApiError, Server},
    *,
};
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
use subtle::ConstantTimeEq;
struct Run {
    agent: Agent,
    runtime: Runtime,
    stop: tokio::sync::oneshot::Sender<()>,
}
pub struct Service {
    key: zeroize::Zeroizing<String>,
    directory: PathBuf,
    chatgpt: ChatGpt,
    runs: tokio::sync::Mutex<BTreeMap<String, Run>>,
}
impl Service {
    pub fn enable(directory: PathBuf, chatgpt: ChatGpt) -> Result<Arc<Self>> {
        use std::io::Write;
        let key = owner::token();
        let path = directory.join("testing.key");
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(path).map_err(|_| Error::Storage)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(std::fs::Permissions::from_mode(0o600))
                .map_err(|_| Error::Storage)?;
        }
        file.write_all(key.as_bytes()).map_err(|_| Error::Storage)?;
        Ok(Arc::new(Self {
            key: zeroize::Zeroizing::new(key),
            directory,
            chatgpt,
            runs: Default::default(),
        }))
    }
    fn authenticate(&self, headers: &HeaderMap) -> Result<()> {
        let token = headers
            .get("authorization")
            .and_then(|h| h.to_str().ok())
            .and_then(|h| h.strip_prefix("Bearer "))
            .unwrap_or("");
        if !bool::from(token.as_bytes().ct_eq(self.key.as_bytes())) {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
}
pub fn router(service: Arc<Service>) -> Router {
    Router::new()
        .route("/api/test-runs", post(create))
        .route("/api/test-runs/:id/stop", post(stop))
        .route("/api/test-runs/:id/report", get(report))
        .with_state(service)
}
async fn create(
    State(s): State<Arc<Service>>,
    headers: HeaderMap,
    Json(input): Json<Value>,
) -> std::result::Result<Json<Value>, ApiError> {
    s.authenticate(&headers)?;
    if input["allowRealModel"] != true {
        return Err(Error::ApprovalRequired.into());
    }
    let mut runs = s.runs.lock().await;
    if runs.len() >= 2 {
        return Err(Error::Saturated.into());
    }
    let id = owner::token();
    let directory = s.directory.join("test-runs").join(&id);
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory).map_err(|_| Error::Storage)?;
    let store = Store::create(&directory.join("workspace.sqlite"))?;
    let secrets = Secrets::open(store.clone(), &directory.join("secrets.key"))?;
    let mut runtime = Runtime::new(store.clone(), secrets.clone(), 2)?;
    runtime.offline_actions = true;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| Error::Network)?;
    let origin = format!(
        "http://{}",
        listener.local_addr().map_err(|_| Error::Network)?
    );
    runtime.browser = browser::BrowserConfig::from_environment(origin.clone())?;
    let owner = OwnerAuth::new(store);
    let password = owner::token();
    owner
        .setup(owner.setup_token().into(), password.clone())
        .await?;
    let (cookie, session) = owner.login(password).await?;
    let agent = Agent::new(runtime.clone(), s.chatgpt.clone(), origin.clone());
    let server = Arc::new(Server {
        runtime: runtime.clone(),
        secrets,
        owner,
        chatgpt: s.chatgpt.clone(),
        agent: agent.clone(),
        origin: origin.clone(),
        directory,
        host: host::Host::new(origin.clone(), format!("{origin}/auth/callback"))?,
    });
    let routes = super::server::router(server).layer(axum::middleware::from_fn(
        |request: axum::extract::Request, next: axum::middleware::Next| async move {
            // Test clients may exercise inference, but cannot alter the shared ChatGPT sign-in.
            if [
                "/api/chatgpt/start",
                "/api/chatgpt/disconnect",
                "/auth/callback",
            ]
            .contains(&request.uri().path())
            {
                return axum::response::IntoResponse::into_response(ApiError(Error::Unauthorized));
            }
            next.run(request).await
        },
    ));
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let worker = agent.clone();
    let registry = Arc::downgrade(&s);
    let run_id = id.clone();
    tokio::spawn(async move {
        let _=axum::serve(listener,routes).with_graceful_shutdown(async move {
            tokio::select! { _=receiver=>{}, _=tokio::time::sleep(std::time::Duration::from_secs(6*3600))=>{} }
            worker.cancel_all().await;
        }).await;
        if let Some(service) = registry.upgrade() {
            service.runs.lock().await.remove(&run_id);
        }
    });
    runs.insert(
        id.clone(),
        Run {
            agent,
            runtime,
            stop: sender,
        },
    );
    Ok(Json(
        json!({"id":id,"origin":origin,"cookie":cookie,"csrf":session.csrf,"isolated":true,"externalActions":"mocked","expiresIn":21600}),
    ))
}
async fn stop(
    State(s): State<Arc<Service>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    s.authenticate(&headers)?;
    let run = s.runs.lock().await.remove(&id).ok_or(Error::NotFound)?;
    run.agent.cancel_all().await;
    let _ = run.stop.send(());
    Ok(Json(json!({"stopped":true,"artifactsPreserved":true})))
}

async fn report(
    State(s): State<Arc<Service>>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> std::result::Result<Json<Value>, ApiError> {
    s.authenticate(&headers)?;
    let runtime = s
        .runs
        .lock()
        .await
        .get(&id)
        .ok_or(Error::NotFound)?
        .runtime
        .clone();
    let value = runtime.store.blocking(move |store| {
        let db = store.open()?;
        fn rows(db: &rusqlite::Connection, sql: &str) -> Result<Vec<Value>> {
            let mut q = db.prepare(sql)?;
            let data = q.query_map([], |r| r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;
            data.into_iter().map(|v| serde_json::from_str(&v).map_err(|_| Error::Storage)).collect()
        }
        let jobs = rows(&db, "SELECT json_object('id',id,'conversation',conversation,'app',app,'state',state,'payload',json(payload)) FROM jobs ORDER BY rowid DESC LIMIT 100")?;
        let mut arguments = BTreeMap::new();
        for checkpoint in rows(&db, "SELECT payload FROM agent_checkpoints ORDER BY rowid DESC LIMIT 100")? {
            for call in checkpoint["input"].as_array().into_iter().flatten().filter(|c| c["type"] == "function_call") {
                let mut args: Value = serde_json::from_str(call["arguments"].as_str().unwrap_or("{}")).unwrap_or(json!({"invalidJson":true}));
                if let Some(code) = args.get_mut("code") {
                    *code = json!({"omittedFromCallTrace":true,"serializedBytes":code.to_string().len()});
                }
                if let Some(id) = call["call_id"].as_str() { arguments.insert(id.to_owned(),json!({"name":call["name"],"arguments":args})); }
            }
        }
        let mut calls = rows(&db,"SELECT json_object('job',job,'id',call_id,'state',state,'result',json(payload)) FROM agent_calls ORDER BY rowid DESC LIMIT 1000")?;
        for call in &mut calls {
            if let Some(input) = call["id"].as_str().and_then(|id| arguments.get(id)) { call["input"] = input.clone(); }
            if call["state"] != "completed" { call["result"] = json!({"outcome":"unknown or still running"}); }
        }
        let requests = rows(&db,"SELECT json_object('job',job,'details',json(payload)) FROM model_request_events ORDER BY id DESC LIMIT 4096")?;
        let diagnostics = rows(&db,"SELECT json_object('app',app,'revision',revision,'details',json(payload)) FROM diagnostics ORDER BY rowid DESC LIMIT 200")?;
        let browser = rows(&db,"SELECT json_object('revision',revision,'report',json(report)) FROM frontend_checks ORDER BY rowid DESC LIMIT 100")?;
        let apps = rows(&db,"SELECT json_object('id',a.id,'title',a.title,'emoji',i.emoji,'revision',a.published_revision,'code',json(r.code)) FROM apps a LEFT JOIN app_identity i ON i.app=a.id LEFT JOIN revisions r ON r.id=a.published_revision ORDER BY a.rowid LIMIT 100")?;
        let checkpoints = rows(&db,"SELECT json_object('job',job,'round',json_extract(payload,'$.round'),'calls',json_extract(payload,'$.calls'),'cursor',json_extract(payload,'$.cursor'),'budget',json_extract(payload,'$.budget')) FROM agent_checkpoints ORDER BY rowid DESC LIMIT 100")?;
        Ok(json!({"run":id,"jobs":jobs,"calls":calls,"requests":requests,"diagnostics":diagnostics,"browserChecks":browser,"apps":apps,"checkpoints":checkpoints,"limits":{"jobs":100,"calls":1000,"requestEvents":4096,"diagnostics":200},"omits":["authentication","encrypted reasoning","request headers","full draft tool arguments"]}))
    }).await?;
    Ok(Json(runtime.redact_public(value).await?))
}
