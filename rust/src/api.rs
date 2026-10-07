use crate::{
    automation, backend, jobs, photos,
    store::{execute, first, now, query, text, Result, LAUNCHER},
    vault, App,
};
use axum::{
    body::{to_bytes, Body},
    extract::{Multipart, Path, Request, State},
    http::{HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use tower_http::{
    compression::CompressionLayer,
    services::{ServeDir, ServeFile},
    set_header::SetResponseHeaderLayer,
};
fn response(result: Result<Value>) -> Response {
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response(),
    }
}
fn cookie(app: &App, request: &Request) -> String {
    request
        .headers()
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .find_map(|p| p.trim().strip_prefix(&format!("{}=", app.cookie_name())))
        .unwrap_or("")
        .into()
}
fn origin_matches(expected: &str, origin: Option<&str>, host: Option<&str>) -> bool {
    if origin == Some(expected) {
        return true;
    }
    let Some(origin) = origin else { return false };
    let (Ok(expected), Ok(actual)) = (url::Url::parse(expected), url::Url::parse(origin)) else {
        return false;
    };
    let local = |url: &url::Url| match url.host() {
        Some(url::Host::Domain(name)) => name == "localhost",
        Some(url::Host::Ipv4(ip)) => ip == std::net::Ipv4Addr::LOCALHOST,
        Some(url::Host::Ipv6(ip)) => ip == std::net::Ipv6Addr::LOCALHOST,
        None => false,
    };
    // Local development aliases must still be same-origin with the request host.
    // Production origins continue to require an exact match.
    expected.scheme() == "http"
        && actual.scheme() == "http"
        && local(&expected)
        && local(&actual)
        && expected.port_or_known_default() == actual.port_or_known_default()
        && actual.origin().ascii_serialization() == origin
        && host.is_some_and(|host| {
            origin
                .strip_prefix("http://")
                .is_some_and(|authority| host.eq_ignore_ascii_case(authority))
        })
}
async fn guard(State(app): State<App>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    if !matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    ) && !origin_matches(
        &app.origin,
        request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok()),
        request.headers().get("host").and_then(|v| v.to_str().ok()),
    ) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"Requests must come from this app"})),
        )
            .into_response();
    }
    if (path.starts_with("/api/")
        || path.starts_with("/auth/")
        || path == "/logout"
        || path == "/logout/all")
        && !matches!(path, "/api/session" | "/api/login" | "/api/setup")
        && app
            .auth
            .session(&app.store, &cookie(&app, &request))
            .is_none()
    {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Sign in to LittleSpaces"})),
        )
            .into_response();
    }
    next.run(request).await
}
#[cfg(test)]
mod origin_tests {
    use super::origin_matches;
    #[test]
    fn local_aliases_require_the_same_port_and_request_host() {
        let expected = "http://127.0.0.1:5180";
        assert!(origin_matches(
            expected,
            Some("http://localhost:5180"),
            Some("localhost:5180")
        ));
        for (origin, host) in [
            (Some("http://localhost:5181"), Some("localhost:5181")),
            (Some("http://localhost:5180"), Some("127.0.0.1:5180")),
            (
                Some("http://attacker.example:5180"),
                Some("attacker.example:5180"),
            ),
            (Some("http://localhost:5180/path"), Some("localhost:5180")),
            (None, Some("localhost:5180")),
        ] {
            assert!(!origin_matches(expected, origin, host));
        }
        assert!(origin_matches(
            "http://localhost:5180",
            Some(expected),
            Some("127.0.0.1:5180")
        ));
    }
    #[test]
    fn production_origins_remain_exact() {
        let expected = "https://app.example";
        assert!(origin_matches(
            expected,
            Some(expected),
            Some("app.example")
        ));
        assert!(!origin_matches(
            expected,
            Some("https://localhost"),
            Some("localhost")
        ));
        assert!(!origin_matches(
            "https://127.0.0.1:5180",
            Some("https://localhost:5180"),
            Some("localhost:5180")
        ));
    }
}
pub fn router(app: App) -> Router {
    Router::new()
        .route(
            "/health",
            get(|| async { Json(json!({"ok":true,"stack":"rust-preact-quickjs"})) }),
        )
        .route("/api/spaces/:id/photos", get(handle).post(upload))
        .route(
            "/api/*path",
            get(handle).post(handle).patch(handle).delete(handle),
        )
        .route("/auth/start", post(handle))
        .route("/auth/status", get(handle))
        .route("/auth/logout", post(handle))
        .route("/logout", post(handle))
        .route("/logout/all", post(handle))
        .fallback_service(
            ServeDir::new(&app.assets)
                .precompressed_gzip()
                .not_found_service(ServeFile::new(app.assets.join("index.html"))),
        )
        .layer(CompressionLayer::new().gzip(true))
        .layer(middleware::from_fn_with_state(app.clone(), guard))
        .layer(axum::extract::DefaultBodyLimit::max(
            8 * 1024 * 1024 + 10000,
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            axum::http::header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .with_state(app)
}
async fn upload(
    State(app): State<App>,
    Path(space): Path<String>,
    mut multipart: Multipart,
) -> Response {
    let result = async {
        let _permit = app
            .actions
            .try_acquire()
            .map_err(|_| "The app server is busy. Retry shortly.")?;
        while let Some(field) = multipart.next_field().await.map_err(|_| "Invalid upload")? {
            if field.name() != Some("photo") {
                continue;
            }
            let name = field.file_name().unwrap_or("Photo").to_string();
            let bytes = field.bytes().await.map_err(|_| "Invalid photo")?;
            let store = app.store.clone();
            let value =
                tokio::task::spawn_blocking(move || photos::import(&store, &space, &name, &bytes))
                    .await
                    .map_err(|e| e.to_string())??;
            return Ok(json!({"photo":value}));
        }
        Err("Choose a photo".into())
    }
    .await;
    response(result)
}
async fn handle(State(app): State<App>, request: Request) -> Response {
    let fields = json!({"path":request.uri().path(),"method":request.method().as_str()});
    let store = app.store.clone();
    crate::diagnostics::trace(&store, "http", fields, handle_inner(app, request)).await
}
async fn handle_inner(app: App, request: Request) -> Response {
    let path = request.uri().path().to_string();
    let method = request.method().clone();
    let token = cookie(&app, &request);
    let query: std::collections::HashMap<String, String> =
        url::form_urlencoded::parse(request.uri().query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let input = if matches!(method, Method::GET | Method::HEAD) {
        json!({})
    } else {
        match to_bytes(request.into_body(), 150000).await {
            Ok(bytes) => {
                if bytes.is_empty() {
                    json!({})
                } else {
                    match serde_json::from_slice::<Value>(&bytes) {
                        Ok(v) if v.is_object() => v,
                        _ => return response(Err("Expected a JSON object".into())),
                    }
                }
            }
            Err(_) => {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    Json(json!({"error":"Request is too large"})),
                )
                    .into_response()
            }
        }
    };
    if path == "/api/login" && method == Method::POST {
        return match app.auth.login(&app.store, &input).await {
            Ok((session, remember)) => {
                let mut response = Json(json!({"ok":true})).into_response();
                let secure = if app.secure { "; Secure" } else { "" };
                let age = if remember { "; Max-Age=2592000" } else { "" };
                response.headers_mut().insert(
                    "set-cookie",
                    HeaderValue::from_str(&format!(
                        "{}={session}; Path=/; HttpOnly; SameSite=Lax{secure}{age}",
                        app.cookie_name()
                    ))
                    .unwrap(),
                );
                response
            }
            Err(error) => response(Err(error)),
        };
    }
    if path == "/api/setup" && method == Method::POST {
        return response(
            app.auth
                .configure(&app.store, &input)
                .await
                .map(|_| json!({"ok":true})),
        );
    }
    if path == "/logout" || path == "/logout/all" {
        let result = app.auth.logout(&app.store, &token, path.ends_with("/all"));
        let mut response = response(result.map(|_| json!({"ok":true})));
        response.headers_mut().insert(
            "set-cookie",
            HeaderValue::from_str(&format!(
                "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{}",
                app.cookie_name(),
                if app.secure { "; Secure" } else { "" }
            ))
            .unwrap(),
        );
        return response;
    }
    if path.starts_with("/auth/") && app.auth.session(&app.store, &token).is_none() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({"error":"Sign in first"})),
        )
            .into_response();
    }
    if let Some((space, id)) = photo_path(&path) {
        if method == Method::GET {
            return match photos::read(&app.store, space, id) {
                Ok((mut metadata, bytes)) => {
                    if query.contains_key("data") {
                        use base64::Engine;
                        metadata["dataUrl"] = json!(format!(
                            "data:{};base64,{}",
                            text(&metadata, "mime"),
                            base64::engine::general_purpose::STANDARD.encode(bytes)
                        ));
                        Json(metadata).into_response()
                    } else {
                        let mut response = Response::new(Body::from(bytes));
                        response.headers_mut().insert(
                            "content-type",
                            HeaderValue::from_str(text(&metadata, "mime")).unwrap(),
                        );
                        response
                    }
                }
                Err(error) => response(Err(error)),
            };
        }
    }
    if let Some(id) = path
        .strip_prefix("/api/applets/")
        .and_then(|v| v.strip_suffix("/document"))
    {
        return match applet_document(&app, id).await {
            Ok(doc) => axum::response::Html(doc).into_response(),
            Err(error) => response(Err(error)),
        };
    }
    response(dispatch(&app, &path, &method, &query, input, &token).await)
}
fn photo_path(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("/api/spaces/")?;
    let (space, id) = rest.split_once("/photos/")?;
    if id.contains('/') {
        return None;
    }
    Some((space, id))
}
async fn dispatch(
    app: &App,
    path: &str,
    method: &Method,
    query_args: &std::collections::HashMap<String, String>,
    input: Value,
    token: &str,
) -> Result<Value> {
    let store = &app.store;
    match path {
        "/api/session" => {
            return Ok(
                json!({"configured":app.auth.owner(store).is_ok(),"owner":app.auth.session(store,token)}),
            )
        }
        "/api/state" => {
            let owner = app.auth.session(store, token).ok_or("Sign in first")?;
            if let Ok(mut guard) = app.codex.try_lock() {
                if guard.is_none() && crate::codex::binary().is_ok() {
                    *guard = Some(crate::codex::Codex::start(store).await?);
                }
                if let Some(rpc) = guard.as_mut() {
                    if let Ok(account) = rpc.account(text(&owner, "email")).await {
                        *app.account.lock().map_err(|_| "Account unavailable")? = account;
                    }
                }
            }
            return Ok(
                json!({"owner":owner,"account":*app.account.lock().map_err(|_|"Account unavailable")?,"spaces":store.spaces(false)?,"apps":store.spaces(true)?,"chatSpaceId":LAUNCHER}),
            );
        }
        "/api/applets" => {
            if method == Method::GET {
                let mut applets = Vec::new();
                for space in store.spaces(true)? {
                    if let Ok(id) = store.applet_id(text(&space, "id")) {
                        if let Ok(mut rev) = store.revision(&id, None) {
                            rev["id"] = json!(id);
                            applets.push(rev);
                        }
                    }
                }
                return Ok(json!({"applets":applets}));
            }
            if text(&input, "template") != "plants" {
                return Err("Unknown template".into());
            }
            let _permit = app
                .actions
                .try_acquire()
                .map_err(|_| "App server is busy")?;
            let space = if text(&input, "spaceId").is_empty() {
                store.create_space("Plant care", "leaf")?
            } else {
                store.space(text(&input, "spaceId"))?
            };
            if store.applet_id(text(&space, "id")).is_ok() {
                return Err("This space already has an applet".into());
            }
            let source = include_str!("../../web/applets/plants.js");
            backend::validate_frontend(source)?;
            let tests = backend::test(include_str!("plants-backend.js")).await?;
            let content = json!({"title":"Plant care","description":"A watering journal for your indoor jungle.","source":source,"bundle":source,"backend":include_str!("plants-backend.js"),"backendBundle":include_str!("plants-backend.js"),"testReport":json!(tests.report).to_string(),"chatInstructions":include_str!("plants-chat.txt"),"frontendFormat":"preact-htm"});
            return Ok(
                json!({"applet":store.publish(text(&space,"id"),&crate::random_uuid(),&content,None)?,"spaceId":space["id"]}),
            );
        }
        "/api/spaces" => {
            if method == Method::GET {
                return Ok(json!({"spaces":store.spaces(false)?}));
            }
            return Ok(
                json!({"space":store.create_space(text(&input,"name"),if text(&input,"icon").is_empty(){"grid"}else{text(&input,"icon")})?}),
            );
        }
        "/auth/start" => {
            let mut guard = app.rpc().await?;
            return guard.as_mut().unwrap().login_start().await;
        }
        "/auth/status" => {
            let email = text(&app.auth.owner(store)?, "email").to_string();
            let mut guard = app.rpc().await?;
            let value = guard.as_mut().unwrap().login_status(&email).await?;
            if value["status"] == json!("complete") {
                *app.account.lock().map_err(|_| "Account unavailable")? = value["account"].clone();
            }
            return Ok(value);
        }
        "/auth/logout" => {
            app.rpc()
                .await?
                .as_mut()
                .unwrap()
                .request("account/logout", json!({}))
                .await?;
            *app.account.lock().map_err(|_| "Account unavailable")? = Value::Null;
            return Ok(json!({"ok":true}));
        }
        "/api/models" => {
            if let Ok(mut rpc) = app.codex.try_lock() {
                if rpc.is_none() {
                    *rpc = Some(crate::codex::Codex::start(store).await?);
                }
                let models = rpc.as_mut().unwrap().models().await?;
                *app.models.lock().map_err(|_| "Model catalog unavailable")? = models.clone();
                return Ok(json!({"models":models}));
            }
            return Ok(
                json!({"models":*app.models.lock().map_err(|_|"Model catalog unavailable")?}),
            );
        }
        "/api/chat" => {
            if method == Method::GET {
                let space = query_args.get("spaceId").map(String::as_str).unwrap_or("");
                let chat = query_args.get("chatId").map(String::as_str).unwrap_or("");
                store.chat(space, chat)?;
                return Ok(
                    json!({"messages":store.messages(chat)?,"tools":store.tools(chat,None)?,"job":jobs::latest(app,chat),"running":jobs::running(app,space)}),
                );
            }
            if method == Method::PATCH {
                return Ok(json!({"job":jobs::stop(app,&input)?}));
            }
            if method == Method::DELETE {
                let deleted=execute(&store.workspace()?,"DELETE FROM chats WHERE id=? AND NOT EXISTS(SELECT 1 FROM messages WHERE thread=chats.id) AND NOT EXISTS(SELECT 1 FROM chat_tools WHERE thread=chats.id) AND NOT EXISTS(SELECT 1 FROM build_plans WHERE chat_id=chats.id) AND NOT EXISTS(SELECT 1 FROM build_drafts WHERE chat_id=chats.id) AND NOT EXISTS(SELECT 1 FROM voice_actions WHERE chat_id=chats.id)",&[input["chatId"].clone()])?;
                return Ok(json!({"deleted":deleted>0}));
            }
            return Ok(json!({"job":jobs::start(app.clone(),input,false).await?}));
        }
        "/api/build-plans" => {
            let chat = if method == Method::GET {
                query_args.get("chatId").map(String::as_str).unwrap_or("")
            } else {
                text(&input, "chatId")
            };
            let mut plan = store.json_row("build_plans", chat).unwrap_or(Value::Null);
            if method != Method::GET {
                if plan["id"] != input["id"]
                    || text(&input, "decision") != "cancel"
                    || plan["status"] == json!("running")
                {
                    return Err("Build plan cannot be dismissed now".into());
                }
                plan["status"] = json!("cancelled");
                store.json_save("build_plans", chat, &plan)?;
            }
            return Ok(json!({"plan":plan}));
        }
        "/api/notifications" => {
            if method != Method::GET {
                execute(
                    &store.workspace()?,
                    "UPDATE notifications SET is_read=1 WHERE (? IS NULL OR id=?) AND due_at<=?",
                    &[input["id"].clone(), input["id"].clone(), json!(now())],
                )?;
            }
            return Ok(json!({"notifications":automation::notifications(store,None,false)?}));
        }
        "/api/settings/apps" => {
            if method != Method::GET {
                let id = text(&input, "id");
                if id == LAUNCHER {
                    return Err("Chat cannot be archived".into());
                }
                execute(
                    &store.workspace()?,
                    "UPDATE spaces SET archived=? WHERE id=?",
                    &[input["archived"].clone(), json!(id)],
                )?;
            }
            return Ok(json!({"apps":store.spaces(true)?}));
        }
        "/api/settings/secrets" => {
            if method != Method::GET {
                if text(&input, "action") == "delete" {
                    execute(
                        &store.workspace()?,
                        "DELETE FROM secrets WHERE name=?",
                        &[input["name"].clone()],
                    )?;
                } else {
                    vault::save(store, &input)?;
                }
            }
            return Ok(json!({"secrets":vault::list(store)?}));
        }
        "/api/settings/schedules" => {
            if method != Method::GET {
                execute(
                    &store.workspace()?,
                    "DELETE FROM schedules WHERE space_id=? AND key=?",
                    &[input["spaceId"].clone(), input["key"].clone()],
                )?;
            }
            return Ok(json!({"schedules":automation::schedules(store,None)?}));
        }
        "/api/settings/push" => {
            if method == Method::GET {
                return Ok(json!({"publicKey":automation::vapid(store)?["publicKey"]}));
            }
            if text(&input, "action") == "status" {
                return Ok(
                    json!({"enabled":first(&store.workspace()?,"SELECT endpoint FROM push_subscriptions WHERE endpoint=?",&[input["endpoint"].clone()]).is_ok()}),
                );
            }
            if text(&input, "action") == "disable" {
                execute(
                    &store.workspace()?,
                    "DELETE FROM push_subscriptions WHERE endpoint=?",
                    &[input["endpoint"].clone()],
                )?;
            } else {
                automation::subscription(&input["subscription"])?;
                if first(
                    &store.workspace()?,
                    "SELECT COUNT(*) AS n FROM push_subscriptions",
                    &[],
                )?["n"]
                    .as_i64()
                    .unwrap_or(0)
                    >= 20
                {
                    return Err("Device limit reached".into());
                }
                execute(&store.workspace()?,"INSERT INTO push_subscriptions VALUES(?,?,?) ON CONFLICT(endpoint) DO UPDATE SET subscription=excluded.subscription",&[input["subscription"]["endpoint"].clone(),json!(input["subscription"].to_string()),json!(now())])?;
            }
            return Ok(json!({"ok":true}));
        }
        "/api/voice/actions" => {
            let chat = if method == Method::GET {
                query_args.get("chatId").map(String::as_str).unwrap_or("")
            } else {
                text(&input, "chatId")
            };
            store.chat(LAUNCHER, chat)?;
            if method != Method::GET {
                let mut proposal = store.json_row("voice_actions", text(&input, "id"))?;
                if text(&proposal, "chatId") != chat {
                    return Err("Suggestion belongs to another conversation".into());
                }
                if text(&proposal, "status") == "pending" {
                    let decision = text(&input, "decision");
                    if !["confirm", "cancel"].contains(&decision) {
                        return Err("Choose confirm or cancel".into());
                    }
                    proposal["status"] = json!(if decision == "confirm" {
                        "running"
                    } else {
                        "cancelled"
                    });
                    let claimed = execute(
                        &store.workspace()?,
                        "UPDATE voice_actions SET status=?,data=? WHERE id=? AND status='pending'",
                        &[
                            proposal["status"].clone(),
                            json!(proposal.to_string()),
                            proposal["id"].clone(),
                        ],
                    )?;
                    if claimed > 0 && decision == "confirm" {
                        let result = async {
                            if store.space(text(&proposal, "spaceId"))?["archived"] == json!(1) {
                                return Err("App is archived".into());
                            }
                            let created =
                                chrono::DateTime::parse_from_rfc3339(text(&proposal, "createdAt"))
                                    .map_err(|_| "Invalid suggestion date")?;
                            if chrono::Utc::now()
                                .signed_duration_since(created)
                                .num_minutes()
                                > 30
                            {
                                return Err(
                                    "Suggestion expired. Ask Voice to inspect current data again."
                                        .into(),
                                );
                            }
                            let _permit = app
                                .actions
                                .try_acquire()
                                .map_err(|_| "App server is busy")?;
                            backend::call(
                                store,
                                text(&proposal, "appletId"),
                                text(&proposal, "action"),
                                proposal["input"].clone(),
                                false,
                                proposal["version"].as_i64(),
                                true,
                            )
                            .await
                        }
                        .await;
                        match result {
                            Ok(value) => {
                                proposal["status"] = json!("complete");
                                proposal["result"] = value;
                            }
                            Err(error) => {
                                proposal["status"] = json!("failed");
                                proposal["error"] = json!(error);
                            }
                        }
                        execute(
                            &store.workspace()?,
                            "UPDATE voice_actions SET status=?,data=? WHERE id=?",
                            &[
                                proposal["status"].clone(),
                                json!(proposal.to_string()),
                                proposal["id"].clone(),
                            ],
                        )?;
                    }
                }
            }
            let rows = query(
                &store.workspace()?,
                "SELECT data FROM voice_actions WHERE chat_id=? ORDER BY rowid",
                &[json!(chat)],
            )?;
            return Ok(
                json!({"actions":rows.iter().filter_map(|r|serde_json::from_str::<Value>(text(r,"data")).ok()).collect::<Vec<_>>()}),
            );
        }
        _ => {}
    }
    let parts = path.trim_start_matches('/').split('/').collect::<Vec<_>>();
    if parts.len() >= 4 && parts[0] == "api" && parts[1] == "spaces" {
        let space = parts[2];
        store.space(space)?;
        match parts[3] {
            "chats" => {
                if method == Method::GET {
                    return Ok(json!({"chats":store.chats(space)?}));
                }
                return Ok(
                    json!({"chat":store.create_chat(space,input["launch"].as_object().map(|_|input["launch"].clone()).unwrap_or(json!({})))?}),
                );
            }
            "view" => {
                let id = store.applet_id(space).ok();
                let chats = store.chats(space)?;
                return Ok(
                    json!({"space":store.space(space)?,"chats":chats,"applet":id.as_ref().and_then(|id|store.revision(id,None).ok()).map(|mut v|{v["id"]=json!(id);v}),"account":*app.account.lock().map_err(|_|"Account unavailable")?}),
                );
            }
            "photos" => return Ok(json!({"photos":photos::list(store,space)?})),
            "notifications" => {
                let result = if method == Method::GET {
                    automation::notifications(store, Some(space), true)?
                } else if text(&input, "action") == "cancel" {
                    execute(
                        &store.workspace()?,
                        "DELETE FROM notifications WHERE space_id=? AND key=?",
                        &[json!(space), input["key"].clone()],
                    )?;
                    json!({"cancelled":true})
                } else {
                    automation::notify(store, space, &input)?
                };
                return Ok(json!({"result":result}));
            }
            "schedules" => {
                let result = if method == Method::GET {
                    automation::schedules(store, Some(space))?
                } else if text(&input, "action") == "cancel" {
                    execute(
                        &store.workspace()?,
                        "DELETE FROM schedules WHERE space_id=? AND key=?",
                        &[json!(space), input["key"].clone()],
                    )?;
                    json!({"cancelled":true})
                } else {
                    automation::schedule(store, space, &input)?
                };
                return Ok(json!({"result":result}));
            }
            "vision" => {
                return Ok(json!({"result":crate::vision::analyze(app,space,&input).await?}))
            }
            _ => {}
        }
    }
    if parts.len() >= 3 && parts[0] == "api" && parts[1] == "applets" {
        let id = parts[2];
        let rev = store.revision(id, None)?;
        if parts.len() == 3 {
            if method != Method::GET {
                if text(&input, "action") != "restore" {
                    return Err("Choose restore".into());
                }
                if rev["version"] != input["expectedVersion"] {
                    return Err("App changed. Reload versions.".into());
                }
                let version = input["version"].as_i64().ok_or("Choose version")?;
                if rev["version"] == json!(version) {
                    return Err("That version is already current".into());
                }
                let old = store.revision(id, Some(version))?;
                let owner = first(
                    &store.workspace()?,
                    "SELECT space_id FROM space_applets WHERE applet_id=?",
                    &[json!(id)],
                )?;
                store.publish(text(&owner, "space_id"), id, &old, Some(version))?;
            }
            return Ok(
                json!({"applet":store.revision(id,None)?,"versions":store.versions(id)?,"document":applet_document(app,id).await?,"spaceId":first(&store.workspace()?,"SELECT space_id FROM space_applets WHERE applet_id=?",&[json!(id)])?["space_id"]}),
            );
        }
        match parts[3] {
            "actions" => {
                if method == Method::GET {
                    return Ok(json!({"actions":backend::inspect(backend::source(&rev)).await?}));
                }
                let _permit = app
                    .actions
                    .try_acquire()
                    .map_err(|_| "App server is busy running actions")?;
                return Ok(
                    json!({"result":backend::call(store,id,text(&input,"action"),input.get("input").cloned().unwrap_or(json!({})),false,None,true).await?}),
                );
            }
            "records" => {
                if method != Method::GET {
                    if !backend::source(&rev).is_empty() {
                        return Err(
                            "This app uses backend actions. Direct writes are unavailable.".into(),
                        );
                    }
                    let key = text(&input, "key");
                    if key.is_empty() || key.chars().count() > 200 {
                        return Err("Invalid record key".into());
                    }
                    if text(&input, "method") == "remove" {
                        execute(
                            &store.applet(id, false)?,
                            "DELETE FROM records WHERE key=?",
                            &[json!(key)],
                        )?;
                    } else {
                        let db = store.applet(id, false)?;
                        if first(&db, "SELECT COUNT(*) AS n FROM records", &[])?["n"]
                            .as_i64()
                            .unwrap_or(0)
                            >= 2000
                            && first(&db, "SELECT key FROM records WHERE key=?", &[json!(key)])
                                .is_err()
                        {
                            return Err("This app has reached its 2,000-record limit".into());
                        }
                        if input["value"].to_string().chars().count() > 100000 {
                            return Err("Record exceeds limit".into());
                        }
                        execute(&store.applet(id,false)?,"INSERT INTO records VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",&[json!(key),json!(input["value"].to_string())])?;
                    }
                }
                return Ok(json!({"records":store.records(id)?}));
            }
            "diagnostics" => {
                static REPORTS: std::sync::Mutex<(i64, u32)> = std::sync::Mutex::new((0, 0));
                {
                    let mut reports = REPORTS.lock().map_err(|_| "Diagnostic state unavailable")?;
                    let now = chrono::Utc::now().timestamp();
                    if now - reports.0 > 60 {
                        *reports = (now, 0);
                    }
                    reports.1 += 1;
                    if reports.1 > 60 {
                        return Err("Too many diagnostic reports. Try again later.".into());
                    }
                }

                if !input["message"].is_string()
                    || text(&input, "message").chars().count() > 4000
                    || text(&input, "stack").chars().count() > 8000
                {
                    return Err("Invalid diagnostic report".into());
                }
                crate::diagnostics::log(
                    store,
                    "frontend.error",
                    json!({"appletId":id,"version":rev["version"],"message":input["message"],"stack":input["stack"],"source":"untrusted applet report"}),
                );
                return Ok(json!({"logged":true}));
            }
            _ => {}
        }
    }
    Err("Endpoint not found".into())
}
async fn applet_document(app: &App, id: &str) -> Result<String> {
    let revision = app.store.revision(id, None)?;
    let bundle = text(&revision, "bundle");
    let nonce = crate::random_id();
    let runtime = if text(&revision, "frontendFormat") == "preact-htm" {
        std::fs::read_to_string(app.assets.join("applet-runtime.js"))
            .map_err(|_| "Build frontend assets first")?
    } else {
        String::new()
    };
    let css = if runtime.is_empty() {
        String::new()
    } else {
        std::fs::read_to_string(app.assets.join("applet.css"))
            .map_err(|_| "Build applet styles first")?
    };
    let baseline="html{color-scheme:light}body{margin:0;font:16px/1.5 system-ui,sans-serif;color:#17223b;background:#fff}*{box-sizing:border-box}button,input,textarea,select{font:inherit}button{cursor:pointer}button:disabled{cursor:wait}";
    let baseline = if runtime.is_empty() {
        baseline.to_string()
    } else {
        format!("@layer base {{{baseline}}}")
    };
    let script=format!("{}\n{}\ntry {{\n{}\n}} catch(error) {{ window.dispatchEvent(new ErrorEvent('error',{{error,message:error.message}})); }}",include_str!("bridge.js"),runtime,bundle).replace("</script","<\\/script");
    Ok(format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'nonce-{nonce}';style-src 'unsafe-inline';img-src data: blob:;connect-src 'none';frame-src 'none';form-action 'none';base-uri 'none';"><style>{baseline}{css}</style></head><body><div id="app"></div><script nonce="{nonce}">{script}</script></body></html>"#
    ))
}
