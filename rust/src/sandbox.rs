use crate::runtime::{Output, Request, MAX_BYTES};
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{timeout, Duration},
};

pub use crate::broker::Authority;
static WORKERS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

fn command(executable: &Path) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("/usr/bin/sandbox-exec");
        let profile = "(version 1)(deny default)(allow process-exec (literal (param \"EXEC\")))(allow sysctl-read)(allow file-read-metadata)(allow file-read* (literal (param \"EXEC\")) (subpath \"/System/Library\") (subpath \"/usr/lib\") (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/\") (regex #\"^/opt/homebrew/.*\\.dylib$\") (regex #\"^/usr/local/.*\\.dylib$\"))";
        cmd.args([
            "-D",
            &format!("EXEC={}", executable.display()),
            "-p",
            profile,
        ]);
        cmd.arg(executable).arg("--worker");
        Ok(cmd)
    }
    #[cfg(target_os = "linux")]
    {
        let mut cmd = Command::new("bwrap");
        cmd.args([
            "--unshare-all",
            "--die-with-parent",
            "--new-session",
            "--clearenv",
            "--ro-bind",
            "/usr/lib",
            "/usr/lib",
            "--symlink",
            "usr/lib",
            "/lib",
            "--ro-bind-try",
            "/usr/lib64",
            "/usr/lib64",
            "--symlink",
            "usr/lib64",
            "/lib64",
            "--ro-bind",
        ]);
        cmd.arg(executable).args([
            "/worker", "--dev", "/dev", "--tmpfs", "/tmp", "--chdir", "/tmp", "/worker", "--worker",
        ]);
        Ok(cmd)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = executable;
        Err("Backend isolation requires Linux or macOS".into())
    }
}

pub async fn run(request: &Request) -> Result<Output, String> {
    run_with(request, None).await
}
pub async fn run_with(
    request: &Request,
    authority: Option<Authority<'_>>,
) -> Result<Output, String> {
    let mut diagnostics = Vec::new();
    let result = run_with_trace(request, authority, &mut diagnostics).await;
    result.map(|mut output| {
        output.requests = diagnostics;
        output
    })
}
pub async fn run_with_trace(
    request: &Request,
    authority: Option<Authority<'_>>,
    diagnostics: &mut Vec<serde_json::Value>,
) -> Result<Output, String> {
    let _permit = WORKERS
        .try_acquire()
        .map_err(|_| "Backend workers are busy; retry later")?;
    let mut input = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    if input.len() > MAX_BYTES {
        return Err("App data exceeds execution limit".into());
    }
    input.push(b'\n');
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = command(&executable)?
        .env_clear()
        .current_dir("/tmp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Cannot start OS-isolated worker; install Bubblewrap on Linux")?;
    let mut stdin = child.stdin.take().ok_or("Missing worker input")?;
    let stdout = child.stdout.take().ok_or("Missing worker output")?;
    let task = async {
        stdin
            .write_all(&input)
            .await
            .map_err(|_| "Worker input failed")?;
        let mut reader = tokio::io::BufReader::new(stdout);
        let mut requests = 0;
        loop {
            let mut bytes = Vec::new();
            let count = (&mut reader)
                .take((MAX_BYTES + 1) as u64)
                .read_until(b'\n', &mut bytes)
                .await
                .map_err(|_| "Worker output failed")?;
            if count == 0 {
                return Err("Isolated backend worker failed".into());
            }
            if bytes.len() > MAX_BYTES {
                return Err("Worker output exceeds limit".into());
            }
            let value: serde_json::Value =
                serde_json::from_slice(&bytes).map_err(|_| "Invalid worker response")?;
            if value["http"].as_bool() == Some(true) {
                requests += 1;
                if requests > 10 {
                    return Err("HTTP request limit exceeded".into());
                }
                let result = match &authority {
                    Some(auth) if request.mode == "call" => {
                        crate::broker::request_for_action(
                            auth,
                            &request.action,
                            &value["input"],
                            diagnostics,
                        )
                        .await
                    }
                    Some(_) => Err("Live HTTP is unavailable in tests and debug runs".into()),
                    None => Err("HTTP unavailable".into()),
                };
                let url = url::Url::parse(value["input"]["url"].as_str().unwrap_or(""));
                let diagnostic = match &result {
                    Ok(value) => {
                        serde_json::json!({"code":if value["ok"].as_bool()==Some(true){"http_success"}else{"http_failure"},"status":value["status"],"message":if value["ok"].as_bool()==Some(true){"API request succeeded"}else{"API rejected the request"}})
                    }
                    Err(error) => serde_json::json!({"code":"http_failure","message":error}),
                };
                let mut diagnostic = diagnostic;
                if let Ok(url) = url {
                    diagnostic["origin"] = serde_json::json!(url.origin().ascii_serialization());
                }
                diagnostics.push(diagnostic);
                let frame = match result {
                    Ok(result) => serde_json::json!({"result":result}),
                    Err(error) => serde_json::json!({"error":error}),
                }
                .to_string()
                    + "\n";
                stdin
                    .write_all(frame.as_bytes())
                    .await
                    .map_err(|_| "Worker bridge failed")?;
                continue;
            }
            drop(stdin);
            let status = child.wait().await.map_err(|e| e.to_string())?;
            if !status.success() {
                return Err("Isolated backend worker failed".into());
            }
            if let Some(error) = value
                .get("error")
                .and_then(|v| v.as_str())
                .filter(|_| request.mode != "debug")
            {
                return Err(error.into());
            }
            return serde_json::from_value(value).map_err(|e| e.to_string());
        }
    };
    match timeout(Duration::from_millis(request.budget_ms + 1000), task).await {
        Ok(value) => value,
        Err(_) => {
            let _ = child.kill().await;
            Err("Backend execution timed out. Inspect external-write outcomes before retrying a write.".into())
        }
    }
}
