use super::{
    agent::Agent,
    authoring::AuthoringSession,
    chatgpt::ChatGpt,
    http::MockHttp,
    owner::{hash_token, OwnerAuth},
    secrets::Secrets,
    *,
};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

use serde_json::{json, Value};
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}
#[derive(Clone)]
pub struct Server {
    pub runtime: Runtime,
    pub secrets: Secrets,
    pub owner: OwnerAuth,
    pub chatgpt: ChatGpt,
    pub agent: Agent,
    pub origin: String,
    pub directory: PathBuf,
}
#[derive(Debug)]
pub struct ApiError(pub Error);
impl From<Error> for ApiError {
    fn from(e: Error) -> Self {
        Self(e)
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let code = match self.0 {
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Saturated => StatusCode::SERVICE_UNAVAILABLE,
            Error::Conflict | Error::Untested | Error::ExternalUncertain => StatusCode::CONFLICT,
            _ => StatusCode::BAD_REQUEST,
        };
        (code, Json(json!({"error":self.0}))).into_response()
    }
}
type Api<T> = std::result::Result<Json<T>, ApiError>;
fn cookie(headers: &HeaderMap) -> String {
    headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .filter_map(|s| s.trim().split_once('='))
        .find(|(k, _)| *k == "little_session")
        .map(|(_, v)| v.to_owned())
        .unwrap_or_default()
}
async fn owner_session(server: &Server, headers: &HeaderMap) -> Result<super::owner::Session> {
    let owner = server.owner.clone();
    let token = cookie(headers);
    server
        .runtime
        .store
        .blocking(move |_| owner.session(&token))
        .await
}
async fn authenticate(
    State(server): State<Arc<Server>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let headers = request.headers().clone();
    let method = request.method().clone();
    let checked = async {
        let session = owner_session(&server, &headers).await?;
        if method != axum::http::Method::GET {
            let origin = headers
                .get("origin")
                .and_then(|v| v.to_str().ok())
                .ok_or(Error::Unauthorized)?;
            let csrf = headers
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
                .ok_or(Error::Unauthorized)?;
            use subtle::ConstantTimeEq;
            if origin != server.origin
                || !bool::from(csrf.as_bytes().ct_eq(session.csrf.as_bytes()))
            {
                return Err(Error::Unauthorized);
            }
        }
        Ok(())
    }
    .await;
    match checked {
        Ok(()) => next.run(request).await,
        Err(e) => ApiError(e).into_response(),
    }
}
async fn security_headers(
    State(server): State<Arc<Server>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let expected = url::Url::parse(&server.origin)
        .ok()
        .and_then(|u| {
            u.host_str()
                .map(|h| format!("{h}:{}", u.port_or_known_default().unwrap_or(80)))
        })
        .unwrap_or_default();
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if host != expected {
        return ApiError(Error::Unauthorized).into_response();
    }
    let mut response = next.run(request).await;
    let h = response.headers_mut();
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert("cache-control", HeaderValue::from_static("no-store"));
    h.entry("content-security-policy").or_insert(HeaderValue::from_static("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"));
    response
}
pub fn router(server: Arc<Server>) -> Router {
    let private = Router::new()
        .route("/api/apps", get(apps).post(create_app))
        .route("/api/apps/:id", get(app_detail))
        .route("/api/action", post(action))
        .route("/api/build/:id", post(build))
        .route("/api/authoring/:id", post(author_tool))
        .route("/api/owner-preview/:app/:revision", post(owner_preview))
        .route("/api/owner-publish/:conversation", post(owner_publish))
        .route(
            "/api/conversations",
            get(conversations).post(create_conversation),
        )
        .route("/api/conversations/:id", get(history))
        .route("/api/conversations/:id/send", post(send))
        .route("/api/jobs/:id", get(job))
        .route("/api/jobs/:id/cancel", post(cancel_job))
        .route("/api/secrets", get(secret_names).post(secret_put))
        .route("/api/secrets/:name/delete", post(secret_delete))
        .route("/api/chatgpt", get(chatgpt_status))
        .route("/api/chatgpt/start", post(chatgpt_start))
        .route("/api/chatgpt/disconnect", post(chatgpt_disconnect))
        .route("/api/models", get(models))
        .route("/api/logout", post(logout))
        .route("/api/schedules", get(list_schedules).post(add_schedule))
        .route("/api/schedules/:id/delete", post(delete_schedule))
        .route("/api/effects/:app/:id", get(evidence))
        .route("/api/effects/:app/:id/resolve", post(resolve_effect))
        .route(
            "/api/diagnostics/:app/:revision",
            get(diagnostics).post(frontend_diagnostic),
        )
        .route("/api/preview/:app/:revision", get(preview))
        .route_layer(middleware::from_fn_with_state(server.clone(), authenticate));
    Router::new()
        .route("/", get(index))
        .route("/shell.js", get(shell_js))
        .route("/style.css", get(style_css))
        .route("/applet.js", get(applet_js))
        .route("/api/session", get(session))
        .route("/api/setup", post(setup))
        .route("/api/login", post(login))
        .route("/preview-test/:ticket", get(preview_test))
        .route("/preview-test/:ticket/action", post(preview_test_action))
        .route("/auth/callback", get(callback))
        .merge(private)
        .layer(DefaultBodyLimit::max(512 * 1024))
        .layer(middleware::from_fn_with_state(
            server.clone(),
            security_headers,
        ))
        .with_state(server)
}
async fn index() -> impl IntoResponse {
    axum::response::Html("<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>LittleSpaces</title><link rel=stylesheet href=/style.css><div id=root></div><script src=/shell.js defer></script></html>")
}
fn asset(content: &'static [u8], kind: &'static str) -> Response {
    ([("content-type", kind)], Body::from(content)).into_response()
}
async fn shell_js() -> Response {
    asset(assets::SHELL_JS, "text/javascript")
}
async fn applet_js() -> Response {
    asset(assets::APPLET_JS, "text/javascript")
}
async fn style_css() -> Response {
    asset(assets::STYLE_CSS, "text/css")
}
async fn session(State(s): State<Arc<Server>>, headers: HeaderMap) -> Api<Value> {
    let owner = s.owner.clone();
    let configured = s
        .runtime
        .store
        .blocking(move |_| owner.configured())
        .await?;
    Ok(Json(match owner_session(&s, &headers).await {
        Ok(session) => json!({"configured":configured,"authenticated":true,"csrf":session.csrf}),
        Err(_) => json!({"configured":configured,"authenticated":false}),
    }))
}
fn check_origin(s: &Server, h: &HeaderMap) -> Result<()> {
    if h.get("origin").and_then(|v| v.to_str().ok()) != Some(&s.origin) {
        return Err(Error::Unauthorized);
    }
    Ok(())
}
async fn setup(State(s): State<Arc<Server>>, h: HeaderMap, Json(v): Json<Value>) -> Api<Value> {
    check_origin(&s, &h)?;
    s.owner
        .setup(text(&v, "token")?, text(&v, "password")?)
        .await?;
    Ok(Json(json!({"configured":true})))
}
async fn login(
    State(s): State<Arc<Server>>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> std::result::Result<Response, ApiError> {
    check_origin(&s, &h)?;
    let (token, session) = s.owner.login(text(&v, "password")?).await?;
    let mut response = Json(json!({"authenticated":true,"csrf":session.csrf})).into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&format!(
            "little_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400"
        ))
        .map_err(|_| ApiError(Error::Authentication))?,
    );
    Ok(response)
}
async fn logout(
    State(s): State<Arc<Server>>,
    h: HeaderMap,
) -> std::result::Result<Response, ApiError> {
    let owner = s.owner.clone();
    let token = cookie(&h);
    s.runtime
        .store
        .blocking(move |_| owner.logout(&token))
        .await?;
    Ok((
        [(
            "set-cookie",
            "little_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        )],
        Json(json!({"loggedOut":true})),
    )
        .into_response())
}
fn text(v: &Value, k: &str) -> Result<String> {
    v[k].as_str()
        .filter(|s| s.len() < 131072)
        .map(str::to_owned)
        .ok_or(Error::Validation)
}
async fn apps(State(s): State<Arc<Server>>) -> Api<Value> {
    Ok(Json(s.runtime.store.blocking(|store|{let db=store.open()?;let mut q=db.prepare("SELECT id,title,published_revision FROM apps ORDER BY rowid")?;let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"revision":r.get::<_,Option<String>>(2)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(json!(rows))}).await?))
}
async fn create_app(State(s): State<Arc<Server>>, Json(v): Json<Value>) -> Api<Value> {
    let title = text(&v, "title")?;
    let runtime = s.runtime.clone();
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| {
                let app = store.create_app(&title)?;
                let code = AppCode {
                    backend: "fn list(input) { db_list() }".into(),
                    frontend: "".into(),
                    actions: vec![ActionContract {
                        name: "list".into(),
                        read_only: true,
                        input: json!({"type":"object","additionalProperties":false}),
                        output: json!({"type":"array"}),
                    }],
                    tests: vec![TestCase {
                        http: Default::default(),
                        action: "list".into(),
                        input: json!({}),
                        expected: json!([]),
                    }],
                    frontend_tests: vec![],
                };
                let draft = store.create_draft(&app, code)?;
                let session = AuthoringSession::begin(runtime, &app, &draft.id, true)?;
                Ok(json!({"app":app,"draft":draft.id,"conversation":session.conversation}))
            })
            .await?,
    ))
}
async fn app_detail(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| {
                let app = AppId(id);
                let snapshot = store.snapshot(&app)?;
                let revision = snapshot
                    .revision
                    .as_ref()
                    .map(|id| store.revision(&app, id))
                    .transpose()?;
                Ok(json!({"app":app,"revision":revision,"records":snapshot.records}))
            })
            .await?,
    ))
}
async fn build(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    let runtime = s.runtime.clone();
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| {
                let app = AppId(id);
                let published = store.snapshot(&app)?.revision.ok_or(Error::NotFound)?;
                let code = store.revision(&app, &published)?.code;
                let draft = store.create_draft(&app, code)?;
                let session = AuthoringSession::begin(runtime, &app, &draft.id, true)?;
                Ok(json!({"conversation":session.conversation}))
            })
            .await?,
    ))
}
async fn action(State(s): State<Arc<Server>>, Json(request): Json<Invocation>) -> Api<Value> {
    let id = request.id.clone();
    let app = request.app.clone();
    let result = s
        .runtime
        .invoke(request, MockHttp::default(), Cancellation::default())
        .await;
    let evidence = s
        .runtime
        .store
        .blocking(move |store| store.external_evidence(&app, &id))
        .await?;
    Ok(Json(
        json!({"result":result.as_ref().ok(),"error":result.err(),"externalEffects":evidence}),
    ))
}
async fn secret_names(State(s): State<Arc<Server>>) -> Api<Value> {
    let secrets = s.secrets.clone();
    Ok(Json(
        s.runtime
            .store
            .blocking(move |_| Ok(json!(secrets.list()?)))
            .await?,
    ))
}
async fn secret_put(State(s): State<Arc<Server>>, Json(v): Json<Value>) -> Api<Value> {
    let name = text(&v, "name")?;
    let value = zeroize::Zeroizing::new(text(&v, "value")?);
    let secrets = s.secrets.clone();
    s.runtime
        .store
        .blocking(move |_| secrets.put(&name, &value))
        .await?;
    Ok(Json(json!({"saved":true})))
}
async fn secret_delete(State(s): State<Arc<Server>>, Path(name): Path<String>) -> Api<Value> {
    let secrets = s.secrets.clone();
    s.runtime
        .store
        .blocking(move |_| secrets.delete(&name))
        .await?;
    Ok(Json(json!({"deleted":true})))
}
async fn chatgpt_status(State(s): State<Arc<Server>>) -> Api<Value> {
    Ok(Json(s.chatgpt.status().await?))
}
async fn chatgpt_start(State(s): State<Arc<Server>>, h: HeaderMap) -> Api<Value> {
    let owner = hash_token(&cookie(&h));
    Ok(Json(
        json!({"url":s.chatgpt.begin(owner,format!("{}/auth/callback",s.origin)).await?}),
    ))
}
async fn callback(
    State(s): State<Arc<Server>>,
    h: HeaderMap,
    Query(query): Query<BTreeMap<String, String>>,
) -> Response {
    if owner_session(&s, &h).await.is_err() {
        return ApiError(Error::Unauthorized).into_response();
    }
    match s.chatgpt.callback(&hash_token(&cookie(&h)), query).await {
        Ok(()) => axum::response::Redirect::to("/").into_response(),
        Err(e) => ApiError(e).into_response(),
    }
}
async fn chatgpt_disconnect(State(s): State<Arc<Server>>) -> Api<Value> {
    s.agent.cancel_all().await;
    Ok(Json(
        json!({"remoteRevocationConfirmed":s.chatgpt.disconnect().await?}),
    ))
}
async fn models(State(s): State<Arc<Server>>) -> Api<Value> {
    Ok(Json(s.chatgpt.models().await?))
}
async fn evidence(
    State(s): State<Arc<Server>>,
    Path((app, id)): Path<(String, String)>,
) -> Api<Value> {
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| {
                Ok(json!(
                    store.external_evidence(&AppId(app), &InvocationId(id))?
                ))
            })
            .await?,
    ))
}
async fn resolve_effect(
    State(s): State<Arc<Server>>,
    Path((app, id)): Path<(String, String)>,
    Json(v): Json<Value>,
) -> Api<Value> {
    let decision = serde_json::from_value(v["decision"].clone()).map_err(|_| Error::Validation)?;
    s.runtime
        .store
        .blocking(move |store| store.resolve_external(&AppId(app), &id, decision))
        .await?;
    Ok(Json(json!({"acknowledged":true})))
}
async fn diagnostics(
    State(s): State<Arc<Server>>,
    Path((app, id)): Path<(String, String)>,
) -> Api<Value> {
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| store.diagnostics(&AppId(app), &RevisionId(id)))
            .await?,
    ))
}
async fn preview(
    State(s): State<Arc<Server>>,
    Path((app, id)): Path<(String, String)>,
) -> std::result::Result<Response, ApiError> {
    let code = s
        .runtime
        .store
        .blocking(move |store| Ok(store.revision(&AppId(app), &RevisionId(id))?.code.frontend))
        .await?;
    let html = frame_html(&code);
    let mut response = axum::response::Html(html).into_response();
    response.headers_mut().insert("content-security-policy",HeaderValue::from_static("sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:*; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"));
    Ok(response)
}
pub fn frame_html(code: &str) -> String {
    let encoded = serde_json::to_string(code)
        .unwrap_or_default()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    format!("<!doctype html><html><meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' http://127.0.0.1:*; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'\"><meta name=viewport content='width=device-width,initial-scale=1'><style>body{{margin:0;padding:16px;font:16px system-ui;color:#23332f}}button,input{{font:inherit;padding:8px}}</style><div id=app></div><script src=/applet.js></script><script>{FRAME_BRIDGE}\ntry{{new Function({encoded})();}}catch(e){{parent.postMessage({{kind:'diagnostic',message:String(e)}},'*');}}</script></html>")
}
const FRAME_BRIDGE: &str = r#"let serial=0;const pending=new Map();window.applet=Object.freeze({call:(action,input={})=>new Promise((resolve,reject)=>{if(pending.size>=16)return reject(Error('Too many calls'));const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Action timed out'));},15000);pending.set(id,{resolve,reject,timer});parent.postMessage({kind:'action',id,action,input},'*');})});addEventListener('message',e=>{if(e.source!==parent||e.data?.kind!=='result')return;const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.result);});addEventListener('error',e=>parent.postMessage({kind:'diagnostic',message:String(e.message)},'*'));addEventListener('unhandledrejection',e=>parent.postMessage({kind:'diagnostic',message:String(e.reason)},'*'));"#;
async fn conversations(State(s): State<Arc<Server>>) -> Api<Value> {
    Ok(Json(s.agent.conversations().await?))
}
async fn create_conversation(State(s): State<Arc<Server>>, Json(v): Json<Value>) -> Api<Value> {
    Ok(Json(
        json!({"conversation":s.agent.create_conversation(v["app"].as_str().map(|v|AppId(v.into()))).await?}),
    ))
}
async fn history(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    Ok(Json(s.agent.history(ConversationId(id)).await?))
}
async fn send(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Api<Value> {
    Ok(Json(
        json!({"job":s.agent.start(ConversationId(id),text(&v,"message")?,text(&v,"model")?).await?}),
    ))
}
async fn job(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    Ok(Json(s.agent.job(id).await?))
}
async fn cancel_job(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    s.agent.cancel(&id).await?;
    Ok(Json(json!({"cancelled":true})))
}
async fn list_schedules(State(s): State<Arc<Server>>) -> Api<Value> {
    Ok(Json(super::schedules::list(&s.runtime.store).await?))
}
async fn add_schedule(State(s): State<Arc<Server>>, Json(v): Json<Value>) -> Api<Value> {
    Ok(Json(super::schedules::create(&s.runtime.store, v).await?))
}
async fn delete_schedule(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    s.runtime
        .store
        .blocking(move |store| {
            store
                .open()?
                .execute("DELETE FROM schedules WHERE id=?", [id])?;
            Ok(())
        })
        .await?;
    Ok(Json(json!({"deleted":true})))
}
pub async fn serve(
    directory: PathBuf,
    port: u16,
) -> std::result::Result<(), Box<dyn std::error::Error>> {
    if !assets::READY {
        return Err("Build frontend assets first: cd web && npm ci && npm run build".into());
    }
    #[cfg(unix)]
    let _instance_lock = {
        use std::os::{fd::AsRawFd, unix::fs::OpenOptionsExt};
        let lock = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(directory.join("server.lock"))?;
        // Advisory lock is released by the OS after a crash; recovery never interrupts another host.
        if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err("This workspace already has a running LittleSpaces server".into());
        }
        lock
    };
    let store = Store::create(&directory.join("workspace.sqlite"))?;
    let secrets = Secrets::open(store.clone(), &directory.join("secrets.key"))?;
    let mut runtime = Runtime::new(store.clone(), secrets.clone(), 4)?;
    let owner = OwnerAuth::new(store.clone());
    let chatgpt = ChatGpt::new(store.clone(), secrets.clone())?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    let origin = format!("http://127.0.0.1:{port}");
    runtime.browser = super::browser::BrowserConfig::from_environment(origin.clone())?;
    let agent = Agent::new(runtime.clone(), chatgpt.clone(), origin.clone());
    agent.recover().await?;
    if !owner.configured()? {
        println!("Owner setup: {origin}/#setup={}", owner.setup_token());
    } else {
        println!("LittleSpaces: {origin}");
    }
    let server = Arc::new(Server {
        runtime: runtime.clone(),
        secrets,
        owner,
        chatgpt,
        agent,
        origin,
        directory,
    });
    let scheduler = tokio::spawn(super::schedules::run(runtime));
    let result = axum::serve(listener, router(server))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await;
    scheduler.abort();
    result?;
    Ok(())
}

async fn preview_test(
    State(s): State<Arc<Server>>,
    Path(ticket): Path<String>,
) -> std::result::Result<Response, ApiError> {
    let preview = s.runtime.previews.get(&ticket).await?;
    let app = preview.app;
    let id = preview.revision;
    let code = s
        .runtime
        .store
        .blocking(move |store| Ok(store.revision(&app, &id)?.code.frontend))
        .await?;
    let frame = serde_json::to_string(&frame_html(&code))
        .map_err(|_| Error::Validation)?
        .replace('<', "\\u003c");
    let html=format!("<!doctype html><meta charset=utf-8><iframe id=frame sandbox='allow-scripts allow-forms' style='width:100%;height:600px;border:0'></iframe><script>const frame=document.getElementById('frame');frame.srcdoc={frame};addEventListener('message',async e=>{{if(e.source!==frame.contentWindow)return;if(e.data.kind==='diagnostic'){{window.errors.push(String(e.data.message));parent.postMessage({{kind:'diagnostic',message:String(e.data.message)}},'*');return;}}if(e.data.kind!=='action')return;try{{let r=await fetch('/preview-test/{ticket}/action',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify(e.data)}});let v=await r.json();frame.contentWindow.postMessage({{kind:'result',id:e.data.id,result:v.result,error:v.error}},'*');}}catch(error){{frame.contentWindow.postMessage({{kind:'result',id:e.data.id,error:String(error)}},'*');}}}});window.errors=[];</script>");
    let mut response = axum::response::Html(html).into_response();
    response.headers_mut().insert("content-security-policy",HeaderValue::from_static("default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; frame-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'"));
    Ok(response)
}
async fn preview_test_action(
    State(s): State<Arc<Server>>,
    Path(ticket): Path<String>,
    Json(v): Json<Value>,
) -> Api<Value> {
    let preview = s.runtime.previews.get(&ticket).await?;
    let mut records = preview.records.lock().await;
    let (result, next) = s
        .runtime
        .preview_action(
            preview.app,
            preview.revision,
            text(&v, "action")?,
            v["input"].clone(),
            records.clone(),
            preview.http,
        )
        .await?;
    *records = next;
    Ok(Json(json!({"result":result})))
}

async fn author_tool(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Json(tool): Json<super::authoring::AuthoringTool>,
) -> Api<Value> {
    let runtime = s.runtime.clone();
    let session = s
        .runtime
        .store
        .blocking(move |_| AuthoringSession::resume(runtime, ConversationId(id)))
        .await?;
    Ok(Json(
        session
            .dispatch(tool, MockHttp::default(), Cancellation::default())
            .await?,
    ))
}

async fn owner_preview(
    State(s): State<Arc<Server>>,
    Path((app, revision)): Path<(String, String)>,
) -> Api<Value> {
    let a = AppId(app);
    let r = RevisionId(revision);
    let checka = a.clone();
    let checkr = r.clone();
    let revision = s
        .runtime
        .store
        .blocking(move |store| store.revision(&checka, &checkr))
        .await?;
    let mocks = MockHttp(
        revision
            .code
            .tests
            .iter()
            .flat_map(|t| t.http.clone())
            .collect(),
    );
    let ticket = s.runtime.previews.create(a, r, mocks).await?;
    Ok(Json(json!({"url":format!("/preview-test/{ticket}")})))
}
async fn owner_publish(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Api<Value> {
    if v["confirmed"] != true {
        return Err(Error::ApprovalRequired.into());
    }
    let revision = RevisionId(text(&v, "revision")?);
    let expected = v["expected_version"].as_i64().ok_or(Error::Validation)?;
    let runtime = s.runtime.clone();
    let session = s
        .runtime
        .store
        .blocking(move |_| AuthoringSession::resume(runtime, ConversationId(id)))
        .await?;
    let cid = session.conversation.clone();
    let r = revision.clone();
    s.runtime.store.blocking(move|store|{let db=store.open()?;let app:String=db.query_row("SELECT app FROM conversations WHERE id=?",[cid.0],|r|r.get(0))?;let rev=store.revision(&AppId(app),&r)?;db.execute("INSERT OR REPLACE INTO frontend_checks VALUES(?,?,?)",rusqlite::params![r.0,rev.digest,json!({"kind":"owner_preview","approved":true,"coverage":"owner-reviewed interactions and runtime diagnostics; not automated browser assertions"}).to_string()])?;Ok(())}).await?;
    Ok(Json(
        session
            .dispatch(
                super::authoring::AuthoringTool::Publish {
                    revision,
                    expected_version: expected,
                },
                MockHttp::default(),
                Cancellation::default(),
            )
            .await?,
    ))
}

async fn frontend_diagnostic(
    State(s): State<Arc<Server>>,
    Path((app, id)): Path<(String, String)>,
    Json(v): Json<Value>,
) -> Api<Value> {
    let runtime = s.runtime.clone();
    let message = text(&v, "message")?.chars().take(4096).collect::<String>();
    s.runtime
        .store
        .blocking(move |store| {
            let revision = store.revision(&AppId(app), &RevisionId(id))?;
            runtime.diagnostic(
                &revision,
                "frontend",
                "frontend",
                json!({"message":message}),
            );
            Ok(())
        })
        .await?;
    Ok(Json(json!({"recorded":true})))
}
