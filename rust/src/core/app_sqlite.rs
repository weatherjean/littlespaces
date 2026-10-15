//! An app-owned SQLite image; persisted inside the workspace transaction, never a host connection.
use super::{control::Control, *};
use rusqlite::{
    hooks::{AuthAction, AuthContext, Authorization},
    limits::Limit,
    types::{Value as SqlValue, ValueRef},
    Connection, DatabaseName,
};
use serde_json::{json, Value};
use std::ptr::NonNull;

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
pub(crate) struct Database {
    db: Connection,
    control: Control,
    last_error: std::cell::RefCell<Option<String>>,
}
impl Database {
    pub fn open(bytes: &[u8], readonly: bool, control: Control) -> Result<Self> {
        if bytes.len() > MAX_BYTES {
            return Err(Error::Limit);
        }
        let mut db = Connection::open_in_memory()?;
        if !bytes.is_empty() {
            // SQLite owns this allocation after deserialize; no filesystem is exposed.
            let data = unsafe {
                let ptr =
                    NonNull::new(rusqlite::ffi::sqlite3_malloc64(bytes.len() as u64).cast::<u8>())
                        .ok_or(Error::Limit)?;
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.as_ptr(), bytes.len());
                rusqlite::serialize::OwnedData::from_raw_nonnull(ptr, bytes.len())
            };
            db.deserialize(DatabaseName::Main, data, false)?;
        }
        db.execute_batch("PRAGMA page_size=4096; PRAGMA max_page_count=2048; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;")?;
        db.set_limit(Limit::SQLITE_LIMIT_LENGTH, 65536);
        db.set_limit(Limit::SQLITE_LIMIT_SQL_LENGTH, 16384);
        db.set_limit(Limit::SQLITE_LIMIT_COLUMN, 64);
        db.set_limit(Limit::SQLITE_LIMIT_VARIABLE_NUMBER, 64);
        db.set_limit(Limit::SQLITE_LIMIT_ATTACHED, 0);
        db.set_limit(Limit::SQLITE_LIMIT_EXPR_DEPTH, 32);
        db.set_limit(Limit::SQLITE_LIMIT_COMPOUND_SELECT, 16);
        db.set_limit(Limit::SQLITE_LIMIT_VDBE_OP, 100000);
        if readonly {
            db.pragma_update(None, "query_only", true)?;
        }
        let progress = control.clone();
        db.progress_handler(1000, Some(move || progress.check().is_err()));
        db.authorizer(Some(|ctx: AuthContext<'_>| {
            use AuthAction::*;
            let allowed = match ctx.action {
                Select
                | Read { .. }
                | Insert { .. }
                | Update { .. }
                | Delete { .. }
                | CreateTable { .. }
                | CreateIndex { .. }
                | CreateTrigger { .. }
                | CreateView { .. }
                | DropTable { .. }
                | DropIndex { .. }
                | DropTrigger { .. }
                | DropView { .. }
                | AlterTable { .. }
                | Reindex { .. }
                | Analyze { .. }
                | Recursive => true,
                CreateVtable { module_name, .. } | DropVtable { module_name, .. } => {
                    module_name == "fts5"
                }
                Function { function_name } => !["load_extension", "readfile", "writefile"]
                    .contains(&function_name.to_ascii_lowercase().as_str()),
                // FTS5 reads data_version; serialization reads page_count.
                Pragma {
                    pragma_name,
                    pragma_value: None,
                } => ["data_version", "page_count"]
                    .iter()
                    .any(|name| pragma_name.eq_ignore_ascii_case(name)),
                _ => false,
            };
            if allowed {
                Authorization::Allow
            } else {
                Authorization::Deny
            }
        }));
        Ok(Self {
            db,
            control,
            last_error: Default::default(),
        })
    }
    fn sql_error(&self, error: rusqlite::Error) -> Error {
        *self.last_error.borrow_mut() = Some(error.to_string().chars().take(1024).collect());
        Error::Validation
    }
    pub fn last_error(&self) -> Option<String> {
        self.last_error.borrow().clone()
    }
    pub fn run(&self, sql: &str, params: &Value, query: bool) -> Result<Value> {
        self.control.check()?;
        if sql.len() > 16384 {
            return Err(Error::Limit);
        }
        let params = params
            .as_array()
            .filter(|p| p.len() <= 64)
            .ok_or(Error::Validation)?;
        let values = params
            .iter()
            .map(|v| {
                Ok(match v {
                    Value::Null => SqlValue::Null,
                    Value::Bool(v) => SqlValue::Integer(i64::from(*v)),
                    Value::Number(n) => {
                        if let Some(i) = n.as_i64() {
                            SqlValue::Integer(i)
                        } else {
                            SqlValue::Real(n.as_f64().ok_or(Error::Validation)?)
                        }
                    }
                    Value::String(s) if s.len() <= 16384 => SqlValue::Text(s.clone()),
                    _ => return Err(Error::Validation),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        let mut batch = rusqlite::Batch::new(&self.db, sql);
        let mut stmt = batch
            .next()
            .map_err(|e| self.sql_error(e))?
            .ok_or(Error::Validation)?;
        if batch.next().map_err(|e| self.sql_error(e))?.is_some() {
            return Err(Error::Validation);
        }
        if query && !stmt.readonly() {
            return Err(Error::ReadOnly);
        }
        if !query {
            if stmt.column_count() != 0 {
                return Err(Error::Validation);
            }
            let changes = stmt
                .execute(rusqlite::params_from_iter(values))
                .map_err(|e| self.sql_error(e))?;
            self.control.check()?;
            return Ok(json!({"changes":changes}));
        }
        let names = stmt
            .column_names()
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>();
        let mut cursor = stmt
            .query(rusqlite::params_from_iter(values))
            .map_err(|e| self.sql_error(e))?;
        let mut rows = Vec::new();
        let mut size = 0;
        while let Some(row) = cursor.next().map_err(|e| self.sql_error(e))? {
            self.control.check()?;
            let mut item = serde_json::Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => json!(v),
                    ValueRef::Real(v) => json!(v),
                    ValueRef::Text(v) => {
                        json!(std::str::from_utf8(v).map_err(|_| Error::Validation)?)
                    }
                    ValueRef::Blob(_) => return Err(Error::Validation),
                };
                item.insert(name.clone(), value);
            }
            size += serde_json::to_vec(&item)
                .map_err(|_| Error::Validation)?
                .len();
            if rows.len() >= 512 || size > 65536 {
                return Err(Error::Limit);
            }
            rows.push(Value::Object(item));
        }
        Ok(json!(rows))
    }
    /// Compare all old row values (including duplicate rows), without exposing them.
    /// Added columns/rows preserve data; missing columns, rows or changed values require review.
    pub(crate) fn preservation_report(&self, after: &Self) -> Result<Value> {
        use sha2::{Digest, Sha256};
        use std::collections::BTreeMap;
        let quote = |s: &str| format!("\"{}\"", s.replace('"', "\"\""));
        let objects = |db: &Self| -> Result<BTreeMap<String, (String, String)>> {
            let mut q = db.db.prepare("SELECT name,type,COALESCE(sql,'') FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")?;
            let rows = q
                .query_map([], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))?
                .collect::<std::result::Result<_, _>>()?;
            Ok(rows)
        };
        let before_objects = objects(self)?;
        let after_objects = objects(after)?;
        let mut lost = 0usize;
        let mut tables = Vec::new();
        let mut changed_objects = Vec::new();
        for (name, (kind, definition)) in &before_objects {
            self.control.check()?;
            if kind != "table" {
                if after_objects.get(name) != Some(&(kind.clone(), definition.clone())) {
                    changed_objects.push(name.clone());
                }
                continue;
            }
            let old_query = format!("SELECT * FROM {}", quote(name));
            let columns = self
                .db
                .prepare(&old_query)?
                .column_names()
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>();
            let identity = ["_rowid_", "rowid", "oid"].into_iter().find(|alias| {
                !columns.iter().any(|c| c.eq_ignore_ascii_case(alias))
                    && self
                        .db
                        .prepare(&format!("SELECT {alias} FROM {}", quote(name)))
                        .is_ok()
            });
            let mut projection = columns.iter().map(|s| quote(s)).collect::<Vec<_>>();
            if let Some(alias) = identity {
                projection.push(alias.to_string());
            }
            let query = format!("SELECT {} FROM {}", projection.join(","), quote(name));
            let rows = |db: &Self| -> Result<BTreeMap<Vec<u8>, usize>> {
                let mut counts = BTreeMap::new();
                let mut statement = db.db.prepare(&query)?;
                let mut cursor = statement.query([])?;
                while let Some(row) = cursor.next()? {
                    db.control.check()?;
                    let mut digest = Sha256::new();
                    for i in 0..projection.len() {
                        let value: SqlValue = row.get(i)?;
                        let bytes = format!("{value:?}");
                        digest.update((bytes.len() as u64).to_le_bytes());
                        digest.update(bytes.as_bytes());
                    }
                    *counts.entry(digest.finalize().to_vec()).or_insert(0) += 1;
                }
                Ok(counts)
            };
            let old = rows(self)?;
            // SQLite treats an unknown double-quoted column as a string literal;
            // explicitly check column presence before comparing projections.
            let compatible = after
                .db
                .prepare(&old_query)
                .map(|s| {
                    columns
                        .iter()
                        .all(|c| s.column_names().contains(&c.as_str()))
                        && identity.is_none_or(|alias| {
                            !s.column_names()
                                .iter()
                                .any(|c| c.eq_ignore_ascii_case(alias))
                        })
                        && after.db.prepare(&query).is_ok()
                })
                .unwrap_or(false);
            let new = if compatible {
                rows(after)?
            } else {
                BTreeMap::new()
            };
            let removed: usize = old
                .iter()
                .map(|(key, n)| n.saturating_sub(*new.get(key).unwrap_or(&0)))
                .sum();
            if !compatible {
                changed_objects.push(name.clone());
            }
            lost += removed;
            tables.push(json!({"table":name,"beforeRows":old.values().sum::<usize>(),"afterRows":new.values().sum::<usize>(),"removedOrChangedRows":removed}));
        }
        Ok(
            json!({"tables":tables,"removedOrChangedRows":lost,"changedObjects":changed_objects,"preservesData":lost==0 && changed_objects.is_empty()}),
        )
    }
    pub(crate) fn check_integrity(&self) -> Result<()> {
        self.control.check()?;
        // Host-only PRAGMAs. The connection is private to this plan, never shared with scripts.
        self.db
            .authorizer(None::<fn(AuthContext<'_>) -> Authorization>);
        let integrity: String = self.db.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
        let violations = self.db.prepare("PRAGMA foreign_key_check")?.exists([])?;
        if integrity != "ok" || violations {
            return Err(Error::Validation);
        }
        self.control.check()
    }
    pub fn image(&self) -> Result<Vec<u8>> {
        self.control.check()?;
        // An untouched empty database has no serialized pages.
        if self
            .db
            .query_row("SELECT count(*) FROM sqlite_schema", [], |r| {
                r.get::<_, i64>(0)
            })?
            == 0
        {
            return Ok(vec![]);
        }
        let bytes = self.db.serialize(DatabaseName::Main)?.to_vec();
        if bytes.len() > MAX_BYTES {
            return Err(Error::Limit);
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    fn database(bytes: &[u8], readonly: bool) -> Database {
        Database::open(
            bytes,
            readonly,
            Control::new(Cancellation::default(), Duration::from_secs(2)),
        )
        .unwrap()
    }
    #[test]
    fn preservation_checks_implicit_row_identity_and_added_columns() {
        let before = database(&[], false);
        before
            .run("CREATE TABLE notes(body TEXT)", &json!([]), false)
            .unwrap();
        before
            .run(
                "INSERT INTO notes(rowid,body) VALUES(1,'keep')",
                &json!([]),
                false,
            )
            .unwrap();
        let after = database(&before.image().unwrap(), false);
        after
            .run("ALTER TABLE notes ADD COLUMN tag TEXT", &json!([]), false)
            .unwrap();
        assert_eq!(
            before.preservation_report(&after).unwrap()["preservesData"],
            true
        );
        after
            .run("UPDATE notes SET rowid=7", &json!([]), false)
            .unwrap();
        assert_eq!(
            before.preservation_report(&after).unwrap()["preservesData"],
            false
        );
    }
    #[test]
    fn relations_fts_and_persistence_with_bound_parameters() {
        let db = database(&[], false);
        db.run(
            "CREATE TABLE folders(id INTEGER PRIMARY KEY)",
            &json!([]),
            false,
        )
        .unwrap();
        db.run("CREATE TABLE notes(id INTEGER PRIMARY KEY, folder INTEGER REFERENCES folders(id), body TEXT)", &json!([]), false).unwrap();
        db.run("INSERT INTO folders VALUES (?)", &json!([1]), false)
            .unwrap();
        assert!(db
            .run(
                "INSERT INTO notes VALUES(1, 99, 'invalid')",
                &json!([]),
                false
            )
            .is_err());
        db.run(
            "INSERT INTO notes VALUES(?, ?, ?)",
            &json!([1, 1, "hello ' world"]),
            false,
        )
        .unwrap();
        db.run(
            "CREATE VIRTUAL TABLE search USING fts5(body)",
            &json!([]),
            false,
        )
        .unwrap();
        db.run(
            "INSERT INTO search SELECT body FROM notes",
            &json!([]),
            false,
        )
        .unwrap();
        let image = db.image().unwrap();
        let restored = database(&image, true);
        assert_eq!(
            restored
                .run(
                    "SELECT notes.body FROM notes JOIN folders ON folders.id=notes.folder",
                    &json!([]),
                    true
                )
                .unwrap(),
            json!([{"body":"hello ' world"}])
        );
        assert_eq!(
            restored
                .run(
                    "SELECT body FROM search WHERE search MATCH ?",
                    &json!(["hello"]),
                    true
                )
                .unwrap(),
            json!([{"body":"hello ' world"}])
        );
        assert!(restored
            .run("DELETE FROM notes", &json!([]), false)
            .is_err());
    }
    #[test]
    fn rejects_host_access_transactions_and_multistatements() {
        let db = database(&[], false);
        for sql in [
            "ATTACH ':memory:' AS other",
            "VACUUM INTO '/tmp/forbidden-sqlite'",
            "PRAGMA writable_schema=ON",
            "PRAGMA query_only=OFF",
            "SELECT load_extension('x')",
            "BEGIN",
            "SAVEPOINT user_transaction",
            "CREATE TEMP TABLE hidden(x)",
            "SELECT * FROM apps",
            "SELECT 1; SELECT 2",
            "CREATE VIRTUAL TABLE leak USING dbstat",
        ] {
            assert!(db.run(sql, &json!([]), true).is_err(), "{sql}");
            assert!(db.run(sql, &json!([]), false).is_err(), "{sql}");
        }
        assert!(db
            .run("CREATE TABLE no_write(x)", &json!([]), true)
            .is_err());
        assert_eq!(db.image().unwrap(), Vec::<u8>::new());
    }
    #[test]
    fn bounds_results_and_interrupts_expensive_queries() {
        let db = database(&[], false);
        assert_eq!(db.run("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<513) SELECT x FROM n", &json!([]), true), Err(Error::Limit));
        let control = Control::new(Cancellation::default(), Duration::from_millis(20));
        let db = Database::open(&[], false, control).unwrap();
        assert!(db.run("WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n", &json!([]), true).is_err());
    }
}
