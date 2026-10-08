//! Applet HTTP operations. The parent router owns session and origin enforcement.
use crate::{
    backend,
    store::{execute, first, text, Result},
    App,
};
use axum::http::Method;
use serde_json::{json, Value};
use std::collections::HashMap;

pub(super) async fn dispatch(
    app: &App,
    parts: &[&str],
    method: &Method,
    input: Value,
) -> Result<Value> {
    let store = &app.store;

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
            store.publish(
                text(&owner, "space_id"),
                id,
                &old,
                Some(version),
                input["expectedVersion"]
                    .as_i64()
                    .ok_or("Choose expected version")?,
            )?;
        }
        return Ok(
            json!({"applet":store.revision(id,None)?,"versions":store.versions(id)?,"document":document(app,id).await?,"spaceId":first(&store.workspace()?,"SELECT space_id FROM space_applets WHERE applet_id=?",&[json!(id)])?["space_id"]}),
        );
    }
    match parts[3] {
        "actions" => {
            if method == Method::GET {
                return Ok(json!({"actions":backend::catalog(store, id, &rev).await?}));
            }
            let _permit = app
                .actions
                .try_acquire()
                .map_err(|_| "App server is busy running actions")?;
            return Ok(
                json!({"result":backend::call(store,id,text(&input,"action"),input.get("input").cloned().unwrap_or(json!({})),false,input["version"].as_i64(),true).await?}),
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
                        && first(&db, "SELECT key FROM records WHERE key=?", &[json!(key)]).is_err()
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
        "permissions" => {
            let grants = if method == Method::GET {
                crate::capabilities::grants(store, id)?
            } else {
                crate::capabilities::save(store, id, &input["grants"])?
            };
            return Ok(json!({"grants":grants,"actions":backend::catalog(store,id,&rev).await?}));
        }
        "diagnostics" => {
            if method == Method::GET {
                return crate::diagnostics::read(
                    store,
                    id,
                    rev["version"].as_i64().unwrap_or(0),
                    None,
                    10,
                );
            }
            if input["version"] != rev["version"] {
                return Err("Diagnostic report belongs to an older app revision".into());
            }
            static REPORTS: std::sync::OnceLock<std::sync::Mutex<HashMap<String, (i64, u32)>>> =
                std::sync::OnceLock::new();
            {
                let mut reports = REPORTS
                    .get_or_init(|| std::sync::Mutex::new(HashMap::new()))
                    .lock()
                    .map_err(|_| "Diagnostic state unavailable")?;
                let now = chrono::Utc::now().timestamp();
                reports.retain(|_, (since, _)| now - *since <= 60);
                let count = reports.entry(id.to_string()).or_insert((now, 0));
                count.1 += 1;
                if count.1 > 60 {
                    return Err("Too many diagnostic reports. Try again later.".into());
                }
            }

            if !input["message"].is_string()
                || text(&input, "message").chars().count() > 4000
                || text(&input, "stack").chars().count() > 8000
            {
                return Err("Invalid diagnostic report".into());
            }
            let kind = match text(&input, "kind") {
                "snapshot" => "frontend.snapshot",
                "console" => "frontend.console",
                _ => "frontend.error",
            };
            crate::diagnostics::record(
                store,
                id,
                rev["version"].as_i64().unwrap_or(0),
                kind,
                &json!({"message":input["message"],"stack":input["stack"],"context":input["context"],"source":"untrusted applet report"}),
            )?;
            crate::diagnostics::log(
                store,
                "frontend.error",
                json!({"appletId":id,"version":rev["version"],"message":input["message"],"stack":input["stack"],"source":"untrusted applet report"}),
            );
            return Ok(json!({"logged":true}));
        }
        _ => {}
    }
    Err("Endpoint not found".into())
}
pub(super) async fn document(app: &App, id: &str) -> Result<String> {
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
    let script=format!("{}\n{}\ntry {{\n{}\n}} catch(error) {{ window.dispatchEvent(new ErrorEvent('error',{{error,message:error.message}})); }}",include_str!("../bridge.js"),runtime,bundle).replace("</script","<\\/script");
    Ok(format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'nonce-{nonce}';style-src 'unsafe-inline';img-src data: blob:;connect-src 'none';frame-src 'none';form-action 'none';base-uri 'none';"><style>{baseline}{css}</style></head><body><div id="app"></div><script nonce="{nonce}">{script}</script></body></html>"#
    ))
}
