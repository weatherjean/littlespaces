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
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};

use serde_json::{json, Value};
use std::future::IntoFuture;
use std::{collections::BTreeMap, path::PathBuf, sync::Arc};
mod sharing;
mod assets {
    include!(concat!(env!("OUT_DIR"), "/assets.rs"));
}
#[derive(Clone)]
pub struct Server {
    pub runtime: Runtime,
    pub secrets: Secrets,
    pub owner: OwnerAuth,
    pub chatgpt: ChatGpt,
    pub chatgpt_management_origin: Option<String>,
    pub agent: Agent,
    pub origin: String,
    pub directory: PathBuf,
    pub host: super::host::Host,
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
        if self.0 == Error::Storage {
            super::telemetry::error("http.request", self.0);
        }
        let code = match self.0 {
            Error::Unauthorized => StatusCode::UNAUTHORIZED,
            Error::SharedChatgptConnection => StatusCode::FORBIDDEN,
            Error::RateLimited | Error::LoginThrottled => StatusCode::TOO_MANY_REQUESTS,
            Error::NotFound => StatusCode::NOT_FOUND,
            Error::Saturated => StatusCode::SERVICE_UNAVAILABLE,
            Error::Conflict | Error::Untested | Error::ExternalUncertain => StatusCode::CONFLICT,
            Error::Storage => StatusCode::INTERNAL_SERVER_ERROR,
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
async fn account_session(server: &Server, headers: &HeaderMap) -> Result<super::owner::Session> {
    let owner = server.owner.clone();
    let token = cookie(headers);
    server
        .runtime
        .store
        .blocking(move |_| owner.account_session(&token))
        .await
}
async fn authenticate(
    State(server): State<Arc<Server>>,
    request: axum::extract::Request,
    next: Next,
) -> Response {
    let headers = request.headers().clone();
    let method = request.method().clone();
    let path = request.uri().path().to_owned();
    let checked = async {
        let session = account_session(&server, &headers).await?;
        if session.guest.is_some()
            && !(path.starts_with("/api/guest/")
                || path == "/api/logout"
                || path == "/api/account/password")
        {
            return Err(Error::Unauthorized);
        }
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
    let host = request
        .headers()
        .get("host")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !server.host.accepts(host, request.uri().path()) {
        return ApiError(Error::Unauthorized).into_response();
    }
    if server.runtime.operations.stopping() && !request.uri().path().starts_with("/health/") {
        return ApiError(Error::Saturated).into_response();
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
        .route("/api/account/email", post(sharing::register_email))
        .route("/api/account/password", post(sharing::password))
        .route(
            "/api/guests",
            get(sharing::guests).post(sharing::create_guest),
        )
        .route("/api/guests/:id", post(sharing::update_guest))
        .route("/api/guests/:id/delete", post(sharing::delete_guest))
        .route("/api/guest/apps", get(sharing::apps))
        .route("/api/guest/apps/:id", get(sharing::detail))
        .route("/api/guest/preview/:app/:revision", get(sharing::preview))
        .route("/api/guest/action", post(action))
        .route(
            "/api/guest/images",
            post(upload_image).layer(DefaultBodyLimit::max(6 * 1024 * 1024)),
        )
        .route("/api/guest/apps/:app/images", get(app_images))
        .route("/api/guest/apps/:app/images/:id", get(app_image))
        .route("/api/operations", get(operations_status))
        .route("/api/storage", get(storage_status))
        .route("/api/storage/cleanup", post(storage_cleanup))
        .route("/api/notifications", get(notice_list).post(notice_read))
        .route("/api/settings/push", get(push_settings).post(push_update))
        .route("/api/settings/push/test", post(push_test))
        .route(
            "/api/images",
            post(upload_image).layer(DefaultBodyLimit::max(6 * 1024 * 1024)),
        )
        .route("/api/images/:id", get(image_data))
        .route("/api/apps/:app/images", get(app_images))
        .route("/api/apps/:app/images/:id", get(app_image))
        .route("/api/apps", get(apps).post(create_app))
        .route("/api/apps/:id", get(app_detail))
        .route("/api/apps/:id/archive", post(archive_app))
        .route("/api/revisions/:app", get(revisions))
        .route("/api/action", post(action))
        .route("/api/build/:id", post(build))
        .route("/api/authoring/:id", post(author_tool))
        .route("/api/owner-preview/:app/:revision", post(owner_preview))
        .route("/api/owner-preview-close", post(owner_preview_close))
        .route("/api/owner-publish/:conversation", post(owner_publish))
        .route(
            "/api/conversations",
            get(conversations).post(create_conversation),
        )
        .route("/api/conversations/:id", get(history))
        .route("/api/conversations/:id/info", get(conversation_info))
        .route("/api/conversations/:id/send", post(send))
        .route("/api/conversations/:id/proposals", get(proposals))
        .route(
            "/api/conversations/:id/proposals/:proposal",
            post(decide_proposal),
        )
        .route("/api/jobs/:id", get(job))
        .route("/api/jobs/:id/cancel", post(cancel_job))
        .route("/api/jobs/:id/resume", post(resume_job))
        .route("/api/apps/:id/releases", get(app_releases))
        .route("/api/apps/:id/data/query", post(inspect_app_data))
        .route(
            "/api/apps/:id/release-plans",
            get(app_release_plans).post(prepare_app_release),
        )
        .route(
            "/api/apps/:id/release-plans/:plan/apply",
            post(apply_app_release),
        )
        .route(
            "/api/apps/:id/release-plans/:plan/discard",
            post(discard_app_release),
        )
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
        .route("/health/live", get(|| async { StatusCode::OK }))
        .route("/health/ready", get(readiness))
        .route("/", get(index))
        .route("/settings", get(index))
        .route("/chat", get(index))
        .route("/chat/:id", get(index))
        .route("/voice", get(index))
        .route("/voice/:id", get(index))
        .route("/apps/:id", get(index))
        .route("/shell.js", get(shell_js))
        .route("/style.css", get(style_css))
        .route("/applet.js", get(applet_js))
        .route("/api/session", get(session))
        .route("/api/setup", post(setup))
        .route("/api/login", post(login))
        .route("/preview-test/:ticket", get(preview_test))
        .route("/preview-test/:ticket/frame", get(preview_frame))
        .route("/preview-test/:ticket/action", post(preview_test_action))
        .route("/auth/callback", get(callback))
        .fallback(public_asset)
        .merge(private)
        .layer(DefaultBodyLimit::max(512 * 1024))
        .layer(middleware::from_fn_with_state(
            server.clone(),
            security_headers,
        ))
        .with_state(server)
}
async fn index() -> impl IntoResponse {
    axum::response::Html("<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1,viewport-fit=cover,interactive-widget=resizes-content'><meta name=theme-color content='#141b30'><meta name=apple-mobile-web-app-capable content=yes><meta name=apple-mobile-web-app-status-bar-style content=black-translucent><meta name=apple-mobile-web-app-title content=LittleSpaces><link rel=manifest href=/manifest.webmanifest><link rel=icon href=/favicon.ico sizes=any><link rel=icon href=/icon.svg type=image/svg+xml><link rel=apple-touch-icon href=/apple-touch-icon.png sizes=180x180><title>LittleSpaces</title><link rel=stylesheet href=/style.css><div id=root></div><script src=/shell.js defer></script></html>")
}
async fn public_asset(uri: axum::http::Uri) -> Response {
    match assets::public_asset(uri.path()) {
        Some((content, kind)) => {
            let mut response = asset(content, kind);
            if uri.path() == "/offline.html" {
                response.headers_mut().insert("content-security-policy", HeaderValue::from_static("default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'"));
            }
            response
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
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
    Ok(Json(match account_session(&s, &headers).await {
        Ok(session) => {
            json!({"configured":configured,"authenticated":true,"csrf":session.csrf,"guest":session.guest,"email":session.email})
        }
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
    let email = super::owner::normalize_email(&text(&v, "email")?)?;
    s.owner
        .setup(text(&v, "token")?, text(&v, "password")?)
        .await?;
    let owner = s.owner.clone();
    s.runtime
        .store
        .blocking(move |_| owner.register_email(&email))
        .await?;
    Ok(Json(json!({"configured":true})))
}
async fn login(
    State(s): State<Arc<Server>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> std::result::Result<Response, ApiError> {
    check_origin(&s, &h)?;
    let (token, session) = s
        .owner
        .login_account(
            v["email"].as_str().map(str::to_owned),
            text(&v, "password")?,
            login_source(peer, &h, s.host.trust_proxy)?,
        )
        .await?;
    let mut response = Json(json!({"authenticated":true,"csrf":session.csrf,"guest":session.guest,"email":session.email})).into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_str(&format!(
            "little_session={token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400{}",
            if s.origin.starts_with("https:") {
                "; Secure"
            } else {
                ""
            }
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
async fn upload_image(
    State(s): State<Arc<Server>>,
    h: HeaderMap,
    Json(v): Json<Value>,
) -> Api<Value> {
    let data = v["dataUrl"].as_str().ok_or(Error::Validation)?.to_owned();
    let name = v["name"].as_str().unwrap_or("Image").to_owned();
    let app = v["app"].as_str().map(str::to_owned);
    sharing::authorize(&s, &h, app.as_deref().unwrap_or(""), None).await?;
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| images::save(&store, app, name, data))
            .await?,
    ))
}
async fn image_data(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
) -> std::result::Result<Response, ApiError> {
    let (mime, bytes) = s
        .runtime
        .store
        .blocking(move |store| images::data(&store, &id))
        .await?;
    let mut response = bytes.into_response();
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_str(&mime).map_err(|_| Error::Storage)?,
    );
    Ok(response)
}
async fn app_images(
    State(s): State<Arc<Server>>,
    Path(app): Path<String>,
    h: HeaderMap,
) -> Api<Value> {
    sharing::authorize(&s, &h, &app, None).await?;
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| images::list(&store, &app))
            .await?,
    ))
}
async fn app_image(
    State(s): State<Arc<Server>>,
    Path((app, id)): Path<(String, String)>,
    h: HeaderMap,
) -> Api<Value> {
    sharing::authorize(&s, &h, &app, None).await?;
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| images::app_image(&store, &app, &id))
            .await?,
    ))
}
async fn apps(State(s): State<Arc<Server>>) -> Api<Value> {
    Ok(Json(s.runtime.store.blocking(|store|{let db=store.open()?;let mut q=db.prepare("SELECT id,title,published_revision,EXISTS(SELECT 1 FROM archived_apps a WHERE a.app=apps.id),(SELECT emoji FROM app_identity i WHERE i.app=apps.id) FROM apps ORDER BY rowid")?;let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"revision":r.get::<_,Option<String>>(2)?,"archived":r.get::<_,bool>(3)?,"emoji":r.get::<_,Option<String>>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(json!(rows))}).await?))
}
async fn archive_app(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Api<Value> {
    let archived = v["archived"].as_bool().ok_or(Error::Validation)?;
    s.runtime
        .store
        .blocking(move |store| store.archive_app(&AppId(id), archived))
        .await?;
    Ok(Json(json!({"ok":true})))
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
                    sqlite: false,
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
                Ok(json!({"app":app,"revision":revision,"records":snapshot.records,"externalEffects":store.app_effects(&app)?}))
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
                let code = if let Some(published) = store.snapshot(&app)?.revision {
                    store.revision(&app, &published)?.code
                } else {
                    let draft: String = store.open()?.query_row(
                        "SELECT id FROM drafts WHERE app=? ORDER BY rowid DESC LIMIT 1",
                        [&app.0],
                        |row| row.get(0),
                    )?;
                    store.draft(&app, &DraftId(draft))?.code
                };
                let draft = store.create_draft(&app, code)?;
                let session = AuthoringSession::begin(runtime, &app, &draft.id, true)?;
                Ok(json!({"conversation":session.conversation}))
            })
            .await?,
    ))
}
async fn action(
    State(s): State<Arc<Server>>,
    h: HeaderMap,
    Json(mut request): Json<Invocation>,
) -> Api<Value> {
    let session = sharing::authorize(&s, &h, &request.app.0, Some(&request.revision.0)).await?;
    let guest = session.guest.is_some();
    if let Some(id) = session.guest {
        if request.mode != ExecutionMode::Commit {
            return Err(Error::Unauthorized.into());
        }
        // Keep guest idempotency keys separate from owner/other guests' outcomes.
        request.id = InvocationId(super::owner::hash_token(&format!(
            "guest:{id}:{}",
            request.id.0
        )));
    }
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
        json!({"result":result.as_ref().ok(),"error":result.err(),"externalEffects":if guest { vec![] } else { evidence }}),
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
    let mut status = s.chatgpt.status().await?;
    status["managementOrigin"] = json!(s.chatgpt_management_origin);
    status["requiresLocalCallback"] = json!(s.origin.starts_with("https:"));
    status["callbackPort"] = json!(url::Url::parse(&s.host.callback)
        .map_err(|_| Error::Validation)?
        .port_or_known_default());
    Ok(Json(status))
}
async fn chatgpt_start(State(s): State<Arc<Server>>, h: HeaderMap) -> Api<Value> {
    let owner = hash_token(&cookie(&h));
    Ok(Json(
        json!({"url":s.chatgpt.begin(owner,s.host.callback.clone()).await?}),
    ))
}
async fn callback(
    State(s): State<Arc<Server>>,
    h: HeaderMap,
    Query(query): Query<BTreeMap<String, String>>,
) -> Response {
    let result = if owner_session(&s, &h).await.is_ok() {
        s.chatgpt.callback(&hash_token(&cookie(&h)), query).await
    } else {
        s.chatgpt.tunnel_callback(query).await
    };
    match result {
        Ok(()) => axum::response::Redirect::to(&s.origin).into_response(),
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
    frame_response(&code, &s.origin)
}
fn frame_response(code: &str, origin: &str) -> std::result::Result<Response, ApiError> {
    let html = frame_html(code, origin);
    let mut response = axum::response::Html(html).into_response();
    let policy=format!("sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' {origin}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'");
    response.headers_mut().insert(
        "content-security-policy",
        HeaderValue::from_str(&policy).map_err(|_| Error::Validation)?,
    );
    Ok(response)
}
pub fn frame_html(code: &str, origin: &str) -> String {
    let encoded = serde_json::to_string(code)
        .unwrap_or_default()
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    format!("<!doctype html><html><meta charset=utf-8><meta http-equiv=Content-Security-Policy content=\"default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' {origin}; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'\"><meta name=viewport content='width=device-width,initial-scale=1'><style>body{{margin:0;padding:16px;font:16px system-ui;color:#23332f}}button,input{{font:inherit;padding:8px}}</style><div id=app></div><script src=/applet.js></script><script>{FRAME_BRIDGE}\ntry{{new Function({encoded})();}}catch(e){{parent.postMessage({{kind:'diagnostic',message:String(e)}},'*');}}</script></html>")
}
const FRAME_BRIDGE: &str = r#"let serial=0;const pending=new Map();function request(kind,fields){return new Promise((resolve,reject)=>{if(pending.size>=16)return reject(Error('Too many calls'));const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Request timed out'));},30000);pending.set(id,{resolve,reject,timer});parent.postMessage({kind,id,...fields},'*');});}let actionQueue=Promise.resolve();window.applet=Object.freeze({call:(action,input={})=>{const task=actionQueue.then(()=>request('action',{action,input}));actionQueue=task.catch(()=>{});return task;},images:()=>request('image-list',{}),image:(image)=>request('image-get',{image}),uploadImage:(dataUrl,name='Image')=>request('image-upload',{dataUrl,name})});addEventListener('message',e=>{if(e.source!==parent||e.data?.kind!=='result')return;const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);e.data.error?p.reject(Error(e.data.error)):p.resolve(e.data.result);});addEventListener('error',e=>parent.postMessage({kind:'diagnostic',message:String(e.message)},'*'));addEventListener('unhandledrejection',e=>parent.postMessage({kind:'diagnostic',message:String(e.reason)},'*'));"#;
async fn conversations(
    State(s): State<Arc<Server>>,
    Query(query): Query<super::history::PageQuery>,
) -> Api<Value> {
    if query.page == Some(true) || query.before.is_some() {
        return Ok(Json(
            s.runtime
                .store
                .blocking(move |store| super::history::conversations(&store, query.before))
                .await?,
        ));
    }
    Ok(Json(s.agent.conversations().await?))
}
async fn create_conversation(State(s): State<Arc<Server>>, Json(v): Json<Value>) -> Api<Value> {
    Ok(Json(
        json!({"conversation":s.agent.create_conversation(v["app"].as_str().map(|v|AppId(v.into()))).await?}),
    ))
}
async fn history(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Query(query): Query<super::history::PageQuery>,
) -> Api<Value> {
    if query.page == Some(true) || query.before.is_some() {
        return Ok(Json(
            s.runtime
                .store
                .blocking(move |store| super::history::messages(&store, &id, query.before, 120))
                .await?,
        ));
    }
    Ok(Json(s.agent.history(ConversationId(id)).await?))
}
async fn send(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Api<Value> {
    Ok(Json(
        json!({"job":s.agent.start_with_images(ConversationId(id),text(&v,"message")?,text(&v,"model")?,v["voice"].as_bool().unwrap_or(false),serde_json::from_value(v.get("images").cloned().unwrap_or(json!([]))).map_err(|_|Error::Validation)?,v["effort"].as_str().filter(|value| !value.is_empty() && *value!="default").map(str::to_owned)).await?}),
    ))
}
async fn job(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    Ok(Json(s.agent.job(id).await?))
}
async fn resume_job(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    Ok(Json(s.agent.resume(id).await?))
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
    let _instance_lock = workspace::WorkspaceLock::acquire(&directory)?;
    let store = Store::create(&directory.join("workspace.sqlite"))?;
    let secrets = Secrets::open(store.clone(), &directory.join("secrets.key"))?;
    let mut runtime = Runtime::new(store.clone(), secrets.clone(), 4)?;
    let owner = OwnerAuth::new(store.clone());
    let chatgpt = ChatGpt::new(store.clone(), secrets.clone())?;
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    let port = listener.local_addr()?.port();
    let origin = std::env::var("LITTLESPACES_PUBLIC_URL")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{port}"));
    let callback = std::env::var("LITTLESPACES_OAUTH_CALLBACK")
        .unwrap_or_else(|_| format!("http://127.0.0.1:{port}/auth/callback"));
    let mut host = super::host::Host::new(origin, callback)?;
    host.trust_proxy = match std::env::var("LITTLESPACES_TRUST_PROXY").as_deref() {
        Ok("1") => true,
        Ok("0") | Err(_) => false,
        _ => return Err("LITTLESPACES_TRUST_PROXY must be 0 or 1".into()),
    };
    let origin = host.origin.clone();
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
        chatgpt_management_origin: None,
        agent,
        origin,
        directory,
        host,
    });
    notifications::initialize_jobs(&store)?;
    let push_worker = tokio::spawn(notifications::run(
        store,
        server.secrets.clone(),
        server.runtime.operations.clone(),
    ));
    let scheduler = tokio::spawn(super::schedules::run(runtime));
    let routes = router(server.clone());
    #[cfg(debug_assertions)]
    let mut routes = routes;
    #[cfg(debug_assertions)]
    if std::env::var("LITTLESPACES_ENABLE_LIVE_TESTS").as_deref() == Ok("1") {
        routes = routes.merge(testing::router(testing::Service::enable(
            server.directory.clone(),
            server.chatgpt.clone(),
            server.origin.clone(),
        )?));
    }
    let stopping = server.runtime.operations.clone();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let http = axum::serve(
        listener,
        routes.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = stop_rx.await;
    })
    .into_future();
    tokio::pin!(http);
    tokio::select! {
        result = &mut http => { result?; },
        result = shutdown_signal() => {
            result?;
            stopping.stop();
            let _ = stop_tx.send(());
            // Existing requests/actions and background dispatches may finish before cancellation.
            let drain = async {
                let _ = (&mut http).await;
                while !server.agent.idle().await || !server.runtime.idle() || !scheduler.is_finished() || !push_worker.is_finished() {
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                }
            };
            if tokio::time::timeout(std::time::Duration::from_secs(25), drain).await.is_err() {
                server.agent.cancel_all().await;
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), async {
                    while !server.agent.idle().await { tokio::time::sleep(std::time::Duration::from_millis(50)).await; }
                }).await;
                // Exit while the workspace lock is still held. Detached blocking tasks must
                // never outlive lock ownership and overlap a restarted server's writes.
                super::telemetry::error("shutdown.deadline", Error::Deadline);
                std::process::exit(0);
            }
        }
    }
    stopping.stop();
    scheduler.abort();
    push_worker.abort();
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
    let frame = serde_json::to_string(&frame_html(&code, &s.origin))
        .map_err(|_| Error::Validation)?
        .replace('<', "\\u003c");
    let html=format!("<!doctype html><meta charset=utf-8><iframe id=frame sandbox='allow-scripts allow-forms' style='width:100%;height:600px;border:0'></iframe><script>const frame=document.getElementById('frame');frame.srcdoc={frame};addEventListener('message',async e=>{{if(e.source!==frame.contentWindow)return;if(e.data.kind==='diagnostic'){{window.errors.push(String(e.data.message));parent.postMessage({{kind:'diagnostic',message:String(e.data.message)}},'*');return;}}if(e.data.kind!=='action')return;try{{let r=await fetch('/preview-test/{ticket}/action',{{method:'POST',headers:{{'content-type':'application/json'}},body:JSON.stringify(e.data)}});let v=await r.json();frame.contentWindow.postMessage({{kind:'result',id:e.data.id,result:v.result,error:v.error}},'*');}}catch(error){{frame.contentWindow.postMessage({{kind:'result',id:e.data.id,error:String(error)}},'*');}}}});window.errors=[];</script>");
    let mut response = axum::response::Html(html).into_response();
    response.headers_mut().insert("content-security-policy",HeaderValue::from_static("default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; frame-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'"));
    Ok(response)
}
// The owner shell embeds the same isolated app frame directly. The harness
// wrapper is a top-level document and intentionally forbids being embedded.
async fn preview_frame(
    State(s): State<Arc<Server>>,
    Path(ticket): Path<String>,
) -> std::result::Result<Response, ApiError> {
    let preview = s.runtime.previews.get(&ticket).await?;
    let code = s
        .runtime
        .store
        .blocking(move |store| {
            Ok(store
                .revision(&preview.app, &preview.revision)?
                .code
                .frontend)
        })
        .await?;
    frame_response(&code, &s.origin)
}

async fn preview_test_action(
    State(s): State<Arc<Server>>,
    Path(ticket): Path<String>,
    Json(v): Json<Value>,
) -> Api<Value> {
    let preview = s.runtime.previews.get(&ticket).await?;
    let mut records = preview.records.lock().await;
    let (result, next, sqlite) = s
        .runtime
        .preview_action(
            preview.app,
            preview.revision,
            text(&v, "action")?,
            v["input"].clone(),
            records.0.clone(),
            records.1.clone(),
            preview.http,
        )
        .await?;
    *records = (next, sqlite);
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
    Ok(Json(
        json!({"ticket":ticket,"url":format!("/preview-test/{ticket}/frame"),"actionUrl":format!("/preview-test/{ticket}/action")}),
    ))
}
async fn owner_preview_close(State(s): State<Arc<Server>>, Json(v): Json<Value>) -> Api<Value> {
    s.runtime.previews.remove(&text(&v, "ticket")?).await;
    Ok(Json(json!({"closed":true})))
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

async fn revisions(State(s): State<Arc<Server>>, Path(app): Path<String>) -> Api<Value> {
    Ok(Json(s.runtime.store.blocking(move|store|{let app=AppId(app);let current=store.snapshot(&app)?.revision;let db=store.open()?;let mut q=db.prepare("SELECT r.id,r.code,EXISTS(SELECT 1 FROM revision_tests t WHERE t.revision=r.id AND t.digest=r.digest),(SELECT report FROM frontend_checks f WHERE f.revision=r.id AND f.digest=r.digest) FROM revisions r WHERE r.app=? ORDER BY r.rowid DESC LIMIT 50")?;let rows=q.query_map([&app.0],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,bool>(2)?,r.get::<_,Option<String>>(3)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;let result=rows.into_iter().map(|(id,code,tested,report)|{let code:AppCode=serde_json::from_str(&code).map_err(|_|Error::Storage)?;let kind=report.and_then(|s|serde_json::from_str::<Value>(&s).ok()).and_then(|v|v["kind"].as_str().map(str::to_owned));Ok(json!({"current":current.as_ref().is_some_and(|r|r.0==id),"id":id,"testCount":code.tests.len(),"backendTested":tested,"frontendKind":kind}))}).collect::<Result<Vec<_>>>()?;Ok(json!(result))}).await?))
}

async fn proposals(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    Ok(Json(
        super::interactions::list(&s.runtime.store, ConversationId(id)).await?,
    ))
}
async fn decide_proposal(
    State(s): State<Arc<Server>>,
    Path((id, proposal)): Path<(String, String)>,
    Json(v): Json<Value>,
) -> Api<Value> {
    let confirm = v["confirm"].as_bool().ok_or(Error::Validation)?;
    Ok(Json(
        super::interactions::decide(s.runtime.clone(), ConversationId(id), proposal, confirm)
            .await?,
    ))
}

async fn notice_list(State(s): State<Arc<Server>>) -> Api<Value> {
    Ok(Json(
        s.runtime
            .store
            .blocking(|store| notifications::list(&store))
            .await?,
    ))
}
async fn notice_read(State(s): State<Arc<Server>>, Json(value): Json<Value>) -> Api<Value> {
    if let Some(job) = value.get("seenJob").and_then(Value::as_str) {
        let job = job.to_owned();
        s.runtime
            .store
            .blocking(move |store| notifications::acknowledge_job(&store, &job))
            .await?;
        return Ok(Json(json!({"ok":true})));
    }
    let id = value.get("id").and_then(Value::as_str).map(str::to_owned);
    if id.is_none() && value.get("all") != Some(&Value::Bool(true)) {
        return Err(Error::Validation.into());
    }
    s.runtime
        .store
        .blocking(move |store| notifications::read(&store, id.as_deref()))
        .await?;
    Ok(Json(json!({"ok":true})))
}
async fn push_settings(State(s): State<Arc<Server>>) -> Api<Value> {
    let secrets = s.secrets.clone();
    let key = s
        .runtime
        .store
        .blocking(move |store| notifications::public_key(&store, &secrets))
        .await?;
    let delivery = s
        .runtime
        .store
        .blocking(|store| notifications::delivery_status(&store))
        .await?;
    Ok(Json(json!({"publicKey":key,"delivery":delivery})))
}
async fn push_update(State(s): State<Arc<Server>>, Json(value): Json<Value>) -> Api<Value> {
    let secrets = s.secrets.clone();
    s.runtime
        .store
        .blocking(move |store| {
            if value.get("enabled") == Some(&Value::Bool(false)) {
                notifications::unsubscribe(
                    &store,
                    value
                        .get("endpoint")
                        .and_then(Value::as_str)
                        .ok_or(Error::Validation)?,
                )
            } else {
                let sub = serde_json::from_value(
                    value
                        .get("subscription")
                        .cloned()
                        .ok_or(Error::Validation)?,
                )
                .map_err(|_| Error::Validation)?;
                notifications::subscribe(&store, &secrets, sub)
            }
        })
        .await?;
    Ok(Json(json!({"ok":true})))
}
async fn push_test(State(s): State<Arc<Server>>) -> Api<Value> {
    s.runtime
        .store
        .blocking(|store| notifications::test_notice(&store))
        .await?;
    Ok(Json(json!({"ok":true})))
}

async fn conversation_info(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    Ok(Json(s.runtime.store.blocking(move |store| {
        Ok(store.open()?.query_row("SELECT c.id,c.app,c.title,EXISTS(SELECT 1 FROM authoring_sessions a WHERE a.conversation=c.id),(SELECT id FROM jobs j WHERE j.conversation=c.id AND j.state IN ('running','queued') ORDER BY j.rowid DESC LIMIT 1),(SELECT id FROM jobs j WHERE j.conversation=c.id AND j.state IN ('completed','failed','interrupted','cancelled') ORDER BY j.rowid DESC LIMIT 1) FROM conversations c WHERE c.id=?",[id],|r|Ok(json!({"id":r.get::<_,String>(0)?,"app":r.get::<_,Option<String>>(1)?,"title":r.get::<_,String>(2)?,"build":r.get::<_,bool>(3)?,"job":r.get::<_,Option<String>>(4)?,"latestReplyJob":r.get::<_,Option<String>>(5)?})))?)
    }).await?))
}

async fn app_releases(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| store.releases(&AppId(id)))
            .await?,
    ))
}
async fn app_release_plans(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Api<Value> {
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| store.release_plans(&AppId(id)))
            .await?,
    ))
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct DataQuery {
    #[serde(default)]
    source: Option<releases::SavedData>,
    #[serde(default)]
    query: Option<releases::Query>,
}
async fn inspect_app_data(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Json(input): Json<DataQuery>,
) -> Api<Value> {
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| store.inspect_data(&AppId(id), input.source, input.query))
            .await?,
    ))
}
async fn prepare_app_release(
    State(s): State<Arc<Server>>,
    Path(id): Path<String>,
    Json(plan): Json<releases::Plan>,
) -> Api<Value> {
    Ok(Json(
        s.runtime
            .prepare_release(AppId(id), plan, None, Cancellation::default())
            .await?,
    ))
}
#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct ConfirmRelease {
    confirm: bool,
}
async fn apply_app_release(
    State(s): State<Arc<Server>>,
    Path((id, plan)): Path<(String, String)>,
    Json(input): Json<ConfirmRelease>,
) -> Api<Value> {
    // Once accepted, a lost HTTP response cannot interrupt the atomic release.
    let task = tokio::spawn(async move {
        s.runtime
            .store
            .blocking(move |store| {
                store.apply_release(&AppId(id), &plan, input.confirm, Cancellation::default())
            })
            .await
    });
    Ok(Json(task.await.map_err(|_| ApiError(Error::Storage))??))
}

async fn storage_status(
    State(s): State<Arc<Server>>,
    Query(policy): Query<StoragePolicy>,
) -> Api<Value> {
    let policy = policy.into_policy();
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| maintenance::status(&store, &policy))
            .await?,
    ))
}
#[derive(Default, serde::Deserialize)]
struct StoragePolicy {
    keep_releases: Option<usize>,
    orphan_days: Option<i64>,
    confirm: Option<bool>,
}
impl StoragePolicy {
    fn into_policy(self) -> maintenance::Retention {
        maintenance::Retention {
            keep_releases: self.keep_releases.unwrap_or(20),
            orphan_days: self.orphan_days.unwrap_or(30),
        }
    }
}
async fn storage_cleanup(
    State(s): State<Arc<Server>>,
    Json(policy): Json<StoragePolicy>,
) -> Api<Value> {
    if policy.confirm != Some(true) {
        return Err(Error::ApprovalRequired.into());
    }
    let policy = policy.into_policy();
    Ok(Json(
        s.runtime
            .store
            .blocking(move |store| maintenance::cleanup(&store, &policy))
            .await?,
    ))
}

async fn discard_app_release(
    State(s): State<Arc<Server>>,
    Path((app, plan)): Path<(String, String)>,
) -> Api<Value> {
    s.runtime
        .store
        .blocking(move |store| store.discard_release_plan(&AppId(app), &plan))
        .await?;
    Ok(Json(json!({"discarded":true})))
}

fn login_source(
    peer: std::net::SocketAddr,
    headers: &HeaderMap,
    trust_proxy: bool,
) -> Result<String> {
    let ip = if trust_proxy {
        if !peer.ip().is_loopback() {
            return Err(Error::Unauthorized);
        }
        headers
            .get("x-real-ip")
            .and_then(|h| h.to_str().ok())
            .and_then(|s| s.parse::<std::net::IpAddr>().ok())
            .ok_or(Error::Unauthorized)?
    } else {
        peer.ip()
    };
    // Group IPv6 privacy addresses by /64 so rotating addresses cannot bypass the window.
    Ok(match ip {
        std::net::IpAddr::V6(ip) => match ip.to_ipv4_mapped() {
            Some(ip) => ip.to_string(),
            None => {
                let s = ip.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
        _ => ip.to_string(),
    })
}
async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! { result=tokio::signal::ctrl_c()=>result, _=terminate.recv()=>Ok(()) }
    }
    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c().await
    }
}
async fn readiness(State(s): State<Arc<Server>>) -> StatusCode {
    if !s.runtime.operations.healthy() {
        return StatusCode::SERVICE_UNAVAILABLE;
    }
    if let Some(browser) = &s.runtime.browser {
        if !browser.healthy().await {
            return StatusCode::SERVICE_UNAVAILABLE;
        }
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(2),
        s.runtime
            .store
            .blocking(|store| operations::storage_health(&store)),
    )
    .await
    {
        Ok(Ok(value)) if value["storageHealthy"] == true => StatusCode::OK,
        _ => StatusCode::SERVICE_UNAVAILABLE,
    }
}
async fn operations_status(State(s): State<Arc<Server>>) -> Api<Value> {
    let storage = s
        .runtime
        .store
        .blocking(|store| operations::storage_health(&store))
        .await?;
    let browser_healthy = match &s.runtime.browser {
        Some(browser) => Some(browser.healthy().await),
        None => None,
    };
    Ok(Json(
        json!({"process":s.runtime.operations.status(),"storage":storage,
        "actionSlotsAvailable":s.runtime.available_actions(),"sqlSlotsAvailable":worker::sql_available(),
        "browserVerifierConfigured":s.runtime.browser.is_some(),"browserVerifierHealthy":browser_healthy}),
    ))
}

#[cfg(test)]
mod ingress_tests {
    use super::*;
    #[test]
    fn source_headers_require_explicit_trusted_loopback_proxy() {
        let mut h = HeaderMap::new();
        h.insert("x-real-ip", HeaderValue::from_static("203.0.113.7"));
        let local = "127.0.0.1:42".parse().unwrap();
        assert_eq!(login_source(local, &h, false).unwrap(), "127.0.0.1");
        assert_eq!(login_source(local, &h, true).unwrap(), "203.0.113.7");
        assert!(login_source("192.0.2.1:42".parse().unwrap(), &h, true).is_err());
        h.insert(
            "x-real-ip",
            HeaderValue::from_static("203.0.113.7, 1.2.3.4"),
        );
        assert!(login_source(local, &h, true).is_err());
    }
}
