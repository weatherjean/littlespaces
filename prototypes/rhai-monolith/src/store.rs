use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    time::Duration,
};

pub type Result<T> = std::result::Result<T, String>;
pub const MAX_RECORDS: usize = 512;
pub const MAX_RECORD_BYTES: usize = 8192;
pub const MAX_DATA_BYTES: usize = 256 * 1024;
#[derive(Clone)]
pub struct Store {
    path: PathBuf,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub app: String,
    pub version: i64,
    pub hash: String,
    pub records: BTreeMap<String, Value>,
}
impl Store {
    pub fn new(path: &Path) -> Result<Self> {
        if path.exists() {
            let db = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e| e.to_string())?;
            let tables:i64 = db.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",[],|row|row.get(0)).map_err(|e|e.to_string())?;
            let marker: i64 = db
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE name='rhai_prototype'",
                    [],
                    |row| row.get(0),
                )
                .map_err(|e| e.to_string())?;
            if tables > 0 && marker == 0 {
                return Err("Refusing to modify a non-prototype database".into());
            }
        }
        let store = Self {
            path: path.to_path_buf(),
        };
        let db = store.open()?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS rhai_prototype(id INTEGER PRIMARY KEY CHECK(id=1));
            CREATE TABLE IF NOT EXISTS apps(id TEXT PRIMARY KEY,version INTEGER NOT NULL,hash TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS records(app TEXT NOT NULL,key TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(app,key));
            CREATE TABLE IF NOT EXISTS grants(app TEXT NOT NULL,resource TEXT NOT NULL,PRIMARY KEY(app,resource));").map_err(|e|e.to_string())?;
        Ok(store)
    }
    fn open(&self) -> Result<Connection> {
        let db = Connection::open(&self.path).map_err(|e| e.to_string())?;
        db.busy_timeout(Duration::from_secs(2))
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        Ok(db)
    }
    pub fn seed(&self, app: &str, hash: &str) -> Result<()> {
        let db = self.open()?;
        db.execute(
            "INSERT OR IGNORE INTO apps VALUES(?,1,?)",
            params![app, hash],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn grant(&self, app: &str, resource: &str) -> Result<()> {
        self.open()?
            .execute(
                "INSERT OR IGNORE INTO grants VALUES(?,?)",
                params![app, resource],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn allowed(&self, app: &str, resource: &str) -> Result<bool> {
        let count: i64 = self
            .open()?
            .query_row(
                "SELECT COUNT(*) FROM grants WHERE app=? AND resource=?",
                params![app, resource],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        Ok(count == 1)
    }
    pub fn snapshot(&self, app: &str) -> Result<Snapshot> {
        let mut db = self.open()?;
        let tx = db.transaction().map_err(|e| e.to_string())?;
        let (version, hash) = tx
            .query_row("SELECT version,hash FROM apps WHERE id=?", [app], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(|e| e.to_string())?;
        let records = read_records(&tx, app)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Snapshot {
            app: app.into(),
            version,
            hash,
            records,
        })
    }
    pub fn commit(&self, before: &Snapshot, after: &BTreeMap<String, Value>) -> Result<usize> {
        validate_records(after)?;
        let mut db = self.open()?;
        let tx = db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (version, hash): (i64, String) = tx
            .query_row(
                "SELECT version,hash FROM apps WHERE id=?",
                [&before.app],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| e.to_string())?;
        if version != before.version
            || hash != before.hash
            || read_records(&tx, &before.app)? != before.records
        {
            return Err("Conflict: app revision or records changed".into());
        }
        let mut changed = 0;
        for key in before
            .records
            .keys()
            .filter(|key| !after.contains_key(*key))
        {
            changed += tx
                .execute(
                    "DELETE FROM records WHERE app=? AND key=?",
                    params![before.app, key],
                )
                .map_err(|e| e.to_string())?;
        }
        for (key, value) in after
            .iter()
            .filter(|(key, value)| before.records.get(*key) != Some(*value))
        {
            changed += tx.execute("INSERT INTO records VALUES(?,?,?) ON CONFLICT(app,key) DO UPDATE SET value=excluded.value",params![before.app,key,value.to_string()]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(changed)
    }
    pub fn advance_revision(&self, app: &str) -> Result<()> {
        self.open()?
            .execute("UPDATE apps SET version=version+1 WHERE id=?", [app])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}
fn read_records(db: &Connection, app: &str) -> Result<BTreeMap<String, Value>> {
    let mut statement = db
        .prepare("SELECT key,value FROM records WHERE app=? ORDER BY key")
        .map_err(|e| e.to_string())?;
    let rows = statement
        .query_map([app], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let records = rows
        .map(|row| {
            let (key, value) = row.map_err(|e| e.to_string())?;
            Ok((
                key,
                serde_json::from_str(&value).map_err(|e| e.to_string())?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>>>()?;
    validate_records(&records)?;
    Ok(records)
}
pub fn validate_records(records: &BTreeMap<String, Value>) -> Result<()> {
    if records.len() > MAX_RECORDS
        || records.iter().any(|(key, value)| {
            key.is_empty() || key.len() > 64 || value.to_string().len() > MAX_RECORD_BYTES
        })
        || serde_json::to_vec(records)
            .map_err(|e| e.to_string())?
            .len()
            > MAX_DATA_BYTES
    {
        return Err("Record budget exceeded".into());
    }
    Ok(())
}
