use crate::{
    runtime::{Output, Request},
    sandbox,
    store::{execute, query, text, Result, Store},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub fn contract(source: &str, catalog: &[Value]) -> Value {
    json!({"sdkVersion":1,"sourceHash":format!("{:x}",Sha256::digest(source.as_bytes())),"actions":catalog})
}

pub fn validate_catalog(catalog: &[Value]) -> Result<()> {
    if catalog.is_empty() || catalog.len() > 30 || json!(catalog).to_string().len() > 128 * 1024 {
        return Err("Declare 1–30 actions with a catalog smaller than 128 KB".into());
    }
    let pattern = regex::Regex::new(r"^[a-zA-Z][a-zA-Z0-9_]{0,63}$").unwrap();
    let mut names = std::collections::HashSet::new();
    for action in catalog {
        if !pattern.is_match(text(action, "name"))
            || !names.insert(text(action, "name"))
            || !action["readOnly"].is_boolean()
            || !action["description"].is_string()
            || text(action, "description").len() > 4000
        {
            return Err("Invalid action metadata".into());
        }
        jsonschema::validator_for(&action["parameters"])
            .map_err(|e| format!("Invalid input schema: {e}"))?;
        jsonschema::validator_for(&action["output"])
            .map_err(|e| format!("Invalid output schema: {e}"))?;
        let http = crate::capabilities::normalize(&action["http"])?;
        let external_write = http.as_array().unwrap().iter().any(|p| {
            p["methods"]
                .as_array()
                .unwrap()
                .iter()
                .any(|m| m != "GET" && m != "HEAD")
        });
        let effects = json!({"records":if action["readOnly"] == true {"read"} else {"write"},"http":if http.as_array().unwrap().is_empty(){"none"}else if external_write{"write"}else{"read"}});
        if action["effects"] != effects {
            return Err("Action effects do not match its permissions".into());
        }
        if action["readOnly"] == true
            && http.as_array().unwrap().iter().any(|p| {
                p["methods"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m != "GET" && m != "HEAD")
            })
        {
            return Err("Read-only actions cannot declare external writes".into());
        }
    }
    Ok(())
}

pub async fn catalog(store: &Store, id: &str, revision: &Value) -> Result<Vec<Value>> {
    let source = source(revision);
    if source.is_empty() {
        return Ok(vec![]);
    }
    let hash = contract(source, &[])["sourceHash"].clone();
    let db = store.applet(id, false)?;
    let encoded = if !text(revision, "actionContract").is_empty() {
        text(revision, "actionContract").to_string()
    } else {
        crate::store::first(
            &db,
            "SELECT contract FROM backend_contracts WHERE hash=?",
            &[hash.clone()],
        )
        .map(|row| text(&row, "contract").to_string())
        .unwrap_or_default()
    };
    if !encoded.is_empty() {
        let value: Value = serde_json::from_str(&encoded).map_err(|_| "Invalid action contract")?;
        if value["sourceHash"] != hash || value["sdkVersion"] != 1 {
            return Err("Action contract does not match this revision".into());
        }
        let actions = value["actions"]
            .as_array()
            .ok_or("Invalid action catalog")?
            .clone();
        validate_catalog(&actions)?;
        return Ok(actions);
    }
    // Older revisions get a content-addressed, validated catalog without rewriting their source.
    let actions = inspect(source).await?;
    validate_catalog(&actions)?;
    execute(
        &db,
        "INSERT OR IGNORE INTO backend_contracts VALUES(?,?)",
        &[hash, json!(contract(source, &actions).to_string())],
    )?;
    Ok(actions)
}

fn apply_output(
    before: &BTreeMap<String, Value>,
    output: &Output,
) -> Result<BTreeMap<String, Value>> {
    let mut records = before.clone();
    if !output.records.is_empty() {
        return Err("Unexpected full-record worker output".into());
    }
    for key in &output.removals {
        if key.is_empty() || key.chars().count() > 200 {
            return Err("Invalid removed record key".into());
        }
        records.remove(key);
    }
    for (key, value) in &output.changes {
        records.insert(key.clone(), value.clone());
    }
    if records.len() > 2000
        || records.iter().any(|(key, value)| {
            key.is_empty()
                || key.chars().count() > 200
                || value.to_string().chars().count() > 100000
        })
        || serde_json::to_vec(&records)
            .map_err(|e| e.to_string())?
            .len()
            > crate::runtime::MAX_BYTES
    {
        return Err("Invalid or oversized app records".into());
    }
    Ok(records)
}
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
    if let Err(error) = jsonschema::validator_for(&action["parameters"])
        .map_err(|e| e.to_string())?
        .validate(&input)
    {
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
                jsonschema::validator_for(&action["output"])
                    .ok()
                    .and_then(|v| {
                        v.validate(&output.result)
                            .err()
                            .map(|e| format!("Invalid action output: {e}"))
                    })
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
    let validator = jsonschema::validator_for(&action["parameters"]).map_err(|e| e.to_string())?;
    if let Err(error) = validator.validate(&input) {
        return Err(format!("Invalid action input: {error}"));
    }
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
        &json!({"action":name,"phase":"execution","durationMs":started.elapsed().as_millis(),"ok":result.is_ok(),"error":result.as_ref().err(),"logs":result.as_ref().ok().map(|o| &o.logs),"requests":result.as_ref().ok().map(|o| &o.requests)}),
    );
    let output = result?;
    if output.catalog != catalog {
        return Err("Action declarations changed during execution".into());
    }
    jsonschema::validator_for(&action["output"])
        .map_err(|e| e.to_string())?
        .validate(&output.result)
        .map_err(|e| format!("Invalid action output: {e}"))?;
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
    }.await;
    let _ = crate::diagnostics::record(
        store,
        id,
        current["version"].as_i64().unwrap_or(0),
        "action",
        &json!({"action":name,"phase":"completion","durationMs":total_started.elapsed().as_millis(),"ok":result.is_ok(),"commitRequested":commit,"error":result.as_ref().err()}),
    );
    result
}
pub(crate) fn commit_records(
    store: &Store,
    id: &str,
    version: &Value,
    old: &BTreeMap<String, Value>,
    records: &BTreeMap<String, Value>,
    external_write: bool,
) -> Result<()> {
    let mut db = store.applet(id, false)?;
    let tx = db.transaction().map_err(|e| e.to_string())?;
    let rev = crate::store::first(
        &tx,
        "SELECT version FROM revisions ORDER BY version DESC LIMIT 1",
        &[],
    )?;
    let live: BTreeMap<String, Value> = query(&tx, "SELECT key,value FROM records", &[])?
        .into_iter()
        .map(|r| {
            Ok((
                text(&r, "key").to_string(),
                serde_json::from_str(text(&r, "value")).map_err(|e| e.to_string())?,
            ))
        })
        .collect::<Result<_>>()?;
    if &rev["version"] != version || &live != old {
        return Err(if external_write {
            "App data changed while the action ran. External changes may already have occurred; inspect external operations before retrying."
        } else { "App data changed while the action ran. Refresh before retrying." }.into());
    }
    for key in old.keys().filter(|key| !records.contains_key(*key)) {
        execute(&tx, "DELETE FROM records WHERE key=?", &[json!(key)])?;
    }
    for (key, value) in records
        .iter()
        .filter(|(key, value)| old.get(*key) != Some(*value))
    {
        execute(
            &tx,
            "INSERT INTO records VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            &[json!(key), json!(value.to_string())],
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}
pub fn validate_frontend(source: &str) -> Result<()> {
    if source.trim().is_empty() || source.len() > 80000 {
        return Err("Frontend source must contain 1–80,000 characters".into());
    }
    let runtime = rquickjs::Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(16 * 1024 * 1024);
    let ctx = rquickjs::Context::full(&runtime).map_err(|e| e.to_string())?;
    ctx.with(|ctx|{let script=format!("new Function({});",serde_json::to_string(source).unwrap());ctx.eval::<rquickjs::Value,_>(script).map(|_|()).map_err(|_|"Frontend contains invalid JavaScript. Use Preact with HTM, without JSX, TypeScript, imports, or export declarations.".into())})
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
    jsonschema::validator_for(&action["parameters"])
        .map_err(|e| e.to_string())?
        .validate(&input)
        .map_err(|e| e.to_string())?;
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
            jsonschema::validator_for(&action["output"])
                .map_err(|e| e.to_string())?
                .validate(&output.result)
                .map_err(|e| format!("Invalid action output: {e}"))?;
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
