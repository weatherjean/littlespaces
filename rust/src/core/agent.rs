use super::{
    authoring::{AuthoringSession, AuthoringTool},
    chatgpt::ChatGpt,
    http::MockHttp,
    owner::now,
    *,
};
use futures_util::StreamExt;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};
#[derive(Clone)]
pub struct Agent {
    runtime: Runtime,
    chatgpt: ChatGpt,

    active: Arc<tokio::sync::Mutex<BTreeMap<String, Cancellation>>>,
    admission: Arc<tokio::sync::Semaphore>,
}
impl Agent {
    pub fn new(runtime: Runtime, chatgpt: ChatGpt, _origin: String) -> Self {
        Self {
            runtime,
            chatgpt,

            active: Arc::new(tokio::sync::Mutex::new(BTreeMap::new())),
            admission: Arc::new(tokio::sync::Semaphore::new(2)),
        }
    }
    pub async fn recover(&self) -> Result<()> {
        self.runtime
            .store
            .blocking(|store| {
                let mut db = store.open()?;
                let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                tx.execute(
                    "UPDATE jobs SET state='interrupted' WHERE state IN ('running','queued')",
                    [],
                )?;
                tx.execute(
                    "UPDATE agent_calls SET state='interrupted' WHERE state='dispatching'",
                    [],
                )?;
                tx.execute(
                    "UPDATE invocations SET state='interrupted' WHERE state='running'",
                    [],
                )?;
                tx.commit()?;
                Ok(())
            })
            .await
    }
    pub async fn create_conversation(&self, app: Option<AppId>) -> Result<ConversationId> {
        self.runtime
            .store
            .blocking(move |store| {
                let id = ConversationId::new();
                store.open()?.execute(
                    "INSERT INTO conversations(id,app) VALUES(?,?)",
                    params![id.0, app.map(|a| a.0)],
                )?;
                Ok(id)
            })
            .await
    }
    pub async fn conversations(&self) -> Result<Value> {
        self.runtime.store.blocking(|store|{let db=store.open()?;let mut q=db.prepare("SELECT c.id,c.app,c.title,EXISTS(SELECT 1 FROM authoring_sessions a WHERE a.conversation=c.id),(SELECT id FROM jobs j WHERE j.conversation=c.id AND j.state='running' ORDER BY j.rowid DESC LIMIT 1) FROM conversations c ORDER BY c.rowid DESC LIMIT 100")?;let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"app":r.get::<_,Option<String>>(1)?,"title":r.get::<_,String>(2)?,"build":r.get::<_,bool>(3)?,"job":r.get::<_,Option<String>>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?;Ok(json!(rows))}).await
    }
    pub async fn history(&self, conversation: ConversationId) -> Result<Value> {
        self.runtime.store.blocking(move|store|{let db=store.open()?;let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM conversations WHERE id=?)",[&conversation.0],|r|r.get(0))?;if !exists{return Err(Error::NotFound);}let mut q=db.prepare("SELECT payload FROM messages WHERE conversation=? ORDER BY rowid DESC LIMIT 120")?;let rows=q.query_map([&conversation.0],|r|r.get::<_,String>(0))?.collect::<std::result::Result<Vec<_>,_>>()?;let values=rows.iter().rev().map(|s|serde_json::from_str(s).map_err(|_|Error::Storage)).collect::<Result<Vec<Value>>>()?;Ok(json!(values))}).await
    }
    async fn message(&self, conversation: &ConversationId, value: Value) -> Result<()> {
        let value = self.runtime.redact_public(value).await?;
        let conversation = conversation.clone();
        self.runtime
            .store
            .blocking(move |store| {
                store.open()?.execute(
                    "INSERT INTO messages VALUES(?,?,?)",
                    params![super::owner::token(), conversation.0, value.to_string()],
                )?;
                Ok(())
            })
            .await
    }
    pub async fn start(
        &self,
        conversation: ConversationId,
        message: String,
        model: String,
    ) -> Result<String> {
        if message.trim().is_empty()
            || message.len() > 32768
            || model.is_empty()
            || model.len() > 128
        {
            return Err(Error::Validation);
        }
        let message = self
            .runtime
            .redact_public(json!(message))
            .await?
            .as_str()
            .ok_or(Error::Validation)?
            .to_owned();
        let permit = self
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Saturated)?;
        let id = super::owner::token();
        let job = id.clone();
        let conv = conversation.clone();
        let payload = json!({"model":model,"text":"","startedAt":now()});
        self.runtime.store.blocking(move|store|{let mut db=store.open()?;let tx=db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let app:Option<String>=tx.query_row("SELECT app FROM conversations WHERE id=?",[&conv.0],|r|r.get(0)).optional()?.ok_or(Error::NotFound)?;
            let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM jobs WHERE conversation=? AND state IN ('running','queued'))",[&conv.0],|r|r.get(0))?;if active{return Err(Error::Conflict);}
            tx.execute("INSERT INTO jobs VALUES(?,?,?,'running',?)",params![job,app,conv.0,payload.to_string()])?;
            let title=message.lines().next().unwrap_or("").chars().take(80).collect::<String>();
            tx.execute("UPDATE conversations SET title=? WHERE id=? AND title='Conversation'",params![title,conv.0])?;
            tx.execute("INSERT INTO messages VALUES(?,?,?)",params![super::owner::token(),conv.0,json!({"role":"user","content":message}).to_string()])?;tx.commit()?;Ok(())
        }).await?;
        let cancel = Cancellation::default();
        self.active.lock().await.insert(id.clone(), cancel.clone());
        let agent = self.clone();
        let job = id.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let result = tokio::time::timeout(
                Duration::from_secs(600),
                agent.run_job(&job, &conversation, &model, cancel.clone()),
            )
            .await
            .unwrap_or(Err(Error::Deadline));
            if result == Err(Error::Deadline) {
                cancel.cancel();
            }
            let state = match result {
                Ok(()) => "completed",
                Err(Error::Cancelled) => "cancelled",
                Err(_) => "failed",
            };
            let id = job.clone();
            let error = result.err();
            let _ = agent
                .runtime
                .store
                .blocking(move |store| {
                    let db = store.open()?;
                    let raw: String =
                        db.query_row("SELECT payload FROM jobs WHERE id=?", [&id], |r| r.get(0))?;
                    let mut payload: Value =
                        serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
                    payload["error"] = json!(error);
                    db.execute(
                        "UPDATE jobs SET state=?,payload=? WHERE id=?",
                        params![state, payload.to_string(), id],
                    )?;
                    Ok(())
                })
                .await;
            agent.active.lock().await.remove(&job);
        });
        Ok(id)
    }
    pub async fn job(&self, id: String) -> Result<Value> {
        self.runtime.store.blocking(move|store|{let (state,payload):(String,String)=store.open()?.query_row("SELECT state,payload FROM jobs WHERE id=?",[&id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?.ok_or(Error::NotFound)?;Ok(json!({"id":id,"state":state,"payload":serde_json::from_str::<Value>(&payload).map_err(|_|Error::Storage)?}))}).await
    }
    pub async fn cancel_all(&self) {
        for cancel in self.active.lock().await.values() {
            cancel.cancel();
        }
    }
    pub async fn cancel(&self, id: &str) -> Result<()> {
        let active = self.active.lock().await;
        active.get(id).ok_or(Error::NotFound)?.cancel();
        Ok(())
    }
    async fn streamed_text(&self, id: &str, text: String) -> Result<()> {
        let text = self
            .runtime
            .redact_public(json!(text))
            .await?
            .as_str()
            .ok_or(Error::Validation)?
            .to_owned();
        let id = id.to_owned();
        self.runtime
            .store
            .blocking(move |store| {
                let db = store.open()?;
                let raw: String =
                    db.query_row("SELECT payload FROM jobs WHERE id=?", [&id], |r| r.get(0))?;
                let mut payload: Value = serde_json::from_str(&raw).map_err(|_| Error::Storage)?;
                payload["text"] = json!(text);
                db.execute(
                    "UPDATE jobs SET payload=? WHERE id=?",
                    params![payload.to_string(), id],
                )?;
                Ok(())
            })
            .await
    }
    async fn scope(&self, conversation: &ConversationId) -> Result<(Option<AppId>, bool)> {
        let id = conversation.clone();
        self.runtime.store.blocking(move|store|Ok(store.open()?.query_row("SELECT app,EXISTS(SELECT 1 FROM authoring_sessions WHERE conversation=?) FROM conversations WHERE id=?",params![id.0,id.0],|r|Ok((r.get::<_,Option<String>>(0)?.map(AppId),r.get(1)?)))?)).await
    }
    async fn run_job(
        &self,
        job: &str,
        conversation: &ConversationId,
        model: &str,
        cancel: Cancellation,
    ) -> Result<()> {
        let (app, build) = self.scope(conversation).await?;
        let mut input = self
            .history(conversation.clone())
            .await?
            .as_array()
            .ok_or(Error::Storage)?
            .iter()
            .filter(|m| m["role"] == "user" || m["role"] == "assistant")
            .cloned()
            .collect::<Vec<_>>();
        let instructions = if build {
            include_str!("agent-prompt.txt")
        } else {
            "You are LittleSpaces, the owner's personal workspace assistant. Use app_info to inspect the app's published actions before invoking them. Do not retry ambiguous external writes. No arbitrary host tools or plaintext secrets are available. Ask the owner to open an app's build conversation for code changes."
        };
        let mut seen = BTreeSet::new();
        let mut dispatched = 0;
        for _ in 0..32 {
            if cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            if serde_json::to_vec(&input).map_err(|_| Error::Limit)?.len() > 768 * 1024 {
                return Err(Error::Limit);
            }
            let tools = if build {
                vec![tool_definition(
                    "authoring",
                    "Read SDK, inspect/edit/test/dry-run/publish this conversation's app draft.",
                )]
            } else {
                vec![
                    tool_definition("app_info", "Read published app actions and contracts."),
                    tool_definition(
                        "invoke_action",
                        "Invoke a published app action using action and input fields.",
                    ),
                ]
            };
            let request = json!({"model":model,"instructions":instructions,"input":input,"tools":tools,"store":false,"stream":true,"parallel_tool_calls":false});
            let output = self.request(job, request, cancel.clone()).await?;
            input.extend(output.clone());
            let calls: Vec<_> = output
                .iter()
                .filter(|v| v["type"] == "function_call")
                .cloned()
                .collect();
            if calls.is_empty() {
                let text = output
                    .iter()
                    .filter(|v| v["type"] == "message")
                    .flat_map(|v| v["content"].as_array().into_iter().flatten())
                    .filter(|v| v["type"] == "output_text")
                    .filter_map(|v| v["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                self.message(conversation, json!({"role":"assistant","content":text}))
                    .await?;
                return Ok(());
            }
            if calls.len() > 8 {
                return Err(Error::Limit);
            }
            for call in calls {
                dispatched += 1;
                if dispatched > 64 {
                    return Err(Error::Limit);
                }
                let call_id = call["call_id"]
                    .as_str()
                    .filter(|s| s.len() < 256)
                    .ok_or(Error::Model)?
                    .to_owned();
                if !seen.insert(call_id.clone()) {
                    return Err(Error::DuplicateInvocation);
                }
                let args = call["arguments"]
                    .as_str()
                    .filter(|s| s.len() < 256 * 1024)
                    .ok_or(Error::Model)?;
                let args: Value = serde_json::from_str(args).map_err(|_| Error::Model)?;
                let job_id = job.to_owned();
                let cid = call_id.clone();
                let payload = call.clone();
                self.runtime
                    .store
                    .blocking(move |store| {
                        store.open()?.execute(
                            "INSERT INTO agent_calls VALUES(?,?,'dispatching',?)",
                            params![job_id, cid, payload.to_string()],
                        )?;
                        Ok(())
                    })
                    .await?;
                let result = self
                    .dispatch(
                        conversation,
                        app.as_ref(),
                        build,
                        call["name"].as_str().ok_or(Error::Model)?,
                        args,
                        cancel.clone(),
                    )
                    .await;
                let result = match result {
                    Ok(v) => json!({"ok":v}),
                    Err(e) => json!({"error":e,"retryAutomatically":false}),
                };
                let result = self.runtime.redact_public(result).await?;
                self.message(
                    conversation,
                    json!({"role":"tool","name":call["name"],"call_id":call_id,"result":result}),
                )
                .await?;
                let job_id = job.to_owned();
                let cid = call_id.clone();
                let payload = result.clone();
                self.runtime.store.blocking(move|store|{store.open()?.execute("UPDATE agent_calls SET state='completed',payload=? WHERE job=? AND call_id=?",params![payload.to_string(),job_id,cid])?;Ok(())}).await?;
                input.push(json!({"type":"function_call_output","call_id":call_id,"output":result.to_string()}));
            }
        }
        Err(Error::Limit)
    }
    async fn dispatch(
        &self,
        conversation: &ConversationId,
        app: Option<&AppId>,
        build: bool,
        name: &str,
        args: Value,
        cancel: Cancellation,
    ) -> Result<Value> {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled);
        }
        match name {
            "authoring" if build => {
                let runtime = self.runtime.clone();
                let id = conversation.clone();
                let session = self
                    .runtime
                    .store
                    .blocking(move |_| AuthoringSession::resume(runtime, id))
                    .await?;
                let tool: AuthoringTool =
                    serde_json::from_value(args).map_err(|_| Error::Validation)?;
                session.dispatch(tool, MockHttp::default(), cancel).await
            }
            "app_info" if !build => {
                let app = app.cloned().ok_or(Error::NotFound)?;
                self.runtime
                    .store
                    .blocking(move |store| {
                        let snapshot = store.snapshot(&app)?;
                        let id = snapshot.revision.ok_or(Error::NotFound)?;
                        let revision = store.revision(&app, &id)?;
                        Ok(json!({"app":app,"revision":id,"actions":revision.code.actions}))
                    })
                    .await
            }
            "invoke_action" if !build => {
                let app = app.cloned().ok_or(Error::NotFound)?;
                let a = app.clone();
                let id = self
                    .runtime
                    .store
                    .blocking(move |store| store.snapshot(&a)?.revision.ok_or(Error::NotFound))
                    .await?;
                let outcome = self
                    .runtime
                    .invoke(
                        Invocation {
                            id: InvocationId::new(),
                            app,
                            revision: id,
                            action: args["action"].as_str().ok_or(Error::Validation)?.into(),
                            input: args["input"].clone(),
                            mode: ExecutionMode::Commit,
                        },
                        MockHttp::default(),
                        cancel,
                    )
                    .await?;
                Ok(json!(outcome))
            }
            _ => Err(Error::Validation),
        }
    }
    async fn request(&self, job: &str, request: Value, cancel: Cancellation) -> Result<Vec<Value>> {
        #[cfg(feature = "development-fixtures")]
        let fixture = std::env::var("LITTLESPACES_TEST_PROVIDER").ok();
        #[cfg(not(feature = "development-fixtures"))]
        let fixture: Option<String> = None;
        let (endpoint, access) = if let Some(endpoint) = fixture {
            let url = url::Url::parse(&endpoint).map_err(|_| Error::Validation)?;
            if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") {
                return Err(Error::Validation);
            }
            (endpoint, None)
        } else {
            (
                "https://api.openai.com/v1/responses".to_string(),
                Some(self.chatgpt.access_token().await?),
            )
        };
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(180))
            .build()
            .map_err(|_| Error::Network)?;
        let mut outgoing = client.post(endpoint).json(&request);
        if let Some(access) = &access {
            outgoing = outgoing.bearer_auth(access.as_str());
        }
        let mut cancel_wait = Box::pin(async {
            while !cancel.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        let response = tokio::select! {_= &mut cancel_wait=>return Err(Error::Cancelled),r=outgoing.send()=>r.map_err(|_|Error::Network)?};
        if !response.status().is_success() {
            return Err(Error::Model);
        }
        let mut stream = response.bytes_stream();
        let mut parser = ResponseStream::default();
        let mut last = std::time::Instant::now();
        loop {
            let chunk = tokio::select! {_= &mut cancel_wait=>return Err(Error::Cancelled),chunk=tokio::time::timeout(Duration::from_secs(45),stream.next())=>chunk.map_err(|_|Error::Deadline)?};
            match chunk {
                Some(Ok(bytes)) => parser.feed(&bytes)?,
                Some(Err(_)) => return Err(Error::Network),
                None => break,
            }
            if last.elapsed() > Duration::from_millis(150) {
                self.streamed_text(job, parser.text.clone()).await?;
                last = std::time::Instant::now();
            }
        }
        self.streamed_text(job, parser.text.clone()).await?;
        parser.finish()
    }
}
fn tool_definition(name: &str, description: &str) -> Value {
    json!({"type":"function","name":name,"description":description,"parameters":{"type":"object","additionalProperties":true},"strict":false})
}
#[derive(Default)]
pub(crate) struct ResponseStream {
    buffer: Vec<u8>,
    total: usize,
    pub text: String,
    output: Option<Vec<Value>>,
    failed: bool,
}
impl ResponseStream {
    pub fn feed(&mut self, bytes: &[u8]) -> Result<()> {
        self.total += bytes.len();
        if self.total > 2 * 1024 * 1024 {
            return Err(Error::Limit);
        }
        self.buffer.extend_from_slice(bytes);
        if self.buffer.len() > 256 * 1024 {
            return Err(Error::Limit);
        }
        loop {
            let lf = self
                .buffer
                .windows(2)
                .position(|w| w == b"\n\n")
                .map(|n| (n, 2));
            let crlf = self
                .buffer
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|n| (n, 4));
            let Some((end, len)) = lf.into_iter().chain(crlf).min_by_key(|(n, _)| *n) else {
                break;
            };
            let event = self.buffer.drain(..end + len).collect::<Vec<_>>();
            let text = std::str::from_utf8(&event).map_err(|_| Error::Model)?;
            let data = text
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(str::trim)
                .collect::<Vec<_>>()
                .join("\n");
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let v: Value = serde_json::from_str(&data).map_err(|_| Error::Model)?;
            self.event(v)?;
        }
        Ok(())
    }
    fn event(&mut self, v: Value) -> Result<()> {
        match v["type"].as_str() {
            Some("response.output_text.delta") => {
                self.text.push_str(v["delta"].as_str().ok_or(Error::Model)?);
                if self.text.len() > 128 * 1024 {
                    return Err(Error::Limit);
                }
            }
            Some("response.completed") => {
                if self.output.is_some() || v["response"]["status"] != "completed" {
                    return Err(Error::Model);
                }
                self.output = Some(
                    v["response"]["output"]
                        .as_array()
                        .ok_or(Error::Model)?
                        .clone(),
                );
            }
            Some("response.failed") => {
                self.failed = true;
                return Err(match v["response"]["error"]["code"].as_str() {
                    Some("subscription_sharing_usage_limit_exceeded") => Error::UsageLimit,
                    Some("subscription_sharing_usage_unavailable") => Error::UsageUnavailable,
                    _ => Error::Model,
                });
            }
            Some("response.incomplete") => {
                self.failed = true;
                return Err(Error::ModelIncomplete);
            }
            Some("error") => {
                self.failed = true;
                return Err(Error::Model);
            }
            _ => {}
        }
        Ok(())
    }
    pub fn finish(self) -> Result<Vec<Value>> {
        if self.failed || !self.buffer.iter().all(|b| b.is_ascii_whitespace()) {
            return Err(Error::Model);
        }
        self.output.ok_or(Error::StreamInterrupted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_and_failed_streams_never_dispatch_tools() {
        let call = json!({"type":"response.output_item.done","item":{"type":"function_call","name":"authoring","call_id":"x","arguments":"{}"}});
        let mut s = ResponseStream::default();
        s.feed(format!("data: {call}\n\n").as_bytes()).unwrap();
        assert!(s.finish().is_err());
        let mut s = ResponseStream::default();
        assert_eq!(
            s.feed(b"data: {\"type\":\"response.failed\"}\n\n"),
            Err(Error::Model)
        );
    }
    #[test]
    fn chunked_completed_output_is_authoritative() {
        let event = json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"okay"}]}]}});
        let bytes = format!("data: {event}\n\n");
        let mut s = ResponseStream::default();
        for chunk in bytes.as_bytes().chunks(3) {
            s.feed(chunk).unwrap();
        }
        assert_eq!(s.finish().unwrap()[0]["content"][0]["text"], "okay");
    }
}

#[cfg(test)]
mod recovery_tests {
    use super::*;
    #[tokio::test]
    async fn recovery_preserves_effects_and_does_not_replay_dispatched_calls() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("db.sqlite")).unwrap();
        let secrets =
            super::super::secrets::Secrets::open(store.clone(), &dir.path().join("secrets.key"))
                .unwrap();
        let runtime = Runtime::new(store.clone(), secrets.clone(), 4).unwrap();
        let auth = ChatGpt::new(store.clone(), secrets).unwrap();
        let agent = Agent::new(runtime, auth, "http://127.0.0.1:5175".into());
        let conversation = agent.create_conversation(None).await.unwrap();
        store
            .open()
            .unwrap()
            .execute(
                "INSERT INTO jobs VALUES('interrupted',NULL,?,'running','{}')",
                [&conversation.0],
            )
            .unwrap();
        store
            .open()
            .unwrap()
            .execute(
                "INSERT INTO agent_calls VALUES('interrupted','unique','dispatching','{}')",
                [],
            )
            .unwrap();
        agent.recover().await.unwrap();
        assert_eq!(
            agent.job("interrupted".into()).await.unwrap()["state"],
            "interrupted"
        );
        let state: String = store
            .open()
            .unwrap()
            .query_row(
                "SELECT state FROM agent_calls WHERE job='interrupted'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(state, "interrupted");
        assert!(store
            .open()
            .unwrap()
            .execute(
                "INSERT INTO agent_calls VALUES('interrupted','unique','dispatching','{}')",
                []
            )
            .is_err());
    }
}
