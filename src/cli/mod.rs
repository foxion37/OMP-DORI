//! `cataly <verb>`: parse, send one request to the hub, print the answer as text or `--json`.

mod args;
mod client;
mod home;
mod install;
mod lead;
pub(crate) mod out;
pub(crate) mod setup;
pub(crate) mod setup_discord;
mod slot;
mod transcribe;

use std::fmt::Write as _;
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use serde_json::{Value, json};

use crate::config;
use crate::jobs::instant_text;
use crate::jobs::owner::quota::GateView;
use crate::proto::{self, Events, JobList, Stats, Status, method};
use crate::store::EventRecord;
use crate::sys::paths::Paths;
use args::{Invocation, Parsed};
use client::{Client, ClientError};

/// Exit statuses, distinct per kind of refusal (COORD req. 75).
pub(crate) mod exit {
    pub(crate) const OK: u8 = 0;
    /// The request was refused or failed.
    pub(crate) const FAILED: u8 = 1;
    /// The command line itself was refused.
    pub(crate) const USAGE: u8 = 2;
    /// No hub answers.
    pub(crate) const NO_HUB: u8 = 3;
    /// A hub already runs.
    pub(crate) const ALREADY_RUNNING: u8 = 4;
    /// A message may or may not have arrived: never send it again (COORD req. 25).
    pub(crate) const IN_DOUBT: u8 = 5;
    /// An install operation was held: nothing changed (IR req. 34).
    pub(crate) const HELD: u8 = 6;
    /// An update or rollback was switched back: the system is as before.
    pub(crate) const SWITCHED_BACK: u8 = 7;
    /// The installation differs from both before and after; the message says what to do.
    pub(crate) const NEEDS_ATTENTION: u8 = 8;
    /// Internal failure: supervision gave up, the store writer failed, or the main loop stalled.
    pub(crate) const INTERNAL: u8 = 70;
}

/// Bound for ordinary calls.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// Bound for `job run`: the longest job time limit plus the kill grace and margin.
const RUN_TIMEOUT: Duration = Duration::from_mins(24 * 60 + 2);

/// Entry point of the binary.
pub(crate) fn main() -> ExitCode {
    let words: Vec<String> = std::env::args().skip(1).collect();
    // `slot` keeps its command's words verbatim after `--`, so it parses its own line.
    // `transcribe` takes one path or URL and runs locally against the owner's command.
    if words.first().map(String::as_str) == Some("transcribe") {
        return match Paths::from_env() {
            Ok(paths) => {
                ExitCode::from(transcribe::run(words.get(1..).unwrap_or_default(), &paths))
            }
            Err(e) => {
                out::error_line(&format!("cataly: {e}"));
                ExitCode::from(exit::FAILED)
            }
        };
    }
    if words.first().map(String::as_str) == Some("slot")
        && !words
            .iter()
            .take_while(|w| *w != "--")
            .any(|w| w == "--help")
    {
        let paths = match Paths::from_env() {
            Ok(p) => p,
            Err(e) => {
                out::error_line(&format!("cataly: {e}"));
                return ExitCode::from(exit::FAILED);
            }
        };
        return ExitCode::from(slot::run(words.get(1..).unwrap_or_default(), &paths.socket));
    }
    let parsed = match args::parse(&words) {
        Ok(Invocation::Run(parsed)) => parsed,
        Ok(Invocation::Help(text)) => {
            out::text(&text);
            return ExitCode::from(exit::OK);
        }
        Err(refusal) => {
            out::error_line(&format!("cataly: {refusal}"));
            return ExitCode::from(exit::USAGE);
        }
    };
    let paths = match Paths::from_env() {
        Ok(p) => p,
        Err(e) => {
            out::error_line(&format!("cataly: {e}"));
            return ExitCode::from(exit::FAILED);
        }
    };
    if parsed.is(&["hub"]) {
        return crate::hub::run(&paths);
    }
    ExitCode::from(match execute(&parsed, &paths) {
        Ok(()) => exit::OK,
        Err(Failure::Usage(m)) => fail(exit::USAGE, &m),
        Err(Failure::Refused(m)) => fail(exit::FAILED, &m),
        Err(Failure::Status(code, m)) => fail(code, &m),
        Err(Failure::Client(ClientError::NoHub)) => fail(
            exit::NO_HUB,
            &format!(
                "the hub is not running (no answer on {})",
                paths.socket.display()
            ),
        ),
        Err(Failure::Client(e)) => fail(exit::FAILED, &e.to_string()),
    })
}

fn fail(code: u8, message: &str) -> u8 {
    out::error_line(&format!("cataly: {message}"));
    code
}

enum Failure {
    Usage(String),
    Refused(String),
    /// A distinct exit status with its message (a failed limits fetch exits 2, WS req. 38).
    Status(u8, String),
    Client(ClientError),
}

impl From<ClientError> for Failure {
    fn from(e: ClientError) -> Self {
        Self::Client(e)
    }
}

fn decode<T: serde::de::DeserializeOwned>(value: Value) -> Result<T, Failure> {
    serde_json::from_value(value).map_err(|e| Failure::Refused(format!("unexpected reply: {e}")))
}

fn execute(p: &Parsed, paths: &Paths) -> Result<(), Failure> {
    let as_json = p.flag("--json");
    if p.is(&["config", "check"]) {
        let file = p
            .value("--file")
            .map_or(paths.config_file.as_path(), Path::new);
        return config_check(file, as_json);
    }
    if p.is(&["setup"]) {
        owner_only(paths)?;
        return setup::run(p, paths, as_json);
    }
    if matches!(
        p.spec.path,
        ["install" | "update" | "rollback" | "uninstall"] | ["service", _]
    ) {
        owner_only(paths)?;
    }
    if let Some(done) = install::run(p, paths) {
        return done;
    }
    let mut hub = Client::connect(&paths.socket)?;
    if let Some(done) = owner_verbs(p, &mut hub, as_json) {
        return done;
    }
    match p.spec.path {
        ["status"] => {
            let reply = hub.call(method::STATUS, json!({}), CALL_TIMEOUT)?;
            if as_json {
                out::json(&reply);
            } else {
                print_status(&decode(reply)?);
            }
        }
        ["stats"] => {
            let reply = hub.call(method::STATS, json!({}), CALL_TIMEOUT)?;
            if as_json {
                out::json(&reply);
            } else {
                print_stats(&decode(reply)?);
            }
        }
        ["events"] => events(p, &mut hub, as_json)?,
        ["job", "list"] => {
            let reply = hub.call(method::JOB_LIST, json!({}), CALL_TIMEOUT)?;
            if as_json {
                out::json(&reply);
            } else {
                print_jobs(&decode(reply)?);
            }
        }
        ["job", "run"] => {
            let reply = hub.call(
                method::JOB_RUN,
                json!({ "name": p.args.first() }),
                RUN_TIMEOUT,
            )?;
            if as_json {
                out::json(&reply);
            } else {
                let events: Events = decode(reply)?;
                if events.events.is_empty() {
                    out::line("dry run done; no events (nothing changed)");
                }
                for e in &events.events {
                    print_event(e);
                }
            }
        }
        ["job", verb @ ("enable" | "disable")] => {
            job_hold(p, &mut hub, *verb == "enable", as_json)?;
        }
        ["config", "reload"] => {
            let reply = hub.call(method::CONFIG_RELOAD, json!({}), CALL_TIMEOUT)?;
            if as_json {
                out::json(&reply);
            } else {
                let r: proto::Reloaded = decode(reply)?;
                out::line(&format!("config applied: {} jobs", r.jobs));
            }
        }
        other => {
            return Err(Failure::Usage(format!(
                "'{}' is not handled here",
                other.join(" ")
            )));
        }
    }
    Ok(())
}

/// Commands that act locally with the owner's authority first ask the hub who calls (DESIGN 8):
/// inside a session they are refused. With no hub to ask, a caller that carries a session's launch
/// token is refused too (fail closed); anyone else is the owner.
fn owner_only(paths: &Paths) -> Result<(), Failure> {
    let role = match Client::connect(&paths.socket) {
        Ok(mut hub) => hub
            .call(method::WHOAMI, json!({}), CALL_TIMEOUT)
            .ok()
            .and_then(|v| v.get("role").and_then(Value::as_str).map(str::to_string)),
        Err(ClientError::Unsafe(e)) => return Err(Failure::Refused(e)),
        Err(_) => None,
    };
    match role.as_deref() {
        Some("owner") => Ok(()),
        None if client::launch_token().is_none() => Ok(()),
        Some(other) => Err(Failure::Refused(format!(
            "only the owner may run this; it runs inside a Cataly session ({other})"
        ))),
        None => Err(Failure::Refused(
            "only the owner may run this; it runs inside a Cataly session and no hub confirms \
             otherwise"
                .into(),
        )),
    }
}

/// `job enable` (resume, `--ack` after a broken-off run) and `job disable` (hold).
fn job_hold(p: &Parsed, hub: &mut Client, enable: bool, as_json: bool) -> Result<(), Failure> {
    let name = p.args.first().cloned().unwrap_or_default();
    let (m, params) = if enable {
        (
            method::JOB_ENABLE,
            json!({ "name": name, "ack": p.flag("--ack") }),
        )
    } else {
        (method::JOB_DISABLE, json!({ "name": name }))
    };
    let reply = hub.call(m, params, CALL_TIMEOUT)?;
    if as_json {
        out::json(&reply);
    } else {
        let state = if enable { "resumed" } else { "on hold" };
        out::line(&format!("job {name} {state}"));
    }
    Ok(())
}

fn events(p: &Parsed, hub: &mut Client, as_json: bool) -> Result<(), Failure> {
    let mut params = proto::EventsParams::default();
    if let Some(after) = p.value("--after") {
        params.after = Some(
            after
                .parse()
                .map_err(|_| Failure::Usage(format!("--after: '{after}' is not an event id")))?,
        );
    }
    if let Some(since) = p.value("--since") {
        params.since_ms = Some(since_ms(since).ok_or_else(|| {
            Failure::Usage(format!("--since: '{since}' is neither a duration like 10m nor an instant like 2026-11-25T08:00:00Z"))
        })?);
    }
    if let Some(limit) = p.value("--limit") {
        params.limit = Some(
            limit
                .parse()
                .map_err(|_| Failure::Usage(format!("--limit: '{limit}' is not a number")))?,
        );
    }
    let print = |value: Value| {
        if as_json {
            out::json(&value);
        } else if let Ok(e) = serde_json::from_value::<EventRecord>(value) {
            print_event(&e);
        }
    };
    if p.flag("--follow") {
        if params.after.is_none() && params.since_ms.is_some() {
            // Show what happened since then, then keep following from the newest shown.
            let reply = hub.call(
                method::EVENTS_SINCE,
                serde_json::to_value(&params).unwrap_or_default(),
                CALL_TIMEOUT,
            )?;
            let past: Events = decode(reply)?;
            params.after = Some(past.events.last().map_or(0, |e| e.id));
            past.events
                .into_iter()
                .filter_map(|e| serde_json::to_value(e).ok())
                .for_each(print);
        }
        let follow = proto::EventsParams {
            after: params.after,
            since_ms: None,
            limit: None,
        };
        hub.follow(
            method::EVENTS_FOLLOW,
            serde_json::to_value(&follow).unwrap_or_default(),
            print,
        )?;
        return Ok(());
    }
    let reply = hub.call(
        method::EVENTS_SINCE,
        serde_json::to_value(&params).unwrap_or_default(),
        CALL_TIMEOUT,
    )?;
    let events: Events = decode(reply)?;
    events
        .events
        .into_iter()
        .filter_map(|e| serde_json::to_value(e).ok())
        .for_each(print);
    Ok(())
}

/// `10m`-style durations count back from now; anything else must be an instant with an offset.
fn since_ms(text: &str) -> Option<i64> {
    if let Some(d) = config::parse_duration(text) {
        return Some(crate::sys::now_ms().saturating_sub(crate::jobs::duration_ms(d)));
    }
    text.parse::<jiff::Timestamp>()
        .ok()
        .map(jiff::Timestamp::as_millisecond)
}

fn config_check(path: &Path, as_json: bool) -> Result<(), Failure> {
    match config::load(path) {
        Ok(c) => {
            let soon: Vec<String> = c
                .jobs
                .values()
                .filter_map(|j| match &j.trigger {
                    config::Trigger::Once { at } => {
                        let left = at.as_millisecond() - crate::sys::now_ms();
                        (left > 0 && left < 120_000)
                            .then(|| format!("jobs.{}.at is less than two minutes away", j.name))
                    }
                    _ => None,
                })
                .collect();
            if as_json {
                out::json(&json!({
                    "valid": true, "file": path.display().to_string(), "jobs": c.jobs.len(),
                    "destinations": c.destinations.len(), "warnings": soon,
                }));
            } else {
                out::line(&format!(
                    "config valid: {} ({} jobs, {} destinations)",
                    path.display(),
                    c.jobs.len(),
                    c.destinations.len()
                ));
                for w in &soon {
                    out::line(&format!("warning: {w}"));
                }
            }
            Ok(())
        }
        Err(errors) => {
            if as_json {
                let list: Vec<Value> = errors
                    .iter()
                    .map(|e| json!({"path": e.path, "message": e.message}))
                    .collect();
                out::json(
                    &json!({ "valid": false, "file": path.display().to_string(), "errors": list }),
                );
            } else {
                for e in &errors {
                    out::error_line(&format!("{e}"));
                }
            }
            Err(Failure::Refused(format!(
                "config invalid: {} error(s) in {}",
                errors.len(),
                path.display()
            )))
        }
    }
}

fn duration_text(seconds: i64) -> String {
    let (d, h, m) = (
        seconds / 86_400,
        seconds % 86_400 / 3600,
        seconds % 3600 / 60,
    );
    match (d, h, m) {
        (0, 0, m) => format!("{m}m"),
        (0, h, m) => format!("{h}h{m}m"),
        (d, h, _) => format!("{d}d{h}h"),
    }
}

fn print_status(s: &Status) {
    out::line(&format!(
        "hub {} running, pid {}, up {}",
        s.version,
        s.pid,
        duration_text(s.uptime_s)
    ));
    out::line(&format!("socket   {}", s.socket));
    out::line(&format!("state    {}", s.state_dir));
    match &s.config_error {
        None => out::line(&format!("config   {}", s.config_file)),
        Some(e) => out::line(&format!(
            "config   {} NOT APPLIED (previous config in force): {e}",
            s.config_file
        )),
    }
    out::line(&format!(
        "jobs     {} configured, {} running",
        s.jobs, s.jobs_running
    ));
    out::line(&format!("events   last id {}", s.last_event_id));
    match &s.omp {
        Some(r) => out::line(&format!("omp      {}", r.summary())),
        None => out::line("omp      not probed yet"),
    }
    if let Some(why) = &s.sessions_refused {
        out::line(&format!("sessions refused: {why}"));
    }
    // Always shown, so a missing lead is never silent.
    match &s.lead {
        Some(lead) => out::line(&format!("lead     {lead}")),
        None => out::line(
            "lead     no lead configured: messages wait; set one with cataly setup --lead-model provider/id",
        ),
    }
    print_gate(&s.quota_gate);
    if s.task_restarts > 0 || s.panics > 0 {
        out::line(&format!(
            "tasks    {} restarts, {} panics",
            s.task_restarts, s.panics
        ));
    }
}

fn print_gate(g: &GateView) {
    let causes: Vec<String> = g
        .causes
        .iter()
        .map(|c| format!("{} until {}", c.limit, instant_text(c.release_ms)))
        .collect();
    let line = match (g.held, causes.is_empty(), g.lifted_until_ms) {
        (true, false, _) => format!(
            "holding new sessions on {}; others start as usual ({})",
            g.providers.join(", "),
            causes.join(", ")
        ),
        (false, false, Some(until)) => {
            format!(
                "lifted by the owner until {} ({})",
                instant_text(until),
                causes.join(", ")
            )
        }
        _ => "open".to_string(),
    };
    out::line(&format!("quota    {line}"));
}

/// `cataly lane <op> [--params <json>]`: one request per lane operation; `op` and the JSON object's
/// fields are the same as the lead's `lane.<op>` tool operations.
fn lane(hub: &mut Client, p: &Parsed, as_json: bool) -> Result<(), Failure> {
    // A start or reopen may take the whole start deadline (LANE req. 15, default 180 s).
    const LANE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(240);
    let mut params: Value = match p.value("--params") {
        Some(text) => {
            serde_json::from_str(text).map_err(|e| Failure::Usage(format!("--params: {e}")))?
        }
        None => json!({}),
    };
    let map = params
        .as_object_mut()
        .ok_or_else(|| Failure::Usage("--params must be a JSON object".into()))?;
    map.insert(
        "op".into(),
        json!(p.args.first().cloned().unwrap_or_default()),
    );
    let value = hub.call(method::LANE, params, LANE_TIMEOUT)?;
    match value {
        Value::String(text) if !as_json => out::line(&text),
        other => out::json(&other),
    }
    Ok(())
}

/// `voice status`, `voice restart` and `voice reply`.
fn voice(hub: &mut Client, p: &Parsed, verb: &str, as_json: bool) -> Result<(), Failure> {
    let (m, params) = match verb {
        "status" => (method::VOICE_STATUS, json!({})),
        "restart" => (method::VOICE_RESTART, json!({})),
        _ => (
            method::VOICE_REPLY,
            json!({
                "request": p.args.first(),
                "reply": p.args.get(1),
                "subject": p.value("--subject"),
            }),
        ),
    };
    let v = hub.call(m, params, CALL_TIMEOUT)?;
    if as_json {
        out::json(&v);
        return Ok(());
    }
    let field = |k: &str| match v.get(k) {
        Some(Value::String(s)) => s.clone(),
        None | Some(Value::Null) => "-".into(),
        Some(other) => other.to_string(),
    };
    match verb {
        "status" => {
            out::line(&format!("voice    {}", field("state")));
            if v.get("reason").is_some_and(|r| !r.is_null()) {
                out::line(&format!("reason   {}", field("reason")));
            }
            for k in ["transport", "held", "call", "present", "replies_waiting"] {
                if v.get(k).is_some() {
                    out::line(&format!("{k:<8} {}", field(k)));
                }
            }
            if let Some(t) = v.get("today").filter(|t| t.is_object()) {
                out::line(&format!(
                    "today    {} s speech, {} sessions, {:.2} USD",
                    t["speech_seconds"].as_f64().unwrap_or(0.0).round(),
                    t["sessions"],
                    t["spend_usd"].as_f64().unwrap_or(0.0)
                ));
            }
        }
        "restart" => out::line(&match v.get("lifted").and_then(Value::as_str) {
            Some(r) => format!("voice hold lifted ({r}); voice starts again"),
            None => "voice starts again".into(),
        }),
        _ => out::line(&format!("reply queued for {}", field("request"))),
    }
    Ok(())
}

/// `health`, `limits`, `quota`, `pr` and `lead` verbs; `None` for anything else.
fn owner_verbs(p: &Parsed, hub: &mut Client, as_json: bool) -> Option<Result<(), Failure>> {
    if let Some(done) = lead::verbs(p, hub, as_json) {
        return Some(done);
    }
    if let Some(done) = lead::relay_verbs(p, hub, as_json) {
        return Some(done);
    }
    let target = p.args.first().cloned();
    let result = match p.spec.path {
        ["health"] => health(hub, as_json),
        ["lane"] => lane(hub, p, as_json),
        ["voice", verb] => voice(hub, p, verb, as_json),
        ["limits"] => limits(hub, p.flag("--refresh"), as_json),
        ["quota"] => hub
            .call(method::QUOTA, json!({}), CALL_TIMEOUT)
            .map_err(Failure::from)
            .and_then(|v| show(v, as_json, |g: GateView| print_gate(&g))),
        ["quota", "lift"] => hub
            .call(method::QUOTA_LIFT, json!({}), CALL_TIMEOUT)
            .map_err(Failure::from)
            .and_then(|v| show(v, as_json, |g: GateView| print_gate(&g))),
        ["pr", verb @ ("follow" | "unfollow")] => {
            let m = if *verb == "follow" {
                method::PR_FOLLOW
            } else {
                method::PR_UNFOLLOW
            };
            hub.call(
                m,
                json!({ "target": target, "job": p.value("--job") }),
                CALL_TIMEOUT,
            )
            .map_err(Failure::from)
            .and_then(|v| {
                show(v, as_json, |v: Value| {
                    out::line(&format!(
                        "{verb}ing {}",
                        v.get("pr").and_then(Value::as_str).unwrap_or_default()
                    ));
                })
            })
        }
        ["pr", "list"] => hub
            .call(method::PR_LIST, json!({}), CALL_TIMEOUT)
            .map_err(Failure::from)
            .and_then(|v| {
                show(v, as_json, |l: proto::PrList| {
                    if l.prs.is_empty() {
                        out::line("no pull requests followed");
                    }
                    for pr in &l.prs {
                        let error = pr
                            .error
                            .as_deref()
                            .map_or_else(String::new, |e| format!("  error: {e}"));
                        out::line(&format!(
                            "{:<32} {:<12} {:<8} since {}{error}",
                            pr.pr,
                            pr.job,
                            pr.state,
                            instant_text(pr.since_ms)
                        ));
                    }
                })
            }),
        _ => return None,
    };
    Some(result)
}

/// Prints a reply as JSON, or decodes it and prints it as text.
fn show<T: serde::de::DeserializeOwned>(
    value: Value,
    as_json: bool,
    print: impl FnOnce(T),
) -> Result<(), Failure> {
    if as_json {
        out::json(&value);
        return Ok(());
    }
    print(decode(value)?);
    Ok(())
}

fn health(hub: &mut Client, as_json: bool) -> Result<(), Failure> {
    let reply = hub.call(method::HEALTH, json!({}), CALL_TIMEOUT)?;
    let report: proto::Health = decode(reply.clone())?;
    if as_json {
        out::json(&reply);
    } else {
        for c in &report.checks {
            let ignored = if report.ignored.contains(&c.name) {
                " (ignored)"
            } else {
                ""
            };
            let next = c
                .next
                .as_deref()
                .map_or_else(String::new, |n| format!("; next: {n}"));
            out::line(&format!(
                "{:<5} {:<24} {}{next}{ignored}",
                c.level.to_uppercase(),
                c.name,
                c.detail
            ));
        }
    }
    if report.warn {
        return Err(Failure::Refused("health: warnings remain".into()));
    }
    Ok(())
}

fn limits(hub: &mut Client, refresh: bool, as_json: bool) -> Result<(), Failure> {
    let reply = hub.call(method::LIMITS, json!({ "refresh": refresh }), CALL_TIMEOUT)?;
    let view: proto::Limits = decode(reply.clone())?;
    if as_json {
        out::json(&reply);
    } else {
        if view.accounts.is_empty() {
            out::line("no account data from OMP (nothing is shown as zero use)");
        }
        for a in &view.accounts {
            out::line(&format!("{} account {}", a.provider, a.account));
            for w in &a.windows {
                let used = w
                    .used_percent
                    .map_or_else(|| "unknown".into(), |u| format!("{u:.0}%"));
                let reset = w.reset_ms.map_or_else(
                    || "reset unknown".into(),
                    |r| format!("resets {}", instant_text(r)),
                );
                let room = w.headroom_percent.map_or_else(String::new, |h| {
                    format!(", {h:.0} points to the warning level")
                });
                out::line(&format!("  {:<12} {used} used, {reset}{room}", w.label));
            }
            for n in &a.notes {
                out::line(&format!("  note: {n}"));
            }
        }
        if view.without_usage > 0 || view.disabled > 0 {
            out::line(&format!(
                "{} account(s) without usage data, {} disabled",
                view.without_usage, view.disabled
            ));
        }
        if view.stale {
            out::line(&format!(
                "stale: {}",
                view.fetched_ms.map_or_else(
                    || "never fetched".into(),
                    |f| format!("fetched {}", instant_text(f))
                )
            ));
        }
    }
    match view.error {
        Some(e) => Err(Failure::Status(2, format!("limits fetch failed: {e}"))),
        None => Ok(()),
    }
}
fn mib(bytes: u64) -> String {
    format!(
        "{}.{} MiB",
        bytes / 1_048_576,
        bytes % 1_048_576 * 10 / 1_048_576
    )
}

fn print_stats(s: &Stats) {
    out::line(&format!(
        "hub memory      {}",
        s.rss_bytes.map_or_else(|| "unavailable".into(), mib)
    ));
    if let Some(m) = &s.host_memory {
        let mut line = format!(
            "host memory     {} available of {}",
            mib(m.available),
            mib(m.total)
        );
        if let Some(limit) = m.cgroup_limit {
            let _ = write!(line, ", cgroup limit {}", mib(limit));
        }
        out::line(&line);
    }
    if let Some(l) = &s.host_load {
        out::line(&format!(
            "host load       {:.2} {:.2} {:.2} on {} cores",
            l.one, l.five, l.fifteen, l.cores
        ));
    }
    if let Some(d) = &s.state_disk {
        out::line(&format!(
            "state disk      {} free of {}",
            mib(d.available),
            mib(d.total)
        ));
    }
    for (name, lat) in [
        ("control request", &s.control_latency),
        ("store commit", &s.store_commit_latency),
    ] {
        match lat {
            Some(l) => out::line(&format!(
                "{name:<15} p50 {} us, p99 {} us, max {} us over {} samples",
                l.p50_us, l.p99_us, l.max_us, l.count
            )),
            None => out::line(&format!("{name:<15} no samples yet")),
        }
    }
}

fn print_jobs(list: &JobList) {
    if list.jobs.is_empty() {
        out::line("no jobs configured");
        return;
    }
    for j in &list.jobs {
        let due = j.next_due_ms.map_or_else(|| "-".into(), instant_text);
        let outcome = j
            .last_run
            .as_ref()
            .and_then(|r| r.outcome.clone())
            .unwrap_or_else(|| "-".into());
        let mut line = format!(
            "{:<20} {:<6} {:<20} next {due}  last {outcome}",
            j.name, j.kind, j.state
        );
        if j.dry_run {
            line.push_str("  [dry run]");
        }
        if j.needs_ack {
            line.push_str("  [needs --ack]");
        }
        if j.skipped > 0 {
            let _ = write!(line, "  skipped {}", j.skipped);
        }
        if j.error_streak > 0 {
            let _ = write!(line, "  errors {}", j.error_streak);
        }
        out::line(&line);
    }
}

fn print_event(e: &EventRecord) {
    let mut marks = String::new();
    if e.urgent {
        marks.push_str(" urgent");
    }
    if e.dry {
        marks.push_str(" dry");
    }
    out::line(&format!(
        "#{} {} {:<9}{marks} {}",
        e.id,
        instant_text(e.at_ms),
        e.severity,
        e.text
    ));
    if let Some(path) = &e.body_path {
        out::line(&format!("    body: {path}"));
    }
}
