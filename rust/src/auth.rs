use crate::store::{execute, first, open, text, Result, Store};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Mutex;
use subtle::ConstantTimeEq;

pub struct Auth {
    pub setup_token: String,
    ephemeral: Mutex<HashMap<String, Value>>,
    password_gate: tokio::sync::Semaphore,
}
fn digest(value: &str) -> String {
    Sha256::digest(value.as_bytes())
        .iter()
        .fold(String::new(), |mut s, b| {
            use std::fmt::Write;
            let _ = write!(s, "{b:02x}");
            s
        })
}
fn token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}
fn hash(password: &str, salt: &str) -> Result<Vec<u8>> {
    let params = scrypt::Params::new(15, 8, 3, 64).map_err(|e| e.to_string())?;
    let mut output = vec![0u8; 64];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut output)
        .map_err(|e| e.to_string())?;
    Ok(output)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::new(), |mut s, b| {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
        s
    })
}
fn unhex(value: &str) -> Result<Vec<u8>> {
    if value.len() % 2 != 0 {
        return Err("Invalid hash".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&value[i..i + 2], 16).map_err(|_| "Invalid hash".into()))
        .collect()
}
impl Auth {
    pub fn new(store: &Store) -> Result<Self> {
        let db = open(&store.directory.join("owner.sqlite"))?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS owner(id INTEGER PRIMARY KEY CHECK(id=1),email TEXT NOT NULL,salt TEXT NOT NULL,password_hash TEXT NOT NULL,version TEXT NOT NULL,failures INTEGER NOT NULL DEFAULT 0,locked_until INTEGER NOT NULL DEFAULT 0)").map_err(|e|e.to_string())?;
        let db = open(&store.directory.join("sessions.sqlite"))?;
        db.execute_batch("CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,email TEXT NOT NULL,version TEXT NOT NULL,expires_at INTEGER NOT NULL)").map_err(|e|e.to_string())?;
        Ok(Self {
            setup_token: token(),
            ephemeral: Mutex::new(HashMap::new()),
            password_gate: tokio::sync::Semaphore::new(1),
        })
    }
    pub fn owner(&self, store: &Store) -> Result<Value> {
        first(
            &open(&store.directory.join("owner.sqlite"))?,
            "SELECT * FROM owner WHERE id=1",
            &[],
        )
    }
    pub async fn configure(&self, store: &Store, input: &Value) -> Result<()> {
        self.configure_mode(store, input, false).await
    }
    pub async fn reset(&self, store: &Store, input: &Value) -> Result<()> {
        self.configure_mode(store, input, true).await
    }
    async fn configure_mode(&self, store: &Store, input: &Value, reset: bool) -> Result<()> {
        let _permit = self
            .password_gate
            .try_acquire()
            .map_err(|_| "Another password operation is running")?;
        if text(input, "token") != self.setup_token {
            return Err("Open the private setup link from the server terminal".into());
        }
        let email = text(input, "email").trim().to_lowercase();
        let password = text(input, "password").to_string();
        if email.matches('@').count() != 1
            || email.starts_with('@')
            || !email.split('@').nth(1).unwrap_or("").contains('.')
            || email.ends_with('.')
            || email.len() > 254
            || email.contains(char::is_whitespace)
        {
            return Err("Enter a valid email".into());
        }
        if password.chars().count() < 15
            || password.chars().count() > 256
            || text(input, "confirmation") != password
        {
            return Err("Use a matching password of 15–256 characters".into());
        }
        if !reset && self.owner(store).is_ok() {
            return Err("Owner already exists".into());
        }
        if reset && self.owner(store).is_err() {
            return Err("No owner account exists".into());
        }
        let salt = crate::random_id();
        let hashing_salt = salt.clone();
        let encoded = tokio::task::spawn_blocking(move || hash(&password, &hashing_salt))
            .await
            .map_err(|e| e.to_string())??;
        execute(
            &open(&store.directory.join("owner.sqlite"))?,
            "INSERT INTO owner(id,email,salt,password_hash,version) VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,salt=excluded.salt,password_hash=excluded.password_hash,version=excluded.version,failures=0,locked_until=0",
            &[
                json!(email),
                json!(salt),
                json!(hex(&encoded)),
                json!(crate::random_uuid()),
            ],
        )?;
        Ok(())
    }
    pub async fn login(&self, store: &Store, input: &Value) -> Result<(String, bool)> {
        let _permit = self
            .password_gate
            .try_acquire()
            .map_err(|_| "Another sign-in is in progress")?;
        let owner = self.owner(store)?;
        let now = chrono::Utc::now().timestamp_millis();
        if owner["locked_until"].as_i64().unwrap_or(0) > now {
            return Err("Sign-in is temporarily locked. Try again in five minutes.".into());
        }
        let password = text(input, "password").to_string();
        let salt = text(&owner, "salt").to_string();
        if password.len() > 1024 {
            return Err("Invalid email or password".into());
        }
        let encoded = tokio::task::spawn_blocking(move || hash(&password, &salt))
            .await
            .map_err(|e| e.to_string())??;
        let stored = unhex(text(&owner, "password_hash"))?;
        let valid: bool = encoded.ct_eq(&stored).into();
        let db = open(&store.directory.join("owner.sqlite"))?;
        if !valid || text(input, "email").trim().to_lowercase() != text(&owner, "email") {
            let failures = if owner["locked_until"].as_i64().unwrap_or(0) > 0 {
                1
            } else {
                owner["failures"].as_i64().unwrap_or(0) + 1
            };
            execute(
                &db,
                "UPDATE owner SET failures=?,locked_until=? WHERE id=1",
                &[
                    json!(failures),
                    json!(if failures >= 3 { now + 300000 } else { 0 }),
                ],
            )?;
            return Err("Invalid email or password".into());
        }
        execute(
            &db,
            "UPDATE owner SET failures=0,locked_until=0 WHERE id=1",
            &[],
        )?;
        let remember = input["remember"].as_bool().unwrap_or(false);
        let session = token();
        let expires = now
            + if remember {
                30 * 24 * 60 * 60 * 1000
            } else {
                12 * 60 * 60 * 1000
            };
        let row = json!({"email":owner["email"],"version":owner["version"],"expires_at":expires});
        if remember {
            let db = open(&store.directory.join("sessions.sqlite"))?;
            execute(
                &db,
                "DELETE FROM sessions WHERE expires_at<=? OR version<>?",
                &[json!(now), owner["version"].clone()],
            )?;
            execute(&db,"DELETE FROM sessions WHERE token_hash IN(SELECT token_hash FROM sessions ORDER BY expires_at DESC LIMIT -1 OFFSET 49)",&[])?;
            execute(
                &db,
                "INSERT INTO sessions VALUES(?,?,?,?)",
                &[
                    json!(digest(&session)),
                    owner["email"].clone(),
                    owner["version"].clone(),
                    json!(expires),
                ],
            )?;
        } else {
            let mut sessions = self
                .ephemeral
                .lock()
                .map_err(|_| "Session store unavailable")?;
            sessions.retain(|_, v| v["expires_at"].as_i64().unwrap_or(0) > now);
            if sessions.len() >= 50 {
                let key = sessions.keys().next().cloned().unwrap();
                sessions.remove(&key);
            }
            sessions.insert(digest(&session), row);
        }
        Ok((session, remember))
    }
    pub fn session(&self, store: &Store, cookie: &str) -> Option<Value> {
        if cookie.len() != 43 {
            return None;
        }
        let owner = self.owner(store).ok()?;
        let key = digest(cookie);
        let now = chrono::Utc::now().timestamp_millis();
        let row = self.ephemeral.lock().ok()?.get(&key).cloned().or_else(|| {
            first(
                &open(&store.directory.join("sessions.sqlite")).ok()?,
                "SELECT * FROM sessions WHERE token_hash=?",
                &[json!(key)],
            )
            .ok()
        })?;
        if row["version"] != owner["version"] || row["expires_at"].as_i64()? <= now {
            return None;
        }
        Some(json!({"email":row["email"]}))
    }
    pub fn logout(&self, store: &Store, cookie: &str, all: bool) -> Result<()> {
        self.ephemeral
            .lock()
            .map_err(|_| "Session store unavailable")?
            .remove(&digest(cookie));
        let db = open(&store.directory.join("sessions.sqlite"))?;
        execute(
            &db,
            "DELETE FROM sessions WHERE token_hash=?",
            &[json!(digest(cookie))],
        )?;
        if all {
            self.ephemeral
                .lock()
                .map_err(|_| "Session store unavailable")?
                .clear();
            execute(
                &open(&store.directory.join("owner.sqlite"))?,
                "UPDATE owner SET version=? WHERE id=1",
                &[json!(crate::random_uuid())],
            )?;
            execute(&db, "DELETE FROM sessions", &[])?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod compatibility {
    use super::*;
    #[test]
    fn password_hash_matches_the_original_node_scrypt() {
        assert_eq!(hex(&hash("correct horse battery fixture",&"0123456789abcdef".repeat(4)).unwrap()),"145b89d14ba4c295c22afe1d37be9adde15344db49576a22769cf169a196d94147ba99e5cf0d169f805679c23ce6db60a632ed3c06f3848faedeb00bbd80c809");
    }
}
