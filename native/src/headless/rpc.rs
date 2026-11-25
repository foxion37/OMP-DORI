//! The OMP `rpc-ui` client the host owns (`src/runtime/headless-rpc.ts`): version gate, spawn flags, readiness,
//! one command/response id, native UI events and EOF shutdown.
//!
//! The protocol is pinned to v1: JSONL frames of at most 1 MiB, no negotiation and no chunking.

use std::collections::HashMap;
use std::os::unix::process::ExitStatusExt as _;
use std::path::Path;
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde_json::Value;
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
use tokio::process::{ChildStdin, ChildStdout, Command};
use tokio::sync::{oneshot, watch};

use super::protocol::{is_blank, is_js_space, js_trim_start};
use crate::json::Json;
use crate::util::uuid;

const MAX_FRAME: usize = 1024 * 1024;
/// OMP's reply, handshake, write and exit deadline (shortened under test so stalled-OMP cases finish quickly).
const RPC_TIMEOUT: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 15 });
/// `native-omp.lock`, from the same commit as this binary.
const LOCK: &str = include_str!("../../../native-omp.lock");

/// The OMP version every headless lane requires (`native-omp.lock` `nativeVersion`).
pub(super) fn required_version() -> Result<String> {
    let lock: Value = serde_json::from_str(LOCK)?;
    lock.get("nativeVersion")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("native-omp.lock has no nativeVersion"))
}

/// A failed `request`: OMP answered with `success !== true` (`RpcRefusal`), or the exchange was not confirmed.
#[derive(Debug)]
pub(super) enum RpcError {
    Refused(String),
    Failed(String),
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Refused(message) | Self::Failed(message) => formatter.write_str(message),
        }
    }
}

type Event = Box<dyn Fn(&Value) + Send + Sync>;
type Fault = Box<dyn FnOnce() + Send>;

struct Pending {
    command: String,
    done: oneshot::Sender<Value>,
}

struct Shared {
    pending: HashMap<String, Pending>,
    stopped: bool,
    native_ready: bool,
    ready: Option<oneshot::Sender<bool>>,
    fault: Option<Fault>,
}

fn lock(shared: &Mutex<Shared>) -> std::sync::MutexGuard<'_, Shared> {
    shared.lock().unwrap_or_else(PoisonError::into_inner)
}

/// `end()`: fails every pending request, releases a waiting handshake and reports the fault once.
fn end(shared: &Mutex<Shared>) {
    let fault = {
        let mut shared = lock(shared);
        if shared.stopped {
            return;
        }
        shared.stopped = true;
        if let Some(ready) = shared.ready.take() {
            let _ = ready.send(false);
        }
        shared.pending.clear();
        shared.fault.take()
    };
    if let Some(fault) = fault {
        fault();
    }
}

/// `exited`: the exit code, or 128 + the signal number as Bun reports a signaled child.
fn exit_code(status: ExitStatus) -> i32 {
    status
        .code()
        .or_else(|| status.signal().map(|signal| 128 + signal))
        .unwrap_or(1)
}

pub(super) struct Rpc {
    pid: u32,
    stdin: tokio::sync::Mutex<Option<ChildStdin>>,
    shared: Arc<Mutex<Shared>>,
    ready: Mutex<Option<oneshot::Receiver<bool>>>,
    exited: watch::Receiver<Option<i32>>,
}

/// The launch argv/env/cwd a start record names.
pub(super) struct Launch<'a> {
    pub(super) argv: &'a [String],
    pub(super) env: &'a [(String, String)],
    pub(super) cwd: &'a str,
    /// The reservation's `ref.id`, exported as `CATALY_HEADLESS_ID`.
    pub(super) id: &'a str,
}

impl Launch<'_> {
    fn command(&self, extra: &[&str]) -> Command {
        let mut argv = self
            .argv
            .iter()
            .map(String::as_str)
            .chain(extra.iter().copied());
        let mut command = Command::new(argv.next().unwrap_or_default());
        command
            .args(argv)
            .current_dir(self.cwd)
            .env_clear()
            .envs(self.env.iter().map(|(key, value)| (key, value)))
            .env("CATALY_HEADLESS_ID", self.id)
            .env("PI_NOTIFICATIONS", "off");
        command
    }
}

/// `startRpc`: refuses an OMP whose `--version` does not print the locked version, then spawns `rpc-ui`.
pub(super) async fn start(
    launch: &Launch<'_>,
    overlay: &Path,
    event: Event,
    fault: Fault,
) -> Result<Rpc> {
    let required = required_version()?;
    let mut version = launch.command(&["--version"]);
    version
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let mut child = version.spawn()?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("OMP stdout unavailable"))?;
    let probe = async {
        let mut printed = Vec::new();
        drop(stdout.read_to_end(&mut printed).await);
        let status = child.wait().await.ok();
        (printed, status)
    };
    let (printed, status) = tokio::time::timeout(RPC_TIMEOUT, probe)
        .await
        .unwrap_or_default();
    let printed = String::from_utf8_lossy(&printed);
    let matched = printed.split('\n').any(|line| {
        // `line.trim().replace(/^omp\s+/i, "")`.
        let line = line.trim_matches(is_js_space);
        let bare = line
            .get(..3)
            .filter(|prefix| prefix.eq_ignore_ascii_case("omp"))
            .map(|_| (&line[3..], js_trim_start(&line[3..])))
            .filter(|(rest, trimmed)| trimmed.len() < rest.len())
            .map_or(line, |(_, trimmed)| trimmed);
        bare == required
    });
    if status.is_none_or(|status| exit_code(status) != 0) || !matched {
        bail!("headless lanes require OMP {required}");
    }
    let overlay = overlay
        .to_str()
        .ok_or_else(|| anyhow!("headless overlay path is not UTF-8"))?;
    let mut command = launch.command(&[
        "--mode",
        "rpc-ui",
        "--approval-mode",
        "always-ask",
        "--config",
        overlay,
    ]);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    let mut child = command.spawn()?;
    let pid = child
        .id()
        .ok_or_else(|| anyhow!("OMP exited before its pid was observed"))?;
    let stdin = child.stdin.take();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow!("OMP stdout unavailable"))?;
    let (ready_tx, ready_rx) = oneshot::channel();
    let shared = Arc::new(Mutex::new(Shared {
        pending: HashMap::new(),
        stopped: false,
        native_ready: false,
        ready: Some(ready_tx),
        fault: Some(fault),
    }));
    let (exit_tx, exited) = watch::channel(None);
    let waiter = Arc::clone(&shared);
    tokio::spawn(async move {
        let code = child.wait().await.map_or(1, exit_code);
        end(&waiter);
        let _ = exit_tx.send(Some(code));
    });
    let reader = Arc::clone(&shared);
    tokio::spawn(async move {
        // Any read, size or framing failure ends the stream exactly like EOF.
        drop(read(stdout, &reader, &event).await);
        end(&reader);
    });
    Ok(Rpc {
        pid,
        stdin: tokio::sync::Mutex::new(stdin),
        shared,
        ready: Mutex::new(Some(ready_rx)),
        exited,
    })
}

async fn read(mut stdout: ChildStdout, shared: &Mutex<Shared>, event: &Event) -> Result<()> {
    let mut rest = Vec::new();
    let mut chunk = vec![0_u8; 64 * 1024];
    loop {
        let count = stdout.read(&mut chunk).await?;
        if count == 0 {
            return Ok(());
        }
        rest.extend_from_slice(&chunk[..count]);
        while let Some(at) = rest.iter().position(|byte| *byte == b'\n') {
            let line: Vec<u8> = rest.drain(..=at).collect();
            let line = String::from_utf8_lossy(&line[..at]);
            if is_blank(&line) {
                continue;
            }
            if line.len() > MAX_FRAME {
                bail!("oversized OMP RPC frame");
            }
            let frame: Value = crate::json::parse_js(line.as_bytes())?;
            if !frame.is_object() {
                bail!("invalid OMP RPC frame");
            }
            handle(shared, event, frame)?;
        }
        if rest.len() > MAX_FRAME {
            bail!("oversized OMP RPC frame");
        }
    }
}

fn handle(shared: &Mutex<Shared>, event: &Event, frame: Value) -> Result<()> {
    let kind = frame.get("type").and_then(Value::as_str);
    let mut guard = lock(shared);
    if kind == Some("ready")
        && frame.get("protocolVersion").and_then(Value::as_f64) == Some(1.0)
        && !guard.native_ready
    {
        guard.native_ready = true;
        let ready = guard.ready.take();
        drop(guard);
        if let Some(ready) = ready {
            let _ = ready.send(true);
        }
        return Ok(());
    }
    if !guard.native_ready {
        bail!("OMP did not speak pinned RPC protocol");
    }
    if kind == Some("response") {
        let id = frame.get("id").and_then(Value::as_str);
        let matches = id
            .and_then(|id| guard.pending.get(id))
            .is_some_and(|pending| {
                Some(pending.command.as_str()) == frame.get("command").and_then(Value::as_str)
            });
        let pending = id
            .filter(|_| matches)
            .and_then(|id| guard.pending.remove(id));
        drop(guard);
        if let Some(pending) = pending {
            let _ = pending.done.send(frame);
        }
        return Ok(());
    }
    drop(guard);
    if kind == Some("rpc_frame_error") {
        // A dropped native UI frame could otherwise leave a falsely idle or sendable observation.
        bail!("OMP dropped an RPC frame");
    }
    event(&frame);
    Ok(())
}

impl Rpc {
    /// The OMP child's pid (`observation.pid`).
    pub(super) const fn pid(&self) -> u32 {
        self.pid
    }

    /// `waitReady`.
    pub(super) async fn wait_ready(&self) -> Result<()> {
        let ready = self
            .ready
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        let ready = match ready {
            Some(ready) => tokio::time::timeout(RPC_TIMEOUT, ready).await,
            None => Ok(Ok(false)),
        };
        if !matches!(ready, Ok(Ok(true))) {
            bail!("OMP RPC handshake did not complete");
        }
        Ok(())
    }

    /// `request`: `{...command, id}`, matched by id and echoed command; returns the response's object `data`.
    pub(super) async fn request(&self, mut command: Json) -> Result<Option<Value>, RpcError> {
        let kind = command.str("type").unwrap_or_default().to_owned();
        let id = uuid().map_err(|error| RpcError::Failed(error.to_string()))?;
        command.set("id", Json::string(&id));
        let (done, reply) = oneshot::channel();
        lock(&self.shared).pending.insert(
            id.clone(),
            Pending {
                command: kind.clone(),
                done,
            },
        );
        let sent = self.send(&command.compact()).await;
        let frame = match sent {
            Ok(()) => tokio::time::timeout(RPC_TIMEOUT, reply)
                .await
                .ok()
                .and_then(Result::ok),
            Err(error) => {
                lock(&self.shared).pending.remove(&id);
                return Err(RpcError::Failed(error.to_string()));
            }
        };
        lock(&self.shared).pending.remove(&id);
        let Some(frame) = frame else {
            return Err(RpcError::Failed(format!(
                "OMP RPC {kind} response was not confirmed"
            )));
        };
        if frame.get("success") != Some(&Value::Bool(true)) {
            return Err(RpcError::Refused(format!("OMP rejected RPC {kind}")));
        }
        Ok(frame.get("data").filter(|data| data.is_object()).cloned())
    }

    /// `send`: one serialized frame. Once a mutation write is attempted, a failure means ambiguous; never replay.
    pub(super) async fn send(&self, frame: &str) -> Result<()> {
        {
            let shared = lock(&self.shared);
            if shared.stopped || !shared.native_ready {
                bail!("OMP RPC stream unavailable");
            }
        }
        let data = format!("{frame}\n");
        if data.len() > MAX_FRAME {
            bail!("OMP RPC frame is too large");
        }
        // Bun's sink buffered without blocking; a stuck OMP must not hold the stdin lock (and every later readback)
        // forever, so the locked write is bounded.
        let written = tokio::time::timeout(RPC_TIMEOUT, async {
            let mut stdin = self.stdin.lock().await;
            let sink = stdin.as_mut()?;
            let written =
                sink.write_all(data.as_bytes()).await.is_ok() && sink.flush().await.is_ok();
            drop(stdin);
            Some(written)
        })
        .await;
        match written {
            Ok(Some(true)) => Ok(()),
            Ok(None) => bail!("OMP RPC stream unavailable"),
            Ok(Some(false)) => bail!("OMP RPC write was not confirmed"),
            Err(_) => {
                // A partly written frame would corrupt every later one: the stream is no longer trustworthy.
                end(&self.shared);
                bail!("OMP RPC write was not confirmed")
            }
        }
    }

    /// The child's exit code once it has exited.
    pub(super) async fn exited(&self) -> i32 {
        let mut exited = self.exited.clone();
        let code = exited
            .wait_for(Option::is_some)
            .await
            .ok()
            .and_then(|code| *code);
        code.unwrap_or(1)
    }

    /// `shutdown`: EOF triggers the pinned OMP RPC teardown (session shutdown, dialog cancellation, disposal).
    pub(super) async fn shutdown(&self) -> Result<()> {
        let disconnected = tokio::time::timeout(RPC_TIMEOUT, async {
            drop(self.stdin.lock().await.take());
            self.exited().await
        })
        .await;
        if disconnected.is_err() {
            bail!("OMP did not confirm exit after RPC disconnect");
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_repository_lock_version_is_embedded() {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/native-omp.lock");
        let lock: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
        assert_eq!(
            required_version().unwrap(),
            lock["nativeVersion"].as_str().unwrap()
        );
    }

    #[test]
    fn signaled_children_report_like_bun() {
        assert_eq!(exit_code(ExitStatus::from_raw(9)), 137);
        assert_eq!(exit_code(ExitStatus::from_raw(3 << 8)), 3);
    }
}
