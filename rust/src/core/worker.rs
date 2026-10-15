//! Disposable evaluator with bounded framed IPC. Only the parent has workspace/secret capabilities.
use super::{control::Control, evaluator::EvaluationHost, http::HttpRequest, store::Records, *};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    cell::RefCell,
    io::{Read, Write},
    rc::Rc,
    time::Duration,
};
const MAX_FRAME: usize = 24 * 1024 * 1024;
#[derive(Serialize, Deserialize)]
struct Input {
    revision: Revision,
    action: ActionContract,
    input: Value,
    records: Records,
    #[serde(with = "blob")]
    sqlite: Vec<u8>,
    readonly: bool,
    timeout_ms: u64,
}
#[derive(Serialize, Deserialize)]
struct Evaluated {
    result: Value,
    records: Records,
    #[serde(with = "blob")]
    sqlite: Vec<u8>,
    notices: Vec<notifications::Change>,
}
#[derive(Serialize, Deserialize)]
enum Event {
    Http(HttpRequest),
    Diagnostic(String, Value),
    Redact(Value),
    Done(Result<Evaluated>),
}
#[derive(Serialize, Deserialize)]
enum Reply {
    Value(Result<Value>),
    Diagnostic(Error),
}
mod blob {
    use super::*;
    use base64::{engine::general_purpose::STANDARD, Engine};
    pub fn serialize<S: serde::Serializer>(
        bytes: &[u8],
        s: S,
    ) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&STANDARD.encode(bytes))
    }
    pub fn deserialize<'de, D: serde::Deserializer<'de>>(
        d: D,
    ) -> std::result::Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        STANDARD.decode(s).map_err(serde::de::Error::custom)
    }
}
fn send(io: &mut impl Write, value: &impl Serialize) -> Result<()> {
    let bytes = serde_json::to_vec(value).map_err(|_| Error::Validation)?;
    if bytes.len() > MAX_FRAME {
        return Err(Error::Limit);
    }
    io.write_all(&(bytes.len() as u32).to_be_bytes())
        .and_then(|_| io.write_all(&bytes))
        .and_then(|_| io.flush())
        .map_err(|_| Error::Script)
}
fn receive<T: serde::de::DeserializeOwned>(io: &mut impl Read) -> Result<T> {
    let mut header = [0; 4];
    io.read_exact(&mut header).map_err(|_| Error::Script)?;
    let len = u32::from_be_bytes(header) as usize;
    if len > MAX_FRAME {
        return Err(Error::Limit);
    }
    let mut data = vec![0; len];
    io.read_exact(&mut data).map_err(|_| Error::Script)?;
    serde_json::from_slice(&data).map_err(|_| Error::Script)
}
struct RemoteHost {
    input: RefCell<std::io::Stdin>,
    output: RefCell<std::io::Stdout>,
}
impl RemoteHost {
    fn exchange(&self, event: Event) -> Result<Reply> {
        send(&mut *self.output.borrow_mut(), &event)?;
        receive(&mut *self.input.borrow_mut())
    }
}
impl EvaluationHost for RemoteHost {
    fn request(&self, request: HttpRequest) -> Result<Value> {
        match self.exchange(Event::Http(request))? {
            Reply::Value(v) => v,
            _ => Err(Error::Script),
        }
    }
    fn redact(&self, value: Value) -> Result<Value> {
        match self.exchange(Event::Redact(value))? {
            Reply::Value(v) => v,
            _ => Err(Error::Script),
        }
    }
    fn diagnostic(&self, phase: &str, value: Value) -> Error {
        match self.exchange(Event::Diagnostic(phase.into(), value)) {
            Ok(Reply::Diagnostic(e)) => e,
            _ => Error::Script,
        }
    }
}
/// Invoked before constructing a Tokio runtime or opening any workspace.
pub fn run() -> Result<()> {
    limits()?;
    let host = Rc::new(RemoteHost {
        input: RefCell::new(std::io::stdin()),
        output: RefCell::new(std::io::stdout()),
    });
    let input: Input = receive(&mut *host.input.borrow_mut())?;
    let control = Control::new(
        Cancellation::default(),
        Duration::from_millis(input.timeout_ms),
    );
    let result = super::evaluator::evaluate(
        &input.revision,
        &input.action,
        input.input,
        &input.records,
        &input.sqlite,
        host.clone(),
        input.readonly,
        &control,
    )
    .map(|(result, records, sqlite, notices)| Evaluated {
        result,
        records,
        sqlite,
        notices,
    });
    let sent = send(&mut *host.output.borrow_mut(), &Event::Done(result));
    sent
}
fn limits() -> Result<()> {
    #[cfg(unix)]
    unsafe {
        let cpu = libc::rlimit {
            rlim_cur: 305,
            rlim_max: 305,
        };
        let files = libc::rlimit {
            rlim_cur: 0,
            rlim_max: 0,
        };
        if libc::setrlimit(libc::RLIMIT_CPU, &cpu) != 0
            || libc::setrlimit(libc::RLIMIT_CORE, &files) != 0
            || libc::setrlimit(libc::RLIMIT_FSIZE, &files) != 0
        {
            return Err(Error::Limit);
        }
        #[cfg(target_os = "linux")]
        {
            let memory = libc::rlimit {
                rlim_cur: 512 * 1024 * 1024,
                rlim_max: 512 * 1024 * 1024,
            };
            if libc::setrlimit(libc::RLIMIT_AS, &memory) != 0
                || libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0
            {
                return Err(Error::Limit);
            }
        }
        // SQLite uses its own allocator, independent of the binary's Rust heap budget.
        rusqlite::ffi::sqlite3_hard_heap_limit64(64 * 1024 * 1024);
        Ok(())
    }
    #[cfg(not(unix))]
    {
        Err(Error::Limit)
    }
}
#[cfg(unix)]
struct Pipe {
    stream: std::os::unix::net::UnixStream,
    control: Control,
}
#[cfg(unix)]
impl Read for Pipe {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        loop {
            if self.control.check().is_err() {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            match self.stream.read(buf) {
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                result => return result,
            }
        }
    }
}
#[cfg(unix)]
impl Write for Pipe {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        loop {
            if self.control.check().is_err() {
                return Err(std::io::ErrorKind::TimedOut.into());
            }
            match self.stream.write(buf) {
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock
                            | std::io::ErrorKind::TimedOut
                            | std::io::ErrorKind::Interrupted
                    ) =>
                {
                    continue
                }
                result => return result,
            }
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
struct Child(std::process::Child);
impl Drop for Child {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
#[allow(clippy::too_many_arguments)]
#[cfg_attr(test, allow(dead_code))]
pub(crate) fn evaluate(
    revision: &Revision,
    action: &ActionContract,
    input: Value,
    records: &Records,
    sqlite: &[u8],
    host: impl EvaluationHost,
    readonly: bool,
    control: &Control,
) -> Result<(Value, Records, Vec<u8>, Vec<notifications::Change>)> {
    #[cfg(unix)]
    {
        use std::{
            os::fd::OwnedFd,
            os::unix::net::UnixStream,
            process::{Command, Stdio},
        };
        control.check()?;
        let (parent, child) = UnixStream::pair().map_err(|_| Error::Script)?;
        parent
            .set_read_timeout(Some(Duration::from_millis(25)))
            .map_err(|_| Error::Script)?;
        parent
            .set_write_timeout(Some(Duration::from_millis(25)))
            .map_err(|_| Error::Script)?;
        let stdin: OwnedFd = child.try_clone().map_err(|_| Error::Script)?.into();
        let stdout: OwnedFd = child.into();
        let _child = Child(
            Command::new(std::env::current_exe().map_err(|_| Error::Script)?)
                .arg("--action-worker")
                .env_clear()
                .current_dir("/")
                .stdin(Stdio::from(stdin))
                .stdout(Stdio::from(stdout))
                .stderr(Stdio::null())
                .spawn()
                .map_err(|_| Error::Script)?,
        );
        let mut pipe = Pipe {
            stream: parent,
            control: control.clone(),
        };
        let input = Input {
            revision: revision.clone(),
            action: action.clone(),
            input,
            records: records.clone(),
            sqlite: sqlite.to_vec(),
            readonly,
            timeout_ms: control
                .deadline
                .saturating_duration_since(std::time::Instant::now())
                .as_millis() as u64,
        };
        let exchange = (|| {
            send(&mut pipe, &input)?;
            let mut calls = 0;
            let mut events = 0;
            loop {
                events += 1;
                if events > 16 {
                    return Err(Error::Limit);
                }
                let reply = match receive::<Event>(&mut pipe)? {
                    Event::Http(request) => {
                        calls += 1;
                        Reply::Value(if calls > 2 {
                            Err(Error::Limit)
                        } else {
                            host.request(request)
                        })
                    }
                    Event::Diagnostic(phase, details) => {
                        Reply::Diagnostic(host.diagnostic(&phase, details))
                    }
                    Event::Redact(value) => Reply::Value(host.redact(value)),
                    Event::Done(value) => {
                        return value.map(|v| (v.result, v.records, v.sqlite, v.notices))
                    }
                };
                send(&mut pipe, &reply)?;
            }
        })();
        control.check()?;
        exchange
    }
    #[cfg(not(unix))]
    {
        let _ = (
            revision, action, input, records, sqlite, host, readonly, control,
        );
        Err(Error::Limit)
    }
}
