use crate::store::{execute, first, now, query, text, Result, Store};
use aes_gcm::{
    aead::{Aead, Payload},
    Aes256Gcm, KeyInit, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::RngCore;
use serde_json::{json, Value};
fn key(store: &Store, create: bool) -> Result<Vec<u8>> {
    let path = store.directory.join("secrets.key");
    if let Ok(bytes) = std::fs::read(&path) {
        if bytes.len() != 32 {
            return Err("Invalid secret encryption key".into());
        }
        return Ok(bytes);
    }
    if !create
        || first(
            &store.workspace()?,
            "SELECT COUNT(*) AS n FROM secrets",
            &[],
        )?["n"]
            .as_i64()
            .unwrap_or(0)
            > 0
    {
        return Err("Restore the matching secrets.key from backup".into());
    }
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|e| e.to_string())?;
    file.write_all(&bytes).map_err(|e| e.to_string())?;
    Ok(bytes.to_vec())
}
pub fn origins(value: &Value) -> Result<Value> {
    let input = value.as_array().ok_or("Provide API origins")?;
    if input.len() > 10 {
        return Err("Add up to ten origins".into());
    }
    let mut result = Vec::new();
    for origin in input {
        let url = url::Url::parse(origin.as_str().ok_or("Invalid API origin")?)
            .map_err(|_| "Invalid API origin")?;
        if url.scheme() != "https"
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || url.port_or_known_default() != Some(443)
        {
            return Err("Use HTTPS origins without paths or custom ports".into());
        }
        let origin = url.origin().ascii_serialization();
        if !result.contains(&origin) {
            result.push(origin);
        }
    }
    Ok(json!(result))
}
pub fn save(store: &Store, input: &Value) -> Result<()> {
    let name = text(input, "name");
    let value = text(input, "value");
    let description = text(input, "description");
    if name.is_empty()
        || name.len() > 64
        || !name.bytes().next().unwrap().is_ascii_uppercase()
        || !name
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
        || description.chars().count() > 500
    {
        return Err("Use an uppercase secret name and a short description".into());
    }
    let allowed = origins(&input["origins"])?;
    if text(input, "action") == "configure" {
        if execute(
            &store.workspace()?,
            "UPDATE secrets SET description=?,origins=?,updated_at=? WHERE name=?",
            &[
                json!(description),
                json!(allowed.to_string()),
                json!(now()),
                json!(name),
            ],
        )? == 0
        {
            return Err("Secret not found".into());
        }
        return Ok(());
    }
    if value.is_empty() || value.len() > 16000 {
        return Err("Provide a secret value".into());
    }
    let cipher =
        Aes256Gcm::new_from_slice(&key(store, true)?).map_err(|_| "Invalid encryption key")?;
    let mut iv = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut iv);
    let mut encrypted = cipher
        .encrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: value.as_bytes(),
                aad: name.as_bytes(),
            },
        )
        .map_err(|_| "Secret encryption failed")?;
    let tag = encrypted.split_off(encrypted.len() - 16);
    let encoded=json!({"iv":STANDARD.encode(iv),"tag":STANDARD.encode(tag),"data":STANDARD.encode(encrypted)}).to_string();
    execute(&store.workspace()?,"INSERT INTO secrets(name,description,origins,ciphertext,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET description=excluded.description,origins=excluded.origins,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at",&[json!(name),json!(description),json!(allowed.to_string()),json!(encoded),json!(now())])?;
    Ok(())
}
pub fn list(store: &Store) -> Result<Value> {
    let rows = query(
        &store.workspace()?,
        "SELECT name,description,origins,ciphertext,updated_at AS updatedAt FROM secrets ORDER BY name",
        &[],
    )?;
    Ok(json!(rows
        .into_iter()
        .map(|mut row| {
            row["origins"] = serde_json::from_str(text(&row, "origins")).unwrap_or(json!([]));
            row["verification"] = json!("not_verified");
            let warnings=match decrypt(store,text(&row,"name"),text(&row,"ciphertext")){Ok(value)=>credential_warnings(text(&row,"name"),&value),Err(_)=>vec!["The stored value could not be decrypted. Restore the matching encryption key or replace the credential.".into()]};
            row["warnings"] = json!(warnings);row.as_object_mut().unwrap().remove("ciphertext");
            row
        })
        .collect::<Vec<_>>()))
}
pub fn for_origin(store: &Store, name: &str, origin: &str) -> Result<String> {
    let row = first(
        &store.workspace()?,
        "SELECT origins,ciphertext FROM secrets WHERE name=?",
        &[json!(name)],
    )
    .map_err(|_| format!("Add secret {name} in Settings"))?;
    let allowed: Vec<String> =
        serde_json::from_str(text(&row, "origins")).map_err(|_| "Invalid origin permissions")?;
    if !allowed.iter().any(|o| o == origin) {
        return Err(format!("Secret {name} is not allowed for {origin}"));
    }
    decrypt(store, name, text(&row, "ciphertext"))
}
fn decrypt(store: &Store, name: &str, ciphertext: &str) -> Result<String> {
    let encoded: Value = serde_json::from_str(ciphertext).map_err(|_| "Invalid encrypted value")?;
    let iv = STANDARD
        .decode(text(&encoded, "iv"))
        .map_err(|_| "Invalid encrypted value")?;
    if iv.len() != 12 {
        return Err("Invalid encrypted nonce".into());
    }
    let mut data = STANDARD
        .decode(text(&encoded, "data"))
        .map_err(|_| "Invalid encrypted value")?;
    data.extend(
        STANDARD
            .decode(text(&encoded, "tag"))
            .map_err(|_| "Invalid encrypted value")?,
    );
    let cipher =
        Aes256Gcm::new_from_slice(&key(store, false)?).map_err(|_| "Invalid encryption key")?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&iv),
            Payload {
                msg: &data,
                aad: name.as_bytes(),
            },
        )
        .map_err(|_| "Restore the matching encryption key or replace this secret")?;
    String::from_utf8(plain).map_err(|_| "Invalid secret encoding".into())
}

fn credential_warnings(name: &str, value: &str) -> Vec<String> {
    let mut warnings = Vec::new();
    if value != value.trim() {
        warnings.push("The value starts or ends with whitespace. Check the copied credential; whitespace is preserved.".into());
    }
    if name == "GOOGLE_BOOKS_API_KEY"
        && !(value.len() == 39
            && value.starts_with("AIza")
            && value
                .bytes()
                .skip(4)
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'))
    {
        warnings.push("This does not match the usual Google Cloud API-key format. Copy the complete API key from Google Cloud Credentials, not its name or ID. Saving it does not verify it.".into());
    }
    warnings
}
