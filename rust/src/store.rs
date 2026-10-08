use rusqlite::{
    params_from_iter,
    types::{Value as Sql, ValueRef},
    Connection,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const LAUNCHER: &str = "00000000-0000-4000-8000-000000000001";
pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone)]
pub struct Store {
    pub directory: PathBuf,
}
fn sql(value: &Value) -> Sql {
    match value {
        Value::Null => Sql::Null,
        Value::Bool(v) => Sql::Integer(i64::from(*v)),
        Value::Number(v) => v
            .as_i64()
            .map(Sql::Integer)
            .unwrap_or(Sql::Real(v.as_f64().unwrap_or_default())),
        Value::String(v) => Sql::Text(v.clone()),
        _ => Sql::Text(value.to_string()),
    }
}
pub fn open(path: &Path) -> Result<Connection> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;")
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(db)
}
pub fn query(db: &Connection, statement: &str, args: &[Value]) -> Result<Vec<Value>> {
    let mut prepared = db.prepare(statement).map_err(|e| e.to_string())?;
    let names: Vec<String> = prepared
        .column_names()
        .iter()
        .map(|v| v.to_string())
        .collect();
    let arguments: Vec<Sql> = args.iter().map(sql).collect();
    let mut rows = prepared
        .query(params_from_iter(arguments))
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let mut object = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index).map_err(|e| e.to_string())? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(v) => json!(v),
                ValueRef::Real(v) => json!(v),
                ValueRef::Text(v) => json!(String::from_utf8_lossy(v)),
                ValueRef::Blob(_) => Value::Null,
            };
            object.insert(name.clone(), value);
        }
        result.push(Value::Object(object));
    }
    Ok(result)
}
pub fn execute(db: &Connection, statement: &str, args: &[Value]) -> Result<usize> {
    let arguments: Vec<Sql> = args.iter().map(sql).collect();
    db.execute(statement, params_from_iter(arguments))
        .map_err(|e| e.to_string())
}
pub fn first(db: &Connection, statement: &str, args: &[Value]) -> Result<Value> {
    query(db, statement, args)?
        .into_iter()
        .next()
        .ok_or("Not found".into())
}
pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn valid_id(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit() && !b.is_ascii_uppercase()
            }
        })
}
impl Store {
    pub fn new(directory: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(directory.join("applets")).map_err(|e| e.to_string())?;
        let store = Self { directory };
        let db = store.workspace()?;
        db.execute_batch(include_str!("schema.sql"))
            .map_err(|e| e.to_string())?;
        // Compatible additive upgrades for original workspaces.
        for (table, column, definition) in [
            ("spaces", "archived", "INTEGER NOT NULL DEFAULT 0"),
            ("chats", "launch", "TEXT NOT NULL DEFAULT '{}'"),
            ("messages", "photos", "TEXT NOT NULL DEFAULT '[]'"),
            ("secrets", "origins", "TEXT NOT NULL DEFAULT '[]'"),
            ("schedules", "revision", "INTEGER NOT NULL DEFAULT 1"),
        ] {
            let columns = query(&db, &format!("PRAGMA table_info({table})"), &[])?;
            if !columns.iter().any(|r| text(r, "name") == column) {
                db.execute_batch(&format!(
                    "ALTER TABLE {table} ADD COLUMN {column} {definition}"
                ))
                .map_err(|e| e.to_string())?;
            }
        }
        execute(
            &db,
            "INSERT OR IGNORE INTO spaces(id,name,icon) VALUES(?,'Chat','spark')",
            &[json!(LAUNCHER)],
        )?;
        execute(&db,"UPDATE chat_jobs SET status='failed',data=json_set(data,'$.status','failed','$.error','Server restarted. Completed actions may remain saved.') WHERE status='running'",&[])?;
        execute(&db,"UPDATE voice_actions SET status='failed',data=json_set(data,'$.status','failed','$.error','Execution was interrupted. Inspect app data before retrying.') WHERE status='running'",&[])?;
        store.import_legacy()?;
        Ok(store)
    }
    pub fn workspace(&self) -> Result<Connection> {
        open(&self.directory.join("workspace.sqlite"))
    }
    pub fn applet(&self, id: &str, create: bool) -> Result<Connection> {
        if !valid_id(id) {
            return Err("Invalid applet ID".into());
        }
        let path = self.directory.join("applets").join(format!("{id}.sqlite"));
        if !create && !path.exists() {
            return Err("Applet not found".into());
        }
        let db = open(&path)?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS records(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS revisions(version INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,description TEXT NOT NULL,source TEXT NOT NULL,bundle TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));").map_err(|e|e.to_string())?;
        let columns = query(&db, "PRAGMA table_info(revisions)", &[])?;
        for column in [
            "backend",
            "backendBundle",
            "testReport",
            "chatInstructions",
            "changeSummary",
            "requestedChange",
            "frontendFormat",
            "actionContract",
        ] {
            if !columns.iter().any(|row| text(row, "name") == column) {
                db.execute_batch(&format!(
                    "ALTER TABLE revisions ADD COLUMN {column} TEXT NOT NULL DEFAULT ''"
                ))
                .map_err(|e| e.to_string())?;
            }
        }
        if !columns.iter().any(|r| text(r, "name") == "restoredFrom") {
            db.execute_batch("ALTER TABLE revisions ADD COLUMN restoredFrom INTEGER")
                .map_err(|e| e.to_string())?;
        }
        db.execute_batch("CREATE TABLE IF NOT EXISTS photos(id TEXT PRIMARY KEY,owner TEXT NOT NULL,name TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,bytes INTEGER NOT NULL,data BLOB NOT NULL,created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))").map_err(|e|e.to_string())?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS backend_contracts(hash TEXT PRIMARY KEY,contract TEXT NOT NULL); CREATE TABLE IF NOT EXISTS http_grants(id INTEGER PRIMARY KEY CHECK(id=1),grants TEXT NOT NULL); CREATE TABLE IF NOT EXISTS external_operations(id TEXT PRIMARY KEY,action TEXT NOT NULL,origin TEXT NOT NULL,method TEXT NOT NULL,status TEXT NOT NULL,http_status INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS app_diagnostics(id INTEGER PRIMARY KEY AUTOINCREMENT,version INTEGER NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);").map_err(|e| e.to_string())?;
        Ok(db)
    }
    pub fn import_legacy(&self) -> Result<()> {
        let db = self.workspace()?;
        for file in std::fs::read_dir(self.directory.join("applets")).map_err(|e| e.to_string())? {
            let name = file
                .map_err(|e| e.to_string())?
                .file_name()
                .to_string_lossy()
                .into_owned();
            let Some(id) = name.strip_suffix(".sqlite") else {
                continue;
            };
            if !valid_id(id) {
                continue;
            }
            if first(
                &db,
                "SELECT applet_id FROM space_applets WHERE applet_id=?",
                &[json!(id)],
            )
            .is_ok()
            {
                continue;
            }
            if let Ok(rev) = self.revision(id, None) {
                execute(
                    &db,
                    "INSERT OR IGNORE INTO spaces(id,name,icon) VALUES(?,?,'grid')",
                    &[json!(id), rev["title"].clone()],
                )?;
                execute(
                    &db,
                    "INSERT OR IGNORE INTO space_applets(applet_id,space_id) VALUES(?,?)",
                    &[json!(id), json!(id)],
                )?;
            }
        }
        Ok(())
    }
    pub fn revision(&self, id: &str, version: Option<i64>) -> Result<Value> {
        first(
            &self.applet(id, false)?,
            "SELECT * FROM revisions WHERE (? IS NULL OR version=?) ORDER BY version DESC LIMIT 1",
            &[json!(version), json!(version)],
        )
    }
    pub fn versions(&self, id: &str) -> Result<Vec<Value>> {
        query(&self.applet(id,false)?,"SELECT version,title,created_at AS createdAt,changeSummary,requestedChange,restoredFrom,testReport FROM revisions ORDER BY version DESC",&[])
    }
    pub fn records(&self, id: &str) -> Result<Vec<Value>> {
        query(
            &self.applet(id, false)?,
            "SELECT key,value FROM records ORDER BY key LIMIT 2000",
            &[],
        )?
        .into_iter()
        .map(|mut row| {
            row["value"] = serde_json::from_str(text(&row, "value")).map_err(|e| e.to_string())?;
            Ok(row)
        })
        .collect()
    }
    pub fn spaces(&self, all: bool) -> Result<Vec<Value>> {
        query(&self.workspace()?,"SELECT s.id,s.name,s.icon,s.archived,s.updated_at AS updatedAt,COUNT(a.applet_id) AS appletCount FROM spaces s LEFT JOIN space_applets a ON a.space_id=s.id WHERE s.id<>? AND (? OR s.archived=0) GROUP BY s.id ORDER BY s.updated_at DESC",&[json!(LAUNCHER),json!(all)])
    }
    pub fn space(&self, id: &str) -> Result<Value> {
        first(
            &self.workspace()?,
            "SELECT id,name,icon,archived,updated_at AS updatedAt FROM spaces WHERE id=?",
            &[json!(id)],
        )
    }
    pub fn applet_id(&self, space: &str) -> Result<String> {
        first(
            &self.workspace()?,
            "SELECT applet_id FROM space_applets WHERE space_id=?",
            &[json!(space)],
        )
        .map(|r| text(&r, "applet_id").into())
    }
    pub fn create_space(&self, name: &str, icon: &str) -> Result<Value> {
        if name.trim().is_empty() || name.len() > 200 {
            return Err("Enter an app name".into());
        }
        let id = crate::random_uuid();
        execute(
            &self.workspace()?,
            "INSERT INTO spaces(id,name,icon) VALUES(?,?,?)",
            &[json!(id), json!(name.trim()), json!(icon)],
        )?;
        self.space(&id)
    }
    pub fn chats(&self, space: &str) -> Result<Vec<Value>> {
        self.space(space)?;
        let db = self.workspace()?;
        execute(&db,"INSERT INTO chats(id,space_id,title) SELECT ?,?,'First chat' WHERE NOT EXISTS(SELECT 1 FROM chats WHERE space_id=?) AND (EXISTS(SELECT 1 FROM messages WHERE thread=?) OR EXISTS(SELECT 1 FROM chat_tools WHERE thread=?) OR EXISTS(SELECT 1 FROM build_drafts WHERE chat_id=?) OR EXISTS(SELECT 1 FROM voice_actions WHERE chat_id=?))",&[json!(space),json!(space),json!(space),json!(space),json!(space),json!(space),json!(space)])?;
        query(&db,"SELECT id,space_id AS spaceId,title,launch,updated_at AS updatedAt FROM chats WHERE space_id=? ORDER BY updated_at DESC,rowid DESC",&[json!(space)])?.into_iter().map(|mut row|{row["launch"]=serde_json::from_str(text(&row,"launch")).unwrap_or(json!({}));Ok(row)}).collect()
    }
    pub fn chat(&self, space: &str, id: &str) -> Result<Value> {
        self.chats(space)?
            .into_iter()
            .find(|r| text(r, "id") == id)
            .ok_or("Chat not found in this app".into())
    }
    pub fn validate_launch(&self, space: &str, launch: &Value) -> Result<()> {
        if !launch.is_object()
            || text(launch, "task").trim().is_empty()
            || text(launch, "task").chars().count() > 2000
            || text(launch, "title").chars().count() > 80
            || text(launch, "welcome").chars().count() > 2000
            || launch["context"].to_string().len() > 8000
        {
            return Err("Invalid app chat context".into());
        }
        for (field, max) in [("recordKeys", 10), ("photoIds", 4)] {
            if launch.get(field).is_some() {
                let values = launch[field]
                    .as_array()
                    .ok_or("Invalid context references")?;
                if values.len() > max
                    || values
                        .iter()
                        .any(|v| v.as_str().map_or(true, |s| s.is_empty() || s.len() > 200))
                {
                    return Err("Invalid context references".into());
                }
            }
        }
        if let Some(keys) = launch["recordKeys"].as_array() {
            if !keys.is_empty() {
                let records = self.records(&self.applet_id(space)?)?;
                for key in keys {
                    if !records.iter().any(|r| r["key"] == *key) {
                        return Err("A referenced record is no longer available".into());
                    }
                }
            }
        }
        if let Some(ids) = launch["photoIds"].as_array() {
            for id in ids {
                crate::photos::read(self, space, id.as_str().unwrap_or(""))?;
            }
        }
        Ok(())
    }
    pub fn create_chat(&self, space: &str, launch: Value) -> Result<Value> {
        self.space(space)?;
        if !launch.as_object().map_or(true, |o| o.is_empty()) {
            self.validate_launch(space, &launch)?;
        }
        let id = crate::random_uuid();
        let title = if text(&launch, "title").is_empty() {
            "New chat"
        } else {
            text(&launch, "title")
        };
        execute(
            &self.workspace()?,
            "INSERT INTO chats(id,space_id,title,launch) VALUES(?,?,?,?)",
            &[
                json!(id),
                json!(space),
                json!(title),
                json!(launch.to_string()),
            ],
        )?;
        self.chat(space, &id)
    }
    pub fn messages(&self, chat: &str) -> Result<Vec<Value>> {
        query(&self.workspace()?,"SELECT id,role,content,photos FROM (SELECT id,role,content,photos FROM messages WHERE thread=? ORDER BY id DESC LIMIT 30) ORDER BY id",&[json!(chat)])?.into_iter().map(|mut row|{row["photos"]=serde_json::from_str(text(&row,"photos")).unwrap_or(json!([]));row["toolCalls"]=self.tools(chat,Some(row["id"].as_i64().unwrap_or_default()))?;Ok(row)}).collect()
    }
    pub fn tools(&self, chat: &str, message: Option<i64>) -> Result<Value> {
        let rows=query(&self.workspace()?,"SELECT data FROM chat_tools WHERE thread=? AND ((? IS NULL AND message_id IS NULL) OR message_id=?) ORDER BY rowid",&[json!(chat),json!(message),json!(message)])?;
        Ok(json!(rows
            .iter()
            .filter_map(|r| serde_json::from_str::<Value>(text(r, "data")).ok())
            .collect::<Vec<_>>()))
    }
    pub fn tool(&self, chat: &str, call: &Value) -> Result<()> {
        execute(&self.workspace()?,"INSERT INTO chat_tools(id,thread,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",&[call["id"].clone(),json!(chat),json!(crate::diagnostics::sanitize(call,0).to_string())])?;
        Ok(())
    }
    pub fn publish(
        &self,
        space: &str,
        id: &str,
        content: &Value,
        restored: Option<i64>,
    ) -> Result<Value> {
        self.space(space)?;
        if let Ok(owner) = first(
            &self.workspace()?,
            "SELECT space_id FROM space_applets WHERE applet_id=?",
            &[json!(id)],
        ) {
            if text(&owner, "space_id") != space {
                return Err("Applet belongs to another app".into());
            }
        }
        let existing = self.applet_id(space).ok();
        if existing.as_deref().is_some_and(|other| other != id) {
            return Err("An app has one applet".into());
        }
        let db = self.applet(id, true)?;
        let summary = restored
            .map(|v| format!("Restored code and chat guidance from v{v}. Current data kept."))
            .unwrap_or_else(|| "Published app revision.".into());
        execute(&db,"INSERT INTO revisions(title,description,source,bundle,backend,backendBundle,testReport,chatInstructions,changeSummary,requestedChange,restoredFrom,frontendFormat,actionContract) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",&[content["title"].clone(),content["description"].clone(),content["source"].clone(),content["bundle"].clone(),json!(text(content,"backend")),json!(text(content,"backendBundle")),json!(text(content,"testReport")),json!(text(content,"chatInstructions")),json!(summary),json!(text(content,"requestedChange")),json!(restored),json!(text(content,"frontendFormat")),json!(text(content,"actionContract"))])?;
        execute(
            &self.workspace()?,
            "INSERT OR IGNORE INTO space_applets VALUES(?,?)",
            &[json!(id), json!(space)],
        )?;
        execute(
            &self.workspace()?,
            "UPDATE spaces SET name=?,updated_at=? WHERE id=?",
            &[content["title"].clone(), json!(now()), json!(space)],
        )?;
        let mut rev = self.revision(id, None)?;
        rev["id"] = json!(id);
        Ok(rev)
    }
    pub fn json_row(&self, table: &str, key: &str) -> Result<Value> {
        let column = if table == "build_plans" || table == "build_drafts" {
            "chat_id"
        } else {
            "id"
        };
        first(
            &self.workspace()?,
            &format!("SELECT data FROM {table} WHERE {column}=?"),
            &[json!(key)],
        )
        .and_then(|r| serde_json::from_str(text(&r, "data")).map_err(|e| e.to_string()))
    }
    pub fn json_save(&self, table: &str, key: &str, value: &Value) -> Result<()> {
        let column = if table == "build_plans" || table == "build_drafts" {
            "chat_id"
        } else {
            "id"
        };
        execute(&self.workspace()?,&format!("INSERT INTO {table}({column},data) VALUES(?,?) ON CONFLICT({column}) DO UPDATE SET data=excluded.data"),&[json!(key),json!(value.to_string())])?;
        Ok(())
    }
}
