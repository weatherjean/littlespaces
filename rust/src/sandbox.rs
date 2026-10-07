use crate::runtime::{Output, Request, MAX_BYTES};
use std::{path::Path, process::Stdio};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{timeout, Duration},
};

fn command(executable: &Path) -> Result<Command, String> {
    #[cfg(target_os = "macos")]
    {
        let mut cmd = Command::new("/usr/bin/sandbox-exec");
        let profile = "(version 1)(deny default)(allow process-exec (literal (param \"EXEC\")))(allow sysctl-read)(allow file-read-metadata)(allow file-read* (literal (param \"EXEC\")) (subpath \"/System/Library\") (subpath \"/usr/lib\") (literal \"/dev/urandom\") (literal \"/dev/random\") (literal \"/\"))";
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
            "/worker", "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--chdir", "/tmp",
            "/worker", "--worker",
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
    let input = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    if input.len() > MAX_BYTES {
        return Err("App data exceeds the execution limit".into());
    }
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
        // Read and write concurrently so an invalid early response cannot deadlock the pipes.
        let writer = async move {
            stdin.write_all(&input).await?;
            drop(stdin);
            Ok::<_, std::io::Error>(())
        };
        let reader = async {
            let mut output = Vec::new();
            stdout
                .take((MAX_BYTES + 1) as u64)
                .read_to_end(&mut output)
                .await?;
            Ok::<_, std::io::Error>(output)
        };
        let (_, output) =
            tokio::try_join!(writer, reader).map_err(|_| "Worker communication failed")?;
        if output.len() > MAX_BYTES {
            return Err("Worker output exceeds limit".to_string());
        }
        let status = child.wait().await.map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("Isolated backend worker failed".into());
        }
        let value: serde_json::Value =
            serde_json::from_slice(&output).map_err(|_| "Invalid worker response")?;
        if let Some(error) = value.get("error").and_then(|x| x.as_str()) {
            return Err(error.into());
        }
        serde_json::from_value(value).map_err(|e| e.to_string())
    };
    match timeout(Duration::from_secs(3), task).await {
        Ok(result) => result,
        Err(_) => {
            let _ = child.kill().await;
            Err("Backend execution timed out".into())
        }
    }
}
