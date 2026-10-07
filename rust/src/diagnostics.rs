use crate::store::{now, Store};
use serde_json::{json, Value};
use std::{
    io::Write,
    sync::{Mutex, OnceLock},
};
tokio::task_local! {static CONTEXT:Value;}
static WRITE_LOCK: Mutex<()> = Mutex::new(());
fn sensitive() -> &'static regex::Regex {
    static PATTERN: OnceLock<regex::Regex> = OnceLock::new();
    PATTERN.get_or_init(||regex::Regex::new(r"(?i)^(authorization|cookie|set-cookie|access_?token|refresh_?token|id_?token|token|client_?secret|secret|password|encrypted_content|code|code_verifier|api_?key)$").unwrap())
}
fn redactors() -> &'static Vec<(regex::Regex, &'static str)> {
    static PATTERNS: OnceLock<Vec<(regex::Regex, &'static str)>> = OnceLock::new();
    PATTERNS.get_or_init(|| {
        [
            (r#"(?i)data:image/[^\s\"']+"#, "[image omitted]"),
            (r#"(?i)\bBearer\s+[^\s\"']+"#, "Bearer [redacted]"),
            (r"\bsk-[A-Za-z0-9_-]+", "[redacted]"),
            (
                r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+",
                "[redacted]",
            ),
        ]
        .into_iter()
        .map(|(pattern, replacement)| (regex::Regex::new(pattern).unwrap(), replacement))
        .collect()
    })
}
pub fn sanitize(value: &Value, depth: usize) -> Value {
    if depth > 18 {
        return json!("[depth limit]");
    }
    match value {
        Value::String(text) => {
            let mut clean = text.clone();
            for (regex, replacement) in redactors() {
                clean = regex.replace_all(&clean, *replacement).into_owned();
            }
            if clean.trim_start().starts_with(['{', '[']) {
                if let Ok(decoded) = serde_json::from_str::<Value>(&clean) {
                    return json!(sanitize(&decoded, depth + 1).to_string());
                }
            }
            if clean.chars().count() > 250000 {
                clean = clean.chars().take(250000).collect::<String>() + " [truncated]";
            }
            json!(clean)
        }
        Value::Array(items) => {
            let mut values = items
                .iter()
                .take(200)
                .map(|value| sanitize(value, depth + 1))
                .collect::<Vec<_>>();
            if items.len() > 200 {
                values.push(json!("[array truncated]"));
            }
            json!(values)
        }
        Value::Object(values) => {
            if values
                .get("type")
                .and_then(Value::as_str)
                .is_some_and(|s| s == "reasoning" || s.starts_with("response.reasoning"))
            {
                return json!({"type":"reasoning","content":"[reasoning omitted]"});
            }
            let result = values
                .iter()
                .map(|(key, value)| {
                    (
                        key.clone(),
                        if sensitive().is_match(key) {
                            json!("[redacted]")
                        } else {
                            sanitize(value, depth + 1)
                        },
                    )
                })
                .collect::<serde_json::Map<_, _>>();
            Value::Object(result)
        }
        _ => value.clone(),
    }
}
pub fn log(store: &Store, event: &str, details: Value) {
    if std::env::var("APP_DIAGNOSTICS").as_deref() == Ok("off") {
        return;
    }
    let result = (|| -> Result<(), String> {
        let _guard = WRITE_LOCK
            .lock()
            .map_err(|_| "Diagnostic lock unavailable")?;
        let directory = store.directory.join("logs");
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let file = directory.join("events.jsonl");
        if std::fs::metadata(&file)
            .map(|m| m.len() >= 10 * 1024 * 1024)
            .unwrap_or(false)
        {
            let _ = std::fs::remove_file(directory.join("events.4.jsonl"));
            for index in (0..4).rev() {
                let source = if index == 0 {
                    file.clone()
                } else {
                    directory.join(format!("events.{index}.jsonl"))
                };
                if source.exists() {
                    std::fs::rename(
                        source,
                        directory.join(format!("events.{}.jsonl", index + 1)),
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
        let context = CONTEXT.try_with(Clone::clone).unwrap_or(json!({}));
        let mut record = context;
        if event == "chat.saved" {
            record["traceId"] = details["id"].clone();
            record["spaceId"] = details["spaceId"].clone();
            record["chatId"] = details["chatId"].clone();
        }
        record["time"] = json!(now());
        record["event"] = json!(event);
        record["details"] = sanitize(&details, 0);
        let mut options = std::fs::OpenOptions::new();
        options.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut output = options.open(&file).map_err(|e| e.to_string())?;
        output
            .write_all((record.to_string() + "\n").as_bytes())
            .map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600))
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() {
        eprintln!("Local diagnostic log could not be written.");
    }
}
pub async fn trace<F, T>(store: &Store, name: &str, mut fields: Value, future: F) -> T
where
    F: std::future::Future<Output = T>,
{
    let parent = CONTEXT.try_with(Clone::clone).unwrap_or(json!({}));
    fields["traceId"] = fields
        .get("traceId")
        .or_else(|| parent.get("traceId"))
        .cloned()
        .unwrap_or_else(|| json!(crate::random_uuid()));
    fields["spanId"] = json!(crate::random_uuid());
    fields["parentSpanId"] = parent["spanId"].clone();
    CONTEXT
        .scope(fields, async {
            let start = std::time::Instant::now();
            log(store, &format!("{name}.start"), json!({}));
            let result = future.await;
            log(
                store,
                &format!("{name}.end"),
                json!({"durationMs":start.elapsed().as_millis()}),
            );
            result
        })
        .await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn credentials_images_and_reasoning_are_not_logged() {
        let value=sanitize(&json!({"token":"private","nested":"{\"password\":\"private\"}","image":"data:image/png;base64,AAAAAAAA","header":"Bearer private","reasoning":{"type":"reasoning","text":"hidden"}}),0).to_string();
        assert!(!value.contains("private"));
        assert!(!value.contains("AAAAAAAA"));
        assert!(!value.contains("hidden"));
    }
}
