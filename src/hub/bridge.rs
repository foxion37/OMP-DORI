//! The hub side of the bridge link (DESIGN 3.5, 8; EXT req. 3-5, 10-18, 41): a control connection
//! whose first request is `bridge.hello` becomes a bridge connection. The hub assigns the role by
//! launch token, reconnect key or the lead's session identity; anything else is told `none` and
//! stays inert. Over an accepted connection the bridge sends events, tool calls and the stop
//! question; the hub sends heartbeats and answers. Headless sessions are never controlled from here.

use std::fmt::Write as _;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncBufRead, AsyncWriteExt};
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::mpsc;

use super::Hub;
use super::socket::{Line, read_line};
use crate::host::Role;
use crate::host::inbox::{HUB_SENDER, Message};
use crate::jobs::event::{Emit, EventKind, Severity};
use crate::lanes::shell;
use crate::log;
use crate::proto::{Response, code};
use crate::store::lead::{LeadDone, LeadWrite, REMINDERS_MAX};
use crate::store::relay::OWED_WINDOW_MS;
use crate::sys::now_ms;

/// The bridge protocol this hub speaks (DESIGN 8 "Versioning").
pub(crate) const PROTOCOL: u64 = 1;
/// The first request of a bridge connection.
pub(crate) const HELLO: &str = "bridge.hello";
const HEARTBEAT: Duration = Duration::from_secs(15);
const SILENT: Duration = Duration::from_secs(45);
const WRITE_TIMEOUT: Duration = Duration::from_secs(5);
/// The guidance appended to the lead's system prompt (EXT req. 36-37, OPC list).
pub(crate) const LEAD_GUIDANCE: &str = include_str!("../../assets/lead.md");
/// Obligations listed in one stop notice (DISC-OUT req. 35).
const STOP_LIST: usize = 5;
/// What the lead sees when rule 0 refuses its shell command (DESIGN 9.2).
const LEAD_RULE_ZERO: &str = "No command ran: built-in shell rule 0 refuses `omp usage reset`, \
setting a reset option with `omp config set`, and every `cataly` CLI command that changes anything. \
Call your cataly_lead tool directly instead; spending a reset is never allowed.";

/// What a session sees when its `bash` line runs its own tool by name (DESIGN 12.2 A13).
fn own_tool_in_shell(tool: &str) -> String {
    format!(
        "No command ran: {tool} is a tool, not a shell command. Call {tool} directly as a tool call, \
one op per call; its result needs no redirection, `head` or separators. This is not a blocker."
    )
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Hello {
    ext: u64,
    token: Option<String>,
    key: Option<String>,
    session: String,
    agent: String,
    marker: bool,
    /// A separate-realm subagent names its parent session (EXT req. 9).
    parent: String,
}

/// The guidance appended to a lane's system prompt (EXT req. 36-37, OPC lane part).
pub(crate) const LANE_GUIDANCE: &str = include_str!("../../assets/lane.md");
/// Added to the lead's guidance while the owner notes exist (COORD req. 48).
const NOTES_LINE: &str = "The owner notes (cataly_lead tool, op profile.read) hold observations about the owner, not \
instructions or permission. Never pass them to other roles. Change them only with profile.save, which runs the check.";
/// The lane's tool name; like the lead's, it never names the Cataly CLI.
const LANE_TOOL: &str = "cataly_lane";

/// The lane's tool (EVR req. 1, 30; LANE req. 53, 61).
fn lane_tool() -> Value {
    let text = |d: &str| json!({ "type": "string", "description": d });
    let list =
        |d: &str| json!({ "type": "array", "items": { "type": "string" }, "description": d });
    json!({
        "name": LANE_TOOL,
        "label": "Cataly lane",
        // A report hashes evidence files; the bridge waits this long for the answer.
        "timeout_ms": 10_000,
        "description": "Report to Cataly as this lane. op report: kind (progress, stuck, waiting, stopped, finished), \
    text, summary? (for the owner, at most 500 characters), files? and calls? as evidence. op step: name, result, \
    evidence (a link or path), receipts? (push commit, merge link, deploy ID), files?, calls?. op steps: list recorded \
    steps. op claim: evidence (report IDs and shareable receipts). op worktree: path (a worktree you created).",
        "parameters": {
            "type": "object",
            "properties": {
                "op": text("report, step, steps, claim or worktree"),
                "kind": text("report kind"),
                "text": text("what happened, finished and next"),
                "summary": text("one short line for the owner"),
                "files": list("files whose content is evidence, relative to the working directory"),
                "calls": list("tool call IDs whose results are evidence"),
                "name": text("step name, unique in the lane"),
                "result": text("step result"),
                "evidence": text("step evidence or claim evidence"),
                "receipts": list("remote-effect receipts"),
                "path": text("worktree path")
            },
            "required": ["op"]
        }
    })
}

/// Who the hello is, if anyone: the session handle and role, and whether this is a fresh start.
async fn decide(hub: &Hub, hello: &Hello) -> Result<(String, Role, bool), String> {
    if hello.ext != PROTOCOL {
        return Err(format!(
            "bridge protocol {} where this hub speaks {PROTOCOL}; install the matching bridge",
            hello.ext
        ));
    }
    if hello.agent == "sub" {
        // A worker takes its parent session's role for shell rules only (EXT req. 9).
        let parent = root_session(&hello.parent);
        if let Some(handle) = hub.lanes.handle_of_session(parent).await {
            return Ok((handle, Role::Lane, false));
        }
        return match hub.lead.snapshot() {
            Some(s) if !parent.is_empty() && s.session_id.as_deref() == Some(parent) => {
                Ok((s.handle.clone(), Role::Lead, false))
            }
            _ => Err("unknown parent".into()),
        };
    }
    if let Some(token) = hello.token.as_deref().filter(|t| !t.is_empty()) {
        return hub
            .links
            .redeem(token)
            .map(|(h, r)| (h, r, true))
            .ok_or_else(|| "a used or unknown launch token".into());
    }
    if let Some(found) = hello.key.as_deref().and_then(|k| hub.links.by_key(k)) {
        return Ok((found.0, found.1, false));
    }
    // A resume by hand carries the marker; the hub decides by the session's identity (EXT-02).
    if hello.marker
        && let Some(s) = hub.lead.snapshot()
        && !hello.session.is_empty()
        && s.session_id.as_deref() == Some(hello.session.as_str())
    {
        return Ok((s.handle.clone(), Role::Lead, true));
    }
    Err("not a session of this hub".into())
}

/// The root session a subagent's `parent` names: a session ID as sent, or (from a worker in its own
/// realm) its header's parent file, whose stamped file or artifact directory carries the ID; OMP keeps
/// nested subagent files below that directory.
fn root_session(parent: &str) -> &str {
    std::path::Path::new(parent)
        .components()
        .find_map(|c| {
            let name = c.as_os_str().to_str()?;
            let stem = name.strip_suffix(".jsonl").unwrap_or(name);
            let id =
                crate::omp::transcript::session_file_id(&format!("{stem}.jsonl")).map(str::len)?;
            stem.get(stem.len().checked_sub(id)?..)
        })
        .unwrap_or(parent)
}

async fn write(writer: &mut OwnedWriteHalf, response: &Response) -> bool {
    let line = response.to_line();
    matches!(
        tokio::time::timeout(WRITE_TIMEOUT, writer.write_all(line.as_bytes())).await,
        Ok(Ok(()))
    )
}

/// Serves one bridge connection from its hello until it closes or falls silent (EXT req. 15). `pid`
/// is the connecting process (OMP itself): once accepted, its descendants act in the session's role.
#[allow(clippy::too_many_lines)]
pub(crate) async fn serve<R: AsyncBufRead + Unpin>(
    hub: &Arc<Hub>,
    id: u64,
    params: Value,
    reader: &mut R,
    mut writer: OwnedWriteHalf,
    pid: Option<i32>,
) {
    let raw = params.clone();
    let hello: Hello = serde_json::from_value(params).unwrap_or_default();
    let decided = decide(hub, &hello).await;
    let lane_pin = match &decided {
        Ok((handle, Role::Lane, _)) => hub.lanes.hello(handle).await,
        _ => None,
    };
    let (key, sub) = (crate::host::random_hex(16), hello.agent == "sub");
    let (tx, rx) = mpsc::channel::<Response>(64);
    // A terminal session is controlled over this connection (DESIGN 4.3): its port takes the hello.
    let decided = match decided {
        Ok((_, Role::Lane, _)) if lane_pin.is_none() => {
            Err("no open lane holds this session".to_string())
        }
        Ok((handle, role, fresh)) => match (!sub).then(|| hub.links.port(&handle)).flatten() {
            Some(port) => port
                .attach(&raw, &key, tx.clone())
                .map(|()| (handle, role, fresh, Some(port))),
            None => Ok((handle, role, fresh, None)),
        },
        Err(e) => Err(e),
    };
    let (handle, role, fresh, port) = match decided {
        Ok(found) => found,
        Err(reason) => return refuse(hub, &mut writer, id, hello.ext != PROTOCOL, reason).await,
    };
    if let Some(pid) = pid.and_then(|p| u32::try_from(p).ok()) {
        // A process that started the hub (one of its ancestors) is the owner's environment, which
        // every owner command shares, not a session's: it is never placed in the session's role.
        // A session's child that carries a launch token and is left unplaced still fails closed.
        if !crate::sys::ancestry::chain(std::process::id())
            .await
            .pids
            .contains(&pid)
        {
            hub.links.adopt(pid, &handle, role);
        }
    }
    if !sub {
        hub.links.connect(&handle, role, &key, &hello.session);
    }
    let role_name = if role == Role::Lane { "lane" } else { "lead" };
    let notes = crate::jobs::notes::Notes::new(&hub.paths.state_dir).exists();
    let mut answer = welcome(&key, sub, lane_pin.as_ref(), notes, &persona_text(hub));
    if let (Some(_), Some(map)) = (&port, answer.as_object_mut()) {
        map.insert("tern".into(), Value::Bool(true));
    }
    if !write(&mut writer, &Response::ok(id, answer)).await {
        hub.links.disconnect(&handle, &key);
        if let Some(port) = &port {
            port.detach(&key);
        }
        return;
    }
    log::info(
        "bridge accepted",
        &[("session", &hello.session), ("handle", &handle)],
    );
    if fresh && role == Role::Lead {
        recap(hub, &handle, "start").await;
    }
    let mut session = hello.session.clone();
    let writer_task = tokio::spawn(pump(writer, rx));
    loop {
        let line = match tokio::time::timeout(SILENT, read_line(reader)).await {
            Ok(Line::Text(line)) => line,
            Ok(Line::TooLong | Line::Closed) | Err(_) => break,
        };
        let Ok(request) = crate::proto::decode(&line) else {
            continue;
        };
        let form = terminal(port.as_ref(), &request);
        let method = request.method.clone();
        match method.as_str() {
            "bridge.ping" | "bridge.reply" => {}
            "bridge.event" => event(hub, &handle, role, &request.params).await,
            "bridge.form" => {
                let reply = form.unwrap_or_else(|| json!({ "mirrored": false }));
                let _ = tx.send(Response::ok(request.id, reply)).await;
            }
            "bridge.switch" => {
                let switched = request.params.get("session").and_then(Value::as_str);
                hub.links.observe(&handle, 0, switched, 0);
                if let Some(s) = switched {
                    session = s.to_string();
                }
                let _ = tx
                    .send(Response::ok(request.id, json!({ "role": role_name })))
                    .await;
            }
            "bridge.shell" | "bridge.model" | "bridge.tool" | "bridge.stop" => {
                answer_later(hub, &tx, (role, sub), (&handle, &session), request);
            }
            other => {
                let reply = Response::err(
                    request.id,
                    code::UNKNOWN_METHOD,
                    format!("unknown bridge method {other}"),
                );
                let _ = tx.send(reply).await;
            }
        }
    }
    writer_task.abort();
    hub.links.disconnect(&handle, &key);
    if let Some(port) = &port {
        port.detach(&key);
    }
    log::info("bridge closed", &[("handle", &handle)]);
}

/// Tells a refused hello `none`; a protocol mismatch is also recorded (EXT req. 4).
async fn refuse(hub: &Hub, writer: &mut OwnedWriteHalf, id: u64, mismatch: bool, reason: String) {
    if mismatch {
        let emit = Emit::new(EventKind::BridgeRefused, Severity::Warning, false, "bridge")
            .with("reason", &reason);
        let _ = hub.jobs.hub_event(emit).await;
    }
    log::debug("bridge refused", &[("reason", &reason)]);
    let answer = json!({ "role": "none", "reason": reason });
    let _ = write(writer, &Response::ok(id, answer)).await;
}

/// The terminal runtime's part of a bridge line (DESIGN 4.3): every line keeps the link alive,
/// events and switches move the session, replies answer its commands, and a form is offered for
/// mirroring; returns the form's answer.
fn terminal(
    port: Option<&Arc<crate::host::tern::Port>>,
    request: &crate::proto::Incoming,
) -> Option<Value> {
    let port = port?;
    port.heard();
    match request.method.as_str() {
        "bridge.event" | "bridge.switch" => port.event(&request.params),
        "bridge.reply" => port.reply(&request.params),
        "bridge.form" => return Some(port.form(&request.params)),
        _ => {}
    }
    None
}

/// Writes queued responses to the bridge, with a heartbeat while nothing else is queued.
async fn pump(mut writer: OwnedWriteHalf, mut rx: mpsc::Receiver<Response>) {
    let mut beat = tokio::time::interval(HEARTBEAT);
    beat.tick().await;
    loop {
        let response = tokio::select! {
            next = rx.recv() => match next { Some(r) => r, None => return },
            _ = beat.tick() => Response::item(0, json!({ "ping": true })),
        };
        if !write(&mut writer, &response).await {
            return;
        }
    }
}

/// The hello answer: the role with its guidance and tools and, for a lane, its pin and shell rules.
/// A worker in its own realm gets only the rules, no guidance and no tool.
fn welcome(
    key: &str,
    sub: bool,
    lane: Option<&(String, String)>,
    notes: bool,
    persona: &str,
) -> Value {
    match lane {
        Some((lane_key, pin)) => json!({
            "role": "lane",
            "key": key,
            "lane": lane_key,
            "guidance": if sub { "" } else { LANE_GUIDANCE },
            "tools": if sub { json!([]) } else { json!([lane_tool()]) },
            "pin": pin,
            "shell": true,
            "sub": sub,
            "status": format!("lane {lane_key}"),
        }),
        None => json!({
            "role": "lead",
            "key": key,
            // The owner notes are named only when they exist, never embedded (COORD req. 48).
            "guidance": match (sub, notes, persona.is_empty()) {
                (true, _, _) => String::new(),
                (false, true, true) => format!("{LEAD_GUIDANCE}\n{NOTES_LINE}"),
                (false, true, false) => format!("{LEAD_GUIDANCE}\n{NOTES_LINE}\n{persona}"),
                (false, false, true) => LEAD_GUIDANCE.to_string(),
                (false, false, false) => format!("{LEAD_GUIDANCE}\n{persona}"),
            },
            "tools": if sub { json!([]) } else { json!([super::tool::definition()]) },
            // The hub judges the lead's shell calls by the built-in rule 0 (DESIGN 9.2).
            "shell": true,
            "sub": sub,
            "status": "",
        }),
    }
}
/// The persona line and paragraph from `[lead] name`/`persona` (issue 278): absent keys, or the
/// default name alone, add nothing and the guidance stays byte-identical to the built-in one.
fn persona_text(hub: &Hub) -> String {
    let config = hub.config();
    let Some(lead) = config.lead.as_ref() else {
        return String::new();
    };
    let mut extra = String::new();
    if let Some(name) = lead.name.as_deref()
        && name != "Cataly"
    {
        let _ = write!(
            extra,
            "\nYour name is {name}: you introduce yourself as {name}, never as Cataly. Cataly is only the harness that runs you.\n"
        );
    }
    if let Some(persona) = lead.persona.as_deref() {
        extra.push_str("\nYour personality and tone, chosen by the owner:\n");
        extra.push_str(persona.trim());
        extra.push('\n');
    }
    extra
}

/// Answers a request off the read loop, so a slow lane action never stalls the connection. Shell
/// and spawn calls and the model barrier carry facts the hub judges (EXT req. 32-35, 38-39; the
/// lead has only rule 0 and no pin); tool calls and the stop gate go to their owners. A `bash` line
/// that runs the session's own tool by name is refused with a pointer to the direct call, the only
/// form OMP offers; a subagent has no tool, so the name is judged as usual there.
fn answer_later(
    hub: &Arc<Hub>,
    tx: &mpsc::Sender<Response>,
    (role, sub): (Role, bool),
    (handle, session): (&str, &str),
    request: crate::proto::Incoming,
) {
    let (hub, tx) = (Arc::clone(hub), tx.clone());
    let caller = (role == Role::Lane).then(|| crate::lanes::Caller::Lane {
        handle: handle.to_string(),
        session: session.to_string(),
    });
    let own_tool = match (sub, role) {
        (true, _) => None,
        (false, Role::Lane) => Some(LANE_TOOL),
        (false, _) => Some(super::tool::LEAD_TOOL),
    };
    let handle = handle.to_string();
    tokio::spawn(async move {
        let verdict = |(allow, reason): (bool, String)| json!({ "allow": allow, "reason": reason });
        let param = |key: &str| request.params.get(key).and_then(Value::as_str);
        let tool_line = own_tool.filter(|t| {
            param("tool") == Some("bash")
                && param("command").is_some_and(|c| shell::runs_tool(c, t))
        });
        let reply = match (request.method.as_str(), &caller) {
            ("bridge.model", None) => verdict((true, String::new())),
            ("bridge.shell", _) if tool_line.is_some() => {
                verdict((false, tool_line.map_or_else(String::new, own_tool_in_shell)))
            }
            ("bridge.shell", None) => {
                if param("command").is_some_and(shell::rule_zero) {
                    verdict((false, LEAD_RULE_ZERO.to_string()))
                } else {
                    verdict((true, String::new()))
                }
            }
            ("bridge.shell", Some(_)) => verdict(hub.lanes.veto(&handle, &request.params).await),
            ("bridge.model", Some(_)) => {
                verdict(hub.lanes.model_check(&handle, &request.params).await)
            }
            ("bridge.tool", _) => tool(&hub, caller, &request.params).await,
            (_, Some(_)) => json!({}),
            (_, None) => {
                let answered =
                    request.params.get("answered").and_then(Value::as_bool) == Some(true);
                json!({ "context": stop_gate(&hub, answered).await })
            }
        };
        let _ = tx.send(Response::ok(request.id, reply)).await;
    });
}

async fn event(hub: &Arc<Hub>, handle: &str, role: Role, params: &Value) {
    let seq = params.get("seq").and_then(Value::as_u64).unwrap_or(0);
    let session = params.get("session").and_then(Value::as_str);
    let kind = params
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let dropped = if kind == "dropped" {
        params.get("count").and_then(Value::as_u64).unwrap_or(0)
    } else {
        0
    };
    hub.links.observe(handle, seq, session, dropped);
    if role == Role::Lead && kind == "session_compact" {
        recap(hub, handle, &format!("compact:{seq}")).await;
    }
}

/// One tool call, answered once per call ID (EXT req. 18).
async fn tool(hub: &Arc<Hub>, caller: Option<crate::lanes::Caller>, params: &Value) -> Value {
    let call = params
        .get("call")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if !call.is_empty()
        && let Some(text) = hub.links.answered(&call)
    {
        return json!({ "text": text });
    }
    let mut input = params.get("input").cloned().unwrap_or(Value::Null);
    let result = match caller {
        Some(caller) => {
            // The bridge's facts about the named calls travel with the input (EXT req. 22).
            if let (Some(map), Some(facts)) = (input.as_object_mut(), params.get("evidence")) {
                map.insert("evidence".into(), facts.clone());
            }
            hub.lanes.call(caller, &input).await.map(|v| match v {
                Value::String(s) => s,
                other => other.to_string(),
            })
        }
        None => super::tool::call(hub, &input).await,
    };
    let (text, error) = match result {
        Ok(text) => (text, false),
        Err(text) => (text, true),
    };
    if !call.is_empty() && !error {
        hub.links.remember(&call, &text);
    }
    json!({ "text": text, "error": error })
}

/// Puts the recap in front of the lead as a note that goes out with the next wake (EVR req. 48,
/// OPC req. 57); `reason` keeps each start and each compaction its own.
async fn recap(hub: &Arc<Hub>, handle: &str, reason: &str) {
    let text = super::tool::recap(hub).await;
    let message = Message {
        sender: HUB_SENDER.into(),
        text,
        urgent: false,
        owner: false,
        identity: Some(format!("recap:{handle}:{reason}")),
        request_id: None,
    };
    if let Err(e) = hub.lead.deliver(message).await {
        log::warn("recap not delivered", &[("error", &e)]);
    }
}

/// The stop gate (DISC-OUT req. 35-37, DESIGN 12.2 C8): when the lead stops without a publishable
/// answer and owner messages are still owed, it continues once with a notice; each obligation
/// takes one of its three reminders. Quota-blocked leads get nothing (OPC-64).
pub(crate) async fn stop_gate(hub: &Hub, answered: bool) -> Option<String> {
    if answered
        || hub
            .lead
            .snapshot()
            .is_some_and(|s| s.quota_blocked.is_some())
    {
        return None;
    }
    let since = now_ms() - OWED_WINDOW_MS;
    let open = hub
        .store
        .read(move |r| r.owed_open("discord", since))
        .await
        .ok()?;
    let open: Vec<_> = open
        .into_iter()
        .filter(|o| o.reminders < REMINDERS_MAX)
        .collect();
    let mut lines = Vec::new();
    for o in open.iter().take(STOP_LIST) {
        let took = hub
            .store
            .lead(LeadWrite::Remind {
                relay: "discord".into(),
                room: o.room.clone(),
                message: o.message.clone(),
            })
            .await;
        if matches!(took, Ok(LeadDone::Count(1))) {
            lines.push(owed_line(&o.room, &o.message, o.admitted_ms, &o.text));
        }
    }
    if lines.is_empty() {
        return None;
    }
    let more = open.len().saturating_sub(STOP_LIST);
    let mut text = format!(
        "[reminder] These owner messages have no answer yet:\n{}",
        lines.join("\n")
    );
    if more > 0 {
        let _ = write!(text, "\nand {more} more");
    }
    text.push_str("\nAnswer each, or say in one line what happens next.");
    Some(text)
}

/// One owed message in a reminder. It carries the request's tag, so the answer the reminder brings
/// is captured and posted as the linked reply to that message.
pub(crate) fn owed_line(room: &str, message: &str, at_ms: i64, text: &str) -> String {
    let quoted: String = text.chars().take(200).collect();
    format!(
        "- [discord {room}/{message}] at {}: \"{}\"",
        crate::jobs::instant_text(at_ms),
        quoted.replace('\n', " ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_subagents_parent_resolves_to_its_root_session() {
        let id = "0b5c1d2e-3f40-4a51-8b62-7c83d94ea5f6";
        let file = format!("/h/sessions/--w--/2026-11-25T01-02-03-004Z_{id}.jsonl");
        assert_eq!(root_session(id), id);
        assert_eq!(root_session(&file), id);
        let nested = format!("/h/sessions/--w--/2026-11-25T01-02-03-004Z_{id}/0-Worker.jsonl");
        assert_eq!(root_session(&nested), id);
        assert_eq!(root_session("/h/x/0-Worker.jsonl"), "/h/x/0-Worker.jsonl");
        assert_eq!(root_session(""), "");
    }

    #[test]
    fn the_persona_reaches_the_leads_guidance_and_the_default_does_not_change_it() {
        // No name or persona: the guidance is the built-in file, byte-identical.
        let plain = welcome("k", false, None, false, "");
        assert_eq!(plain["guidance"], LEAD_GUIDANCE);
        let noted = welcome("k", false, None, true, "");
        assert_eq!(noted["guidance"], format!("{LEAD_GUIDANCE}\n{NOTES_LINE}"));
        // A persona joins after the contract and the notes line.
        let extra = "\nYour name is Mi: you introduce yourself as Mi, never as Cataly.\n";
        let named = welcome("k", false, None, true, extra);
        let guidance = named["guidance"].as_str().unwrap();
        assert!(guidance.starts_with(LEAD_GUIDANCE));
        assert!(guidance.contains(NOTES_LINE));
        assert!(guidance.contains("you introduce yourself as Mi"));
        // A subagent still gets nothing.
        assert_eq!(welcome("k", true, None, false, extra)["guidance"], "");
    }
}
