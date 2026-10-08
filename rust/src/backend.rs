use crate::{
    runtime::{Output, Request},
    sandbox,
    store::{text, Result, Store},
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

mod contracts;
mod records;
pub use contracts::{catalog, contract, validate_catalog};
use contracts::{validate_input, validate_output};
use records::apply_output;
pub(crate) use records::commit_records;

fn request(source: &str, mode: &str, action: &str, input: Value, rows: Vec<Value>) -> Request {
    Request {
        source: source.into(),
        mode: mode.into(),
        budget_ms: if mode == "call" { 30000 } else { 10000 },
        action: action.into(),
        input,
        records: rows
            .into_iter()
            .map(|r| (text(&r, "key").to_string(), r["value"].clone()))
            .collect(),
        now: crate::store::now(),
        catalog: vec![],
        mock_http: vec![],
    }
}
pub fn source(revision: &Value) -> &str {
    if !text(revision, "backendBundle").is_empty() {
        text(revision, "backendBundle")
    } else {
        text(revision, "backend")
    }
}
pub async fn inspect(source: &str) -> Result<Vec<Value>> {
    if source.is_empty() {
        return Ok(vec![]);
    }
    Ok(
        sandbox::run(&request(source, "inspect", "", json!({}), vec![]))
            .await?
            .catalog,
    )
}
pub async fn test(source: &str) -> Result<Output> {
    if source.trim().is_empty() || source.chars().count() > 80000 {
        return Err("Backend source must contain 1–80,000 characters".into());
    }
    let output = sandbox::run(&request(source, "test", "", json!({}), vec![])).await?;
    if output.report.is_empty() || output.report.iter().any(|r| r["passed"] != json!(true)) {
        return Err(format!("Backend tests failed: {}", json!(output.report)));
    }
    validate_catalog(&output.catalog)?;
    Ok(output)
}

pub async fn debug(
    source: &str,
    name: &str,
    input: Value,
    rows: Vec<Value>,
    mocks: Vec<Value>,
) -> Result<Value> {
    if mocks.len() > 10 {
        return Err("At most ten HTTP mocks are allowed".into());
    }
    let catalog = inspect(source).await?;
    validate_catalog(&catalog)?;
    let action = catalog
        .iter()
        .find(|a| text(a, "name") == name)
        .ok_or("Unknown action")?;
    if let Err(error) = validate_input(action, &input) {
        return Ok(
            json!({"ok":false,"phase":"input","error":error.to_string(),"committed":false,"liveHttp":false}),
        );
    }
    let mut req = request(source, "debug", name, input, rows);
    req.catalog = catalog.clone();
    req.mock_http = mocks;
    let started = std::time::Instant::now();
    let output = sandbox::run(&req).await;
    let value = match output {
        Ok(output) => {
            let records = apply_output(&req.records, &output)?;
            let error = output.error.or_else(|| {
                if output.catalog != catalog {
                    return Some("Action declarations changed during execution".into());
                }
                if action["readOnly"] == true && records != req.records {
                    return Some("Read-only action attempted to write".into());
                }
                validate_output(action, &output.result).err()
            });
            json!({"ok":error.is_none(),"error":error,"stack":output.stack,"result":output.result,"changes":output.changes,"removals":output.removals,"logs":output.logs})
        }
        Err(error) => json!({"ok":false,"error":error}),
    };
    let mut value = crate::diagnostics::sanitize(&value, 0);
    value["committed"] = json!(false);
    value["liveHttp"] = json!(false);
    value["durationMs"] = json!(started.elapsed().as_millis());
    value["sdkVersion"] = json!(1);
    value["untrusted"] = json!(true);
    Ok(value)
}
pub async fn call(
    store: &Store,
    id: &str,
    name: &str,
    input: Value,
    read_only: bool,
    expected: Option<i64>,
    commit: bool,
) -> Result<Value> {
    let current = store.revision(id, None)?;
    let total_started = std::time::Instant::now();
    let result = async {
        if expected.is_some_and(|v| Some(v) != current["version"].as_i64()) {
            return Err("App revision changed. Refresh before invoking this action".into());
        }
        let source = source(&current);
        let catalog = catalog(store, id, &current).await?;
        let action = catalog
            .iter()
            .find(|a| text(a, "name") == name)
            .ok_or("Unknown action")?;
        if read_only && action["readOnly"] != json!(true) {
            return Err("This turn can only read app data".into());
        }
        validate_input(action, &input)?;
        let before = store.records(id)?;
        let old: BTreeMap<String, Value> = before
            .iter()
            .map(|r| (text(r, "key").into(), r["value"].clone()))
            .collect();
        let mut req = request(source, "call", name, input, before);
        req.catalog = catalog.clone();
        let started = std::time::Instant::now();
        let result = sandbox::run_with(
            &req,
            Some(sandbox::Authority {
                store,
                applet_id: id,
                http: &action["http"],
                read_only: action["readOnly"] == true,
            }),
        )
        .await;
        let _ = crate::diagnostics::record(
            store,
            id,
            current["version"].as_i64().unwrap_or(0),
            "action",
            &json!({
                "action": name,
                "phase": "execution",
                "durationMs": started.elapsed().as_millis(),
                "ok": result.is_ok(),
                "error": result.as_ref().err(),
                "logs": result.as_ref().ok().map(|output| &output.logs),
                "requests": result.as_ref().ok().map(|output| &output.requests),
            }),
        );
        let output = result?;
        if output.catalog != catalog {
            return Err("Action declarations changed during execution".into());
        }
        validate_output(action, &output.result)?;
        let records = apply_output(&old, &output)?;
        if action["readOnly"] == true && records != old {
            return Err("Read-only action attempted to write".into());
        }
        if commit && action["readOnly"] != json!(true) {
            commit_records(
                store,
                id,
                &current["version"],
                &old,
                &records,
                output
                    .requests
                    .iter()
                    .any(|event| event["code"] == "external_write"),
            )?;
        }
        Ok(output.result)
    }
    .await;
    let _ = crate::diagnostics::record(
        store,
        id,
        current["version"].as_i64().unwrap_or(0),
        "action",
        &json!({"action":name,"phase":"completion","durationMs":total_started.elapsed().as_millis(),"ok":result.is_ok(),"commitRequested":commit,"error":result.as_ref().err()}),
    );
    result
}
pub fn validate_frontend(source: &str) -> Result<()> {
    if source.trim().is_empty() || source.len() > 80000 {
        return Err("Frontend source must contain 1–80,000 characters".into());
    }
    let runtime = rquickjs::Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(16 * 1024 * 1024);
    let ctx = rquickjs::Context::full(&runtime).map_err(|e| e.to_string())?;
    ctx.with(|ctx| {
        let script = format!("new Function({});", serde_json::to_string(source).map_err(|error| error.to_string())?);
        ctx.eval::<rquickjs::Value, _>(script)
            .map(|_| ())
            .map_err(|_| "Frontend contains invalid JavaScript. Use Preact with HTM, without JSX, TypeScript, imports, or export declarations.".into())
    })
}

pub fn validate_utilities(source: &str, assets: &std::path::Path) -> Result<()> {
    if source.contains("@apply") || source.contains("@import") {
        return Err("Applet styles have no build step. Use plain CSS and the shipped utility vocabulary instead of @apply or @import.".into());
    }
    let manifest = std::fs::read_to_string(assets.join("applet-utilities.json"))
        .map_err(|_| "Build the frontend utility manifest first")?;
    let names: Vec<String> =
        serde_json::from_str(&manifest).map_err(|_| "Invalid utility manifest")?;
    let names: std::collections::HashSet<_> = names.iter().map(String::as_str).collect();
    let pattern = regex::Regex::new(r#"\bclass(?:Name)?\s*=\s*["']([^"']+)["']"#)
        .map_err(|e| e.to_string())?;
    let mut unsupported = Vec::new();
    for captures in pattern.captures_iter(source) {
        for name in captures[1].split_whitespace() {
            if name.contains("${") {
                continue;
            }
            let utility = name.contains(':')
                || [
                    "bg-",
                    "text-",
                    "border-",
                    "rounded-",
                    "shadow-",
                    "p-",
                    "px-",
                    "py-",
                    "pt-",
                    "pb-",
                    "pl-",
                    "pr-",
                    "m-",
                    "mx-",
                    "my-",
                    "mt-",
                    "mb-",
                    "ml-",
                    "mr-",
                    "gap-",
                    "w-",
                    "h-",
                    "min-",
                    "max-",
                    "grid-cols-",
                    "items-",
                    "justify-",
                    "font-",
                    "opacity-",
                ]
                .iter()
                .any(|prefix| name.starts_with(prefix));
            if utility && !names.contains(name) && !source.contains(&format!(".{name}")) {
                unsupported.push(name.to_string());
            }
        }
    }
    unsupported.sort();
    unsupported.dedup();
    if !unsupported.is_empty() {
        return Err(format!("Unsupported prebuilt Tailwind classes: {}. Use shipped classes, plain CSS, or inline styles; applets have no CSS build step.",unsupported.join(", ")));
    }
    Ok(())
}

pub async fn probe(store: &Store, id: &str, action: &str, input: Value) -> Result<Value> {
    let rev = store.revision(id, None)?;
    let catalog = catalog(store, id, &rev).await?;
    probe_source(
        store,
        id,
        source(&rev),
        &catalog,
        action,
        input,
        store.records(id)?,
    )
    .await
}
pub async fn probe_source(
    store: &Store,
    id: &str,
    source: &str,
    catalog: &[Value],
    name: &str,
    input: Value,
    rows: Vec<Value>,
) -> Result<Value> {
    let action = catalog
        .iter()
        .find(|a| text(a, "name") == name)
        .ok_or("Unknown action")?;
    if action["readOnly"] != json!(true) {
        return Err("Connection checks must use a read-only action".into());
    }
    validate_input(action, &input)?;
    let mut req = request(source, "call", name, input, rows);
    req.catalog = catalog.to_vec();
    let before = req.records.clone();
    let mut requests = Vec::new();
    let output = sandbox::run_with_trace(
        &req,
        Some(sandbox::Authority {
            store,
            applet_id: id,
            http: &action["http"],
            read_only: true,
        }),
        &mut requests,
    )
    .await;
    let verified =
        !requests.is_empty() && requests.iter().all(|v| v["code"] == json!("http_success"));
    match output {
        Ok(output) => {
            if output.catalog != catalog {
                return Err("Action declarations changed during connection check".into());
            }
            validate_output(action, &output.result)?;
            if apply_output(&before, &output)? != before {
                return Err(
                    "Connection check attempted to write. No records were committed.".into(),
                );
            }
            Ok(
                json!({"ok":true,"verified":verified,"result":output.result,"requests":requests,"checkedAt":crate::store::now(),"action":name}),
            )
        }
        Err(error) => Ok(
            json!({"ok":false,"verified":false,"error":error,"requests":requests,"checkedAt":crate::store::now(),"action":name}),
        ),
    }
}
