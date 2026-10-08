//! Serialized, versioned additive upgrades. Ordinary opens perform no schema writes.
use super::{query, text, Result};
use rusqlite::{Connection, TransactionBehavior};

fn version(db: &Connection) -> Result<i64> {
    db.pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|error| error.to_string())
}

fn migrate(db: &mut Connection, apply: impl FnOnce(&Connection) -> Result<()>) -> Result<()> {
    const CURRENT: i64 = 1;
    let check = |version| -> Result<bool> {
        if version > CURRENT {
            Err("Database schema is newer than this LittleSpaces version".into())
        } else {
            Ok(version == CURRENT)
        }
    };
    if check(version(db)?)? {
        return Ok(());
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    // Another opener may have finished the upgrade while this connection waited.
    if !check(version(&tx)?)? {
        apply(&tx)?;
        tx.pragma_update(None, "user_version", CURRENT)
            .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())
}

fn columns(db: &Connection, table: &str, additions: &[(&str, &str)]) -> Result<()> {
    let existing = query(db, &format!("PRAGMA table_info({table})"), &[])?;
    for (column, definition) in additions {
        if !existing.iter().any(|row| text(row, "name") == *column) {
            db.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(super) fn workspace(db: &mut Connection) -> Result<()> {
    migrate(db, |db| {
        db.execute_batch(include_str!("../schema.sql"))
            .map_err(|error| error.to_string())?;
        for (table, column, definition) in [
            ("spaces", "archived", "INTEGER NOT NULL DEFAULT 0"),
            ("chats", "launch", "TEXT NOT NULL DEFAULT '{}'"),
            ("messages", "photos", "TEXT NOT NULL DEFAULT '[]'"),
            ("secrets", "origins", "TEXT NOT NULL DEFAULT '[]'"),
            ("schedules", "revision", "INTEGER NOT NULL DEFAULT 1"),
        ] {
            columns(db, table, &[(column, definition)])?;
        }
        if !query(
            db,
            "SELECT space_id FROM space_applets GROUP BY space_id HAVING COUNT(*) > 1",
            &[],
        )?
        .is_empty()
        {
            return Err("Workspace contains multiple applets in one app. Repair the links before upgrading; no data was removed.".into());
        }
        db.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS space_applets_one_per_space ON space_applets(space_id)")
            .map_err(|error| error.to_string())
    })
}

pub(super) fn applet(db: &mut Connection) -> Result<()> {
    migrate(db, |db| {
        db.execute_batch(include_str!("applet-schema.sql"))
            .map_err(|error| error.to_string())?;
        let additions: Vec<_> = [
            "backend",
            "backendBundle",
            "testReport",
            "chatInstructions",
            "changeSummary",
            "requestedChange",
            "frontendFormat",
            "actionContract",
        ]
        .into_iter()
        .map(|name| (name, "TEXT NOT NULL DEFAULT ''"))
        .chain([("restoredFrom", "INTEGER")])
        .collect();
        columns(db, "revisions", &additions)
    })
}
