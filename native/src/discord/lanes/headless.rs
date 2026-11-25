//! The Discord lane's view of the detached headless runtime (`headless-lifecycle.ts`,
//! `discord-lane-headless-state.ts`): observation, the extension's `discord-lane.json` receiver, reservation and
//! the detached start. The shared owner-only records and the endpoint client live in `crate::headless`.

use std::collections::BTreeMap;
use std::fs::{self, DirBuilder, OpenOptions};
use std::os::unix::fs::{DirBuilderExt as _, OpenOptionsExt as _};
use std::path::Path;
use std::process::Stdio;

use anyhow::{Context as _, Result, anyhow, bail, ensure};
use serde::Serialize;
use tokio::io::AsyncWriteExt as _;

use super::registry::{Lane, int_field};
use crate::headless::http::client::request_host;
use crate::headless::record::{
    Entry, data_dir, lane_dir, lane_entry, private_dir, read_private, write_private,
};
use crate::json::Json;
use crate::util::{is_uuid, iso, now_ms, parse_iso, uuid};

/// A headless session reference (`{runtime:"headless", id, group?}`).
#[derive(Clone, Debug, PartialEq)]
pub(super) struct HeadlessRef {
    pub(super) id: String,
    pub(super) group: Option<Json>,
}

impl HeadlessRef {
    pub(super) fn of(lane: &Lane) -> Option<Self> {
        let reference = lane.session_ref()?;
        // `...(prior.group ? { group } : {})`: only a truthy group is carried to a new reservation.
        let group = lane
            .0
            .get("sessionRef")
            .filter(|reference| reference.truthy("group"))
            .and_then(|reference| reference.get("group"))
            .cloned();
        (reference.runtime() == Some("headless")).then(|| Self {
            id: reference.id().unwrap_or_default().to_owned(),
            group,
        })
    }

    pub(super) fn json(&self) -> Json {
        let mut fields = vec![
            ("runtime", Json::string("headless")),
            ("id", Json::string(&self.id)),
        ];
        if let Some(group) = &self.group {
            fields.push(("group", group.clone()));
        }
        Json::object(fields)
    }
}

/// A broker observation (`HeadlessObservation`) as far as lane checks read it.
#[derive(Debug, Default)]
pub(super) struct Observation {
    pub(super) id: Option<String>,
    pub(super) runtime: Option<String>,
    pub(super) cwd: Option<String>,
    pub(super) status: String,
    pub(super) pid: Option<i64>,
    pub(super) role: Option<String>,
    pub(super) session_id: Option<String>,
    pub(super) session_file: Option<String>,
    pub(super) model: Option<String>,
    pub(super) held: bool,
    pub(super) dialogs: usize,
    pub(super) detail: bool,
}

impl Observation {
    fn base(status: &str, reference: &HeadlessRef, entry: Option<&Entry>) -> Self {
        let reserved = entry.and_then(|entry| entry.reservation.get("ref"));
        Self {
            id: Some(
                reserved
                    .and_then(|r| r.str("id"))
                    .unwrap_or(reference.id.as_str())
                    .to_owned(),
            ),
            runtime: Some("headless".to_owned()),
            cwd: entry
                .and_then(|entry| entry.reservation.str("cwd"))
                .map(str::to_owned),
            status: status.to_owned(),
            held: true,
            ..Self::default()
        }
    }

    fn parse(value: &Json) -> Result<Self> {
        let text = |key: &str| value.str(key).map(str::to_owned);
        // parseCatalyRole; an unrecognized role is an invalid observation.
        let role = match value.get("role") {
            None => None,
            Some(role) => match role.as_str() {
                Some("lane") => Some("lane".to_owned()),
                Some("cataly") => Some("cataly".to_owned()),
                _ => bail!("invalid headless runtime role"),
            },
        };
        let reference = value.get("ref");
        Ok(Self {
            id: reference.and_then(|r| r.str("id")).map(str::to_owned),
            runtime: reference.and_then(|r| r.str("runtime")).map(str::to_owned),
            cwd: text("cwd"),
            status: text("status").unwrap_or_default(),
            pid: int_field(value, "pid"),
            role,
            session_id: text("sessionId"),
            session_file: text("sessionFile"),
            model: text("model"),
            held: !matches!(value.get("held"), Some(Json::Bool(false))),
            dialogs: match value.get("dialogs") {
                Some(Json::Array(items)) => items.len(),
                _ => 1,
            },
            detail: value.get("detail").is_some(),
        })
    }
}

/// `observeHost`.
pub(super) async fn observe(state: &Path, reference: &HeadlessRef) -> Result<Observation> {
    let entry = lane_entry(state, &reference.id)?;
    let Some(entry) = entry else {
        return Ok(Observation::base("gone", reference, None));
    };
    if let Some(stopped) = read_private(&entry.dir.join("stopped.json"))? {
        let mut seen = Observation::base("gone", reference, Some(&entry));
        seen.detail = stopped.truthy("detail");
        return Ok(seen);
    }
    if read_private(&entry.dir.join("endpoint.json"))?.is_none() {
        return Ok(Observation::base("unknown", reference, Some(&entry)));
    }
    let observed = request_host(&entry, &Json::object(vec![("op", Json::string("observe"))]))
        .await
        .and_then(|value| Observation::parse(&value));
    Ok(observed.unwrap_or_else(|_| {
        let mut seen = Observation::base("unknown", reference, Some(&entry));
        seen.detail = true;
        seen
    }))
}

/// `listHosts` restricted to what lane gates read: every non-gone headless session.
pub(super) async fn hosts(state: &Path) -> Result<Vec<(HeadlessRef, Observation)>> {
    let base = data_dir(state);
    if !base.exists() {
        return Ok(Vec::new());
    }
    private_dir(&base)?;
    let mut ids = Vec::new();
    for entry in fs::read_dir(base)? {
        let name = entry?.file_name();
        if let Some(name) = name.to_str()
            && is_uuid(name, false)
        {
            ids.push(name.to_owned());
        }
    }
    ids.sort();
    let mut out = Vec::new();
    for id in ids {
        let reference = HeadlessRef { id, group: None };
        if lane_entry(state, &reference.id)?.is_none() {
            continue;
        }
        let seen = observe(state, &reference).await?;
        if seen.status != "gone" {
            out.push((reference, seen));
        }
    }
    Ok(out)
}

/// The extension's `discord-lane.json` activation record, verified against the lane (`headlessDiscordReceiver`).
pub(super) struct Binding {
    pub(super) reference: HeadlessRef,
    pub(super) receiver: Json,
    pub(super) stopped: Option<Json>,
}

impl Binding {
    pub(super) fn session(&self) -> &str {
        self.receiver.str("session").unwrap_or_default()
    }

    pub(super) fn file(&self) -> &str {
        self.receiver.str("file").unwrap_or_default()
    }

    pub(super) fn cwd(&self) -> &str {
        self.receiver.str("cwd").unwrap_or_default()
    }

    pub(super) fn pid(&self) -> i64 {
        int_field(&self.receiver, "pid").unwrap_or(0)
    }

    pub(super) fn retired_goal(&self) -> Option<&Json> {
        self.receiver.get("retiredGoal")
    }
}

fn realpath(path: &str) -> Result<String> {
    fs::canonicalize(path)?
        .into_os_string()
        .into_string()
        .map_err(|_| anyhow!("path is not UTF-8"))
}

/// `headlessDiscordReceiver(stateDir, lane)`.
pub(super) fn receiver(state: &Path, lane: &Lane) -> Result<Option<Binding>> {
    let Some(reference) = HeadlessRef::of(lane) else {
        return Ok(None);
    };
    let (Some(session), Some(file), Some(cwd)) = (lane.session(), lane.session_file(), lane.cwd())
    else {
        return Ok(None);
    };
    let Some(entry) = lane_entry(state, &reference.id)? else {
        return Ok(None);
    };
    let Some(receiver) = read_private(&entry.dir.join("discord-lane.json"))? else {
        return Ok(None);
    };
    let updated = receiver.str("updatedAt").and_then(parse_iso);
    let started = entry.reservation.str("startedAt").and_then(parse_iso);
    let opened = lane.0.str("openedAt").and_then(parse_iso);
    let fresh = match (updated, started, opened) {
        (Some(updated), Some(started), Some(opened)) => {
            updated >= started.max(opened) && updated <= now_ms() + 1000
        }
        _ => false,
    };
    let valid = receiver.str("session") == Some(session)
        && receiver.str("file") == Some(file)
        && receiver.str("cwd") == Some(realpath(cwd)?.as_str())
        && receiver.str("cwd") == entry.reservation.str("cwd")
        && int_field(&receiver, "pid").is_some_and(|pid| pid > 0)
        && fresh;
    if !valid {
        return Ok(None);
    }
    let stopped = read_private(&entry.dir.join("stopped.json"))?;
    Ok(Some(Binding {
        reference,
        receiver,
        stopped,
    }))
}

/// `headlessDiscordLaneAvailable(stateDir, lane)` (not for dispatch).
pub(super) async fn available(state: &Path, lane: &Lane) -> Result<bool> {
    let Some(binding) = receiver(state, lane)? else {
        return Ok(false);
    };
    if let Some(stopped) = &binding.stopped {
        return Ok(stopped.str("closedSessionId") == Some(binding.session())
            && binding.retired_goal().is_some());
    }
    if binding.retired_goal().is_some() {
        return Ok(false);
    }
    let seen = observe(state, &binding.reference).await?;
    Ok(live_receiver(&seen, &binding))
}

fn live_receiver(seen: &Observation, binding: &Binding) -> bool {
    seen.runtime.as_deref() == Some("headless")
        && seen.id.as_deref() == Some(binding.reference.id.as_str())
        && !seen.detail
        && matches!(seen.status.as_str(), "idle" | "working" | "blocked")
        && seen.role.as_deref() == Some("lane")
        && seen.pid == Some(binding.pid())
        && seen.session_id.as_deref() == Some(binding.session())
        && seen.session_file.as_deref() == Some(binding.file())
        && seen.cwd.as_deref() == Some(binding.cwd())
}

/// `HeadlessRuntime.create`: a fresh owner-only reservation for one lane role session.
pub(super) fn reserve(
    state: &Path,
    name: &str,
    cwd: &Path,
    group: Option<Json>,
) -> Result<HeadlessRef> {
    let reference = HeadlessRef { id: uuid()?, group };
    let cwd = fs::canonicalize(cwd)?
        .into_os_string()
        .into_string()
        .map_err(|_| anyhow!("lane directory is not UTF-8"))?;
    let base = data_dir(state);
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&base)?;
    private_dir(&base)?;
    let dir = lane_dir(state, &reference.id)?;
    DirBuilder::new().mode(0o700).create(&dir)?;
    write_private(
        &dir.join("reservation.json"),
        &Json::object(vec![
            ("ref", reference.json()),
            ("cwd", Json::string(&cwd)),
            ("name", Json::string(name)),
            ("role", Json::string("lane")),
            ("startedAt", Json::string(&iso(now_ms()))),
        ]),
    )?;
    Ok(reference)
}

/// `HostStart`, streamed to the host's stdin.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostStart<'a> {
    argv: &'a [String],
    env: &'a BTreeMap<String, String>,
    expected_resume_id: &'a str,
}

const SETSID: [&str; 2] = ["/usr/bin/setsid", "/bin/setsid"];

const HOST_ENV_REMOVED: [&str; 3] = [
    "CATALY_HEADLESS_ID",
    "CATALY_ASK_LAUNCHED_LANE",
    "CATALY_HARNESS_ROLE",
];

/// `startHost` for a lane resume: claims `started`, then spawns `<host> headless-host <dir>` detached with the start
/// record on stdin. Startup is proven later by attestation; this never waits for the native session.
pub(super) async fn start(
    state: &Path,
    reference: &HeadlessRef,
    host: &Path,
    argv: &[String],
    mut env: BTreeMap<String, String>,
    resume: (&str, &str),
) -> Result<()> {
    let entry =
        lane_entry(state, &reference.id)?.ok_or_else(|| anyhow!("headless reservation missing"))?;
    ensure!(
        entry.reservation.str("role").unwrap_or("lane") == "lane",
        "native start role mismatch"
    );
    ensure!(
        !entry.dir.join("stopped.json").exists(),
        "headless reservation has stopped"
    );
    // A competing start/close gets the same exclusive file. Never retry a spawn after ambiguity.
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(entry.dir.join("started"))
        .context("headless reservation already started")?;
    for key in HOST_ENV_REMOVED {
        env.remove(key);
    }
    let (file, session) = resume;
    let mut argv = argv.to_vec();
    argv.push(format!("--resume={file}"));
    let start = serde_json::to_vec(&HostStart {
        argv: &argv,
        env: &env,
        expected_resume_id: session,
    })?;
    // `spawn(..., { detached: true })` calls setsid(2). `unsafe_code = "forbid"` rules out `pre_exec`, so the
    // util-linux `setsid` program does it where present (it execs without forking: the child is no group leader);
    // elsewhere the host gets its own process group, which still keeps terminal job-control signals away.
    let setsid = SETSID
        .into_iter()
        .map(Path::new)
        .find(|path| path.is_file());
    let mut command = tokio::process::Command::new(setsid.unwrap_or(host));
    if setsid.is_some() {
        command.arg(host);
    } else {
        command.process_group(0);
    }
    command
        .arg("headless-host")
        .arg(&entry.dir)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(false);
    // Secrets are streamed to the child, not persisted or inserted into argv.
    for key in ["PATH", "HOME", "TMPDIR"] {
        if let Some(value) = env.get(key) {
            command.env(key, value);
        }
    }
    let mut child = command
        .spawn()
        .context("headless supervisor start unconfirmed")?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("headless supervisor input pipe unavailable"))?;
    stdin
        .write_all(&start)
        .await
        .context("headless supervisor start unconfirmed")?;
    // EOF ends the record.
    drop(stdin);
    // Dropping the handle leaves the host running; tokio reaps it if it exits while this process lives.
    drop(child);
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::PermissionsExt as _;
    use std::time::{Duration, Instant};

    use super::*;

    /// A wake runs `<host> headless-host <dir>` with only PATH/HOME/TMPDIR, streaming the start record on stdin.
    #[tokio::test]
    async fn start_runs_the_native_host_with_the_start_record() {
        let state = std::env::temp_dir().join(format!("cataly-lane-start-{}", uuid().unwrap()));
        fs::create_dir_all(&state).unwrap();
        let reference = reserve(&state, "lane", &state, None).unwrap();
        let seen = state.join("seen");
        let host = state.join("host");
        let script = format!(
            "#!/bin/sh\n{{ printf '%s\\n' \"$@\" \"${{SECRET-unset}}\" \"$PATH\"; cat; }} > {0}.tmp && mv {0}.tmp {0}\n",
            seen.display()
        );
        fs::write(&host, script).unwrap();
        fs::set_permissions(&host, fs::Permissions::from_mode(0o700)).unwrap();
        let env = BTreeMap::from(
            [
                ("PATH", "/usr/bin:/bin"),
                ("SECRET", "s"),
                ("CATALY_HEADLESS_ID", "stale"),
            ]
            .map(|(key, value)| (key.to_owned(), value.to_owned())),
        );
        let argv = ["omp".to_owned()];
        start(&state, &reference, &host, &argv, env, ("/s.jsonl", "sid"))
            .await
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while !seen.exists() && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let recorded = fs::read_to_string(&seen);
        let dir = lane_dir(&state, &reference.id).unwrap();
        let started = dir.join("started").exists();
        fs::remove_dir_all(&state).ok();
        assert!(started, "the start claim precedes the spawn");
        assert_eq!(
            recorded.unwrap(),
            format!(
                "headless-host\n{}\nunset\n/usr/bin:/bin\n{}",
                dir.display(),
                r#"{"argv":["omp","--resume=/s.jsonl"],"env":{"PATH":"/usr/bin:/bin","SECRET":"s"},"expectedResumeId":"sid"}"#
            )
        );
    }
}
