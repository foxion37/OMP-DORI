//! First run and onboarding (OPC-66 to OPC-73): the consent state lives in the hub, not in the
//! lead's memory. Onboarding starts with one consent question; a "no" is stored and
//! `onboarding.start` refuses to ask again unless the owner raises it himself. Tools are asked about
//! one at a time and each answer is kept. While onboarding runs it is read-only: the lead's tool
//! refuses every operation that would post to a messenger or start work. The lead's shell never runs
//! a `cataly` command that writes, onboarding or not (shell rule 0, `lanes::shell`).
//!
//! The same conversation sets the assistant's identity (issue 278): `onboarding.name` and
//! `onboarding.persona` write `[lead] name` and `persona` into the config file, `onboarding.avatar`
//! sets the bot's avatar and the application's icon and records them like setup does, so setup keeps
//! them.

use serde_json::{Value, json};

use super::Hub;
use crate::jobs::memory::Memory;
use crate::store::Apply;
use crate::sys::now_ms;

/// The memory key; job names start with a letter or digit, so no job shares it.
const JOB: &str = "@onboarding";
const PHASE: &str = "phase";
const CONSENT: &str = "consent";
/// What the owner chose for the assistant's identity, kept next to the consent state.
const PERSONA_NAME: &str = "persona:name";
const PERSONA_TEXT: &str = "persona:text";
const PERSONA_AVATAR: &str = "persona:avatar";
/// A tool name: letters, digits, `.`, `-`, `_`, at most 64.
const NAME_MAX: usize = 64;
const TEXT_MAX: usize = 2000;
/// The assistant's name: at most 100 characters on one line.
const ASSISTANT_NAME_MAX: usize = 100;
/// The config file is never larger than this (the config loader's own limit).
const CONFIG_MAX: u64 = 1024 * 1024;
/// The largest avatar image taken from the owner's attachment.
const IMAGE_MAX: usize = 10 * 1024 * 1024;

/// Lane operations that only read; every other lane operation, and posting a question, writes.
const LANE_READS: [&str; 12] = [
    "list",
    "board",
    "read",
    "files",
    "rules",
    "admission",
    "slots",
    "spend",
    "drift",
    "queued",
    "items",
    "plan-status",
];

async fn load(hub: &Hub) -> Result<Memory, String> {
    let rows = hub
        .store
        .read(|r| r.memory(JOB, false))
        .await
        .map_err(|e| e.to_string())?;
    Ok(Memory::new(JOB, false, rows))
}

async fn save(hub: &Hub, memory: Memory) -> Result<(), String> {
    hub.store
        .apply(Apply {
            memory: memory.into_writes(),
            ..Apply::default()
        })
        .await
        .map_err(|e| e.to_string())
}

fn text<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|t| !t.is_empty())
}

/// Whether onboarding runs; an unreadable record counts as running (fail closed).
async fn running(hub: &Hub) -> bool {
    load(hub)
        .await
        .map_or(true, |m| m.get(PHASE, "value") == Some("running"))
}

/// Why `op` is refused now, if it is: onboarding runs and `op` would write to a messenger or start
/// work (OPC-68).
pub(crate) async fn blocks(hub: &Hub, op: &str) -> Option<String> {
    let writes = match op.strip_prefix("lane.") {
        Some(lane_op) => !LANE_READS.contains(&lane_op),
        None => matches!(op, "question.ask" | "question.choose" | "job.start"),
    };
    (writes && running(hub).await).then(|| {
        format!(
            "{op} is refused while onboarding runs: onboarding is read-only (no posts, reactions, \
             lanes or jobs). Finish it with onboarding.finish first."
        )
    })
}

/// The first-run line for the recap: what the lead does about onboarding now.
pub(crate) async fn recap_line(hub: &Hub) -> String {
    let Ok(memory) = load(hub).await else {
        return "Onboarding: its record is unreadable; treat onboarding as running (read-only)."
            .into();
    };
    match (memory.get(PHASE, "value"), memory.get(CONSENT, "answer")) {
        (None, _) => "First run: greet the owner through the bot before anything else, then call \
                      onboarding.start and ask its one consent question before reading anything."
            .into(),
        (Some("running"), None) => {
            "Onboarding runs: the consent question is unanswered; read nothing yet.".into()
        }
        (Some("running"), _) => {
            "Onboarding runs (read-only): ask before each tool, finish with onboarding.finish."
                .into()
        }
        (_, Some("no")) => {
            "Onboarding: the owner declined; do not ask again unless the owner raises it.".into()
        }
        _ => "Onboarding: done.".into(),
    }
}

/// Answers the `onboarding` operations and refuses the writes onboarding forbids; `None` lets any
/// other operation through.
pub(crate) async fn call(hub: &Hub, op: &str, input: &Value) -> Option<Result<String, String>> {
    let verb = match op {
        "onboarding" => "",
        other => match other.strip_prefix("onboarding.") {
            Some(verb) => verb,
            None => return blocks(hub, op).await.map(Err),
        },
    };
    Some(run(hub, verb, input).await)
}

async fn run(hub: &Hub, verb: &str, input: &Value) -> Result<String, String> {
    let mut memory = load(hub).await?;
    let phase = memory.get(PHASE, "value").unwrap_or("new").to_string();
    let consent = memory.get(CONSENT, "answer").map(str::to_string);
    let reply = match verb {
        "" => Ok(view(&memory)),
        "start" => start(&mut memory, &phase, consent.as_deref(), input),
        "consent" => {
            if phase != "running" {
                return Err("onboarding is not running; call onboarding.start first".into());
            }
            let answer = text(input, "answer").ok_or("answer is yes or no")?;
            let message =
                text(input, "message").ok_or("message: the owner's message with the answer")?;
            if !matches!(answer, "yes" | "no") {
                return Err("answer is yes or no".into());
            }
            memory.transition(CONSENT, "answer", answer);
            memory.transition(CONSENT, "message", message);
            memory.transition(CONSENT, "at", &now_ms().to_string());
            if answer == "no" {
                memory.transition(PHASE, "value", "done");
                Ok("Stored: the owner said no. Read nothing; do not ask again unless the owner raises it.".into())
            } else {
                Ok("Stored: the owner agreed. Ask about each tool before reading it (onboarding.tool).".into())
            }
        }
        "tool" => tool(&mut memory, &phase, consent.as_deref(), input),
        "name" => {
            let (name, message) = identity(&phase, input, "name", ASSISTANT_NAME_MAX, true)?;
            write_lead_key(hub, "name", name).await?;
            memory.transition(PERSONA_NAME, "value", name);
            memory.transition(PERSONA_NAME, "message", message);
            Ok(format!(
                "Stored: the assistant is named {name} in the config ([lead] name). The name \
                 reaches your instructions when your session next starts; use it from now on."
            ))
        }
        "persona" => {
            let (persona, message) = identity(&phase, input, "persona", TEXT_MAX, false)?;
            write_lead_key(hub, "persona", persona).await?;
            memory.transition(PERSONA_TEXT, "value", persona);
            memory.transition(PERSONA_TEXT, "message", message);
            Ok(
                "Stored: the personality is in the config ([lead] persona). It reaches your \
                instructions when your session next starts; use it from now on."
                    .into(),
            )
        }
        "avatar" => avatar(hub, &mut memory, &phase, input).await,
        "finish" => {
            if phase != "running" {
                return Err("onboarding is not running".into());
            }
            let summary = text(input, "text").ok_or(
                "text: the short summary of what is known, tools used or skipped, and gaps",
            )?;
            if summary.chars().count() > TEXT_MAX {
                return Err(format!("text is longer than {TEXT_MAX} characters"));
            }
            memory.transition(PHASE, "value", "done");
            memory.transition(PHASE, "summary", summary);
            Ok("Onboarding is done; post the summary to the owner.".into())
        }
        other => Err(format!("unknown onboarding operation '{other}'")),
    };
    if reply.is_ok() {
        save(hub, memory).await?;
    }
    reply
}

/// The checked value and the owner's message of an identity answer. Refused unless onboarding runs
/// or is done: the owner may change his mind in chat later, but a lead that never started
/// onboarding has no business rewriting the config.
fn identity<'a>(
    phase: &str,
    input: &'a Value,
    key: &str,
    max: usize,
    one_line: bool,
) -> Result<(&'a str, &'a str), String> {
    gate(phase)?;
    let value = text(input, key).ok_or(format!("{key} is required"))?;
    if value.chars().count() > max {
        return Err(format!("{key} is longer than {max} characters"));
    }
    if one_line && value.contains(['\n', '\r']) {
        return Err(format!("{key} must be one line"));
    }
    let message = text(input, "message").ok_or("message: the owner's message with the answer")?;
    Ok((value, message))
}

/// Identity answers are taken while onboarding runs and after it is done, not before it started.
fn gate(phase: &str) -> Result<(), String> {
    if matches!(phase, "running" | "done") {
        Ok(())
    } else {
        Err("onboarding has not started; call onboarding.start first".into())
    }
}

/// `text` with `[lead] key` set to `value`, refused unless the result is a valid config with a
/// working `[lead]` that carries the value.
fn with_lead_key(text: &str, key: &str, value: &str) -> Result<String, String> {
    let changed = crate::cli::setup::set_key(text, "lead", key, value);
    let refused = |why: String| {
        format!(
            "the config has no working [lead] section ({why}), so nothing was written; the owner \
             can use `cataly setup --lead-{key}` instead"
        )
    };
    let config =
        crate::config::parse(&changed).map_err(|e| refused(crate::config::describe(&e)))?;
    let lead = config
        .lead
        .as_ref()
        .ok_or_else(|| refused("[lead] model is missing or invalid".into()))?;
    let landed = match key {
        "name" => lead.name.as_deref(),
        _ => lead.persona.as_deref(),
    };
    if landed != Some(value) {
        return Err(refused(format!("[lead] {key} did not parse back")));
    }
    Ok(changed)
}

/// Writes `[lead] key` into the config file and reloads it; a reload the hub refuses restores the
/// file as it was.
async fn write_lead_key(hub: &Hub, key: &str, value: &str) -> Result<(), String> {
    let path = &hub.paths.config_file;
    let original = crate::sys::fs::read_private(path, CONFIG_MAX)
        .map_err(|e| format!("reading the config file: {e}"))?
        .unwrap_or_default();
    let original_text = String::from_utf8(original.clone())
        .map_err(|_| "the config file is not UTF-8; nothing was written".to_string())?;
    let changed = with_lead_key(&original_text, key, value)?;
    crate::sys::fs::write_atomic(path, changed.as_bytes())
        .map_err(|e| format!("writing the config file: {e}"))?;
    if let Err(e) = hub.reload().await {
        let restored = crate::sys::fs::write_atomic(path, &original);
        // Clear the config error the refused reload left behind.
        let _ = hub.reload().await;
        return Err(match restored {
            Ok(()) => format!("the hub refused the new config, so the file is as it was: {e}"),
            Err(w) => format!(
                "the hub refused the new config and the file could not be restored ({w}): {e}"
            ),
        });
    }
    Ok(())
}

/// The mime type of an image by its first bytes: JPEG, PNG or GIF; anything else is refused and
/// named by what it looks like.
fn sniff(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Ok("image/jpeg");
    }
    if bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        return Ok("image/png");
    }
    if bytes.starts_with(b"GIF8") {
        return Ok("image/gif");
    }
    let looks =
        if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
            "a WebP image"
        } else if bytes.starts_with(b"BM") {
            "a BMP image"
        } else if bytes.starts_with(b"%PDF") {
            "a PDF document"
        } else if bytes.is_empty() {
            "an empty file"
        } else if std::str::from_utf8(bytes.get(..bytes.len().min(512)).unwrap_or_default())
            .is_ok_and(|t| t.trim_start().starts_with(['<', '{']))
        {
            "an HTML or JSON page"
        } else {
            "data that is not an image"
        };
    Err(format!(
        "the attachment looks like {looks}; the avatar must be a JPEG, PNG or GIF image"
    ))
}

/// Sets the bot's avatar and the application's icon from the owner's attachment and records both
/// as the owner's choice, so `cataly setup` keeps them. A failed icon after a set avatar is
/// reported as partly applied (the avatar is recorded).
async fn avatar(
    hub: &Hub,
    memory: &mut Memory,
    phase: &str,
    input: &Value,
) -> Result<String, String> {
    gate(phase)?;
    let url = text(input, "url").ok_or("url: the https:// address of the owner's attachment")?;
    // Plain http is for the fake Discord of the tests: only where `[discord] api_base` (itself
    // loopback-only) is set, and `download` allows it for a loopback host alone.
    let test_cdn = hub.config().discord.api_base.is_some() && url.starts_with("http://");
    if !url.starts_with("https://") && !test_cdn {
        return Err("url must start with https://".into());
    }
    let message = text(input, "message").ok_or("message: the owner's message with the answer")?;
    let rest =
        hub.jobs.ctx().discord(&hub.config()).map_err(|e| {
            format!("the avatar needs the Discord intake, which is not working: {e}")
        })?;
    let bytes = crate::relay::http::download(url, IMAGE_MAX)
        .await
        .map_err(|e| format!("downloading the attachment failed: {e}"))?;
    let mime = sniff(&bytes)?;
    let me = rest
        .me()
        .await
        .map_err(|e| format!("Discord did not answer for the bot account: {e}"))?;
    let data = format!(
        "data:{mime};base64,{}",
        crate::cli::setup_discord::base64(&bytes)
    );
    let mut set = serde_json::Map::new();
    let user = rest
        .set_profile(json!({ "avatar": data }))
        .await
        .map_err(|e| format!("Discord refused the avatar, nothing changed: {e}"))?;
    if let Value::Object(v) = user {
        set.extend(v);
    }
    let record = |fields: &[(&str, &[u8])], set: &serde_json::Map<String, Value>| {
        crate::cli::setup_discord::record_images(&hub.paths.state_dir, &me, fields, set, true)
    };
    match rest.set_application(json!({ "icon": data })).await {
        Ok(app) => {
            if let Value::Object(v) = app {
                set.extend(v);
            }
        }
        Err(e) => {
            // The avatar is set: record it so setup keeps it, then say what is left.
            let saved = record(&[("avatar", &bytes)], &set);
            return Err(format!(
                "Partly applied: the bot's avatar is set{}, but Discord refused the application \
                 icon ({e}). Tell the owner; the icon can be set in the developer portal.",
                match saved {
                    Ok(()) => " and recorded".to_string(),
                    Err(w) => format!(" but not recorded ({w})"),
                }
            ));
        }
    }
    record(&[("avatar", &bytes), ("icon", &bytes)], &set)
        .map_err(|e| format!("the avatar and icon are set, but recording them failed: {e}"))?;
    memory.transition(PERSONA_AVATAR, "value", &crate::config::sha256_hex(&bytes));
    memory.transition(PERSONA_AVATAR, "message", message);
    Ok(
        "Stored: the avatar and the application icon are set from the owner's image and recorded, \
        so `cataly setup` keeps them."
            .into(),
    )
}

fn start(
    memory: &mut Memory,
    phase: &str,
    consent: Option<&str>,
    input: &Value,
) -> Result<String, String> {
    let reopen = input
        .get("reopen")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let message = text(input, "message");
    if phase == "running" {
        return Ok("Onboarding already runs.".into());
    }
    if (consent == Some("no") || phase == "done") && !(reopen && message.is_some()) {
        return Err(if consent == Some("no") {
            "The owner declined onboarding. Do not ask again unless the owner raises it; then call \
             onboarding.start with reopen true and the owner's message."
                .into()
        } else {
            "Onboarding is done. Start it again only when the owner asks: reopen true and the owner's message.".into()
        });
    }
    if reopen {
        memory.clear(CONSENT, "answer");
        memory.clear(CONSENT, "message");
        memory.transition(PHASE, "reopened_by", message.unwrap_or_default());
    }
    memory.transition(PHASE, "value", "running");
    Ok("Onboarding runs. Before reading anything, ask the owner one consent question that says why; \
        record the answer with onboarding.consent. Until onboarding.finish nothing may be posted, \
        reacted to, edited, marked read, accepted or sent, and no lane or job starts."
        .into())
}

fn tool(
    memory: &mut Memory,
    phase: &str,
    consent: Option<&str>,
    input: &Value,
) -> Result<String, String> {
    if phase != "running" || consent != Some("yes") {
        return Err("ask about tools only while onboarding runs with the owner's consent".into());
    }
    let name = text(input, "name").ok_or("name: the integration")?;
    if name.len() > NAME_MAX
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
    {
        return Err(format!(
            "name is 1-{NAME_MAX} letters, digits, '.', '-' or '_'"
        ));
    }
    let answer = text(input, "answer").ok_or("answer is allowed or declined")?;
    if !matches!(answer, "allowed" | "declined") {
        return Err("answer is allowed or declined".into());
    }
    let reads = text(input, "reads").ok_or("reads: what it would read and why")?;
    let message = text(input, "message").ok_or("message: the owner's message with the answer")?;
    let subject = format!("tool:{name}");
    memory.transition(&subject, "answer", answer);
    memory.transition(&subject, "reads", reads);
    memory.transition(&subject, "message", message);
    Ok(format!("Stored: {name} {answer}."))
}

fn view(memory: &Memory) -> String {
    let tools: Vec<Value> = memory
        .with_condition("answer")
        .into_iter()
        .filter_map(|(subject, answer)| {
            let name = subject.strip_prefix("tool:")?.to_string();
            let reads = memory
                .get(&subject, "reads")
                .unwrap_or_default()
                .to_string();
            Some(json!({ "name": name, "answer": answer, "reads": reads }))
        })
        .collect();
    json!({
        "phase": memory.get(PHASE, "value").unwrap_or("new"),
        "consent": memory.get(CONSENT, "answer"),
        "tools": tools,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_are_told_by_their_first_bytes() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0]), Ok("image/jpeg"));
        assert_eq!(sniff(&[0x89, 0x50, 0x4E, 0x47, 0x0D]), Ok("image/png"));
        assert_eq!(sniff(b"GIF89a.."), Ok("image/gif"));
        for (bytes, named) in [
            (&b"RIFF\0\0\0\0WEBPVP8 "[..], "WebP"),
            (b"%PDF-1.7", "PDF"),
            (b"<html>sign in</html>", "HTML"),
            (b"", "empty"),
            (b"\x00\x01\x02", "not an image"),
        ] {
            let why = sniff(bytes).unwrap_err();
            assert!(
                why.contains(named) && why.contains("JPEG, PNG or GIF"),
                "{why}"
            );
        }
    }

    #[test]
    fn a_name_lands_in_the_lead_section_and_the_rest_of_the_file_stays() {
        let before = "# mine\n[lead]\nmodel = \"p/m\"\n\n[omp]\npath = \"omp\"\n";
        let after = with_lead_key(before, "name", "Mi \"the\" bot").unwrap();
        assert!(after.contains("name = \"Mi \\\"the\\\" bot\""), "{after}");
        assert!(
            after.starts_with("# mine\n[lead]\nmodel = \"p/m\"\n"),
            "{after}"
        );
        assert!(after.ends_with("[omp]\npath = \"omp\"\n"), "{after}");
        let lead = crate::config::parse(&after).unwrap().lead.unwrap();
        assert_eq!(lead.name.as_deref(), Some("Mi \"the\" bot"));
        // A second answer replaces the first.
        let again = with_lead_key(&after, "name", "Ro").unwrap();
        assert_eq!(again.matches("name =").count(), 1, "{again}");
        let persona = with_lead_key(&again, "persona", "dry wit").unwrap();
        let lead = crate::config::parse(&persona).unwrap().lead.unwrap();
        assert_eq!(
            (lead.name.as_deref(), lead.persona.as_deref()),
            (Some("Ro"), Some("dry wit"))
        );
    }

    #[test]
    fn no_working_lead_section_means_nothing_is_written() {
        for text in [
            "",
            "[omp]\npath = \"omp\"\n",
            "[lead]\ncwd = \"/tmp\"\n",
            "[lead]\nmodel = \"nonsense\"\n",
            "[lead]\nmodel = \"p/m\"\nbogus = 1\n",
        ] {
            let why = with_lead_key(text, "name", "Mi").unwrap_err();
            assert!(
                why.contains("no working [lead] section") && why.contains("--lead-name"),
                "{text:?}: {why}"
            );
        }
    }

    #[test]
    fn identity_answers_are_checked_and_wait_for_onboarding() {
        let ask = |phase, input: Value| {
            identity(phase, &input, "name", ASSISTANT_NAME_MAX, true)
                .map(|(v, m)| (v.to_string(), m.to_string()))
        };
        let ok = json!({ "name": "  Mi  ", "message": "m1" });
        assert_eq!(ask("running", ok.clone()), Ok(("Mi".into(), "m1".into())));
        assert_eq!(ask("done", ok.clone()), Ok(("Mi".into(), "m1".into())));
        assert!(ask("new", ok).unwrap_err().contains("onboarding.start"));
        for bad in [
            json!({ "message": "m1" }),
            json!({ "name": "  ", "message": "m1" }),
            json!({ "name": "a\nb", "message": "m1" }),
            json!({ "name": "x".repeat(101), "message": "m1" }),
            json!({ "name": "Mi" }),
        ] {
            assert!(ask("running", bad).is_err());
        }
        assert!(
            ask(
                "running",
                json!({ "name": "x".repeat(100), "message": "m" })
            )
            .is_ok()
        );
    }
}
