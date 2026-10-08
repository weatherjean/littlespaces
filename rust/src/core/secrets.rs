//! Owner-only name/value API; plaintext resolution stays inside the host broker.
use super::*;
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use rand::RngCore;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;
use serde_json::Value;
use std::{io::Write, path::Path};
use zeroize::Zeroizing;

#[derive(Clone)]
pub struct Secrets {
    store: Store,
    key: std::sync::Arc<Zeroizing<Vec<u8>>>,
}
#[derive(Debug, Serialize)]
pub struct SecretName {
    pub name: String,
    pub configured: bool,
}
impl Secrets {
    pub fn open(store: Store, key_path: &Path) -> Result<Self> {
        let key = if key_path.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if std::fs::metadata(key_path)
                    .map_err(|_| Error::Storage)?
                    .permissions()
                    .mode()
                    & 0o077
                    != 0
                {
                    return Err(Error::Storage);
                }
            }
            Zeroizing::new(std::fs::read(key_path).map_err(|_| Error::Storage)?)
        } else {
            let count: i64 = store
                .open()?
                .query_row("SELECT COUNT(*) FROM secrets", [], |r| r.get(0))?;
            if count != 0 {
                return Err(Error::Storage);
            }
            let mut key = Zeroizing::new(vec![0u8; 32]);
            rand::thread_rng().fill_bytes(&mut key);
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(key_path).map_err(|_| Error::Storage)?;
            file.write_all(&key).map_err(|_| Error::Storage)?;
            file.sync_all().map_err(|_| Error::Storage)?;
            key
        };
        if key.len() != 32 {
            return Err(Error::Storage);
        }
        Ok(Self {
            store,
            key: std::sync::Arc::new(key),
        })
    }
    pub fn put(&self, name: &str, value: &str) -> Result<()> {
        validate_name(name)?;
        if value.is_empty() || value.len() > 16000 {
            return Err(Error::Validation);
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| Error::Storage)?;
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: value.as_bytes(),
                    aad: name.as_bytes(),
                },
            )
            .map_err(|_| Error::Storage)?;
        let mut db = self.store.open()?;
        let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let count: i64 =
            tx.query_row("SELECT COUNT(*) FROM secrets WHERE name<>?", [name], |r| {
                r.get(0)
            })?;
        if count >= 128 {
            return Err(Error::Limit);
        }
        tx.execute("INSERT INTO secrets VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext",params![name,nonce.as_slice(),ciphertext])?;
        tx.commit()?;
        Ok(())
    }
    pub fn delete(&self, name: &str) -> Result<()> {
        validate_name(name)?;
        self.store
            .open()?
            .execute("DELETE FROM secrets WHERE name=?", [name])?;
        Ok(())
    }
    pub fn list(&self) -> Result<Vec<SecretName>> {
        let db = self.store.open()?;
        let mut stmt = db.prepare("SELECT name FROM secrets ORDER BY name")?;
        let names = stmt
            .query_map([], |r| {
                Ok(SecretName {
                    name: r.get(0)?,
                    configured: true,
                })
            })?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(names)
    }
    fn plaintext(&self, name: &str) -> Result<Zeroizing<String>> {
        validate_name(name)?;
        let (nonce, ciphertext): (Vec<u8>, Vec<u8>) = self
            .store
            .open()?
            .query_row(
                "SELECT nonce,ciphertext FROM secrets WHERE name=?",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?
            .ok_or(Error::MissingSecret)?;
        if nonce.len() != 12 {
            return Err(Error::Storage);
        }
        let cipher = Aes256Gcm::new_from_slice(&self.key).map_err(|_| Error::Storage)?;
        let plain = Zeroizing::new(
            cipher
                .decrypt(
                    Nonce::from_slice(&nonce),
                    Payload {
                        msg: &ciphertext,
                        aad: name.as_bytes(),
                    },
                )
                .map_err(|_| Error::Storage)?,
        );
        Ok(Zeroizing::new(
            String::from_utf8(plain.to_vec()).map_err(|_| Error::Storage)?,
        ))
    }
    pub(crate) fn scope(&self) -> Result<HostSecrets> {
        let values = self
            .list()?
            .into_iter()
            .map(|s| Ok((s.name.clone(), self.plaintext(&s.name)?)))
            .collect::<Result<_>>()?;
        Ok(HostSecrets {
            values: std::sync::Arc::new(values),
        })
    }
    pub(crate) fn redact(&self, value: Value) -> Result<Value> {
        self.scope()?.redact(value)
    }
}
#[derive(Clone)]
pub(crate) struct HostSecrets {
    values: std::sync::Arc<std::collections::BTreeMap<String, Zeroizing<String>>>,
}
impl HostSecrets {
    pub fn resolve(&self, value: &Value, mock: bool) -> Result<Value> {
        match value {
            Value::Object(o) if o.contains_key("$secret") => {
                if o.len() != 1 {
                    return Err(Error::Validation);
                }
                let name = o["$secret"].as_str().ok_or(Error::Validation)?;
                validate_name(name)?;
                if mock {
                    Ok(Value::String(format!("synthetic-{name}")))
                } else {
                    Ok(Value::String(
                        self.values
                            .get(name)
                            .ok_or(Error::MissingSecret)?
                            .to_string(),
                    ))
                }
            }
            Value::Object(o) => Ok(Value::Object(
                o.iter()
                    .map(|(k, v)| Ok((k.clone(), self.resolve(v, mock)?)))
                    .collect::<Result<_>>()?,
            )),
            Value::Array(a) => Ok(Value::Array(
                a.iter()
                    .map(|v| self.resolve(v, mock))
                    .collect::<Result<_>>()?,
            )),
            v => Ok(v.clone()),
        }
    }
    pub fn redact(&self, value: Value) -> Result<Value> {
        let secrets = self.values.values().collect::<Vec<_>>();
        fn walk(value: Value, secrets: &[&Zeroizing<String>]) -> Value {
            match value {
                Value::String(mut s) => {
                    for secret in secrets {
                        s = s.replace(secret.as_str(), "[redacted]");
                    }
                    Value::String(s)
                }
                Value::Array(a) => Value::Array(a.into_iter().map(|v| walk(v, secrets)).collect()),
                Value::Object(o) => Value::Object(
                    o.into_iter()
                        .map(|(k, v)| {
                            let Value::String(k) = walk(Value::String(k), secrets) else {
                                unreachable!()
                            };
                            (k, walk(v, secrets))
                        })
                        .collect(),
                ),
                v => {
                    let encoded = v.to_string();
                    if secrets.iter().any(|s| encoded == s.as_str()) {
                        Value::String("[redacted]".into())
                    } else {
                        v
                    }
                }
            }
        }
        Ok(walk(value, &secrets))
    }
}
fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 64
        || !name.as_bytes()[0].is_ascii_alphabetic()
        || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
    {
        return Err(Error::Validation);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn simple_encrypted_names_and_host_resolution() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("workspace.sqlite")).unwrap();
        let secrets = Secrets::open(store.clone(), &dir.path().join("secrets.key")).unwrap();
        secrets.put("TOKEN", "private-synthetic-value").unwrap();
        assert_eq!(
            serde_json::to_value(secrets.list().unwrap()).unwrap(),
            json!([{"name":"TOKEN","configured":true}])
        );
        assert_eq!(
            secrets
                .scope()
                .unwrap()
                .resolve(&json!({"$secret":"TOKEN"}), false)
                .unwrap(),
            json!("private-synthetic-value")
        );
        assert_eq!(
            secrets
                .scope()
                .unwrap()
                .resolve(&json!({"$secret":"TOKEN"}), true)
                .unwrap(),
            json!("synthetic-TOKEN")
        );
        assert_eq!(
            secrets
                .redact(json!({"private-synthetic-value":"prefix private-synthetic-value"}))
                .unwrap(),
            json!({"[redacted]":"prefix [redacted]"})
        );
        assert!(!std::fs::read(dir.path().join("workspace.sqlite"))
            .unwrap()
            .windows(b"private-synthetic-value".len())
            .any(|w| w == b"private-synthetic-value"));
        let inflight = secrets.scope().unwrap();
        secrets.put("TOKEN", "replacement-value").unwrap();
        assert_eq!(
            inflight.redact(json!("private-synthetic-value")).unwrap(),
            json!("[redacted]")
        );
        secrets.delete("TOKEN").unwrap();
        assert!(secrets.list().unwrap().is_empty());
    }
}
