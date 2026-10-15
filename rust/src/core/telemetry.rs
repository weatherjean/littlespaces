//! Bounded structured diagnostics: never log request bodies, keys or provider text.
pub fn error(operation: &str, error: super::Error) {
    eprintln!(
        "{}",
        serde_json::json!({"level":"error","operation":operation,"error":error,"at":super::owner::now()})
    );
}
