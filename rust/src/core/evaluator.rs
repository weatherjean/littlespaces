//! Capability-free evaluator. Production invokes this only in a disposable worker process.
use super::{
    control::Control,
    http::HttpRequest,
    store::{validate_records, Records},
    *,
};
use rhai::{Dynamic, Engine, EvalAltResult, Scope};
use serde_json::{json, Value};
#[cfg(any(test, feature = "development-fixtures"))]
use std::time::Duration;
use std::{
    cell::RefCell,
    rc::Rc,
    time::{SystemTime, UNIX_EPOCH},
};
pub(crate) trait EvaluationHost {
    fn request(&self, request: HttpRequest) -> Result<Value>;
    fn diagnostic(&self, phase: &str, details: Value) -> Error;
    fn redact(&self, value: Value) -> Result<Value>;
}
struct Session {
    records: Records,
    sqlite: Option<app_sqlite::Database>,
    error: Option<Error>,
    http_calls: usize,
    notifications: Vec<notifications::Change>,
}
#[allow(clippy::too_many_arguments)]
pub(crate) fn evaluate(
    revision: &Revision,
    action: &ActionContract,
    input: Value,
    records: &Records,
    sqlite: &[u8],
    host: Rc<dyn EvaluationHost>,
    force_readonly: bool,
    control: &Control,
) -> Result<(Value, Records, Vec<u8>, Vec<notifications::Change>)> {
    control.check()?;
    validate_json(&action.input, &input)
        .map_err(|_| host.diagnostic("input", json!({"schema":action.input,"input":input})))?;
    let readonly = action.read_only || force_readonly;
    let session = Rc::new(RefCell::new(Session {
        records: records.clone(),
        sqlite: if revision.code.sqlite {
            Some(app_sqlite::Database::open(
                sqlite,
                readonly,
                control.clone(),
            )?)
        } else {
            None
        },
        error: None,
        http_calls: 0,
        notifications: Vec::new(),
    }));
    let mut engine = Engine::new();
    engine.set_optimization_level(rhai::OptimizationLevel::None);
    engine.set_max_operations(30000);
    engine.set_max_call_levels(16);
    engine.set_max_expr_depths(32, 32);
    engine.set_max_string_size(16384);
    engine.set_max_array_size(512);
    engine.set_max_map_size(512);
    engine.set_max_variables(32);
    engine.set_max_functions(16);
    for symbol in ["eval", "print", "debug", "import", "export"] {
        engine.disable_symbol(symbol);
    }
    let progress = control.clone();
    engine.on_progress(move |_| progress.check().err().map(|e| Dynamic::from(e.to_string())));
    #[cfg(any(test, feature = "development-fixtures"))]
    engine.register_fn("test_pause", |ms: i64| {
        std::thread::sleep(Duration::from_millis(ms.clamp(0, 10000) as u64));
    });
    #[cfg(feature = "development-fixtures")]
    engine.register_fn("test_allocate", || {
        // Deterministic worker-budget probe. Never present in ordinary/release builds.
        let bytes = vec![0_u8; 256 * 1024 * 1024];
        std::hint::black_box(bytes);
    });
    for (name, query) in [("sql_query", true), ("sql_execute", false)] {
        let ctx = session.clone();
        engine.register_fn(
            name,
            move |sql: &str, params: Dynamic| -> std::result::Result<Dynamic, Box<EvalAltResult>> {
                let result = (|| {
                    if readonly && !query {
                        return Err(Error::ReadOnly);
                    }
                    let params: Value =
                        rhai::serde::from_dynamic(&params).map_err(|_| Error::Validation)?;
                    let state = ctx.borrow();
                    let db = state.sqlite.as_ref().ok_or(Error::Validation)?;
                    db.run(sql, &params, query)
                })();
                match result {
                    Ok(value) => dynamic(&value),
                    Err(error) => {
                        ctx.borrow_mut().error = Some(error);
                        Err(failure(error))
                    }
                }
            },
        );
    }
    let ctx = session.clone();
    engine.register_fn("db_get", move |key: &str| {
        dynamic(ctx.borrow().records.get(key).unwrap_or(&Value::Null))
    });
    let ctx = session.clone();
    engine.register_fn("db_list", move || {
        let values: Vec<_> = ctx
            .borrow()
            .records
            .iter()
            .map(|(key, value)| json!({"key":key,"value":value}))
            .collect();
        dynamic(&json!(values))
    });
    let ctx = session.clone();
    let c = control.clone();
    engine.register_fn(
        "db_set",
        move |key: &str, value: Dynamic| -> std::result::Result<(), Box<EvalAltResult>> {
            let result = (|| {
                c.check()?;
                if readonly {
                    return Err(Error::ReadOnly);
                }
                let value: Value =
                    rhai::serde::from_dynamic(&value).map_err(|_| Error::Validation)?;
                let mut state = ctx.borrow_mut();
                let mut candidate = state.records.clone();
                candidate.insert(key.into(), value);
                validate_records(&candidate)?;
                state.records = candidate;
                Ok(())
            })();
            if let Err(error) = result {
                ctx.borrow_mut().error = Some(error);
            }
            result.map_err(failure)
        },
    );
    let ctx = session.clone();
    let c = control.clone();
    engine.register_fn(
        "db_remove",
        move |key: &str| -> std::result::Result<bool, Box<EvalAltResult>> {
            let result = (|| {
                c.check()?;
                if readonly {
                    return Err(Error::ReadOnly);
                }
                Ok(ctx.borrow_mut().records.remove(key).is_some())
            })();
            if let Err(error) = result {
                ctx.borrow_mut().error = Some(error);
            }
            result.map_err(failure)
        },
    );
    let ctx = session.clone();
    engine.register_fn(
        "notify",
        move |value: Dynamic| -> std::result::Result<(), Box<EvalAltResult>> {
            let result = (|| {
                if readonly {
                    return Err(Error::ReadOnly);
                }
                let notice: notifications::Notice =
                    rhai::serde::from_dynamic(&value).map_err(|_| Error::Validation)?;
                notice.due()?;
                let mut state = ctx.borrow_mut();
                if state.notifications.len() >= 32 {
                    return Err(Error::Limit);
                }
                state.notifications.push(notifications::Change::Put(notice));
                Ok(())
            })();
            if let Err(error) = result {
                ctx.borrow_mut().error = Some(error);
            }
            result.map_err(failure)
        },
    );
    let ctx = session.clone();
    engine.register_fn(
        "cancel_notification",
        move |key: &str| -> std::result::Result<(), Box<EvalAltResult>> {
            let result = (|| {
                if readonly {
                    return Err(Error::ReadOnly);
                }
                let mut state = ctx.borrow_mut();
                if state.notifications.len() >= 32 {
                    return Err(Error::Limit);
                }
                state
                    .notifications
                    .push(notifications::Change::Remove(key.into()));
                Ok(())
            })();
            if let Err(error) = result {
                ctx.borrow_mut().error = Some(error);
            }
            result.map_err(failure)
        },
    );
    engine.register_fn("uuid", || format!("{:032x}", rand::random::<u128>()));
    engine.register_fn("now_ms", || {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
    });
    engine.register_fn(
        "json_parse",
        |s: &str| -> std::result::Result<Dynamic, Box<EvalAltResult>> {
            if s.len() > 16384 {
                return Err(failure(Error::Limit));
            }
            dynamic(&serde_json::from_str(s).map_err(|_| failure(Error::Validation))?)
        },
    );
    engine.register_fn(
        "json_stringify",
        |v: Dynamic| -> std::result::Result<String, Box<EvalAltResult>> {
            let v: Value = rhai::serde::from_dynamic(&v).map_err(|_| failure(Error::Validation))?;
            let s = v.to_string();
            if s.len() > 16384 {
                return Err(failure(Error::Limit));
            }
            Ok(s)
        },
    );
    let ctx = session.clone();
    let http_host = host.clone();
    let c = control.clone();
    engine.register_fn(
        "http_request",
        move |request: Dynamic| -> std::result::Result<Dynamic, Box<EvalAltResult>> {
            let result = (|| {
                c.check()?;
                {
                    let mut state = ctx.borrow_mut();
                    state.http_calls += 1;
                    if state.http_calls > 2 {
                        return Err(Error::Limit);
                    }
                }
                let value: Value =
                    rhai::serde::from_dynamic(&request).map_err(|_| Error::Validation)?;
                let request: HttpRequest =
                    serde_json::from_value(value).map_err(|_| Error::Validation)?;
                let response = http_host.request(request)?;
                c.check()?;
                Ok(response)
            })();
            if let Err(error) = &result {
                ctx.borrow_mut().error = Some(*error);
            }
            dynamic(&result.map_err(failure)?)
        },
    );
    let ast = engine.compile(&revision.code.backend).map_err(|e| {
        host.diagnostic(
            "compile",
            json!({"message":e.to_string().chars().take(4096).collect::<String>()}),
        )
    })?;
    control.check()?;
    let input = dynamic(&input).map_err(|_| Error::Validation)?;
    let result = engine.call_fn::<Dynamic>(&mut Scope::new(), &ast, &action.name, (input,));
    control.check()?;
    if let Some(error) = session.borrow().error {
        if let Some(message) = session
            .borrow()
            .sqlite
            .as_ref()
            .and_then(|db| db.last_error())
        {
            host.diagnostic("sql", json!({"message":message}));
        }
        return Err(error);
    }
    let result = result.map_err(|e| {
        host.diagnostic(
            "script",
            json!({"message":e.to_string().chars().take(4096).collect::<String>()}),
        )
    })?;
    let result: Value = rhai::serde::from_dynamic(&result).map_err(|_| Error::Validation)?;
    // Secrets are never delivered to scripts; redact again at the tool/UI boundary.
    let result = host.redact(result)?;
    validate_json(&action.output, &result)
        .map_err(|_| host.diagnostic("output", json!({"schema":action.output,"actual":result})))?;
    let state = session.borrow();
    validate_records(&state.records)?;
    if readonly && state.records != *records {
        return Err(Error::ReadOnly);
    }
    let image = if readonly {
        sqlite.to_vec()
    } else {
        state
            .sqlite
            .as_ref()
            .map(|db| db.image())
            .transpose()?
            .unwrap_or_else(|| sqlite.to_vec())
    };
    Ok((
        result,
        state.records.clone(),
        image,
        state.notifications.clone(),
    ))
}
fn failure(error: Error) -> Box<EvalAltResult> {
    error.to_string().into()
}
fn dynamic(value: &Value) -> std::result::Result<Dynamic, Box<EvalAltResult>> {
    rhai::serde::to_dynamic(value).map_err(|_| failure(Error::Validation))
}
pub(crate) fn validate_json(schema: &Value, value: &Value) -> Result<()> {
    if value.to_string().len() > 65536 {
        return Err(Error::Limit);
    }
    jsonschema::validator_for(schema)
        .map_err(|_| Error::Validation)?
        .validate(value)
        .map_err(|_| Error::Validation)
}
