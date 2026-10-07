use crate::{
    runtime::{Output, Request},
    sandbox,
    store::{execute, query, text, Result, Store},
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
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
    for action in &output.catalog {
        jsonschema::validator_for(&action["parameters"])
            .map_err(|e| format!("Invalid action schema: {e}"))?;
    }
    Ok(output)
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
    if expected.is_some_and(|v| Some(v) != current["version"].as_i64()) {
        return Err("App changed since confirmation".into());
    }
    let source = source(&current);
    let catalog = inspect(source).await?;
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
    let output = sandbox::run_with(
        &request(source, "call", name, input, before.clone()),
        Some(store),
        action["readOnly"] == json!(true),
    )
    .await?;
    if output.records.len() > 2000
        || output.records.iter().any(|(key, value)| {
            key.is_empty()
                || key.chars().count() > 200
                || value.to_string().chars().count() > 100000
        })
    {
        return Err("Invalid or oversized app records".into());
    }
    let old: BTreeMap<String, Value> = before
        .into_iter()
        .map(|r| (text(&r, "key").into(), r["value"].clone()))
        .collect();
    if action["readOnly"] == json!(true) && output.records != old {
        return Err("Read-only action attempted to write".into());
    }
    if commit && action["readOnly"] != json!(true) {
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
        if rev["version"] != current["version"] || live != old {
            return Err("App data changed while the action ran. Refresh before retrying.".into());
        }
        execute(&tx, "DELETE FROM records", &[])?;
        for (key, value) in &output.records {
            execute(
                &tx,
                "INSERT INTO records VALUES(?,?)",
                &[json!(key), json!(value.to_string())],
            )?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(output.result)
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
    probe_source(store, source(&rev), action, input, store.records(id)?).await
}
pub async fn probe_source(
    store: &Store,
    source: &str,
    name: &str,
    input: Value,
    rows: Vec<Value>,
) -> Result<Value> {
    let catalog = inspect(source).await?;
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
    let req = request(source, "call", name, input, rows);
    let before = req.records.clone();
    let mut requests = Vec::new();
    let output = sandbox::run_with_trace(&req, Some(store), true, &mut requests).await;
    let verified =
        !requests.is_empty() && requests.iter().all(|v| v["code"] == json!("http_success"));
    match output {
        Ok(output) => {
            if output.records != before {
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
