//! Versioned workspace format. Versions 4 and 5 can upgrade to the guest-sharing format.
use super::*;
use rusqlite::Connection;
pub const VERSION: i64 = 6;
const EXTENSIONS: &str = concat!(
    include_str!("notifications.sql"),
    include_str!("app_lifecycle.sql"),
    "CREATE TABLE IF NOT EXISTS app_sqlite(app TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE, image BLOB NOT NULL);",
    "CREATE TABLE IF NOT EXISTS agent_checkpoints(job TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE, payload TEXT NOT NULL);",
    "CREATE TABLE IF NOT EXISTS model_request_events(id INTEGER PRIMARY KEY, job TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, payload TEXT NOT NULL); CREATE INDEX IF NOT EXISTS model_request_events_job ON model_request_events(job,id);",
    include_str!("releases.sql"),
);
const V5: &str = include_str!("migration_005.sql");
pub fn install(db: &mut Connection) -> Result<()> {
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    if ![4, 5, VERSION].contains(&version) {
        return Err(Error::Storage);
    }
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    if version == 4 {
        tx.execute_batch(EXTENSIONS)?;
        tx.execute_batch(V5)?;
    }
    if version < 6 {
        tx.execute_batch(include_str!("migration_006.sql"))?;
    }
    // Compare column contracts to a clean reference, including NOT NULL/default/PK.
    // Extra user-created indexes/triggers are allowed; incompatible table shapes are not.
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(include_str!("schema.sql"))?;
    expected.execute_batch(EXTENSIONS)?;
    expected.execute_batch(V5)?;
    expected.execute_batch(include_str!("migration_006.sql"))?;
    let mut tables = expected.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    )?;
    for name in tables.query_map([], |r| r.get::<_, String>(0))? {
        let name = name?;
        if columns(&tx, &name)? != columns(&expected, &name)? {
            return Err(Error::Storage);
        }
    }
    tx.commit()?;
    Ok(())
}
type Column = (String, String, bool, Option<String>, i64);
fn columns(db: &Connection, name: &str) -> Result<Vec<Column>> {
    let mut q = db.prepare(
        "SELECT name,type,\"notnull\",dflt_value,pk FROM pragma_table_info(?) ORDER BY cid",
    )?;
    let rows = q
        .query_map([name], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migrates_v5_preserves_owner_and_takes_backup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite");
        let mut db = Connection::open(&path).unwrap();
        db.execute_batch(include_str!("schema.sql")).unwrap();
        db.execute_batch(EXTENSIONS).unwrap();
        db.execute_batch(V5).unwrap();
        db.execute("INSERT INTO owner_auth VALUES(1,'preserved-hash',0,0)", [])
            .unwrap();
        db.execute(
            "INSERT INTO owner_sessions VALUES('preserved-session',9999999999,'preserved-csrf')",
            [],
        )
        .unwrap();
        let store = Store::create(&path).unwrap();
        let backup = Connection::open(path.with_extension("pre-v6.sqlite")).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            5
        );
        assert_eq!(
            store
                .open()
                .unwrap()
                .query_row("SELECT password_hash FROM owner_auth", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "preserved-hash"
        );
        assert_eq!(
            store
                .open()
                .unwrap()
                .query_row("SELECT csrf FROM owner_sessions", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "preserved-csrf"
        );
        install(&mut db).unwrap();
    }
    #[test]
    fn migrates_v4_preserves_data_and_rejects_future_or_malformed_formats() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("workspace.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch(include_str!("../../tests/fixtures/workspace-v4.sql"))
            .unwrap();
        db.execute("INSERT INTO apps(id,title) VALUES('kept','Keep me')", [])
            .unwrap();
        let store = Store::create(&path).unwrap();
        assert_eq!(
            store
                .open()
                .unwrap()
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            VERSION
        );
        assert_eq!(
            db.query_row("SELECT title FROM apps WHERE id='kept'", [], |r| r
                .get::<_, String>(0))
                .unwrap(),
            "Keep me"
        );
        let backup = Connection::open(path.with_extension("pre-v5.sqlite")).unwrap();
        assert_eq!(
            backup
                .pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            4
        );
        assert!(Store::create(&path).is_ok());
        db.execute_batch("PRAGMA user_version=7").unwrap();
        assert!(Store::create(&path).is_err());
        assert_eq!(
            db.pragma_query_value(None, "user_version", |r| r.get::<_, i64>(0))
                .unwrap(),
            7
        );
        db.execute_batch(
            "PRAGMA user_version=6; ALTER TABLE invocation_outcomes ADD COLUMN incompatible TEXT",
        )
        .unwrap();
        assert!(Store::create(&path).is_err());
    }
}
