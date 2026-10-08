use crate::store::{validate_records, Result, Snapshot, Store};
use rhai::{Array, Dynamic, Engine, EvalAltResult, ImmutableString, Scope};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    io::Read,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Serialize)]
pub struct Action {
    pub name: String,
    pub read_only: bool,
    pub http: Vec<String>,
    pub input: Value,
    pub output: Value,
}
pub struct AppSpec {
    pub source: &'static str,
    pub actions: Vec<Action>,
}
impl AppSpec {
    pub fn hash(&self) -> String {
        let mut hash = Sha256::new();
        hash.update(self.source);
        hash.update(serde_json::to_vec(&self.actions).unwrap());
        format!("{:x}", hash.finalize())
    }
}
pub fn spec(app: &str) -> Result<AppSpec> {
    let object = |properties: Value, required: Vec<&str>| json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    let action = |name: &str, read_only, input: Value, output: Value| Action {
        name: name.into(),
        read_only,
        http: vec![],
        input,
        output,
    };
    let empty = object(json!({}), vec![]);
    let entry = json!({"type":"object","required":["key","value"]});
    let list = json!({"type":"array"});
    match app {
        "tasks" => Ok(AppSpec {
            source: include_str!("../actions/tasks.rhai"),
            actions: vec![
                action(
                    "add",
                    false,
                    object(
                        json!({"title":{"type":"string","minLength":1,"maxLength":100}}),
                        vec!["title"],
                    ),
                    entry,
                ),
                action(
                    "complete",
                    false,
                    object(
                        json!({"key":{"type":"string","minLength":1,"maxLength":64}}),
                        vec!["key"],
                    ),
                    json!({"type":"object","required":["title","done"]}),
                ),
                action("list", true, empty, list),
            ],
        }),
        "journal" => Ok(AppSpec {
            source: include_str!("../actions/journal.rhai"),
            actions: vec![
                action(
                    "add",
                    false,
                    object(
                        json!({"text":{"type":"string","minLength":1,"maxLength":1000}}),
                        vec!["text"],
                    ),
                    entry,
                ),
                action("list", true, empty, list),
            ],
        }),
        "weather" => {
            let mut weather = action(
                "weather",
                true,
                empty,
                json!({"type":"object","properties":{"temperatureC":{"type":"number"},"observedAt":{"type":"string"}},"required":["temperatureC","observedAt"],"additionalProperties":false}),
            );
            weather.http.push("weather".into());
            Ok(AppSpec {
                source: include_str!("../actions/weather.rhai"),
                actions: vec![weather],
            })
        }
        _ => Err("Unknown prototype app".into()),
    }
}
#[derive(Clone)]
pub struct Limits {
    pub operations: u64,
    pub deadline: Duration,
    pub data_size: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            operations: 30_000,
            deadline: Duration::from_millis(100),
            data_size: 16 * 1024,
        }
    }
}
#[derive(Clone)]
pub struct Runtime {
    pub store: Store,
    pub weather_url: Option<String>,
    pub limits: Limits,
}
#[derive(Serialize)]
pub struct Execution {
    pub result: Value,
    pub records: BTreeMap<String, Value>,
    pub elapsed_us: u128,
}
struct Session {
    records: BTreeMap<String, Value>,
    read_only: bool,
    http_calls: usize,
}
fn failure(message: impl Into<String>) -> Box<EvalAltResult> {
    message.into().into()
}
fn dynamic(value: &Value) -> std::result::Result<Dynamic, Box<EvalAltResult>> {
    rhai::serde::to_dynamic(value).map_err(|e| failure(e.to_string()))
}
fn schema(schema: &Value, value: &Value) -> Result<()> {
    jsonschema::validator_for(schema)
        .map_err(|e| e.to_string())?
        .validate(value)
        .map_err(|e| e.to_string())
}
impl Runtime {
    pub fn new(store: Store, weather_url: Option<String>) -> Result<Self> {
        if let Some(url) = &weather_url {
            let url = url::Url::parse(url).map_err(|e| e.to_string())?;
            if url.scheme() != "http"
                || url.host_str() != Some("127.0.0.1")
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("Prototype HTTP fixture must be IPv4 loopback HTTP".into());
            }
        }
        for app in ["tasks", "journal", "weather"] {
            store.seed(app, &spec(app)?.hash())?;
        }
        Ok(Self {
            store,
            weather_url,
            limits: Limits::default(),
        })
    }
    pub fn invoke(
        &self,
        app: &str,
        action: &str,
        input: Value,
        expected: i64,
        commit: bool,
        cancel: Arc<AtomicBool>,
    ) -> Result<Value> {
        let spec = spec(app)?;
        let action = spec
            .actions
            .iter()
            .find(|a| a.name == action)
            .ok_or("Unknown action")?;
        let before = self.store.snapshot(app)?;
        if before.version != expected || before.hash != spec.hash() {
            return Err("Stale or unbound revision".into());
        }
        let execution = self.evaluate(&before, spec.source, action, input, cancel)?;
        let changed = if commit && !action.read_only {
            self.store.commit(&before, &execution.records)?
        } else {
            0
        };
        Ok(
            json!({"result":execution.result,"changed":changed,"committed":commit&&!action.read_only,"elapsedUs":execution.elapsed_us}),
        )
    }
    // Public for laboratory fault tests. Production invocation uses only the bound fixture source.
    pub fn evaluate(
        &self,
        before: &Snapshot,
        source: &str,
        action: &Action,
        input: Value,
        cancel: Arc<AtomicBool>,
    ) -> Result<Execution> {
        if source.len() > 32 * 1024 || input.to_string().len() > 32 * 1024 {
            return Err("Source or input budget exceeded".into());
        }
        schema(&action.input, &input)?;
        let started = Instant::now();
        let session = Rc::new(RefCell::new(Session {
            records: before.records.clone(),
            read_only: action.read_only,
            http_calls: 0,
        }));
        let mut engine = Engine::new();
        engine.set_optimization_level(rhai::OptimizationLevel::None);
        engine.set_max_operations(self.limits.operations);
        engine.set_max_call_levels(16);
        engine.set_max_expr_depths(32, 32);
        engine.set_max_string_size(self.limits.data_size);
        engine.set_max_array_size(512);
        engine.set_max_map_size(512);
        engine.set_max_variables(32);
        engine.set_max_functions(16);
        for symbol in ["eval", "print", "debug", "import", "export"] {
            engine.disable_symbol(symbol);
        }
        let deadline = self.limits.deadline;
        let progress_cancel = cancel.clone();
        engine.on_progress(move |_| {
            if progress_cancel.load(Ordering::Relaxed) || started.elapsed() > deadline {
                Some(Dynamic::from("cancelled or deadline exceeded"))
            } else {
                None
            }
        });
        let ctx = session.clone();
        engine.register_fn(
            "db_get",
            move |key: &str| -> std::result::Result<Dynamic, Box<EvalAltResult>> {
                dynamic(ctx.borrow().records.get(key).unwrap_or(&Value::Null))
            },
        );
        let ctx = session.clone();
        engine.register_fn(
            "db_list",
            move || -> std::result::Result<Dynamic, Box<EvalAltResult>> {
                let values: Vec<_> = ctx
                    .borrow()
                    .records
                    .iter()
                    .map(|(key, value)| json!({"key":key,"value":value}))
                    .collect();
                dynamic(&json!(values))
            },
        );
        let ctx = session.clone();
        engine.register_fn(
            "db_set",
            move |key: &str, value: Dynamic| -> std::result::Result<(), Box<EvalAltResult>> {
                let mut state = ctx.borrow_mut();
                if state.read_only {
                    return Err(failure("Read-only action attempted a write"));
                }
                let value: Value =
                    rhai::serde::from_dynamic(&value).map_err(|e| failure(e.to_string()))?;
                let mut candidate = state.records.clone();
                candidate.insert(key.into(), value);
                validate_records(&candidate).map_err(failure)?;
                state.records = candidate;
                Ok(())
            },
        );
        let ctx = session.clone();
        engine.register_fn(
            "db_remove",
            move |key: &str| -> std::result::Result<bool, Box<EvalAltResult>> {
                let mut state = ctx.borrow_mut();
                if state.read_only {
                    return Err(failure("Read-only action attempted a write"));
                }
                Ok(state.records.remove(key).is_some())
            },
        );
        engine.register_fn("clean", |value: &str| -> ImmutableString {
            value.trim().into()
        });
        engine.register_fn("uuid", || -> ImmutableString {
            format!("{:032x}", rand::random::<u128>()).into()
        });
        engine.register_fn("now_ms", || -> i64 {
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as i64
        });
        engine.register_fn(
            "newest_first",
            |values: Array| -> std::result::Result<Dynamic, Box<EvalAltResult>> {
                let mut values: Vec<Value> =
                    rhai::serde::from_dynamic(&Dynamic::from_array(values))
                        .map_err(|e| failure(e.to_string()))?;
                if values
                    .iter()
                    .any(|value| value["value"]["createdAt"].as_i64().is_none())
                {
                    return Err(failure("Expected journal entries"));
                }
                values.sort_by_key(|value| {
                    std::cmp::Reverse(value["value"]["createdAt"].as_i64().unwrap())
                });
                dynamic(&json!(values))
            },
        );
        let store = self.store.clone();
        let app = before.app.clone();
        let declarations = action.http.clone();
        let url = self.weather_url.clone();
        let ctx = session.clone();
        engine.register_fn(
            "http_read",
            move |resource: &str| -> std::result::Result<Dynamic, Box<EvalAltResult>> {
                if resource != "weather"
                    || !declarations.iter().any(|item| item == resource)
                    || !store.allowed(&app, resource).map_err(failure)?
                {
                    return Err(failure("HTTP capability denied"));
                }
                let mut state = ctx.borrow_mut();
                state.http_calls += 1;
                if state.http_calls > 2 {
                    return Err(failure("HTTP request budget exceeded"));
                }
                drop(state);
                let url = url
                    .as_ref()
                    .ok_or_else(|| failure("No weather fixture configured"))?;
                let client = reqwest::blocking::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_millis(500))
                    .build()
                    .map_err(|e| failure(e.to_string()))?;
                let response = client
                    .get(url)
                    .send()
                    .map_err(|_| failure("HTTP fixture failed or timed out"))?;
                if !response.status().is_success() {
                    return Err(failure("HTTP fixture rejected request"));
                }
                let mut bytes = Vec::new();
                response
                    .take(64 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| failure("HTTP body failed"))?;
                if bytes.len() > 64 * 1024 {
                    return Err(failure("HTTP response budget exceeded"));
                }
                let value: Value =
                    serde_json::from_slice(&bytes).map_err(|_| failure("Invalid fixture JSON"))?;
                dynamic(&value)
            },
        );
        let ast = engine.compile(source).map_err(|e| e.to_string())?;
        let input = dynamic(&input).map_err(|e| e.to_string())?;
        let value: Dynamic = engine
            .call_fn(&mut Scope::new(), &ast, &action.name, (input,))
            .map_err(|e| e.to_string())?;
        let result: Value = rhai::serde::from_dynamic(&value).map_err(|e| e.to_string())?;
        if result.to_string().len() > 64 * 1024 {
            return Err("Output budget exceeded".into());
        }
        schema(&action.output, &result)?;
        if cancel.load(Ordering::Relaxed) || started.elapsed() > self.limits.deadline {
            return Err("Cancelled or deadline exceeded after host function".into());
        }
        let records = session.borrow().records.clone();
        if action.read_only && records != before.records {
            return Err("Read-only snapshot changed".into());
        }
        Ok(Execution {
            result,
            records,
            elapsed_us: started.elapsed().as_micros(),
        })
    }
}
