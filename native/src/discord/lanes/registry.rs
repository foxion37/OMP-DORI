//! `registry.ts`, `lane-state.ts` and the execution half of `lane-run.ts`, read and written in their exact formats.
//!
//! Lane rows are `<state>/lanes/<key>.json` (`JSON.stringify(lane, null, 1)`, temp `<path>.<pid>.tmp` + rename, under
//! the `<path>.lock` writer lock). Tern pane rows are `<state>/sessions/<encodeURIComponent(id)>.json`, written only by
//! the extension. Execution events append to `<state>/lanes/<key>/reports.jsonl`.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write as _};
use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result, anyhow, bail};

use super::lock::take_lock;
use crate::json::Json;
use crate::util::{RECORD_LIMIT, iso, private_dirs, read_limited, replace_file, safe_int};

const REGISTRY_WAIT: Duration = Duration::from_secs(5);
const REGISTRY_RETRY: Duration = Duration::from_millis(10);

/// `LANE_KEY`: `^[a-z0-9][a-z0-9._-]{1,60}$`.
pub(super) fn valid_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    (2..=61).contains(&bytes.len())
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes[1..].iter().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'.' | b'_' | b'-')
        })
}

/// One registry row as stored, after `upgradeLane`.
#[derive(Clone, Debug)]
pub(super) struct Lane(pub(super) Json);

/// `SessionRef` fields a lane may carry.
#[derive(Clone, Debug)]
pub(super) struct SessionRef<'a> {
    pub(super) runtime: Option<&'a Json>,
    pub(super) id: Option<&'a Json>,
    pub(super) group: Option<&'a Json>,
}

impl<'a> SessionRef<'a> {
    pub(super) fn runtime(&self) -> Option<&'a str> {
        self.runtime.and_then(Json::as_str)
    }

    pub(super) fn id(&self) -> Option<&'a str> {
        self.id.and_then(Json::as_str)
    }
}

impl Lane {
    pub(super) fn key(&self) -> &str {
        self.0.str("key").unwrap_or_default()
    }

    pub(super) fn thread(&self) -> Option<&Json> {
        self.0.get("thread")
    }

    pub(super) fn thread_is(&self, thread: &str) -> bool {
        self.0.str("thread") == Some(thread)
    }

    /// `lane.session` exactly as stored (`None` is `undefined`).
    pub(super) fn session_value(&self) -> Option<&Json> {
        self.0.get("session")
    }

    /// A string `lane.session`; a falsy one is `None`.
    pub(super) fn session(&self) -> Option<&str> {
        self.0.str("session").filter(|s| !s.is_empty())
    }

    pub(super) fn session_file(&self) -> Option<&str> {
        self.0.str("sessionFile").filter(|s| !s.is_empty())
    }

    pub(super) fn cwd(&self) -> Option<&str> {
        self.0.str("cwd").filter(|s| !s.is_empty())
    }

    pub(super) fn epoch(&self) -> Option<&str> {
        self.0.str("lifecycleEpoch")
    }

    pub(super) fn closing(&self) -> bool {
        self.0.truthy("nativeCloseIntent")
    }

    pub(super) fn session_ref(&self) -> Option<SessionRef<'_>> {
        if !self.0.truthy("sessionRef") {
            return None;
        }
        let reference = self.0.get("sessionRef")?;
        Some(SessionRef {
            runtime: reference.get("runtime"),
            id: reference.get("id"),
            group: reference.get("group"),
        })
    }

    /// `statusOf`.
    pub(super) fn status(&self) -> &str {
        if self.0.truthy("closedAt") {
            return "closed";
        }
        match self.0.get("status") {
            None | Some(Json::Null) => "working",
            Some(Json::String(status)) => status.as_str(),
            Some(_) => "",
        }
    }

    fn history_len(&self) -> usize {
        match self.0.get("history") {
            Some(Json::Array(items)) => items.len(),
            _ => 0,
        }
    }

    /// `sameLaneGeneration`.
    pub(super) fn same_generation(&self, current: &Self) -> bool {
        self.0.get("openedAt") == current.0.get("openedAt")
            && self.0.get("lifecycleEpoch") == current.0.get("lifecycleEpoch")
            && self.history_len() == current.history_len()
            && self.status() == current.status()
    }

    /// `sameWakeTarget`.
    pub(super) fn same_wake_target(&self, current: &Self) -> bool {
        let status = current.status();
        let before = self.session_ref();
        let now = current.session_ref();
        self.same_generation(current)
            && (status == "working" || status == "not-done")
            && !current.0.truthy("hold")
            && !current.closing()
            && before.as_ref().and_then(|r| r.runtime) == now.as_ref().and_then(|r| r.runtime)
            && before.as_ref().and_then(|r| r.id) == now.as_ref().and_then(|r| r.id)
            && before.as_ref().and_then(|r| r.group) == now.as_ref().and_then(|r| r.group)
            && ["thread", "session", "sessionFile", "cwd"]
                .iter()
                .all(|key| self.0.get(key) == current.0.get(key))
    }
}

pub(super) struct Scan {
    pub(super) lanes: Vec<Lane>,
    pub(super) unreadable: usize,
}

pub(super) struct Registry {
    pub(super) dir: PathBuf,
}

impl Registry {
    pub(super) fn new(state: &Path) -> Self {
        Self {
            dir: state.join("lanes"),
        }
    }

    fn path(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    fn read_path(path: &Path) -> Result<Option<Lane>> {
        let bytes = match read_limited(path, RECORD_LIMIT) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let raw: Json = serde_json::from_slice(&bytes)
            .with_context(|| format!("unreadable lane record {}", path.display()))?;
        Ok(Some(Lane(raw)))
    }

    /// `Registry.read`.
    pub(super) fn read(&self, key: &str) -> Result<Option<Lane>> {
        Self::read_path(&self.path(key))
    }

    /// `Registry.scan()` (non-strict): unreadable or miskeyed rows are counted, never returned.
    pub(super) fn scan(&self) -> Result<Scan> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(Scan {
                    lanes: Vec::new(),
                    unreadable: 0,
                });
            }
            Err(error) => return Err(error.into()),
        };
        let mut names = Vec::new();
        for entry in entries {
            let name = entry?.file_name();
            let Some(name) = name.to_str() else { continue };
            if let Some(key) = name.strip_suffix(".json") {
                names.push(key.to_owned());
            }
        }
        names.sort();
        let mut scan = Scan {
            lanes: Vec::new(),
            unreadable: 0,
        };
        for key in names {
            match Self::read_path(&self.path(&key)) {
                Ok(None) => {}
                Ok(Some(lane)) if lane.0.is_object() && lane.0.str("key") == Some(key.as_str()) => {
                    scan.lanes.push(lane);
                }
                Ok(Some(_)) | Err(_) => scan.unreadable += 1,
            }
        }
        Ok(scan)
    }

    fn write_now(&self, lane: &Lane) -> Result<()> {
        let path = self.path(lane.key());
        let temporary = crate::util::sibling(&path, &format!(".{}.tmp", std::process::id()));
        replace_file(&path, &temporary, &lane.0.pretty1())
    }

    /// `Registry.update` under `withRegistryLock` (5 s wait, 10 ms retry, stale owners taken over).
    pub(super) async fn update(
        &self,
        key: &str,
        change: impl FnOnce(Option<Lane>) -> Result<Option<Lane>> + Send,
    ) -> Result<Option<Lane>> {
        fs::create_dir_all(&self.dir)?;
        let lock_path = crate::util::sibling(&self.path(key), ".lock");
        let deadline = tokio::time::Instant::now() + REGISTRY_WAIT;
        let lock = loop {
            match take_lock(&lock_path, false)? {
                Ok(lock) => break lock,
                Err(holder) => {
                    if tokio::time::Instant::now() >= deadline {
                        bail!("lane registry locked: {key} ({holder})");
                    }
                    tokio::time::sleep(REGISTRY_RETRY).await;
                }
            }
        };
        let result = self.apply(key, change);
        let released = lock.release();
        let next = result?;
        released?;
        Ok(next)
    }

    /// One read and one write, inside the writer lock.
    fn apply(
        &self,
        key: &str,
        change: impl FnOnce(Option<Lane>) -> Result<Option<Lane>>,
    ) -> Result<Option<Lane>> {
        let next = change(self.read(key)?)?;
        if let Some(next) = &next {
            self.write_now(next)?;
        }
        Ok(next)
    }

    /// `Registry.transition`: apply only while the lane still has the observed generation.
    pub(super) async fn transition(
        &self,
        seen: &Lane,
        next: impl FnOnce(Lane) -> Result<Option<Lane>> + Send,
    ) -> Result<Option<Lane>> {
        self.update(seen.key(), |current| match current {
            Some(current) if seen.same_generation(&current) => next(current),
            _ => Ok(None),
        })
        .await
    }
}

/// `encodeURIComponent`.
pub(super) fn encode_uri_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            use std::fmt::Write as _;
            // Writing to a String cannot fail.
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

/// `readPaneState`: the extension's pane record (`<state>/sessions/<encodeURIComponent(id)>.json`), or `None` when
/// absent or unparsable.
pub(super) fn pane_state(state: &Path, pane: &str) -> Option<Json> {
    let path = state
        .join("sessions")
        .join(format!("{}.json", encode_uri_component(pane)));
    let bytes = read_limited(&path, RECORD_LIMIT).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// A JS number field read as a safe integer.
pub(super) fn int_field(value: &Json, key: &str) -> Option<i64> {
    value.get(key).and_then(Json::as_f64).and_then(safe_int)
}

/// `isRequestId`.
pub(super) fn is_request_id(value: &str) -> bool {
    let parts: Vec<&str> = value.split(':').collect();
    let [platform, channel, message] = parts.as_slice() else {
        return false;
    };
    let (platform, channel, message) = (*platform, *channel, *message);
    let snowflake = |text: &str| {
        (1..=20).contains(&text.len())
            && !text.starts_with('0')
            && text.bytes().all(|b| b.is_ascii_digit())
            && text.parse::<u64>().is_ok()
    };
    let positive = |text: &str| {
        !text.is_empty() && !text.starts_with('0') && text.bytes().all(|b| b.is_ascii_digit())
    };
    let safe = |text: &str| text.parse::<f64>().ok().and_then(safe_int).is_some();
    match platform {
        "discord" => snowflake(channel) && snowflake(message),
        "telegram" => {
            let bare = channel.strip_prefix('-').unwrap_or(channel);
            positive(bare) && positive(message) && safe(channel) && safe(message)
        }
        "slack" => {
            let mut chars = channel.chars();
            chars.next().is_some_and(|c| c.is_ascii_uppercase())
                && channel.len() >= 2
                && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit())
                && message.split_once('.').is_some_and(|(a, b)| {
                    !a.is_empty()
                        && !b.is_empty()
                        && a.bytes().all(|x| x.is_ascii_digit())
                        && b.bytes().all(|x| x.is_ascii_digit())
                })
        }
        _ => false,
    }
}

/// One validated execution event of `lanes/<key>/reports.jsonl`.
struct Context {
    generation: Option<String>,
    native: Option<(String, String, String)>,
}

fn reports_path(state: &Path, key: &str) -> Result<PathBuf> {
    if !valid_key(key) {
        bail!("invalid lane key: {key}");
    }
    Ok(state.join("lanes").join(key).join("reports.jsonl"))
}

fn native_identity(value: Option<&Json>) -> Option<(String, String, String)> {
    let native = value?;
    let reference = native.get("ref")?;
    Some((
        native.str("sessionId")?.to_owned(),
        reference.str("runtime")?.to_owned(),
        reference.str("id")?.to_owned(),
    ))
}

/// `runContext` restricted to execution events. Other journal rows are only required to be keyed JSON objects.
fn run_context(state: &Path, lane: &Lane, run: Option<&str>) -> Result<Option<Context>> {
    let Some(request) = lane.0.get("requestId") else {
        return Ok(Some(Context {
            generation: lane.epoch().map(str::to_owned),
            native: None,
        }));
    };
    let Some(request) = request.as_str().filter(|request| is_request_id(request)) else {
        bail!("invalid original request for {}", lane.key());
    };
    let path = reports_path(state, lane.key())?;
    let text = match read_limited(&path, 64 * RECORD_LIMIT) {
        Ok(bytes) => String::from_utf8(bytes).context("reports journal is not UTF-8")?,
        Err(error) if error.kind() == ErrorKind::NotFound => String::new(),
        Err(error) => return Err(error.into()),
    };
    let mut contexts: Vec<(String, Context)> = Vec::new();
    for (index, line) in text.split('\n').enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let event: Json = serde_json::from_str(line)
            .map_err(|error| anyhow!("{}:{}: {error}", path.display(), index + 1))?;
        if event.str("key") != Some(lane.key()) {
            bail!(
                "{}:{}: invalid report record for {}",
                path.display(),
                index + 1,
                lane.key()
            );
        }
        if event.str("type") != Some("execution") {
            continue;
        }
        let (Some(event_request), Some(event_run)) = (event.str("requestId"), event.str("runId"))
        else {
            bail!("invalid execution record for {}", lane.key());
        };
        if event_request != request {
            bail!("execution request changed for {}", lane.key());
        }
        let generation = event.str("generation").map(str::to_owned);
        let at = contexts.iter().position(|(id, _)| id == event_run);
        match event.str("phase") {
            Some("started") => {
                if at.is_some() {
                    bail!("duplicate execution start for {}", lane.key());
                }
                contexts.push((
                    event_run.to_owned(),
                    Context {
                        generation,
                        native: None,
                    },
                ));
            }
            Some("bound") => {
                let native = native_identity(event.get("nativeRef"))
                    .ok_or_else(|| anyhow!("invalid execution binding for {}", lane.key()))?;
                let Some(at) = at.filter(|at| contexts[*at].1.generation == generation) else {
                    bail!("execution binding has no matching start for {}", lane.key());
                };
                if contexts[at]
                    .1
                    .native
                    .as_ref()
                    .is_some_and(|seen| *seen != native)
                {
                    bail!("execution native reference changed for {}", lane.key());
                }
                contexts[at].1.native = Some(native);
            }
            _ => bail!("invalid execution binding for {}", lane.key()),
        }
    }
    Ok(run
        .filter(|run| crate::util::is_uuid(run, true))
        .and_then(|run| contexts.into_iter().find(|(id, _)| id == run))
        .map(|(_, context)| context))
}

fn append_event(state: &Path, key: &str, event: &Json) -> Result<()> {
    let path = reports_path(state, key)?;
    let dir = state.join("lanes").join(key);
    private_dirs(&dir)?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    let mut line = event.compact();
    line.push('\n');
    OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(&path)
        .with_context(|| format!("opening {}", path.display()))?
        .write_all(line.as_bytes())?;
    Ok(())
}

/// `recordExecution(stateDir, lane, now, nativeSessionId?)`, called inside the registry writer lock.
pub(super) fn record_execution(
    state: &Path,
    lane: &Lane,
    now: i64,
    native: Option<&str>,
) -> Result<()> {
    let Some(request) = lane.0.str("requestId") else {
        if lane.0.get("requestId").is_some() {
            bail!("invalid launch identity for {}", lane.key());
        }
        return Ok(());
    };
    let run = lane.0.str("runId");
    if !is_request_id(request) || !run.is_some_and(|run| crate::util::is_uuid(run, true)) {
        bail!("invalid launch identity for {}", lane.key());
    }
    let previous = run_context(state, lane, run)?;
    let mut common = vec![
        ("type", Json::string("execution")),
        ("key", Json::string(lane.key())),
        ("at", Json::string(&iso(now))),
        ("requestId", Json::string(request)),
        ("runId", Json::string(run.unwrap_or_default())),
    ];
    if let Some(epoch) = lane.epoch() {
        common.push(("generation", Json::string(epoch)));
    }
    let Some(session) = native else {
        if previous.is_some() {
            bail!("execution already started for {}", lane.key());
        }
        common.push(("phase", Json::string("started")));
        common.push((
            "text",
            Json::string("Lane execution started; native admission unverified"),
        ));
        return append_event(state, lane.key(), &Json::object(common));
    };
    let reference = lane.session_ref();
    let (Some(previous), Some(runtime), Some(id)) = (
        previous,
        reference.as_ref().and_then(SessionRef::runtime),
        reference.as_ref().and_then(SessionRef::id),
    ) else {
        bail!(
            "execution binding has no matching launch for {}",
            lane.key()
        );
    };
    if previous.generation.as_deref() != lane.epoch() || session.is_empty() {
        bail!(
            "execution binding has no matching launch for {}",
            lane.key()
        );
    }
    let identity = (session.to_owned(), runtime.to_owned(), id.to_owned());
    if previous.native.is_some_and(|seen| seen != identity) {
        bail!("execution native reference changed for {}", lane.key());
    }
    common.push(("phase", Json::string("bound")));
    common.push((
        "nativeRef",
        Json::object(vec![
            ("sessionId", Json::string(session)),
            (
                "ref",
                Json::object(vec![
                    ("runtime", Json::string(runtime)),
                    ("id", Json::string(id)),
                ]),
            ),
        ]),
    ));
    common.push((
        "text",
        Json::string("Lane execution native session verified"),
    ));
    append_event(state, lane.key(), &Json::object(common))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys() {
        assert!(valid_key("ab") && valid_key("a.b-c_9") && !valid_key("a") && !valid_key("Ab"));
    }

    #[test]
    fn request_ids() {
        assert!(is_request_id("discord:1:2"));
        assert!(!is_request_id("discord:0:2"));
        assert!(is_request_id("telegram:-100:5"));
        assert!(is_request_id("slack:C01:1.2"));
        assert!(!is_request_id("slack:c01:1.2"));
    }
}
