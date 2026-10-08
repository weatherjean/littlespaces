//! Synthetic Responses transport experiment. No real credentials or sign-in implementation.
use crate::{engine::Runtime, store::Result};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    sync::{atomic::AtomicBool, Arc},
    time::Duration,
};

pub async fn run(runtime: Runtime, endpoint: &str, message: &str) -> Result<Value> {
    let url = url::Url::parse(endpoint).map_err(|e| e.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
        return Err("Synthetic provider must be loopback HTTP".into());
    }
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;
    let mut input = vec![json!({"role":"user","content":message})];
    let mut calls = HashSet::new();
    let mut transcript = Vec::new();
    for _ in 0..4 {
        let body = json!({"model":"synthetic","store":false,"stream":true,"input":input,
            "tools":[{"type":"namespace","name":"little_spaces","tools":[{"type":"function","name":"invoke","description":"Invoke a scoped prototype action","parameters":{"type":"object","properties":{"app":{"type":"string"},"action":{"type":"string"},"input":{"type":"object"}},"required":["app","action","input"],"additionalProperties":false}}]}]});
        let response = client
            .post(endpoint)
            .bearer_auth("synthetic-prototype-token")
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("Provider HTTP {}", response.status()));
        }
        let mut bytes = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| e.to_string())?;
            if bytes.len() + chunk.len() > 64 * 1024 {
                return Err("Provider stream budget exceeded".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
        let mut completed = false;
        let mut tool_calls = Vec::new();
        let mut answer = String::new();
        for line in text.lines() {
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let event: Value = serde_json::from_str(data).map_err(|e| e.to_string())?;
            match event["type"].as_str().unwrap_or("") {
                "response.output_item.done" if event["item"]["type"] == "function_call" => {
                    tool_calls.push(event["item"].clone())
                }
                "response.output_text.delta" => {
                    answer.push_str(event["delta"].as_str().ok_or("Invalid text delta")?)
                }
                "response.completed" => {
                    if event["response"]["status"] != "completed" {
                        return Err("Provider did not complete".into());
                    }
                    completed = true;
                }
                "response.failed" | "response.incomplete" => {
                    return Err("Provider failed or was incomplete".into())
                }
                _ => {}
            }
        }
        if !completed {
            return Err("Provider stream ended without completion".into());
        }
        if tool_calls.is_empty() {
            return Ok(json!({"answer":answer,"tools":transcript,"synthetic":true}));
        }
        for call in tool_calls {
            if call["name"] != "invoke" || call["namespace"] != "little_spaces" {
                return Err("Unknown model tool".into());
            }
            let id = call["call_id"]
                .as_str()
                .ok_or("Missing call ID")?
                .to_string();
            if !calls.insert(id.clone()) || calls.len() > 8 {
                return Err("Duplicate call ID or tool budget exceeded".into());
            }
            let args: Value =
                serde_json::from_str(call["arguments"].as_str().ok_or("Missing arguments")?)
                    .map_err(|e| e.to_string())?;
            let app = args["app"].as_str().ok_or("Missing app")?.to_string();
            let action = args["action"].as_str().ok_or("Missing action")?.to_string();
            let runtime = runtime.clone();
            let payload = args["input"].clone();
            let version = runtime.store.snapshot(&app)?.version;
            let result = tokio::task::spawn_blocking(move || {
                runtime.invoke(
                    &app,
                    &action,
                    payload,
                    version,
                    true,
                    Arc::new(AtomicBool::new(false)),
                )
            })
            .await
            .map_err(|e| e.to_string())??;
            transcript.push(json!({"callId":id,"result":result}));
            input.push(call);
            input.push(
                json!({"type":"function_call_output","call_id":id,"output":result.to_string()}),
            );
        }
    }
    Err("AI round-trip budget exceeded".into())
}
