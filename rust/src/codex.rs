use crate::store::{text, Result, Store};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{timeout, Duration},
};

pub struct Codex {
    child: Child,
    input: ChildStdin,
    output: tokio::io::Lines<BufReader<ChildStdout>>,
    sequence: u64,
    inbox: std::collections::VecDeque<Value>,
    pub login: Value,
    pub cwd: PathBuf,
}
pub fn binary() -> Result<PathBuf> {
    if let Ok(path) = std::env::var("CODEX_BINARY") {
        return std::fs::canonicalize(path).map_err(|_| "Codex binary not found".into());
    }
    let root = PathBuf::from("node_modules/@openai");
    fn find(path: &std::path::Path, depth: u8) -> Option<PathBuf> {
        if depth > 6 {
            return None;
        }
        for entry in std::fs::read_dir(path).ok()?.flatten() {
            let p = entry.path();
            if p.is_file() && p.file_name()?.to_str() == Some("codex") {
                return Some(p);
            }
            if p.is_dir() {
                if let Some(p) = find(&p, depth + 1) {
                    return Some(p);
                }
            }
        }
        None
    }
    find(&root, 0)
        .and_then(|path| std::fs::canonicalize(path).ok())
        .ok_or("Install the pinned Codex app-server binary or set CODEX_BINARY".into())
}
impl Codex {
    pub async fn start(store: &Store) -> Result<Self> {
        let home = store.directory.join("codex");
        let cwd = home.join("workspace");
        std::fs::create_dir_all(&cwd).map_err(|e| e.to_string())?;
        let home = std::fs::canonicalize(home).map_err(|e| e.to_string())?;
        let cwd = std::fs::canonicalize(cwd).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| e.to_string())?;
        }
        let mut command = Command::new(binary()?);
        command.args(["app-server", "--listen", "stdio://"]);
        for setting in [
            "cli_auth_credentials_store=\"file\"",
            "analytics.enabled=false",
            "features.shell_tool=false",
            "features.unified_exec=false",
            "features.apply_patch_freeform=false",
            "features.multi_agent=false",
            "features.apps=false",
            "tools.view_image=false",
            "web_search=\"live\"",
            "approval_policy=\"never\"",
            "sandbox_mode=\"read-only\"",
        ] {
            command.args(["-c", setting]);
        }
        let mut child = command
            .current_dir(&cwd)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("CODEX_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|_| "Cannot start Codex app-server")?;
        let input = child.stdin.take().ok_or("Missing Codex input")?;
        let output = BufReader::new(child.stdout.take().ok_or("Missing Codex output")?).lines();
        let mut rpc = Self {
            child,
            input,
            output,
            sequence: 0,
            inbox: std::collections::VecDeque::new(),
            login: Value::Null,
            cwd,
        };
        rpc.request("initialize",json!({"clientInfo":{"name":"little_spaces","title":"LittleSpaces","version":"0.2.0"},"capabilities":{"experimentalApi":true}})).await?;
        rpc.send(json!({"method":"initialized"})).await?;
        Ok(rpc)
    }
    pub fn alive(&mut self) -> bool {
        self.child.try_wait().ok().flatten().is_none()
    }
    pub async fn send(&mut self, value: Value) -> Result<()> {
        let mut bytes = serde_json::to_vec(&value).map_err(|e| e.to_string())?;
        bytes.push(b'\n');
        self.input
            .write_all(&bytes)
            .await
            .map_err(|_| "ChatGPT connection stopped".into())
    }
    async fn receive_raw(&mut self) -> Result<Value> {
        let line = timeout(Duration::from_secs(300), self.output.next_line())
            .await
            .map_err(|_| "ChatGPT took too long")?
            .map_err(|_| "ChatGPT connection stopped")?
            .ok_or("ChatGPT connection stopped")?;
        if line.len() > 4_000_000 {
            return Err("ChatGPT returned excessive data".into());
        }
        serde_json::from_str(&line).map_err(|_| "Invalid ChatGPT response".into())
    }
    pub async fn receive(&mut self) -> Result<Value> {
        if let Some(value) = self.inbox.pop_front() {
            return Ok(value);
        }
        self.receive_raw().await
    }
    async fn notification(&mut self, message: &Value) -> Result<()> {
        if text(message, "method") == "account/login/completed"
            && message["params"]["loginId"] == self.login["loginId"]
        {
            self.login["status"] =
                json!(if message["params"]["success"].as_bool().unwrap_or(false) {
                    "complete"
                } else {
                    "error"
                });
        }
        if message.get("id").is_some() && message.get("method").is_some() {
            self.send(json!({"id":message["id"],"error":{"message":"This action is unavailable in LittleSpaces"}})).await?;
        }
        Ok(())
    }
    pub async fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.sequence += 1;
        let id = self.sequence;
        let mut message = serde_json::Map::new();
        message.insert("id".into(), json!(id));
        message.insert("method".into(), json!(method));
        message.insert("params".into(), params);
        self.send(Value::Object(message)).await?;
        loop {
            let message = self.receive_raw().await?;
            if message["id"] == json!(id) && message.get("method").is_none() {
                if message.get("error").is_some() {
                    return Err(message["error"]["message"]
                        .as_str()
                        .unwrap_or("ChatGPT request failed")
                        .into());
                }
                return Ok(message["result"].clone());
            }
            if !message["params"]["threadId"].is_null() {
                if self.inbox.len() >= 1000 {
                    return Err("ChatGPT event queue exceeds limit".into());
                }
                self.inbox.push_back(message);
            } else {
                self.notification(&message).await?;
            }
        }
    }
    pub async fn account(&mut self, email: &str) -> Result<Value> {
        let value = self
            .request("account/read", json!({"refreshToken":false}))
            .await?;
        let account = &value["account"];
        if text(account, "type") != "chatgpt" {
            return Ok(Value::Null);
        }
        if text(account, "email").trim().to_lowercase() != email {
            return Err("Use the same ChatGPT email as your LittleSpaces account".into());
        }
        Ok(json!({"name":account["email"],"email":account["email"],"canUsePlan":true}))
    }
    pub async fn models(&mut self) -> Result<Value> {
        let mut result = Vec::new();
        let mut cursor = Value::Null;
        loop {
            let value = self
                .request("model/list", json!({"cursor":cursor,"limit":100}))
                .await?;
            for item in value["data"].as_array().ok_or("Invalid model catalog")? {
                if item["hidden"].as_bool().unwrap_or(false) {
                    continue;
                }
                result.push(json!({"slug":item["model"],"display_name":item["displayName"],"efforts":item["supportedReasoningEfforts"].as_array().unwrap_or(&vec![]).iter().map(|e|e["reasoningEffort"].clone()).collect::<Vec<_>>()}));
            }
            cursor = value["nextCursor"].clone();
            if cursor.is_null() {
                break;
            }
        }
        Ok(json!(result))
    }
    pub async fn login_start(&mut self) -> Result<Value> {
        if text(&self.login, "status") == "pending" {
            self.request(
                "account/login/cancel",
                json!({"loginId":self.login["loginId"]}),
            )
            .await?;
        }
        let value = self
            .request("account/login/start", json!({"type":"chatgptDeviceCode"}))
            .await?;
        let url = url::Url::parse(text(&value, "verificationUrl"))
            .map_err(|_| "Invalid ChatGPT sign-in URL")?;
        if url.origin().ascii_serialization() != "https://auth.openai.com"
            || text(&value, "type") != "chatgptDeviceCode"
        {
            return Err("Invalid ChatGPT sign-in URL".into());
        }
        self.login = value.clone();
        self.login["status"] = json!("pending");
        self.login["expiresAt"] = json!(chrono::Utc::now().timestamp_millis() + 600000);
        Ok(value)
    }
    pub async fn login_status(&mut self, email: &str) -> Result<Value> {
        if self.login["expiresAt"].as_i64().unwrap_or(0) < chrono::Utc::now().timestamp_millis() {
            return Ok(json!({"status":"expired"}));
        }
        let account = self.account(email).await?;
        if !account.is_null() {
            self.login["status"] = json!("complete");
            return Ok(json!({"status":"complete","account":account}));
        }
        Ok(json!({"status":self.login["status"]}))
    }
    pub async fn turn<F, Fut, S>(
        &mut self,
        mut options: Value,
        mut execute: F,
        mut activity: S,
        cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
    ) -> Result<String>
    where
        F: FnMut(String, Value) -> Fut,
        Fut: std::future::Future<Output = Result<Value>>,
        S: FnMut(Value),
    {
        let value=self.request("thread/start",json!({"model":options["model"],"cwd":self.cwd,"ephemeral":true,"environments":[],"sandbox":"read-only","approvalPolicy":"never","baseInstructions":options["instructions"],"dynamicTools":options["tools"]})).await?;
        let thread = value["thread"]["id"].clone();
        let mut parameters = serde_json::Map::new();
        parameters.insert("threadId".into(), thread.clone());
        parameters.insert("input".into(), options["input"].take());
        parameters.insert("environments".into(), json!([]));
        if !options["effort"].is_null() {
            parameters.insert("effort".into(), options["effort"].take());
        }
        if !options["outputSchema"].is_null() {
            parameters.insert("outputSchema".into(), options["outputSchema"].take());
        }
        let turn = self
            .request("turn/start", Value::Object(parameters))
            .await?;
        let budget = options["deadlineMs"]
            .as_u64()
            .unwrap_or(300000)
            .clamp(1000, 300000);
        drop(options);
        let turn_id = turn["turn"]["id"].clone();
        let mut answer = String::new();
        let mut final_answer = String::new();
        let mut handled = std::collections::HashSet::new();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(budget);
        let outcome = loop {
            if cancel.load(std::sync::atomic::Ordering::Relaxed)
                || tokio::time::Instant::now() > deadline
            {
                let _ = self
                    .request(
                        "turn/interrupt",
                        json!({"threadId":thread,"turnId":turn_id}),
                    )
                    .await;
                break Err("Stopped. Completed app actions may remain saved.".into());
            }
            let message = tokio::select! { value=self.receive()=>match value{Ok(v)=>v,Err(e)=>break Err(e)}, _=tokio::time::sleep(Duration::from_millis(200))=>continue };
            let p = &message["params"];
            if p["threadId"] != thread {
                self.notification(&message).await?;
                continue;
            }
            match text(&message, "method") {
                "item/agentMessage/delta" => {
                    answer.push_str(text(p, "delta"));
                    activity(json!({"type":"delta","text":p["delta"]}));
                    if answer.len() > 500000 {
                        break Err("ChatGPT reply exceeds limit".into());
                    }
                }
                "item/started" if text(&p["item"], "type") == "webSearch" => {
                    activity(json!({"type":"status","message":"Searching the web…"}))
                }
                "item/completed"
                    if text(&p["item"], "type") == "agentMessage"
                        && text(&p["item"], "phase") == "final_answer" =>
                {
                    final_answer = text(&p["item"], "text").into()
                }
                "item/tool/call" => {
                    let name = text(p, "tool").trim_start_matches("app.").to_string();
                    let result = if handled.len() >= 40
                        || !handled.insert(text(p, "callId").to_string())
                        || (!text(p, "namespace").is_empty() && text(p, "namespace") != "app")
                    {
                        Err("Invalid or excessive tool call".into())
                    } else {
                        execute(name.clone(), p["arguments"].clone()).await
                    };
                    let output = result.unwrap_or_else(|error| json!({"error":error}));
                    let items = if name == "read_photo" && !output["dataUrl"].is_null() {
                        json!([{"type":"inputText","text":json!({"id":output["id"],"name":output["name"]}).to_string()},{"type":"inputImage","imageUrl":output["dataUrl"]}])
                    } else {
                        json!([{"type":"inputText","text":output.to_string().chars().take(200000).collect::<String>()}])
                    };
                    self.send(json!({"id":message["id"],"result":{"contentItems":items,"success":output["error"].is_null()}})).await?;
                }
                "turn/completed" => {
                    if text(&p["turn"], "status") == "completed" {
                        break Ok(if final_answer.is_empty() {
                            answer
                        } else {
                            final_answer
                        });
                    }
                    break Err(p["turn"]["error"]["message"]
                        .as_str()
                        .unwrap_or("ChatGPT could not finish")
                        .into());
                }
                _ => self.notification(&message).await?,
            }
        };
        let _ = self
            .request("thread/unsubscribe", json!({"threadId":thread}))
            .await;
        outcome
    }
}
