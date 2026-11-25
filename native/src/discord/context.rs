//! `INBOUND_CONTEXT` lines: bounded channel metadata and local purpose notes (inboundContext parity).
//! Neither is an owner instruction.

use std::fs::File;
use std::io::{ErrorKind, Read as _};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};

use super::Snowflake;
use super::api::{DiscordApi, RestStatus};
use super::inbound::Inbound;

const CACHE_TTL: Duration = Duration::from_mins(1);
/// Most lookups held at once; a burst across more channels in one minute evicts the oldest.
const CACHE_MAX: usize = 500;
const LOOKUP_BOUND: Duration = Duration::from_secs(5);
const MAX_PURPOSE: usize = 500;
/// The purpose file is local and small; anything larger is treated as unreadable.
const MAX_PURPOSE_FILE: u64 = 16 * 1024 * 1024;

#[derive(Clone)]
enum Lookup {
    Found(Value),
    Failed(String),
    TimedOut,
}

struct Entry {
    id: String,
    at: Instant,
    lookup: Lookup,
}

pub(super) struct Context {
    purposes: PathBuf,
    cache: Vec<Entry>,
}

#[derive(Serialize)]
struct ChannelRecord {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    topic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dm: Option<bool>,
    purpose: Option<String>,
}

#[derive(Serialize)]
struct ThreadRecord {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    purpose: Option<String>,
}

#[derive(Serialize)]
struct Record {
    channel: ChannelRecord,
    thread: Option<ThreadRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

impl Context {
    pub(super) fn new(cataly_state: &Path) -> Self {
        Self {
            purposes: cataly_state.join("discord-channels.json"),
            cache: Vec::new(),
        }
    }

    /// The full `INBOUND_CONTEXT discord <ch> <msg> <json>` line; failures become the record's `error` field.
    pub(super) async fn line(&mut self, api: &DiscordApi, inbound: &Inbound) -> String {
        let record = self.record(api, inbound.channel).await;
        let json = serde_json::to_string(&record)
            .unwrap_or_else(|_| String::from(r#"{"error":"context unavailable"}"#));
        format!(
            "INBOUND_CONTEXT discord {} {} {json}",
            inbound.channel, inbound.message
        )
    }

    async fn record(&mut self, api: &DiscordApi, channel: Snowflake) -> Record {
        let mut errors = Vec::new();
        let purposes = read_purposes(&self.purposes).unwrap_or_else(|()| {
            errors.push(String::from("channel purposes unreadable"));
            Map::new()
        });
        let here_id = channel.to_string();
        let here = self.described(api, &here_id, &mut errors).await;
        let parent = here.as_ref().and_then(|here| match kind(here) {
            Kind::Thread => here
                .get("parent_id")
                .and_then(Value::as_str)
                .map(str::to_owned),
            _ => None,
        });
        let base = match (here.as_ref().map(kind), parent) {
            (Some(Kind::Dm), _) => dm_record(&here_id, &purposes),
            (Some(Kind::Thread), Some(parent)) => {
                let above = self.described(api, &parent, &mut errors).await;
                thread_record(&here_id, here.as_ref(), &parent, above.as_ref(), &purposes)
            }
            _ => plain_record(&here_id, here.as_ref(), &purposes),
        };
        finish(base, &errors)
    }

    /// The channel as looked up, or `None` (with an error recorded) when the lookup failed or ran late.
    async fn described(
        &mut self,
        api: &DiscordApi,
        id: &str,
        errors: &mut Vec<String>,
    ) -> Option<Value> {
        let lookup = self.lookup(api, id).await;
        match lookup {
            Lookup::Found(value) => Some(value),
            Lookup::Failed(error) => {
                errors.push(error);
                None
            }
            Lookup::TimedOut => {
                errors.push(String::from("channel lookup timed out"));
                None
            }
        }
    }

    async fn lookup(&mut self, api: &DiscordApi, id: &str) -> Lookup {
        let now = Instant::now();
        if let Some(hit) = self
            .cache
            .iter()
            .find(|entry| entry.id == id && now.duration_since(entry.at) < CACHE_TTL)
        {
            return hit.lookup.clone();
        }
        evict(&mut self.cache, id, now);
        let lookup = match Snowflake::try_from(id.to_owned()) {
            Err(_) => Lookup::Failed(String::from("channel lookup failed")),
            Ok(channel) => {
                match tokio::time::timeout(LOOKUP_BOUND, api.channel_info(channel)).await {
                    Err(_) => Lookup::TimedOut,
                    Ok(Ok(value)) => Lookup::Found(value),
                    Ok(Err(error)) => Lookup::Failed(lookup_failure(&error)),
                }
            }
        };
        self.cache.push(Entry {
            id: id.to_owned(),
            at: now,
            lookup: lookup.clone(),
        });
        lookup
    }
}

/// Drops every expired entry and `id`, then the oldest while the cache is full.
fn evict(cache: &mut Vec<Entry>, id: &str, now: Instant) {
    cache.retain(|entry| now.duration_since(entry.at) < CACHE_TTL && entry.id != id);
    while cache.len() >= CACHE_MAX {
        cache.remove(0);
    }
}

fn lookup_failure(error: &anyhow::Error) -> String {
    match error.downcast_ref::<RestStatus>() {
        Some(status) if status.status > 0 => {
            format!("channel lookup failed (HTTP {})", status.status)
        }
        _ => String::from("channel lookup failed"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Dm,
    Thread,
    Other,
}

fn kind(channel: &Value) -> Kind {
    // Float patterns keep JS `===` number semantics: `1.0` and `1` are the same channel type.
    match channel.get("type").and_then(Value::as_f64) {
        Some(1.0 | 3.0) => Kind::Dm,
        Some(10.0 | 11.0 | 12.0) => Kind::Thread,
        _ => Kind::Other,
    }
}

fn purpose(purposes: &Map<String, Value>, id: &str) -> Option<String> {
    purposes
        .get(id)
        .and_then(|entry| entry.get("purpose"))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn text(channel: Option<&Value>, key: &str) -> Option<String> {
    channel
        .and_then(|channel| channel.get(key))
        .and_then(Value::as_str)
        .map(str::to_owned)
}

fn channel_record(id: &str, found: Option<&Value>, purposes: &Map<String, Value>) -> ChannelRecord {
    ChannelRecord {
        id: id.to_owned(),
        name: text(found, "name"),
        topic: text(found, "topic").filter(|topic| !topic.is_empty()),
        dm: None,
        purpose: purpose(purposes, id),
    }
}

fn dm_record(id: &str, purposes: &Map<String, Value>) -> Record {
    Record {
        channel: ChannelRecord {
            id: id.to_owned(),
            name: None,
            topic: None,
            dm: Some(true),
            purpose: purpose(purposes, id),
        },
        thread: None,
        error: None,
    }
}

fn thread_record(
    id: &str,
    here: Option<&Value>,
    parent: &str,
    above: Option<&Value>,
    purposes: &Map<String, Value>,
) -> Record {
    Record {
        channel: channel_record(parent, above, purposes),
        thread: Some(ThreadRecord {
            id: id.to_owned(),
            name: text(here, "name"),
            purpose: purpose(purposes, id),
        }),
        error: None,
    }
}

fn plain_record(id: &str, here: Option<&Value>, purposes: &Map<String, Value>) -> Record {
    Record {
        channel: channel_record(id, here, purposes),
        thread: None,
        error: None,
    }
}

fn finish(mut record: Record, errors: &[String]) -> Record {
    if !errors.is_empty() {
        record.error = Some(errors.join("; "));
    }
    record
}

/// `DiscordChannels.read()`: the notes map, validated exactly like readState; `Err` when TS would throw.
fn read_purposes(path: &Path) -> Result<Map<String, Value>, ()> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Map::new()),
        Err(_) => return Err(()),
    };
    let mut bytes = Vec::new();
    file.take(MAX_PURPOSE_FILE + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ())?;
    if bytes.len() as u64 > MAX_PURPOSE_FILE {
        return Err(());
    }
    parse_purposes(&bytes)
}

fn parse_purposes(bytes: &[u8]) -> Result<Map<String, Value>, ()> {
    // readFileSync(..., "utf8") replaces invalid sequences instead of failing.
    let text = String::from_utf8_lossy(bytes);
    let Ok(Value::Object(mut record)) = serde_json::from_str::<Value>(&text) else {
        return Err(());
    };
    if record.len() != 3 || record.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err(());
    }
    let (Some(Value::Object(notes)), Some(Value::Object(receipts))) =
        (record.remove("notes"), record.remove("receipts"))
    else {
        return Err(());
    };
    for (id, entry) in &notes {
        if !is_snowflake(id) || !is_purpose(entry) {
            return Err(());
        }
    }
    for (key, receipt) in &receipts {
        if !is_receipt(key, receipt) {
            return Err(());
        }
    }
    Ok(notes)
}

fn is_snowflake(value: &str) -> bool {
    Snowflake::try_from(value.to_owned()).is_ok()
}

/// ECMAScript `String.prototype.trim` whitespace (`WhiteSpace` and `LineTerminator`).
const fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

const fn not_one_line(c: char) -> bool {
    matches!(
        c,
        '\u{0}'..='\u{1f}'
            | '\u{7f}'..='\u{9f}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202a}'..='\u{202e}'
            | '\u{2066}'..='\u{2069}'
    )
}

fn one_line(text: &str) -> bool {
    !text.is_empty()
        && !text.starts_with(js_space)
        && !text.ends_with(js_space)
        && text.encode_utf16().count() <= MAX_PURPOSE
        && !text.chars().any(not_one_line)
}

fn is_purpose(value: &Value) -> bool {
    let Value::Object(entry) = value else {
        return false;
    };
    entry
        .get("purpose")
        .and_then(Value::as_str)
        .is_some_and(one_line)
        && entry.get("updatedAt").is_some_and(Value::is_string)
        && entry.get("name").is_none_or(Value::is_string)
}

fn is_source(value: &Value) -> Option<[&str; 4]> {
    let Value::Object(source) = value else {
        return None;
    };
    if source.len() != 4 {
        return None;
    }
    let field = |key| {
        source
            .get(key)
            .and_then(Value::as_str)
            .filter(|id| is_snowflake(id))
    };
    let ids = [
        field("botId")?,
        field("ownerId")?,
        field("channelId")?,
        field("messageId")?,
    ];
    (ids[0] != ids[1]).then_some(ids)
}

fn is_receipt(key: &str, value: &Value) -> bool {
    let Value::Object(receipt) = value else {
        return false;
    };
    if receipt.len() != 4 {
        return false;
    }
    let Some(source) = receipt.get("source").and_then(is_source) else {
        return false;
    };
    let Some(channel) = receipt
        .get("channel")
        .and_then(Value::as_str)
        .filter(|id| is_snowflake(id))
    else {
        return false;
    };
    let result = receipt.get("result");
    let valid = match receipt.get("purpose") {
        Some(Value::Null) => result.is_some_and(Value::is_boolean),
        Some(Value::String(purpose)) => {
            one_line(purpose)
                && result.is_some_and(|result| {
                    is_purpose(result)
                        && result.get("purpose").and_then(Value::as_str) == Some(purpose)
                })
        }
        _ => false,
    };
    // receiptKey: JSON.stringify of five decimal-digit strings, which serde_json writes identically.
    valid
        && serde_json::to_string(&[source[0], source[1], source[2], source[3], channel])
            .is_ok_and(|expected| expected == key)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn notes(value: &Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn plain_channel_with_purpose_and_topic() {
        let found = json!({"id": "5", "type": 0, "name": "general", "topic": "talk"});
        let purposes = notes(&json!({"5": {"purpose": "ops", "updatedAt": "x"}}));
        let record = finish(plain_record("5", Some(&found), &purposes), &[]);
        assert_eq!(
            serde_json::to_string(&record).unwrap(),
            r#"{"channel":{"id":"5","name":"general","topic":"talk","purpose":"ops"},"thread":null}"#
        );
    }

    #[test]
    fn empty_topic_and_failed_lookup() {
        let found = json!({"type": 0, "topic": ""});
        let record = finish(plain_record("5", Some(&found), &Map::new()), &[]);
        assert_eq!(
            serde_json::to_string(&record).unwrap(),
            r#"{"channel":{"id":"5","purpose":null},"thread":null}"#
        );
        let failed = finish(
            plain_record("5", None, &Map::new()),
            &[
                "channel purposes unreadable".into(),
                "channel lookup failed (HTTP 403)".into(),
            ],
        );
        assert_eq!(
            serde_json::to_string(&failed).unwrap(),
            r#"{"channel":{"id":"5","purpose":null},"thread":null,"error":"channel purposes unreadable; channel lookup failed (HTTP 403)"}"#
        );
    }

    #[test]
    fn dm_record_shape() {
        assert_eq!(kind(&json!({"type": 1})), Kind::Dm);
        assert_eq!(kind(&json!({"type": 3.0})), Kind::Dm);
        let record = finish(dm_record("9", &Map::new()), &[]);
        assert_eq!(
            serde_json::to_string(&record).unwrap(),
            r#"{"channel":{"id":"9","dm":true,"purpose":null},"thread":null}"#
        );
    }

    #[test]
    fn thread_record_shape() {
        assert_eq!(kind(&json!({"type": 11})), Kind::Thread);
        let here = json!({"type": 11, "name": "t", "parent_id": "4"});
        let above = json!({"type": 0, "name": "p", "topic": null});
        let purposes = notes(&json!({"8": {"purpose": "thread note", "updatedAt": "x"}}));
        let record = finish(
            thread_record("8", Some(&here), "4", Some(&above), &purposes),
            &["channel lookup timed out".into()],
        );
        assert_eq!(
            serde_json::to_string(&record).unwrap(),
            r#"{"channel":{"id":"4","name":"p","purpose":null},"thread":{"id":"8","name":"t","purpose":"thread note"},"error":"channel lookup timed out"}"#
        );
    }

    #[test]
    fn purpose_file_validation() {
        let state = |notes: &str| format!(r#"{{"version":1,"notes":{notes},"receipts":{{}}}}"#);
        assert_eq!(
            parse_purposes(state(r#"{"5":{"purpose":"a","updatedAt":"x"}}"#).as_bytes())
                .unwrap()
                .len(),
            1
        );
        let receipt = json!({
            "version": 1,
            "notes": {},
            "receipts": {
                r#"["1","2","3","4","5"]"#: {
                    "source": {"botId": "1", "ownerId": "2", "channelId": "3", "messageId": "4"},
                    "channel": "5", "purpose": null, "result": false
                }
            }
        });
        assert!(parse_purposes(receipt.to_string().as_bytes()).is_ok());
        let bad_notes = [
            r#"{"x":{"purpose":"a","updatedAt":"x"}}"#,
            r#"{"5":{"purpose":" a","updatedAt":"x"}}"#,
            r#"{"5":{"purpose":"a\u202e","updatedAt":"x"}}"#,
            r#"{"5":{"purpose":"a","updatedAt":"x","name":null}}"#,
        ]
        .map(state);
        for bad in [
            "not json",
            "[]",
            r#"{"version":1,"notes":{}}"#,
            r#"{"5":{"purpose":"a","updatedAt":"x"}}"#,
            r#"{"version":1,"notes":{},"receipts":{"k":{}}}"#,
        ]
        .into_iter()
        .chain(bad_notes.iter().map(String::as_str))
        {
            assert!(parse_purposes(bad.as_bytes()).is_err(), "{bad}");
        }
    }

    #[test]
    fn eviction_drops_expired_then_oldest() {
        let now = Instant::now();
        let mut cache: Vec<Entry> = (0..CACHE_MAX)
            .map(|n| Entry {
                id: n.to_string(),
                at: now,
                lookup: Lookup::TimedOut,
            })
            .collect();
        evict(&mut cache, "7", now);
        assert_eq!(cache.len(), CACHE_MAX - 1);
        assert_eq!(cache[0].id, "0");
        assert!(cache.iter().all(|entry| entry.id != "7"));
        cache.push(Entry {
            id: "a".into(),
            at: now,
            lookup: Lookup::TimedOut,
        });
        evict(&mut cache, "new", now);
        assert_eq!(cache.len(), CACHE_MAX - 1);
        assert_eq!(cache[0].id, "1");
        cache[5].at = now.checked_sub(CACHE_TTL).unwrap();
        evict(&mut cache, "new", now);
        assert_eq!(cache.len(), CACHE_MAX - 2);
    }
}
