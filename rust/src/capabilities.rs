//! Host-owned HTTP grants. App source can request capabilities, never grant them.
use crate::store::{execute, query, text, Result, Store};
use serde_json::{json, Value};

pub fn normalize(value: &Value) -> Result<Value> {
    let entries = value
        .as_array()
        .ok_or("HTTP permissions must be an array")?;
    if entries.len() > 20 {
        return Err("At most twenty HTTP permissions are allowed".into());
    }
    let mut result = Vec::new();
    for entry in entries {
        let origin = crate::vault::origins(&json!([entry["origin"]]))?[0].clone();
        let methods = entry["methods"].as_array().ok_or("Specify HTTP methods")?;
        if methods.is_empty()
            || methods.len() > 6
            || methods.iter().any(|m| {
                !matches!(
                    m.as_str(),
                    Some("GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE")
                )
            })
        {
            return Err("Specify supported uppercase HTTP methods".into());
        }
        let secrets = entry["secrets"]
            .as_array()
            .ok_or("Specify secret names, or [] for public access")?;
        if secrets.len() > 20
            || secrets.iter().any(|s| {
                s.as_str().is_none_or(|s| {
                    s.is_empty()
                        || s.len() > 80
                        || !s
                            .bytes()
                            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
                })
            })
        {
            return Err("Invalid secret names".into());
        }
        result.push(json!({"origin":origin,"methods":methods,"secrets":secrets}));
    }
    Ok(json!(result))
}

pub fn grants(store: &Store, id: &str) -> Result<Value> {
    let db = store.applet(id, false)?;
    let rows = query(&db, "SELECT grants FROM http_grants WHERE id=1", &[])?;
    match rows.first() {
        Some(row) => normalize(
            &serde_json::from_str(text(row, "grants"))
                .map_err(|_| "Invalid stored HTTP permissions")?,
        ),
        None => Ok(json!([])),
    }
}

pub fn save(store: &Store, id: &str, value: &Value) -> Result<Value> {
    let grants = normalize(value)?;
    execute(
        &store.applet(id, false)?,
        "INSERT INTO http_grants VALUES(1,?) ON CONFLICT(id) DO UPDATE SET grants=excluded.grants",
        &[json!(grants.to_string())],
    )?;
    Ok(grants)
}

pub fn check(policy: &Value, input: &Value) -> Result<()> {
    let url = url::Url::parse(text(input, "url")).map_err(|_| "Invalid API URL")?;
    let origin = url.origin().ascii_serialization();
    let method = if text(input, "method").is_empty() {
        "GET".into()
    } else {
        text(input, "method").to_uppercase()
    };
    let secrets: Vec<&str> = ["headers", "query"]
        .into_iter()
        .flat_map(|section| {
            input[section]
                .as_object()
                .into_iter()
                .flat_map(|values| values.values())
        })
        .filter_map(|v| v.get("secret").and_then(Value::as_str))
        .collect();
    let allowed = policy.as_array().is_some_and(|entries| {
        entries.iter().any(|entry| {
            entry["origin"] == origin
                && entry["methods"]
                    .as_array()
                    .is_some_and(|m| m.contains(&json!(method)))
                && secrets.iter().all(|secret| {
                    entry["secrets"]
                        .as_array()
                        .is_some_and(|s| s.contains(&json!(secret)))
                })
        })
    });
    if !allowed {
        return Err("HTTP capability denied. Declare this action's HTTP permissions and enable this app's API access in Settings.".into());
    }
    Ok(())
}
