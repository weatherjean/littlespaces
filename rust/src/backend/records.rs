//! Validate worker deltas and atomically commit a conflict-checked record snapshot.
use crate::{
    runtime::Output,
    store::{execute, query, text, Result, Store},
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub(super) fn apply_output(
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
pub(crate) fn commit_records(
    store: &Store,
    id: &str,
    version: &Value,
    old: &BTreeMap<String, Value>,
    records: &BTreeMap<String, Value>,
    external_write: bool,
) -> Result<()> {
    let mut db = store.applet(id, false)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
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
        let message = if external_write {
            "App data changed while the action ran. External changes may already have occurred; inspect external operations before retrying."
        } else {
            "App data changed while the action ran. Refresh before retrying."
        };
        return Err(message.into());
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
