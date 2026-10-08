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
    #[serde(default)]
    pub catalog: Vec<Value>,
    #[serde(default)]
    pub mock_http: Vec<Value>,
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
    #[serde(default)]
    pub records: BTreeMap<String, Value>,
    #[serde(default)]
    pub changes: BTreeMap<String, Value>,
    #[serde(default)]
    pub removals: Vec<String>,
    #[serde(default)]
    pub logs: Vec<Value>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub stack: Option<String>,
}

pub fn execute(request: Request) -> Result<Output, String> {
    if request.source.len() > 1_000_000 {
        return Err("Backend source is too large".into());
    }
    let debug = request.mode == "debug";
    let runtime = Runtime::new().map_err(|e| e.to_string())?;
    runtime.set_memory_limit(32 * 1024 * 1024);
    runtime.set_max_stack_size(256 * 1024);
    let deadline = Instant::now() + Duration::from_millis(request.budget_ms.clamp(100, 30000));
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() >= deadline)));
    let context = Context::full(&runtime).map_err(|e| e.to_string())?;
    let payload = serde_json::to_string(&request).map_err(|e| e.to_string())?;
    context.with(|ctx| -> Result<(), String> {
        ctx.globals()
            .set(
                "__checkHttp",
                Func::from(|policy: String, input: String| -> String {
                    let result = (|| -> Result<(), String> {
                        let policy =
                            serde_json::from_str(&policy).map_err(|_| "Invalid HTTP policy")?;
                        let input =
                            serde_json::from_str(&input).map_err(|_| "Invalid HTTP request")?;
                        crate::capabilities::check(&policy, &input)
                    })();
                    result.err().unwrap_or_default()
                }),
            )
            .map_err(|e| e.to_string())?;
        ctx.globals()
            .set(
                "__validate",
                Func::from(|schema: String, value: String| -> String {
                    let result = (|| -> Result<(), String> {
                        let schema: Value =
                            serde_json::from_str(&schema).map_err(|e| e.to_string())?;
                        let value: Value =
                            serde_json::from_str(&value).map_err(|e| e.to_string())?;
                        jsonschema::validator_for(&schema)
                            .map_err(|e| e.to_string())?
                            .validate(&value)
                            .map_err(|e| e.to_string())
                    })();
                    result.err().unwrap_or_default()
                }),
            )
            .map_err(|e| e.to_string())?;
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
                        use std::io::{BufRead, Read};
                        std::io::stdin()
                            .lock()
                            .take((MAX_BYTES + 1) as u64)
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
    if let Some(error) = value
        .get("error")
        .and_then(Value::as_str)
        .filter(|_| !debug)
    {
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
    use std::io::{BufRead, Read};
    std::io::stdin()
        .lock()
        .take((MAX_BYTES + 1) as u64)
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
            catalog: vec![],
            mock_http: vec![],
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
        assert_eq!(output.changes.values().next().unwrap()["text"], "An idea");
        assert!(execute(request(source, "add", serde_json::json!({"text":" "}))).is_err());
    }
    #[test]
    fn read_only_actions_cannot_write() {
        assert!(execute(request(
            "const actions={list:{readOnly:true,run:(_,c)=>c.db.set('a',1)}}",
            "list",
            serde_json::json!({})
        ))
        .is_err());
    }
    #[test]
    fn async_actions_work() {
        let out = execute(request(
            "const actions={list:{readOnly:true,run:async()=>42}}",
            "list",
            serde_json::json!({}),
        ))
        .unwrap();
        assert_eq!(out.result, 42);
    }
    #[test]
    fn boolean_input_schemas_are_not_replaced_with_defaults() {
        assert!(execute(request(
            "const actions={read:{parameters:false,run:()=>42}}",
            "read",
            serde_json::json!({})
        ))
        .unwrap_err()
        .contains("Invalid action input"));
        assert_eq!(
            execute(request(
                "const actions={read:{parameters:true,run:input=>input}}",
                "read",
                serde_json::json!(42)
            ))
            .unwrap()
            .result,
            serde_json::json!(42)
        );
    }
    #[test]
    fn ids_are_unique_within_an_action() {
        let out = execute(request(
            "const actions={list:{run:(_,c)=>[c.uuid(),c.uuid()]}}",
            "list",
            serde_json::json!({}),
        ))
        .unwrap();
        assert_ne!(out.result[0], out.result[1]);
    }
    #[test]
    fn no_node_or_browser_capabilities() {
        let out = execute(request("const actions={list:{run:()=>[typeof process,typeof require,typeof fetch,typeof document]}}", "list", serde_json::json!({}))).unwrap();
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
            serde_json::json!({})
        ))
        .is_err());
    }
    #[test]
    fn allocation_is_bounded() {
        assert!(execute(request(
            "const actions={list:{run:()=>new Array(10000000).fill('x')}}",
            "list",
            serde_json::json!({})
        ))
        .is_err());
    }

    #[test]
    fn generated_tests_use_production_schemas_and_rollback_failed_calls() {
        let mut req = request(
            r#"
          const actions={add:{parameters:{type:'object',properties:{name:{type:'string',minLength:1}},required:['name'],additionalProperties:false},output:{type:'number'},run:(input,{db})=>{db.set('a',input);return 'wrong result';}}};
          const tests=[{name:'input and output validation',run:async({call,db,assert})=>{
            await assert.rejects(()=>call('add',{}));
            assert.deepEqual(db.list(),[]);
            await assert.rejects(()=>call('add',{name:'valid'}));
            assert.deepEqual(db.list(),[]);
            assert.deepEqual({a:1,b:2},{b:2,a:1});
          }}];
        "#,
            "",
            serde_json::json!({}),
        );
        req.mode = "test".into();
        let output = execute(req).unwrap();
        assert_eq!(output.report[0]["passed"], true);
    }

    #[test]
    fn read_only_write_is_rejected_even_when_caught() {
        let out = execute(request("const actions={list:{readOnly:true,run:(_,c)=>{try{c.db.set('a',1)}catch{}return c.db.get('a')}}}","list",serde_json::json!({}))).unwrap();
        assert_eq!(out.result, Value::Null);
        assert!(out.changes.is_empty());
    }

    #[test]
    fn delta_omits_unchanged_records_and_tracks_removals() {
        let mut req = request("const actions={edit:{run:(_,c)=>{c.db.set('same',{n:1});c.db.set('changed',2);c.db.remove('deleted');return true}}}","edit",serde_json::json!({}));
        req.records = BTreeMap::from([
            ("same".into(), serde_json::json!({"n":1})),
            ("changed".into(), serde_json::json!(1)),
            ("deleted".into(), serde_json::json!(3)),
        ]);
        let out = execute(req).unwrap();
        assert!(out.records.is_empty());
        assert_eq!(
            out.changes,
            BTreeMap::from([("changed".into(), serde_json::json!(2))])
        );
        assert_eq!(out.removals, vec!["deleted"]);
    }

    #[test]
    fn debugging_uses_exact_http_mocks_and_preserves_bounded_logs_on_failure() {
        let mut req = request("const actions={load:{run:async(_,c)=>{console.info('started');return (await c.http.request({url:'https://api.example.com/items'})).data}}}","load",serde_json::json!({}));
        req.source = req.source.replace(
            "load:{run:",
            "load:{http:[{origin:'https://api.example.com',methods:['GET'],secrets:[]}],run:",
        );
        req.mode = "debug".into();
        let out = execute(req).unwrap();
        assert!(out.error.unwrap().contains("No HTTP mock"));
        assert_eq!(out.logs[0]["message"], "started");
        let mut req = request("const actions={load:{run:async(_,c)=>{for(let i=0;i<100;i++)console.log('x'.repeat(10000));return (await c.http.request({url:'https://api.example.com/items'})).data}}}","load",serde_json::json!({}));
        req.source = req.source.replace(
            "load:{run:",
            "load:{http:[{origin:'https://api.example.com',methods:['GET'],secrets:[]}],run:",
        );
        req.mode = "debug".into();
        req.mock_http = vec![
            serde_json::json!({"url":"https://api.example.com/items","response":{"status":200,"ok":true,"data":[1,2]}}),
        ];
        let out = execute(req).unwrap();
        assert!(out.error.is_none());
        assert_eq!(out.result, serde_json::json!([1, 2]));
        assert_eq!(out.logs.len(), 20);
        assert!(out
            .logs
            .iter()
            .all(|v| v["message"].as_str().unwrap().len() <= 800));
    }
}
