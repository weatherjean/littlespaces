//! Durable external evidence contains metadata only. No automatic retries or deletion.
use crate::store::{execute, first, now, query, Result, Store};
use serde_json::{json, Value};

pub(crate) struct Operation<'a> {
    pub id: String,
    store: &'a Store,
    applet: &'a str,
}

impl<'a> Operation<'a> {
    pub fn begin(
        store: &'a Store,
        applet: &'a str,
        version: i64,
        action: &str,
        origin: &str,
        method: &str,
    ) -> Result<Self> {
        let id = crate::random_uuid();
        let timestamp = now();
        execute(&store.applet(applet, false)?,
            "INSERT INTO external_operations(id,action,origin,method,status,http_status,created_at,updated_at,version,response_state,local_status)
             VALUES(?,?,?,?,'not_sent',NULL,?,?,?,'not_received','pending')",
            &[json!(id),json!(action),json!(origin),json!(method),json!(timestamp),json!(timestamp),json!(version)],
        )?;
        Ok(Self { id, store, applet })
    }

    pub fn dispatched(&self) -> Result<()> {
        self.update(
            "UPDATE external_operations SET status='uncertain',updated_at=? WHERE id=? AND status='not_sent'",
            &[json!(now()), json!(self.id)],
        )
    }

    pub fn received(&self, status: u16) -> Result<()> {
        self.update(
            "UPDATE external_operations SET status='response_received',http_status=?,response_state='headers_received',updated_at=? WHERE id=? AND status='uncertain'",
            &[json!(status),json!(now()),json!(self.id)],
        )
    }

    pub fn body_state(&self, state: &str) -> Result<()> {
        self.update(
            "UPDATE external_operations SET response_state=?,updated_at=? WHERE id=? AND status='response_received' AND response_state='headers_received'",
            &[json!(state), json!(now()), json!(self.id)],
        )
    }

    fn update(&self, statement: &str, args: &[Value]) -> Result<()> {
        if execute(&self.store.applet(self.applet, false)?, statement, args)? != 1 {
            return Err("External-operation evidence is unavailable or changed".into());
        }
        Ok(())
    }

    pub fn evidence(&self) -> Result<Value> {
        first(&self.store.applet(self.applet, false)?,
            "SELECT version,status,http_status,response_state,local_status FROM external_operations WHERE id=?",
            &[json!(self.id)],
        )
    }
}

pub fn ids(events: &[Value]) -> Vec<String> {
    events
        .iter()
        .filter(|event| event["code"] == "external_write")
        .filter_map(|event| event["operationId"].as_str().map(str::to_string))
        .collect()
}

pub fn uncommitted(store: &Store, applet: &str, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let mut db = store.applet(applet, false)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    for id in ids {
        execute(&tx, "UPDATE external_operations SET local_status='not_committed',updated_at=? WHERE id=? AND local_status='pending'", &[json!(now()),json!(id)])?;
    }
    tx.commit().map_err(|error| error.to_string())
}

pub fn read(
    store: &Store,
    applet: &str,
    id: Option<&str>,
    version: Option<i64>,
    limit: usize,
) -> Result<Value> {
    let rows = query(&store.applet(applet, false)?,
        "SELECT * FROM external_operations WHERE (? IS NULL OR id=?) AND (? IS NULL OR version=?) ORDER BY created_at DESC LIMIT ?",
        &[json!(id),json!(id),json!(version),json!(version),json!(limit.clamp(1,100))],
    )?;
    Ok(json!({"operations":rows,"automaticRetry":false}))
}
