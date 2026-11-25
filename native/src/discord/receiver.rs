//! ASK receiver route publication (discord-ask-receiver.ts:124-245): a private, short-lived receipt that lets
//! the extension's automatic ASK routing find this live receiver. Every failure only removes the receipt.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{Result, ensure};
use reqwest::Url;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::Snowflake;
use super::ipc::random_uuid;

const TTL_MS: u64 = 30_000;
const REFRESH: Duration = Duration::from_secs(5);
const MAX_BYTES: usize = 65_536;
const MAX_CHANNELS: usize = 1_024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Receipt<'a> {
    version: u8,
    pid: u32,
    start: &'a str,
    token_digest: &'a str,
    api_base: &'a str,
    owner: Snowflake,
    explicit: &'a [Snowflake],
    watched: &'a [Snowflake],
    expires_at: u64,
}

struct State {
    root: PathBuf,
    path: PathBuf,
    name: String,
    start: Option<String>,
    token_digest: String,
    api_base: Option<String>,
    owner: Snowflake,
    explicit: Vec<Snowflake>,
    watched: Vec<Snowflake>,
    published: Vec<Snowflake>,
    window: Option<u64>,
    active: bool,
    verified_until: u64,
    renew_at: u64,
}

pub(super) struct Receiver {
    state: Arc<Mutex<State>>,
    timer: tokio::task::JoinHandle<()>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

/// `${boot_id}:${starttime}` on Linux; a reused PID or another boot is not this receiver.
#[cfg(target_os = "linux")]
fn identity() -> Option<String> {
    let stat = fs::read_to_string("/proc/self/stat").ok()?;
    let fields: Vec<&str> = stat.get(stat.rfind(')')? + 2..)?.split(' ').collect();
    let start_ticks = fields.get(19)?;
    if matches!(fields.first(), Some(&("Z" | "X")))
        || start_ticks.is_empty()
        || !start_ticks.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let boot = fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
    Some(format!("{}:{start_ticks}", boot.trim()))
}

/// discord-ask-receiver.ts reads `processStart(pid)` off Linux: on macOS the start token alone, an absolute start time
/// to the microsecond. It carries no boot id, as there; a reused PID still starts at another time.
#[cfg(target_os = "macos")]
fn identity() -> Option<String> {
    super::darwin::start(std::process::id())
}

/// No process start reader on other hosts: fail closed rather than publish another format.
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn identity() -> Option<String> {
    None
}

/// `discordApiBase(CATALY_DISCORD_API_BASE)`; `None` fails publication closed.
fn api_base() -> Option<String> {
    let raw = std::env::var("CATALY_DISCORD_API_BASE").unwrap_or_default();
    if raw.is_empty() {
        return Some("https://discord.com/api/v10".to_owned());
    }
    let url = Url::parse(&raw).ok()?;
    let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
    if url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || !loopback
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    Some(url.as_str().trim_end_matches('/').to_owned())
}

fn private_directory(path: &Path) -> Result<()> {
    let stat = fs::symlink_metadata(path)?;
    ensure!(
        stat.is_dir()
            && stat.uid() == rustix::process::geteuid().as_raw()
            && stat.mode().trailing_zeros() >= 6,
        "Discord ASK receiver directory is not private"
    );
    Ok(())
}

fn unique(ids: &[Snowflake]) -> Vec<Snowflake> {
    let mut seen = Vec::with_capacity(ids.len());
    for &id in ids {
        if !seen.contains(&id) {
            seen.push(id);
        }
    }
    seen
}

impl State {
    fn remove(&self) {
        // Process death and the short expiry stay authoritative if cleanup fails.
        if private_directory(&self.root).is_ok() {
            drop(fs::remove_file(&self.path));
        }
    }

    fn suspend(&mut self) {
        self.active = false;
        self.verified_until = 0;
        self.renew_at = 0;
        self.remove();
    }

    fn publish(&mut self) {
        let Some(start) = self.start.clone() else {
            return;
        };
        if !self.active {
            return;
        }
        let now = now();
        if now >= self.verified_until {
            self.suspend();
            return;
        }
        if now < self.renew_at && self.watched == self.published {
            return;
        }
        let temporary = self.root.join(format!(
            ".{}-{}",
            self.name,
            random_uuid().unwrap_or_default()
        ));
        let written = self.write(&start, now, &temporary);
        drop(fs::remove_file(&temporary));
        if written.is_ok() {
            self.published.clone_from(&self.watched);
            self.renew_at = now + REFRESH.as_secs() * 1000;
        } else {
            self.renew_at = 0;
            self.remove();
        }
    }

    fn write(&self, start: &str, now: u64, temporary: &Path) -> Result<()> {
        let watched = unique(&self.watched);
        let api_base = self
            .api_base
            .as_deref()
            .ok_or_else(|| anyhow::anyhow!("invalid API base"))?;
        ensure!(
            self.explicit.len() <= MAX_CHANNELS
                && watched.len() <= MAX_CHANNELS
                && self.explicit.iter().all(|id| watched.contains(id)),
            "Invalid Discord ASK receiver route"
        );
        let text = serde_json::to_string(&Receipt {
            version: 1,
            pid: std::process::id(),
            start,
            token_digest: &self.token_digest,
            api_base,
            owner: self.owner,
            explicit: &self.explicit,
            watched: &watched,
            expires_at: self.verified_until.min(now + TTL_MS),
        })?;
        ensure!(
            text.len() <= MAX_BYTES,
            "Discord ASK receiver route exceeds size limit"
        );
        match DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&self.root)
        {
            Ok(()) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        private_directory(&self.root)?;
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(temporary)?;
        file.write_all(text.as_bytes())?;
        drop(file);
        fs::rename(temporary, &self.path)?;
        Ok(())
    }
}

impl Receiver {
    /// Call only after intake authenticated the bot and validated its owner and channel scope. `window_ms` is
    /// how long one successful intake round proves progress (`None`: until suspended).
    pub(super) fn open(
        cataly_state: &Path,
        token: &str,
        owner: Snowflake,
        explicit: &[Snowflake],
        window_ms: Option<u64>,
    ) -> Result<Self> {
        let root = cataly_state.join("discord-ask-receivers");
        let name = format!("{}-{}.json", std::process::id(), random_uuid()?);
        let state = Arc::new(Mutex::new(State {
            path: root.join(&name),
            root,
            name,
            start: identity(),
            token_digest: format!("{:x}", Sha256::digest(token.as_bytes())),
            api_base: api_base(),
            owner,
            explicit: unique(explicit),
            watched: Vec::new(),
            published: Vec::new(),
            window: window_ms,
            active: false,
            verified_until: 0,
            renew_at: 0,
        }));
        let shared = Arc::clone(&state);
        let timer = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(REFRESH);
            ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                ticks.tick().await;
                shared
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .publish();
            }
        });
        Ok(Self { state, timer })
    }

    fn with(&self, action: impl FnOnce(&mut State)) {
        action(&mut self.state.lock().unwrap_or_else(PoisonError::into_inner));
    }

    /// Renews on schedule, or immediately when the observed channel set changed.
    pub(super) fn refresh(&self, watched: &[Snowflake]) {
        self.with(|state| {
            if state.start.is_none() {
                return;
            }
            state.watched = watched.to_vec();
            state.verified_until = state
                .window
                .map_or(u64::MAX, |window| now().saturating_add(window));
            state.active = true;
            state.publish();
        });
    }

    pub(super) fn suspend(&self) {
        self.with(State::suspend);
    }
}

impl Drop for Receiver {
    fn drop(&mut self) {
        self.timer.abort();
        self.with(State::suspend);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: u64) -> Snowflake {
        Snowflake::try_from(value.to_string()).unwrap()
    }

    #[test]
    fn receipt_matches_ts_key_order() {
        let text = serde_json::to_string(&Receipt {
            version: 1,
            pid: 7,
            start: "boot:9",
            token_digest: "ab",
            api_base: "https://discord.com/api/v10",
            owner: id(10),
            explicit: &[id(20)],
            watched: &[id(20), id(21)],
            expires_at: 5,
        })
        .unwrap();
        assert_eq!(
            text,
            r#"{"version":1,"pid":7,"start":"boot:9","tokenDigest":"ab","apiBase":"https://discord.com/api/v10","owner":"10","explicit":["20"],"watched":["20","21"],"expiresAt":5}"#
        );
        assert_eq!(unique(&[id(2), id(1), id(2)]), vec![id(2), id(1)]);
    }

    /// discord-ask-receiver.ts finds the route only while this start equals its `identity(pid)`: `${bootId}:${start}`
    /// on Linux, `processStart(pid)` elsewhere. Needs `bun`, so Linux runs it with `cargo test -- --ignored`.
    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[cfg_attr(
        not(target_os = "macos"),
        ignore = "runs the TypeScript readers with bun"
    )]
    #[test]
    fn identity_matches_typescript() {
        let ts = crate::discord::darwin::typescript_process(std::process::id());
        let start = ts["start"].as_str().unwrap();
        let expected = if cfg!(target_os = "linux") {
            format!("{}:{start}", ts["bootId"].as_str().unwrap())
        } else {
            start.to_owned()
        };
        assert_eq!(identity(), Some(expected));
    }
}
