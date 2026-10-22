//! VPS-only ChatGPT connection through pinned Codex app-server device authorization.
//! The child owns its private credential file; neither browser nor app tools receive tokens.
use super::{owner::now, *};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};

const RPC_LIMIT: usize = 8 * 1024 * 1024;
struct Rpc {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    sequence: u64,
    login_result: Option<(String, bool)>,
    queued: std::collections::VecDeque<Value>,
}
impl Rpc {
    async fn start(home: &Path, executable: &Path) -> Result<Self> {
        let cwd = home.join("empty-workspace");
        std::fs::create_dir_all(&cwd).map_err(|_| Error::Storage)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(home, std::fs::Permissions::from_mode(0o700))
                .map_err(|_| Error::Storage)?;
        }
        let mut command = tokio::process::Command::new(executable);
        command.args(["app-server", "--listen", "stdio://"]);
        // No local tools, plugins, MCP, project config, or inherited account/environment.
        // All application effects return through Rust's durable, authorized tool dispatcher.
        for setting in [
            "cli_auth_credentials_store=\"file\"",
            "analytics.enabled=false",
            "check_for_update_on_startup=false",
            "features.shell_tool=false",
            "features.unified_exec=false",
            "features.apply_patch_freeform=false",
            "features.code_mode=false",
            "features.multi_agent=false",
            "features.apps=false",
            "features.plugins=false",
            "tools.view_image=false",
            "web_search=\"live\"",
            "approval_policy=\"never\"",
            "sandbox_mode=\"read-only\"",
            "project_doc_max_bytes=0",
            "tool_output_token_limit=196608",
            "mcp_servers={}",
        ] {
            command.args(["-c", setting]);
        }
        command
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .env("HOME", home)
            .env("CODEX_HOME", home)
            .env("TMPDIR", "/tmp")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = command.spawn().map_err(|_| Error::ProviderUnavailable)?;
        let input = child.stdin.take().ok_or(Error::ProviderUnavailable)?;
        let output = BufReader::new(child.stdout.take().ok_or(Error::ProviderUnavailable)?);
        let mut rpc = Self {
            child,
            input,
            output,
            sequence: 0,
            login_result: None,
            queued: std::collections::VecDeque::new(),
        };
        rpc.call("initialize", json!({"clientInfo":{"name":"little_spaces","title":"LittleSpaces","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        rpc.send(json!({"method":"initialized"})).await?;
        Ok(rpc)
    }
    async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|_| Error::Model)?;
        if bytes.len() > RPC_LIMIT {
            return Err(Error::ContextLimit);
        }
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| Error::StreamInterrupted)?;
        self.input
            .flush()
            .await
            .map_err(|_| Error::StreamInterrupted)
    }
    async fn read(&mut self) -> Result<Value> {
        if let Some(message) = self.queued.pop_front() {
            return Ok(message);
        }
        self.read_wire().await
    }
    async fn read_wire(&mut self) -> Result<Value> {
        let mut bytes = Vec::new();
        loop {
            let buffer = self
                .output
                .fill_buf()
                .await
                .map_err(|_| Error::StreamInterrupted)?;
            if buffer.is_empty() {
                return Err(Error::StreamInterrupted);
            }
            let end = buffer.iter().position(|b| *b == b'\n');
            let count = end.map(|n| n + 1).unwrap_or(buffer.len());
            if bytes.len() + count > RPC_LIMIT {
                return Err(Error::Limit);
            }
            bytes.extend_from_slice(&buffer[..count]);
            self.output.consume(count);
            if end.is_some() {
                break;
            }
        }
        let message: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Model)?;
        if message["method"] == "account/login/completed" {
            if let (Some(id), Some(success)) = (
                message["params"]["loginId"].as_str(),
                message["params"]["success"].as_bool(),
            ) {
                self.login_result = Some((id.into(), success));
            }
        }
        Ok(message)
    }
    async fn deny(&mut self, message: &Value) -> Result<()> {
        if message.get("id").is_some() && message.get("method").is_some() {
            self.send(json!({"id":message["id"],"error":{"code":-32601,"message":"Unavailable in LittleSpaces"}})).await?;
        }
        Ok(())
    }
    async fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        self.send(json!({"id":id,"method":method,"params":params}))
            .await?;
        tokio::time::timeout(Duration::from_secs(45), async {
            loop {
                let message = self.read_wire().await?;
                if message["id"] == id && message.get("method").is_none() {
                    if message.get("error").is_some() {
                        return Err(Error::ProviderRequest);
                    }
                    return message.get("result").cloned().ok_or(Error::Model);
                }
                if method == "turn/start"
                    && message["method"]
                        .as_str()
                        .is_some_and(|m| m.starts_with("item/") || m.starts_with("turn/"))
                {
                    if self.queued.len() >= 256 {
                        return Err(Error::Limit);
                    }
                    self.queued.push_back(message);
                } else {
                    self.deny(&message).await?;
                }
            }
        })
        .await
        .map_err(|_| Error::ModelTimeout)?
    }
}
impl Drop for Rpc {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
struct ModelTurn {
    rpc: Rpc,
    thread: String,
    pending_id: Value,
    call_id: String,
}
struct Login {
    owner: String,
    id: String,
    expires: i64,
    code: String,
    url: String,
}
#[derive(Default)]
struct Connection {
    rpc: Option<Rpc>,
    login: Option<Login>,
    failed: bool,
}
#[derive(Clone)]
pub struct ChatGpt {
    store: Store,
    home: PathBuf,
    executable: PathBuf,
    connection: Arc<tokio::sync::Mutex<Connection>>,
    turns: Arc<tokio::sync::Mutex<std::collections::BTreeMap<String, ModelTurn>>>,
}
impl ChatGpt {
    pub fn new(store: Store, _secrets: super::secrets::Secrets) -> Result<Self> {
        let home = std::fs::canonicalize(store.directory())
            .map_err(|_| Error::Storage)?
            .join("codex");
        Ok(Self {
            store,
            home,
            executable: std::env::var_os("LITTLESPACES_CODEX_BIN")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("codex")),
            connection: Arc::new(tokio::sync::Mutex::new(Connection::default())),
            turns: Arc::new(tokio::sync::Mutex::new(std::collections::BTreeMap::new())),
        })
    }
    async fn ensure<'a>(&self, connection: &'a mut Connection) -> Result<&'a mut Rpc> {
        if connection
            .rpc
            .as_mut()
            .is_some_and(|r| r.child.try_wait().ok().flatten().is_some())
        {
            connection.rpc = None;
            connection.login = None;
            connection.failed = true;
        }
        if connection.rpc.is_none() {
            connection.rpc = Some(Rpc::start(&self.home, &self.executable).await?);
        }
        connection.rpc.as_mut().ok_or(Error::ProviderUnavailable)
    }
    async fn owner_valid(&self, owner: String) -> Result<bool> {
        self.store
            .blocking(move |s| {
                Ok(s.open()?.query_row(
                    "SELECT EXISTS(SELECT 1 FROM owner_sessions WHERE id=? AND expires_at>?)",
                    rusqlite::params![owner, now()],
                    |r| r.get(0),
                )?)
            })
            .await
    }
    async fn inspect(&self, c: &mut Connection) -> Result<Value> {
        if let Some(login) = &c.login {
            if login.expires < now() || !self.owner_valid(login.owner.clone()).await? {
                self.ensure(c)
                    .await?
                    .call("account/logout", json!({}))
                    .await?;
                c.login = None;
                c.failed = true;
            }
        }
        let result = self
            .ensure(c)
            .await?
            .call("account/read", json!({"refreshToken":false}))
            .await?;
        if let Some(login) = &c.login {
            if c.rpc
                .as_ref()
                .and_then(|r| r.login_result.as_ref())
                .is_some_and(|(id, success)| id == &login.id && !success)
            {
                c.failed = true;
                c.login = None;
            } else if result["account"]["type"] == "chatgpt" {
                c.login = None;
                c.failed = false;
            }
        }
        let connected = result["account"]["type"] == "chatgpt" && c.login.is_none();
        let mut status = json!({"connected":connected,"planUsage":connected,"email":result["account"]["email"],"deviceCode":true});
        if let Some(login) = &c.login {
            status["login"] = json!({"status":"pending","userCode":login.code,"verificationUrl":login.url,"expiresAt":login.expires});
        } else if c.failed {
            status["login"] = json!({"status":"error"});
        }
        Ok(status)
    }
    pub async fn status(&self) -> Result<Value> {
        let mut c = self.connection.lock().await;
        // Fresh installations and fixture tests need not start Codex just to render Settings.
        if c.rpc.is_none() && !self.home.join("auth.json").exists() {
            return Ok(json!({"connected":false,"deviceCode":true}));
        }
        self.inspect(&mut c).await
    }
    pub async fn begin(&self, owner: String) -> Result<Value> {
        let mut c = self.connection.lock().await;
        if !self.owner_valid(owner.clone()).await? {
            return Err(Error::Unauthorized);
        }
        if let Some(login) = &c.login {
            let id = login.id.clone();
            self.ensure(&mut c)
                .await?
                .call("account/login/cancel", json!({"loginId":id}))
                .await?;
            c.login = None;
        }
        let v = self
            .ensure(&mut c)
            .await?
            .call("account/login/start", json!({"type":"chatgptDeviceCode"}))
            .await?;
        let url = v["verificationUrl"].as_str().ok_or(Error::Authentication)?;
        let parsed = url::Url::parse(url).map_err(|_| Error::Authentication)?;
        if parsed.origin().ascii_serialization() != "https://auth.openai.com"
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || v["type"] != "chatgptDeviceCode"
        {
            return Err(Error::Authentication);
        }
        let code = v["userCode"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 64
                    && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
            .ok_or(Error::Authentication)?;
        let id = v["loginId"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 256)
            .ok_or(Error::Authentication)?;
        c.login = Some(Login {
            owner,
            id: id.into(),
            expires: now() + 600,
            code: code.into(),
            url: url.into(),
        });
        c.failed = false;
        self.inspect(&mut c).await
    }
    pub async fn cancel_login(&self) -> Result<()> {
        let mut c = self.connection.lock().await;
        if let Some(login) = c.login.take() {
            self.ensure(&mut c)
                .await?
                .call("account/login/cancel", json!({"loginId":login.id}))
                .await?;
        }
        c.failed = false;
        Ok(())
    }
    pub async fn disconnect(&self) -> Result<bool> {
        let mut c = self.connection.lock().await;
        self.ensure(&mut c)
            .await?
            .call("account/logout", json!({}))
            .await?;
        c.login = None;
        c.failed = false;
        Ok(false) // Local logout; do not claim provider-side revocation.
    }
    pub async fn models(&self) -> Result<Value> {
        let mut c = self.connection.lock().await;
        if self.inspect(&mut c).await?["connected"] != true {
            return Err(Error::Authentication);
        }
        let mut models = Vec::new();
        let mut cursor = Value::Null;
        for _ in 0..20 {
            let result = self
                .ensure(&mut c)
                .await?
                .call("model/list", json!({"limit":100,"cursor":cursor}))
                .await?;
            for m in result["data"].as_array().ok_or(Error::Model)? {
                if m["hidden"] == true {
                    continue;
                }
                models.push(json!({"slug":m["model"],"display_name":m["displayName"],"efforts":m["supportedReasoningEfforts"].as_array().into_iter().flatten().filter_map(|v|v["reasoningEffort"].as_str()).collect::<Vec<_>>()}));
            }
            cursor = result["nextCursor"].clone();
            if cursor.is_null() {
                return Ok(json!(models));
            }
        }
        Err(Error::Limit)
    }
    pub async fn finish(&self, job: &str) {
        self.turns.lock().await.remove(job);
    }
    pub async fn request<F, Fut>(
        &self,
        job: &str,
        request: Value,
        cancel: Cancellation,
        mut on_text: F,
    ) -> Result<Vec<Value>>
    where
        F: FnMut(String, Vec<Value>) -> Fut,
        Fut: std::future::Future<Output = Result<()>>,
    {
        if self.status().await?["connected"] != true {
            return Err(Error::Authentication);
        }
        let control = super::control::Control::new(cancel, Duration::from_secs(600));
        let run = async {
            let tools = request["tools"].as_array().ok_or(Error::Model)?;
            let saved = self.turns.lock().await.remove(job);
            let (mut rpc, thread_id) = if let Some(mut saved) = saved {
                let input = request["input"].as_array().ok_or(Error::Model)?;
                let index = input
                    .iter()
                    .position(|item| {
                        item["type"] == "function_call_output" && item["call_id"] == saved.call_id
                    })
                    .ok_or(Error::RecoveryRequired)?;
                let result = input[index]["output"].as_str().ok_or(Error::Model)?;
                let mut content = vec![json!({"type":"inputText","text":result})];
                // read_image adds pixels after its durable tool result. Deliver them with it.
                for item in &input[index + 1..] {
                    for part in item["content"].as_array().into_iter().flatten() {
                        match part["type"].as_str() {
                            Some("input_image") => content
                                .push(json!({"type":"inputImage","imageUrl":part["image_url"]})),
                            Some("input_text") => {
                                content.push(json!({"type":"inputText","text":part["text"]}))
                            }
                            _ => {}
                        }
                    }
                }
                let success = serde_json::from_str::<Value>(result)
                    .map_err(|_| Error::Model)?
                    .get("error")
                    .is_none();
                saved.rpc.send(json!({"id":saved.pending_id,"result":{"contentItems":content,"success":success}})).await?;
                (saved.rpc, saved.thread)
            } else {
                let mut rpc = Rpc::start(&self.home, &self.executable).await?;
                let dynamic: Vec<Value> = tools.iter().filter(|t|t["type"]=="function").map(|t|json!({"type":"function","name":t["name"],"description":t["description"],"inputSchema":t["parameters"]})).collect();
                let thread = rpc.call("thread/start", json!({"model":request["model"],"ephemeral":true,"environments":[],"sandbox":"read-only","approvalPolicy":"never","baseInstructions":request["instructions"],"dynamicTools":dynamic})).await?;
                let thread_id = thread["thread"]["id"]
                    .as_str()
                    .ok_or(Error::Model)?
                    .to_owned();
                rpc.call(
                    "thread/inject_items",
                    json!({"threadId":thread_id,"items":codex_history(&request["input"])?}),
                )
                .await?;
                rpc.call("turn/start", json!({"threadId":thread_id,"input":[{"type":"text","text":"Continue from the conversation above. Use the provided application tools when needed."}],"environments":[],"effort":request["reasoning"]["effort"]})).await?;
                (rpc, thread_id)
            };
            let mut text = String::new();
            let mut output = Vec::new();
            loop {
                let message = tokio::time::timeout(Duration::from_secs(600), rpc.read())
                    .await
                    .map_err(|_| Error::ModelTimeout)??;
                let p = &message["params"];
                if p["threadId"] != thread_id {
                    rpc.deny(&message).await?;
                    continue;
                }
                match message["method"].as_str() {
                    Some("item/agentMessage/delta") => {
                        text.push_str(p["delta"].as_str().ok_or(Error::Model)?);
                        if text.len() > 4 * 1024 * 1024 {
                            return Err(Error::Limit);
                        }
                        on_text(text.clone(), vec![]).await?;
                    }
                    Some("item/completed") if p["item"]["type"] == "agentMessage" => {
                        if let Some(value) = p["item"]["text"].as_str() {
                            let mut item = json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":value}]});
                            if p["item"]["phase"].is_string() {
                                item["phase"] = p["item"]["phase"].clone();
                            }
                            output.push(item);
                        }
                    }
                    Some("item/tool/call") if message.get("id").is_some() => {
                        let call = validated_call(p, tools)?;
                        // Pause at a complete request. Rust durably checkpoints and executes it
                        // before the next request returns its saved result to this same turn.
                        self.turns.lock().await.insert(
                            job.to_owned(),
                            ModelTurn {
                                rpc,
                                thread: thread_id,
                                pending_id: message["id"].clone(),
                                call_id: call["call_id"].as_str().ok_or(Error::Model)?.to_owned(),
                            },
                        );
                        output.push(call);
                        return Ok(output);
                    }
                    Some("turn/completed") => {
                        if p["turn"]["status"] != "completed" {
                            return Err(Error::ModelIncomplete);
                        }
                        if output.is_empty() {
                            return Err(Error::ModelIncomplete);
                        }
                        return Ok(output);
                    }
                    _ => rpc.deny(&message).await?,
                }
            }
        };
        let result = tokio::select! { biased; _ = control.cancelled() => Err(Error::Cancelled), result = run => result };
        if result.is_err() {
            self.finish(job).await;
        }
        result
    }
}
// App-server raw history requires explicit message tags and structured content.
fn codex_history(input: &Value) -> Result<Vec<Value>> {
    input
        .as_array()
        .ok_or(Error::Model)?
        .iter()
        .map(|item| {
            let mut item = item.clone();
            if item.get("role").is_some() {
                item["type"] = json!("message");
                if let Some(text) = item["content"].as_str() {
                    let kind = if item["role"] == "assistant" {
                        "output_text"
                    } else {
                        "input_text"
                    };
                    item["content"] = json!([{"type":kind,"text":text}]);
                }
            }
            Ok(item)
        })
        .collect()
}
fn validated_call(p: &Value, tools: &[Value]) -> Result<Value> {
    let name = p["tool"].as_str().ok_or(Error::Model)?;
    if p["namespace"].as_str().is_some_and(|n| !n.is_empty())
        || !tools
            .iter()
            .any(|t| t["type"] == "function" && t["name"] == name)
    {
        return Err(Error::Validation);
    }
    let args = &p["arguments"];
    if !args.is_object() || args.to_string().len() >= 256 * 1024 {
        return Err(Error::Validation);
    }
    let id = p["callId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() < 256)
        .ok_or(Error::Model)?;
    Ok(json!({"type":"function_call","call_id":id,"name":name,"arguments":args.to_string()}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_complete_known_application_calls_can_cross_dispatch_boundary() {
        let tools = vec![json!({"type":"function","name":"read_sdk"})];
        assert!(validated_call(
            &json!({"tool":"read_sdk","callId":"call-1","arguments":{}}),
            &tools
        )
        .is_ok());
        for p in [
            json!({"tool":"exec_command","callId":"x","arguments":{}}),
            json!({"tool":"read_sdk","namespace":"shell","callId":"x","arguments":{}}),
            json!({"tool":"read_sdk","callId":"x","arguments":"partial"}),
            json!({"tool":"read_sdk","arguments":{}}),
        ] {
            assert!(validated_call(&p, &tools).is_err());
        }
    }
    #[tokio::test]
    async fn device_login_is_owner_bound_persistent_cancellable_and_dispatch_is_atomic() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = Store::create(&dir.path().join("workspace.sqlite")).unwrap();
        let secrets =
            super::super::secrets::Secrets::open(store.clone(), &dir.path().join("secrets.key"))
                .unwrap();
        store
            .open()
            .unwrap()
            .execute(
                "INSERT INTO owner_sessions VALUES('owner-hash',?, 'csrf')",
                [now() + 3600],
            )
            .unwrap();
        let fake = dir.path().join("codex-fake");
        std::fs::write(
            &fake,
            include_str!("../../tests/fixtures/codex-device-fake.py"),
        )
        .unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut auth = ChatGpt::new(store.clone(), secrets.clone()).unwrap();
        auth.executable = fake.clone();
        assert!(auth.begin("guest-or-expired".into()).await.is_err());
        assert_eq!(
            auth.begin("owner-hash".into()).await.unwrap()["login"]["userCode"],
            "TEST-1234"
        );
        auth.cancel_login().await.unwrap();
        assert!(auth.status().await.unwrap().get("login").is_none());
        auth.begin("owner-hash".into()).await.unwrap();
        // Expired/revoked owner sessions cannot complete an outstanding authorization.
        store
            .open()
            .unwrap()
            .execute("UPDATE owner_sessions SET expires_at=0", [])
            .unwrap();
        std::fs::write(auth.home.join("approve"), "yes").unwrap();
        assert_eq!(auth.status().await.unwrap()["connected"], false);
        assert!(!auth.home.join("auth.json").exists());
        std::fs::remove_file(auth.home.join("approve")).unwrap();
        store
            .open()
            .unwrap()
            .execute("UPDATE owner_sessions SET expires_at=?", [now() + 3600])
            .unwrap();
        auth.begin("owner-hash".into()).await.unwrap();
        std::fs::write(auth.home.join("approve"), "yes").unwrap();
        assert_eq!(auth.status().await.unwrap()["connected"], true);
        drop(auth);
        let mut auth = ChatGpt::new(store.clone(), secrets).unwrap();
        auth.executable = fake;
        assert_eq!(auth.status().await.unwrap()["connected"], true);
        assert_eq!(auth.models().await.unwrap()[0]["slug"], "synthetic");
        let request = json!({"model":"synthetic","instructions":"test","input":[{"role":"user","content":"hello"}],"tools":[{"type":"function","name":"read_sdk","description":"read","parameters":{"type":"object"}}]});
        let mut deltas = vec![];
        let output = auth
            .request(
                "test",
                request.clone(),
                Cancellation::default(),
                |text, _| {
                    deltas.push(text);
                    async { Ok(()) }
                },
            )
            .await
            .unwrap();
        assert_eq!(deltas, vec!["Hello"]);
        assert_eq!(output[0]["content"][0]["text"], "Hello");
        for scenario in ["crash", "failed", "unknown"] {
            std::fs::write(auth.home.join("scenario"), scenario).unwrap();
            assert!(auth
                .request(
                    "test",
                    request.clone(),
                    Cancellation::default(),
                    |_, _| async { Ok(()) }
                )
                .await
                .is_err());
        }
        std::fs::write(auth.home.join("scenario"), "tool").unwrap();
        let output = auth
            .request(
                "test",
                request.clone(),
                Cancellation::default(),
                |_, _| async { Ok(()) },
            )
            .await
            .unwrap();
        assert_eq!(output[0]["type"], "function_call");
        assert!(auth.turns.lock().await.contains_key("test"));
        let mut continued = request.clone();
        continued["input"].as_array_mut().unwrap().extend(output);
        continued["input"].as_array_mut().unwrap().push(json!({"type":"function_call_output","call_id":"call-1","output":"{\"ok\":\"saved result\"}"}));
        let resumed = auth
            .request("test", continued, Cancellation::default(), |_, _| async {
                Ok(())
            })
            .await
            .unwrap();
        assert_eq!(resumed[0]["content"][0]["text"], "Continued in same turn");
        assert!(auth.turns.lock().await.is_empty());
        std::fs::write(auth.home.join("scenario"), "wait").unwrap();
        let cancel = Cancellation::default();
        let other = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            other.cancel();
        });
        assert_eq!(
            auth.request("test", request, cancel, |_, _| async { Ok(()) })
                .await
                .unwrap_err(),
            Error::Cancelled
        );
        super::super::maintenance::backup(
            &store,
            &dir.path().join("backup"),
            &dir.path().join("secrets.key"),
        )
        .unwrap();
        assert!(dir.path().join("backup/codex/auth.json").exists());
        auth.disconnect().await.unwrap();
        assert_eq!(auth.status().await.unwrap()["connected"], false);
    }
    #[tokio::test]
    #[ignore = "requires the pinned Codex runtime; uses an isolated home with no account"]
    async fn real_codex_protocol_initializes_without_user_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let bin = std::env::var_os("LITTLESPACES_CODEX_BIN")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("codex"));
        let mut rpc = Rpc::start(dir.path(), &bin).await.unwrap();
        let result = rpc
            .call("account/read", json!({"refreshToken":false}))
            .await
            .unwrap();
        assert!(result["account"].is_null());
        let thread = rpc.call("thread/start", json!({"ephemeral":true,"environments":[],"sandbox":"read-only","approvalPolicy":"never"})).await.unwrap();
        rpc.call("thread/inject_items", json!({"threadId":thread["thread"]["id"],"items":codex_history(&json!([{"role":"user","content":"hello"},{"role":"assistant","content":"hi"}])).unwrap()})).await.unwrap();
    }
}
