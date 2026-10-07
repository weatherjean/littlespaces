use rquickjs::{function::Func, Context, Runtime};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    io::Write,
    time::{Duration, Instant},
};

pub const MAX_BYTES: usize = 4_000_000;
#[derive(Serialize, Deserialize)]
pub struct Request {
    pub source: String,
    #[serde(default)]
    pub mode: String,
    #[serde(default = "default_budget")]
    pub budget_ms: u64,
    pub action: String,
    pub input: Value,
    pub records: BTreeMap<String, Value>,
    pub now: String,
}
fn default_budget() -> u64 {
    2000
}
#[derive(Serialize, Deserialize, Debug)]
pub struct Output {
    #[serde(default)]
    pub requests: Vec<Value>,
    #[serde(default)]
    pub catalog: Vec<Value>,
    #[serde(default)]
    pub report: Vec<Value>,
    pub result: Value,
    pub records: BTreeMap<String, Value>,
}

pub fn execute(request: Request) -> Result<Output, String> {
    if request.source.len() > 1_000_000 {
        return Err("Backend source is too large".into());
    }
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(32 * 1024 * 1024);
    runtime.set_max_stack_size(256 * 1024);
    let deadline = Instant::now() + Duration::from_millis(request.budget_ms.clamp(100, 30000));
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(|e| e.to_string())?;
    let payload = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    context.with(|ctx| -> Result<(), String> {
        ctx.globals()
            .set("__now", Func::from(crate::store::now))
            .map_err(|e| e.to_string())?;
        ctx.globals()
            .set("__uuid", Func::from(crate::random_uuid))
            .map_err(|e| e.to_string())?;
        ctx.globals()
            .set(
                "__http",
                Func::from(|input: String| -> String {
                    let response = (|| -> Result<String, String> {
                        let input: Value =
                            serde_json::from_str(&input).map_err(|_| "Invalid HTTP input")?;
                        let frame =
                            serde_json::json!({"http":true,"input":input}).to_string() + "\n";
                        std::io::stdout()
                            .write_all(frame.as_bytes())
                            .map_err(|e| e.to_string())?;
                        std::io::stdout().flush().map_err(|e| e.to_string())?;
                        let mut line = String::new();
                        std::io::stdin()
                            .read_line(&mut line)
                            .map_err(|e| e.to_string())?;
                        if line.len() > MAX_BYTES {
                            return Err("HTTP response exceeds limit".into());
                        }
                        let value: Value =
                            serde_json::from_str(&line).map_err(|_| "Invalid HTTP response")?;
                        if let Some(error) = value.get("error").and_then(Value::as_str) {
                            return Ok(serde_json::json!({"__bridgeError":error}).to_string());
                        }
                        Ok(value["result"].to_string())
                    })();
                    response.unwrap_or_else(|e| serde_json::json!({"__bridgeError":e}).to_string())
                }),
            )
            .map_err(|e| e.to_string())?;
        ctx.eval::<(), _>(format!("globalThis.__request = {payload};"))
            .map_err(|e| e.to_string())?;
        ctx.eval::<(), _>(include_str!("worker.js")).map_err(|e| {
            let exception = ctx.catch();
            format!("Backend failed: {e}: {exception:?}")
        })
    })?;
    while runtime.is_job_pending() {
        if Instant::now() >= deadline {
            return Err("Backend execution timed out".into());
        }
        runtime
            .execute_pending_job()
            .map_err(|_| "Backend promise failed")?;
    }
    let encoded = context
        .with(|ctx| ctx.globals().get::<_, String>("__response"))
        .map_err(|_| "Backend did not finish")?;
    if encoded.len() > MAX_BYTES {
        return Err("Backend output is too large".into());
    }
    let value: Value = serde_json::from_str(&encoded).map_err(|e| e.to_string())?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(error.into());
    }
    let output: Output = serde_json::from_value(value).map_err(|e| e.to_string())?;
    if output.records.len() > 2000
        || output
            .records
            .keys()
            .any(|key| key.is_empty() || key.chars().count() > 200)
    {
        return Err("Invalid backend records".into());
    }
    Ok(output)
}

pub fn worker() -> Result<(), String> {
    // Limit the entire worker on Linux in addition to QuickJS's allocator budget.
    #[cfg(target_os = "linux")]
    unsafe {
        let limit = libc::rlimit {
            rlim_cur: 96 * 1024 * 1024,
            rlim_max: 96 * 1024 * 1024,
        };
        if libc::setrlimit(libc::RLIMIT_AS, &limit) != 0 {
            return Err("Cannot set worker memory limit".into());
        }
    }
    let mut input = String::new();
    std::io::stdin()
        .read_line(&mut input)
        .map_err(|e| e.to_string())?;
    if input.len() > MAX_BYTES {
        return Err("Backend input is too large".into());
    }
    let request: Request = serde_json::from_str(&input).map_err(|e| e.to_string())?;
    let output = match execute(request) {
        Ok(output) => serde_json::to_vec(&output),
        Err(error) => serde_json::to_vec(&serde_json::json!({ "error": error })),
    }
    .map_err(|e| e.to_string())?;
    std::io::stdout()
        .write_all(&output)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(source: &str, action: &str, input: Value) -> Request {
        Request {
            source: source.into(),
            mode: "call".into(),
            budget_ms: 2000,
            action: action.into(),
            input,
            records: BTreeMap::new(),
            now: "2026-10-07T00:00:00Z".into(),
        }
    }
    #[test]
    fn journal_persists_and_rejects_blank_text() {
        let source = include_str!("journal.js");
        let output = execute(request(
            source,
            "add",
            serde_json::json!({"text":" An idea "}),
        ))
        .unwrap();
        assert_eq!(output.records.values().next().unwrap()["text"], "An idea");
        assert!(execute(request(source, "add", serde_json::json!({"text":" "}))).is_err());
    }
    #[test]
    fn read_only_actions_cannot_write() {
        assert!(execute(request(
            "const actions={list:{readOnly:true,run:(_,c)=>c.db.set('a',1)}}",
            "list",
            Value::Null
        ))
        .is_err());
    }
    #[test]
    fn async_actions_work() {
        let out = execute(request(
            "const actions={list:{readOnly:true,run:async()=>42}}",
            "list",
            Value::Null,
        ))
        .unwrap();
        assert_eq!(out.result, 42);
    }
    #[test]
    fn ids_are_unique_within_an_action() {
        let out = execute(request(
            "const actions={list:{run:(_,c)=>[c.uuid(),c.uuid()]}}",
            "list",
            Value::Null,
        ))
        .unwrap();
        assert_ne!(out.result[0], out.result[1]);
    }
    #[test]
    fn no_node_or_browser_capabilities() {
        let out = execute(request("const actions={list:{run:()=>[typeof process,typeof require,typeof fetch,typeof document]}}", "list", Value::Null)).unwrap();
        assert_eq!(
            out.result,
            serde_json::json!(["undefined", "undefined", "undefined", "undefined"])
        );
    }
    #[test]
    fn infinite_loop_is_interrupted() {
        assert!(execute(request(
            "const actions={list:{run:()=>{while(true){}}}}",
            "list",
            Value::Null
        ))
        .is_err());
    }
    #[test]
    fn allocation_is_bounded() {
        assert!(execute(request(
            "const actions={list:{run:()=>new Array(10000000).fill('x')}}",
            "list",
            Value::Null
        ))
        .is_err());
    }
}
