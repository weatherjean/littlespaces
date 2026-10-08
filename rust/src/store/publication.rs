//! Revisions, app identity, and approved draft outcomes share one SQLite commit.
use super::{execute, first, now, query, text, Result, Store, LAUNCHER};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Value};

impl Store {
    fn publication_connection(&self, id: &str) -> Result<Connection> {
        // Finish any additive upgrade before attaching the applet to the workspace.
        drop(self.applet(id, true)?);
        let db = self.workspace()?;
        let path = self.directory.join("applets").join(format!("{id}.sqlite"));
        db.execute(
            "ATTACH DATABASE ? AS applet",
            [path.to_str().ok_or("Database path must be UTF-8")?],
        )
        .map_err(|error| error.to_string())?;
        let mode: String = db
            .query_row("PRAGMA applet.journal_mode", [], |row| row.get(0))
            .map_err(|error| error.to_string())?;
        if mode != "delete" {
            return Err("Atomic publication requires applet rollback journals".into());
        }
        db.execute_batch("PRAGMA applet.synchronous=FULL")
            .map_err(|error| error.to_string())?;
        Ok(db)
    }

    pub fn publish(
        &self,
        space: &str,
        id: &str,
        content: &Value,
        restored: Option<i64>,
        expected_version: i64,
    ) -> Result<Value> {
        let mut db = self.publication_connection(id)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let revision = publish(&tx, space, id, content, restored, expected_version)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(revision)
    }

    pub fn publish_draft(
        &self,
        source_space: &str,
        chat: &str,
        approved: &Value,
        draft: &Value,
    ) -> Result<Value> {
        let id = text(draft, "target");
        let mut db = self.publication_connection(id)?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| error.to_string())?;
        let mut plan = json_row(&tx, "build_plans", chat)?;
        if plan["id"] != approved["id"]
            || plan["status"] != "running"
            || plan["spaceId"] != source_space
            || plan["chatId"] != chat
        {
            return Err("Build approval is no longer active".into());
        }
        let mut live_draft = json_row(&tx, "build_drafts", chat)?;
        if live_draft != *draft {
            return Err("Draft changed. Read and use its current revision".into());
        }
        if !live_draft["prepared"].is_object() {
            return Err("Test this exact draft revision before publishing".into());
        }
        let expected = live_draft["baseVersion"]
            .as_i64()
            .filter(|version| *version >= 0)
            .ok_or("Invalid draft base version")?;
        let target = if source_space == LAUNCHER {
            let target = crate::random_uuid();
            execute(
                &tx,
                "INSERT INTO spaces(id,name,icon) VALUES(?,?,?)",
                &[json!(target), plan["title"].clone(), plan["emoji"].clone()],
            )?;
            target
        } else {
            source_space.to_string()
        };
        let revision = publish(&tx, &target, id, &live_draft["prepared"], None, expected)?;
        plan["status"] = json!("complete");
        plan["publishedId"] = json!(id);
        plan["publishedSpaceId"] = json!(target);
        live_draft["published"] = revision.clone();
        save_json(&tx, "build_plans", chat, &plan)?;
        save_json(&tx, "build_drafts", chat, &live_draft)?;
        tx.commit().map_err(|error| error.to_string())?;
        Ok(json!({"applet":revision,"spaceId":target}))
    }
}

fn json_row(db: &Connection, table: &str, chat: &str) -> Result<Value> {
    let row = first(
        db,
        &format!("SELECT data FROM {table} WHERE chat_id=?"),
        &[json!(chat)],
    )?;
    serde_json::from_str(text(&row, "data")).map_err(|error| error.to_string())
}

fn save_json(db: &Connection, table: &str, chat: &str, value: &Value) -> Result<()> {
    execute(
        db,
        &format!("UPDATE {table} SET data=? WHERE chat_id=?"),
        &[json!(value.to_string()), json!(chat)],
    )?;
    Ok(())
}

fn publish(
    db: &Connection,
    space: &str,
    id: &str,
    content: &Value,
    restored: Option<i64>,
    expected_version: i64,
) -> Result<Value> {
    first(db, "SELECT id FROM spaces WHERE id=?", &[json!(space)])?;
    let links = query(
        db,
        "SELECT applet_id,space_id FROM space_applets WHERE applet_id=? OR space_id=?",
        &[json!(id), json!(space)],
    )?;
    for link in links {
        if text(&link, "space_id") != space {
            return Err("Applet belongs to another app".into());
        }
        if text(&link, "applet_id") != id {
            return Err("An app has one applet".into());
        }
    }
    let current = first(
        db,
        "SELECT COALESCE(MAX(version),0) AS version FROM applet.revisions",
        &[],
    )?;
    if current["version"] != expected_version {
        return Err("Published app changed. Refresh before publishing or restoring.".into());
    }
    let summary = restored
        .map(|version| {
            format!("Restored code and chat guidance from v{version}. Current data kept.")
        })
        .unwrap_or_else(|| "Published app revision.".into());
    execute(db,
        "INSERT INTO applet.revisions(title,description,source,bundle,backend,backendBundle,testReport,chatInstructions,changeSummary,requestedChange,restoredFrom,frontendFormat,actionContract)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        &[
            content["title"].clone(), content["description"].clone(), content["source"].clone(), content["bundle"].clone(),
            json!(text(content,"backend")), json!(text(content,"backendBundle")), json!(text(content,"testReport")),
            json!(text(content,"chatInstructions")), json!(summary), json!(text(content,"requestedChange")),
            json!(restored), json!(text(content,"frontendFormat")), json!(text(content,"actionContract")),
        ],
    )?;
    let version = db.last_insert_rowid();
    execute(db, "INSERT INTO space_applets(applet_id,space_id) VALUES(?,?) ON CONFLICT(applet_id) DO NOTHING", &[json!(id),json!(space)])?;
    execute(
        db,
        "UPDATE spaces SET name=?,updated_at=? WHERE id=?",
        &[content["title"].clone(), json!(now()), json!(space)],
    )?;
    let mut revision = first(
        db,
        "SELECT * FROM applet.revisions WHERE version=?",
        &[json!(version)],
    )?;
    revision["id"] = json!(id);
    Ok(revision)
}
