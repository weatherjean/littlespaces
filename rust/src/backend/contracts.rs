//! Revision-bound declarations and the validated catalog cache.
use super::{inspect, source};
use crate::store::{execute, query, text, Result, Store};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn contract(source: &str, catalog: &[Value]) -> Value {
    json!({
        "sdkVersion": 1,
        "sourceHash": format!("{:x}", Sha256::digest(source.as_bytes())),
        "actions": catalog,
    })
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
        let http_effect = if http.as_array().unwrap().is_empty() {
            "none"
        } else if external_write {
            "write"
        } else {
            "read"
        };
        let effects = json!({
            "records": if action["readOnly"] == true { "read" } else { "write" },
            "http": http_effect,
        });
        if action["effects"] != effects {
            return Err("Action effects do not match its permissions".into());
        }
        if action["readOnly"] == true && external_write {
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
        query(
            &db,
            "SELECT contract FROM backend_contracts WHERE hash=?",
            &[hash.clone()],
        )?
        .first()
        .map(|row| text(row, "contract").to_string())
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

pub(super) fn validate_input(action: &Value, input: &Value) -> Result<()> {
    validate_value(&action["parameters"], input, "input")
}

pub(super) fn validate_output(action: &Value, output: &Value) -> Result<()> {
    validate_value(&action["output"], output, "output")
}

fn validate_value(schema: &Value, value: &Value, label: &str) -> Result<()> {
    jsonschema::validator_for(schema)
        .map_err(|error| format!("Invalid {label} schema: {error}"))?
        .validate(value)
        .map_err(|error| format!("Invalid action {label}: {error}"))
}
