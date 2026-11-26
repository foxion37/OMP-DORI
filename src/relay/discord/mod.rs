//! Discord REST posting (DISC-OUT-01, 03, 06, 23, 24, 27): resolve a destination by ID or unique
//! name, refuse forum and media channels, apply the outgoing text checks, render tables, split, and
//! post the parts in order. Every create parses no mentions and carries a nonce Discord enforces,
//! derived from the logical message, so a repeat after an uncertain outcome returns the existing
//! message instead of a duplicate. Rate-limit buckets are honoured before sending.

use std::collections::HashMap;
use std::fmt::{self, Write as _};
use std::num::NonZeroU64;
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use hyper::Method;
use hyper::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use ring::digest;
use serde_json::{Value, json};
use tokio::time::Instant;

pub(crate) mod away;
pub(crate) mod form;
pub(crate) mod gateway;
pub(crate) mod intake;
pub(crate) mod questions;
pub(crate) mod tap;
pub(crate) mod threads;
pub(crate) mod types;

use super::http::{self, Base, Kind, Outcome, Policy, Response};
use super::text::{self, Checks, DISCORD_LIMIT};

/// The real API; tests use a loopback base instead (DISC-OUT req. 10).
pub(crate) const API: &str = "https://discord.com/api/v10";
/// Longest text accepted for one post (DISC-OUT req. 13).
const INPUT_MAX: usize = 256 * 1024;
/// Discord's nonce length limit.
const NONCE_LEN: usize = 25;
/// Channel types that take no plain post: forum, media.
const FORUM_TYPES: [u64; 2] = [15, 16];
/// Channel types cached at most; the cache starts over when full (each lane thread adds one).
const CHANNEL_TYPES_MAX: usize = 512;

/// Discord's unknown-message error code (DISC-OUT req. 26).
const UNKNOWN_MESSAGE: u64 = 10_008;
/// Discord's epoch, in Unix milliseconds.
const EPOCH_MS: u64 = 1_420_070_400_000;

/// A Discord ID.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) struct Snowflake(NonZeroU64);

impl Snowflake {
    /// Parses the canonical decimal form only.
    pub(crate) fn parse(text: &str) -> Option<Self> {
        let id = text.parse::<NonZeroU64>().ok()?;
        (id.to_string() == text).then_some(Self(id))
    }

    /// The ID as an ordering number for the store (IDs stay below 2^63 until 2084).
    pub(crate) fn seq(self) -> i64 {
        i64::try_from(self.0.get()).unwrap_or(i64::MAX)
    }

    /// The smallest ID made at Unix time `ms`.
    pub(crate) fn at_ms(ms: i64) -> i64 {
        let since = u64::try_from(ms).unwrap_or(0).saturating_sub(EPOCH_MS);
        i64::try_from(since << 22).unwrap_or(i64::MAX)
    }
}

/// A REST failure: the HTTP status and Discord's error code when an answer came, and a reason that
/// never carries a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestError {
    pub(crate) status: Option<u16>,
    pub(crate) code: Option<u64>,
    pub(crate) why: String,
    /// The request may have taken effect.
    pub(crate) uncertain: bool,
}

impl fmt::Display for RestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.why)
    }
}

impl RestError {
    fn from_outcome(outcome: Outcome) -> Self {
        match outcome {
            Outcome::Done(_) => Self {
                status: None,
                code: None,
                why: "no error".into(),
                uncertain: false,
            },
            Outcome::Rejected(resp) => Self {
                status: Some(resp.status),
                code: error_code(&resp),
                why: reason(&resp),
                uncertain: false,
            },
            Outcome::RateLimited(d) => Self {
                status: Some(429),
                code: None,
                why: format!("rate limited for {} s", d.as_secs()),
                uncertain: false,
            },
            Outcome::Failed(why) => Self {
                status: None,
                code: None,
                why,
                uncertain: false,
            },
            Outcome::Uncertain(why) => Self {
                status: None,
                code: None,
                why,
                uncertain: true,
            },
        }
    }

    /// 404 with Discord's unknown-message code.
    pub(crate) fn unknown_message(&self) -> bool {
        self.status == Some(404) && self.code == Some(UNKNOWN_MESSAGE)
    }
}

fn error_code(resp: &Response) -> Option<u64> {
    let v: Value = serde_json::from_slice(&resp.body).ok()?;
    match v.get("code")? {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

impl fmt::Display for Snowflake {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(f)
    }
}

/// A destination as configured: an exact channel or thread ID, or a channel name in the guild.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ChannelRef {
    Id(Snowflake),
    Name(String),
}

impl ChannelRef {
    /// Digits are an ID; anything else is a name, with a leading `#` ignored.
    pub(crate) fn parse(text: &str) -> Option<Self> {
        if let Some(id) = Snowflake::parse(text) {
            return Some(Self::Id(id));
        }
        let name = text.strip_prefix('#').unwrap_or(text).trim();
        (!name.is_empty() && !name.bytes().all(|b| b.is_ascii_digit()))
            .then(|| Self::Name(name.to_string()))
    }
}

/// How a post ended (MSG-05): confirmed parts are never deleted or re-sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Sent {
    Confirmed,
    /// Nothing more was created; the reason names status and Discord's error code, never a token.
    Rejected(String),
    /// The last part may or may not exist.
    Uncertain(String),
}

/// The result of one post.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Posted {
    pub(crate) channel: Option<Snowflake>,
    /// Confirmed message IDs, in order.
    pub(crate) ids: Vec<Snowflake>,
    pub(crate) outcome: Sent,
}

#[derive(Default)]
struct Limits {
    routes: HashMap<String, Instant>,
    global: Option<Instant>,
}

/// A REST client for one bot.
pub(crate) struct Rest {
    base: Base,
    auth: HeaderValue,
    /// For the Gateway identify; never logged.
    token: String,
    guild: Option<Snowflake>,
    limits: Mutex<Limits>,
    channel_types: Mutex<HashMap<Snowflake, u64>>,
}

impl fmt::Debug for Rest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Rest")
            .field("guild", &self.guild)
            .finish_non_exhaustive()
    }
}

fn reason(resp: &Response) -> String {
    let code = serde_json::from_slice::<Value>(&resp.body)
        .ok()
        .and_then(|v| v.get("code").and_then(Value::as_u64));
    match code {
        Some(code) => format!("HTTP {}, Discord error {code}", resp.status),
        None => format!("HTTP {}", resp.status),
    }
}

/// The deterministic nonce of part `index` of a logical message.
pub(crate) fn nonce(seed: &str, index: usize) -> String {
    let hash = digest::digest(&digest::SHA256, format!("cataly:{seed}:{index}").as_bytes());
    let mut out = crate::sys::hex(hash.as_ref());
    out.truncate(NONCE_LEN);
    out
}

impl Rest {
    pub(crate) fn new(base: Base, token: &str, guild: Option<Snowflake>) -> Result<Self, String> {
        let mut auth = HeaderValue::from_str(&format!("Bot {}", token.trim()))
            .map_err(|_| "the Discord token contains invalid characters".to_string())?;
        auth.set_sensitive(true);
        Ok(Self {
            base,
            auth,
            token: token.trim().to_string(),
            guild,
            limits: Mutex::default(),
            channel_types: Mutex::default(),
        })
    }

    /// The bot token, for the Gateway identify.
    pub(crate) fn token(&self) -> &str {
        &self.token
    }

    /// One request under the shared policy, waiting first for its route's bucket and the global
    /// limit, and recording the rate-limit headers of every answer.
    async fn request(
        &self,
        route: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
        kind: Kind,
    ) -> Outcome {
        self.request_as(route, method, path, body.map(Body::Json), kind, true)
            .await
    }

    async fn request_as(
        &self,
        route: &str,
        method: Method,
        path: &str,
        body: Option<Body>,
        kind: Kind,
        auth: bool,
    ) -> Outcome {
        let wait_until = {
            let limits = self.limits.lock().unwrap_or_else(PoisonError::into_inner);
            [limits.routes.get(route).copied(), limits.global]
                .into_iter()
                .flatten()
                .max()
        };
        if let Some(until) = wait_until {
            let wait = until.saturating_duration_since(Instant::now());
            if wait > Duration::from_secs(60) {
                return Outcome::RateLimited(wait);
            }
            tokio::time::sleep(wait).await;
        }
        let mut headers = if auth {
            vec![(AUTHORIZATION, self.auth.clone())]
        } else {
            Vec::new()
        };
        let bytes = match body {
            None => None,
            Some(Body::Json(v)) => Some(v.to_string().into_bytes()),
            Some(Body::Form(bytes, kind)) => {
                headers.push((CONTENT_TYPE, kind));
                Some(bytes)
            }
        };
        let req = http::Request {
            method,
            path,
            headers,
            json: bytes,
            kind,
        };
        http::call(&self.base, &req, Policy::RELAY, |resp| {
            self.observe(route, resp);
        })
        .await
    }

    fn observe(&self, route: &str, resp: &Response) {
        let seconds = |name: &str| {
            resp.header(name)
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|s| s.is_finite() && *s >= 0.0)
                .map(Duration::from_secs_f64)
        };
        let mut limits = self.limits.lock().unwrap_or_else(PoisonError::into_inner);
        if resp.header("x-ratelimit-remaining") == Some("0")
            && let Some(after) = seconds("x-ratelimit-reset-after")
        {
            limits
                .routes
                .insert(route.to_string(), Instant::now() + after);
        }
        let global = resp.header("x-ratelimit-global") == Some("true")
            || serde_json::from_slice::<Value>(&resp.body)
                .ok()
                .and_then(|v| v.get("global").and_then(Value::as_bool))
                == Some(true);
        if resp.status == 429 && global {
            let after = seconds("retry-after").unwrap_or(Duration::from_secs(1));
            limits.global = Some(Instant::now() + after);
        }
    }

    /// A read: the parsed body, or why nothing could be read.
    async fn get(&self, route: &str, path: &str) -> Result<Value, String> {
        match self
            .request(route, Method::GET, path, None, Kind::Read)
            .await
        {
            Outcome::Done(resp) => serde_json::from_slice(&resp.body)
                .map_err(|_| "Discord sent an unreadable answer".into()),
            Outcome::Rejected(resp) => Err(reason(&resp)),
            Outcome::RateLimited(d) => Err(format!("rate limited for {} s", d.as_secs())),
            Outcome::Uncertain(why) | Outcome::Failed(why) => Err(why),
        }
    }

    /// An exact ID, or the one channel in the guild with that name (DISC-OUT req. 12).
    pub(crate) async fn resolve(&self, dest: &ChannelRef) -> Result<Snowflake, String> {
        let name = match dest {
            ChannelRef::Id(id) => return Ok(*id),
            ChannelRef::Name(name) => name,
        };
        let guild = self
            .guild
            .ok_or("a channel name needs [discord] guild in the config")?;
        let all = self.guild_channels(guild).await.map_err(|e| e.why)?;
        let matches: Vec<Snowflake> = all
            .iter()
            .filter(|c| c.get("name").and_then(Value::as_str) == Some(name.as_str()))
            .filter_map(|c| {
                c.get("id")
                    .and_then(Value::as_str)
                    .and_then(Snowflake::parse)
            })
            .collect();
        match matches.as_slice() {
            [one] => Ok(*one),
            [] => Err(format!("no channel named '{name}' in the guild")),
            _ => Err(format!(
                "{} channels are named '{name}'; use the ID",
                matches.len()
            )),
        }
    }

    async fn channel_type(&self, id: Snowflake) -> Result<u64, String> {
        if let Some(t) = self
            .channel_types
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&id)
        {
            return Ok(*t);
        }
        let channel = self.get("GET channels", &format!("/channels/{id}")).await?;
        let kind = channel
            .get("type")
            .and_then(Value::as_u64)
            .ok_or("Discord did not report the channel type")?;
        cache_type(
            &mut self
                .channel_types
                .lock()
                .unwrap_or_else(PoisonError::into_inner),
            id,
            kind,
        );
        Ok(kind)
    }

    /// Posts `text` to `dest` in parts; `seed` names the logical message for its nonces.
    pub(crate) async fn post(
        &self,
        dest: &ChannelRef,
        text: &str,
        seed: &str,
        checks: &Checks,
    ) -> Posted {
        let refuse = |channel, why: String| Posted {
            channel,
            ids: Vec::new(),
            outcome: Sent::Rejected(why),
        };
        let text = text.trim();
        if text.is_empty() {
            return refuse(None, "empty text".into());
        }
        if text.len() > INPUT_MAX {
            return refuse(None, "text over 256 KiB".into());
        }
        if let Err(why) = text::check(text, checks) {
            return refuse(None, format!("refused by the outgoing text checks: {why}"));
        }
        let channel = match self.resolve(dest).await {
            Ok(id) => id,
            Err(why) => return refuse(None, why),
        };
        match self.channel_type(channel).await {
            Ok(t) if FORUM_TYPES.contains(&t) => {
                return refuse(
                    Some(channel),
                    "a forum or media channel takes no plain post; target one of its threads"
                        .into(),
                );
            }
            Ok(_) => {}
            Err(why) => return refuse(Some(channel), format!("channel not readable: {why}")),
        }
        let rendered = text::render_tables(text);
        let Some(parts) = text::split(&rendered, DISCORD_LIMIT) else {
            return refuse(Some(channel), "empty text".into());
        };
        let mut posted = Posted {
            channel: Some(channel),
            ids: Vec::new(),
            outcome: Sent::Confirmed,
        };
        let path = format!("/channels/{channel}/messages");
        for (index, part) in parts.iter().enumerate() {
            let body = json!({
                "content": part,
                "allowed_mentions": { "parse": [], "replied_user": false },
                "nonce": nonce(seed, index),
                "enforce_nonce": true,
            });
            let outcome = self
                .request(
                    "POST channels/messages",
                    Method::POST,
                    &path,
                    Some(body),
                    Kind::Idempotent,
                )
                .await;
            let result = match outcome {
                Outcome::Done(resp) => confirmed(&resp, channel),
                Outcome::Rejected(resp) => Err(Sent::Rejected(reason(&resp))),
                Outcome::RateLimited(d) => Err(Sent::Rejected(format!(
                    "rate limited for {} s",
                    d.as_secs()
                ))),
                Outcome::Failed(why) => Err(Sent::Rejected(why)),
                Outcome::Uncertain(why) => Err(Sent::Uncertain(why)),
            };
            match result {
                Ok(id) => posted.ids.push(id),
                Err(outcome) => {
                    posted.outcome = outcome;
                    break;
                }
            }
        }
        posted
    }
}

impl Rest {
    /// One call; the parsed body (`null` for an empty one) or why it failed.
    pub(crate) async fn call(
        &self,
        route: &str,
        method: Method,
        path: &str,
        body: Option<Value>,
        kind: Kind,
    ) -> Result<Value, RestError> {
        self.call_with(route, method, path, body.map(Body::Json), kind)
            .await
    }

    async fn call_with(
        &self,
        route: &str,
        method: Method,
        path: &str,
        body: Option<Body>,
        kind: Kind,
    ) -> Result<Value, RestError> {
        match self.request_as(route, method, path, body, kind, true).await {
            Outcome::Done(resp) if resp.body.is_empty() => Ok(Value::Null),
            Outcome::Done(resp) => serde_json::from_slice(&resp.body).map_err(|_| RestError {
                status: Some(resp.status),
                code: None,
                why: "Discord sent an unreadable answer".into(),
                uncertain: kind != Kind::Read,
            }),
            other => Err(RestError::from_outcome(other)),
        }
    }

    /// The bot account (DISC-IN req. 1).
    pub(crate) async fn me(&self) -> Result<Value, RestError> {
        self.call("GET users/@me", Method::GET, "/users/@me", None, Kind::Read)
            .await
    }

    /// The application: flags and the interactions endpoint (DISC-IN req. 2, DISC-OUT req. 68).
    pub(crate) async fn application(&self) -> Result<Value, RestError> {
        self.call(
            "GET applications/@me",
            Method::GET,
            "/applications/@me",
            None,
            Kind::Read,
        )
        .await
    }

    /// Sets the application's flags. Discord takes only the limited intent flags from a bot.
    pub(crate) async fn set_application_flags(&self, flags: u64) -> Result<Value, RestError> {
        self.set_application(json!({ "flags": flags })).await
    }

    /// Edits the application (`flags`, or `icon` as an image data URI); returns it as Discord
    /// answers.
    pub(crate) async fn set_application(&self, fields: Value) -> Result<Value, RestError> {
        self.call(
            "PATCH applications/@me",
            Method::PATCH,
            "/applications/@me",
            Some(fields),
            Kind::Idempotent,
        )
        .await
    }

    /// The servers the bot is in (at most 200 per page; a Cataly bot is in one or a few).
    pub(crate) async fn guilds(&self) -> Result<Vec<Value>, RestError> {
        let v = self
            .call(
                "GET users/@me/guilds",
                Method::GET,
                "/users/@me/guilds",
                None,
                Kind::Read,
            )
            .await?;
        list(v, "Discord sent no server list")
    }

    /// Every channel of a guild.
    pub(crate) async fn guild_channels(&self, guild: Snowflake) -> Result<Vec<Value>, RestError> {
        let v = self
            .call(
                "GET guilds/channels",
                Method::GET,
                &format!("/guilds/{guild}/channels"),
                None,
                Kind::Read,
            )
            .await?;
        list(v, "Discord sent no channel list")
    }

    /// Creates one text channel, inside the category `parent` when there is one. Never repeated
    /// after an uncertain outcome: a second run finds the channel by name instead.
    pub(crate) async fn create_text_channel(
        &self,
        guild: Snowflake,
        name: &str,
        topic: &str,
        parent: Option<Snowflake>,
    ) -> Result<Value, RestError> {
        let body = if let Some(parent) = parent {
            json!({ "name": name, "type": 0, "topic": topic, "parent_id": parent.to_string() })
        } else {
            json!({ "name": name, "type": 0, "topic": topic })
        };
        self.call(
            "POST guilds/channels",
            Method::POST,
            &format!("/guilds/{guild}/channels"),
            Some(body),
            Kind::Once,
        )
        .await
    }

    /// Creates one category (channel type 4). Never repeated after an uncertain outcome: a second
    /// run finds the category by name instead.
    pub(crate) async fn create_category(
        &self,
        guild: Snowflake,
        name: &str,
    ) -> Result<Value, RestError> {
        self.call(
            "POST guilds/channels",
            Method::POST,
            &format!("/guilds/{guild}/channels"),
            Some(json!({ "name": name, "type": 4 })),
            Kind::Once,
        )
        .await
    }

    /// Moves a channel into the category `parent`; setting the same parent again changes nothing.
    pub(crate) async fn move_channel(
        &self,
        channel: Snowflake,
        parent: Snowflake,
    ) -> Result<Value, RestError> {
        self.call(
            "PATCH channels",
            Method::PATCH,
            &format!("/channels/{channel}"),
            Some(json!({ "parent_id": parent.to_string() })),
            Kind::Idempotent,
        )
        .await
    }

    /// The Gateway URL Discord names.
    pub(crate) async fn gateway_url(&self) -> Result<String, RestError> {
        let v = self
            .call("GET gateway", Method::GET, "/gateway", None, Kind::Read)
            .await?;
        v.get("url")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(RestError {
                status: None,
                code: None,
                why: "Discord named no Gateway URL".into(),
                uncertain: false,
            })
    }

    pub(crate) async fn channel(&self, id: Snowflake) -> Result<Value, RestError> {
        self.call(
            "GET channels",
            Method::GET,
            &format!("/channels/{id}"),
            None,
            Kind::Read,
        )
        .await
    }

    /// A history page, newest first (DISC-IN req. 31).
    pub(crate) async fn messages(
        &self,
        channel: Snowflake,
        before: Option<Snowflake>,
        limit: u8,
    ) -> Result<Vec<Value>, RestError> {
        let mut path = format!("/channels/{channel}/messages?limit={limit}");
        if let Some(before) = before {
            let _ = write!(path, "&before={before}");
        }
        let v = self
            .call(
                "GET channels/messages",
                Method::GET,
                &path,
                None,
                Kind::Read,
            )
            .await?;
        list(v, "Discord sent no message list")
    }

    pub(crate) async fn message(
        &self,
        channel: Snowflake,
        id: Snowflake,
    ) -> Result<Value, RestError> {
        self.call(
            "GET channels/messages/id",
            Method::GET,
            &format!("/channels/{channel}/messages/{id}"),
            None,
            Kind::Read,
        )
        .await
    }

    /// Active threads of a guild (DISC-IN req. 8).
    pub(crate) async fn active_threads(&self, guild: Snowflake) -> Result<Value, RestError> {
        self.call(
            "GET guilds/threads/active",
            Method::GET,
            &format!("/guilds/{guild}/threads/active"),
            None,
            Kind::Read,
        )
        .await
    }

    /// The bot's eyes reaction on a message (DISC-OUT req. 30); adding it again changes nothing.
    pub(crate) async fn react_seen(
        &self,
        channel: Snowflake,
        message: Snowflake,
    ) -> Result<(), RestError> {
        self.call(
            "PUT channels/messages/reactions",
            Method::PUT,
            &format!("/channels/{channel}/messages/{message}/reactions/%F0%9F%91%80/@me"),
            None,
            Kind::Idempotent,
        )
        .await
        .map(drop)
    }

    /// The typing indicator (about 10 s on Discord's side).
    pub(crate) async fn typing(&self, channel: Snowflake) -> Result<(), RestError> {
        self.call(
            "POST channels/typing",
            Method::POST,
            &format!("/channels/{channel}/typing"),
            None,
            Kind::Once,
        )
        .await
        .map(drop)
    }

    /// Creates a message from a full body; the caller sets the nonce. Confirmed only by a body
    /// naming a message in the channel (DISC-OUT req. 5).
    pub(crate) async fn create(&self, channel: Snowflake, body: Value) -> Result<Value, RestError> {
        self.create_with(channel, body, &[]).await
    }

    /// [`Rest::create`] with files attached (`multipart/form-data`); an embed shows one with
    /// `attachment://<name>`.
    pub(crate) async fn create_with(
        &self,
        channel: Snowflake,
        mut body: Value,
        files: &[Upload<'_>],
    ) -> Result<Value, RestError> {
        put(
            &mut body,
            "allowed_mentions",
            json!({ "parse": [], "replied_user": false }),
        );
        put(&mut body, "enforce_nonce", json!(true));
        let body = if files.is_empty() {
            Body::Json(body)
        } else {
            form(&body, files)
        };
        let v = self
            .call_with(
                "POST channels/messages",
                Method::POST,
                &format!("/channels/{channel}/messages"),
                Some(body),
                Kind::Idempotent,
            )
            .await?;
        let same = v
            .get("channel_id")
            .and_then(Value::as_str)
            .and_then(Snowflake::parse)
            == Some(channel);
        if same
            && v.get("id")
                .and_then(Value::as_str)
                .and_then(Snowflake::parse)
                .is_some()
        {
            Ok(v)
        } else {
            Err(RestError {
                status: None,
                code: None,
                why: "Discord's acknowledgement named no message in this channel".into(),
                uncertain: true,
            })
        }
    }

    /// Replaces a bot message's content and components (DISC-OUT req. 19); never split.
    pub(crate) async fn edit(
        &self,
        channel: Snowflake,
        message: Snowflake,
        mut body: Value,
    ) -> Result<(), RestError> {
        if body
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|c| c.encode_utf16().count() > DISCORD_LIMIT)
        {
            return Err(RestError {
                status: None,
                code: None,
                why: "an edit over 2000 UTF-16 units is refused".into(),
                uncertain: false,
            });
        }
        put(&mut body, "allowed_mentions", json!({ "parse": [] }));
        let v = self
            .call(
                "PATCH channels/messages",
                Method::PATCH,
                &format!("/channels/{channel}/messages/{message}"),
                Some(body),
                Kind::Idempotent,
            )
            .await?;
        let same = v
            .get("id")
            .and_then(Value::as_str)
            .and_then(Snowflake::parse)
            == Some(message);
        if same {
            Ok(())
        } else {
            Err(RestError {
                status: None,
                code: None,
                why: "Discord's acknowledgement named another message".into(),
                uncertain: true,
            })
        }
    }

    /// Pins a message; refused without the permission to pin.
    pub(crate) async fn pin(
        &self,
        channel: Snowflake,
        message: Snowflake,
    ) -> Result<(), RestError> {
        self.call(
            "PUT channels/messages/pins",
            Method::PUT,
            &format!("/channels/{channel}/messages/pins/{message}"),
            None,
            Kind::Idempotent,
        )
        .await
        .map(drop)
    }

    /// Answers an interaction with its own token, within 2.5 s (DISC-OUT req. 69, 82).
    pub(crate) async fn callback(
        &self,
        id: &str,
        token: &str,
        body: Value,
    ) -> Result<(), RestError> {
        let path = format!("/interactions/{id}/{token}/callback");
        let call = self.request_as(
            "POST interactions/callback",
            Method::POST,
            &path,
            Some(Body::Json(body)),
            Kind::Once,
            false,
        );
        match tokio::time::timeout(Duration::from_millis(2_500), call).await {
            Ok(Outcome::Done(_)) => Ok(()),
            Ok(other) => Err(RestError::from_outcome(other)),
            Err(_) => Err(RestError {
                status: None,
                code: None,
                why: "no answer within 2.5 s".into(),
                uncertain: true,
            }),
        }
    }

    /// Sets the bot's avatar and banner (`fields`: `avatar` and/or `banner` as image data URIs);
    /// returns the bot account as Discord answers it, with the new image hashes.
    pub(crate) async fn set_profile(&self, fields: Value) -> Result<Value, RestError> {
        self.call(
            "PATCH users/@me",
            Method::PATCH,
            "/users/@me",
            Some(fields),
            Kind::Idempotent,
        )
        .await
    }

    /// One part of an answer: a linked reply for the first part (fail if the source is gone), with
    /// an enforced deterministic nonce (DISC-OUT req. 15-16, 24-26).
    pub(crate) async fn reply_part(
        &self,
        channel: Snowflake,
        reply_to: Option<Snowflake>,
        text: &str,
        nonce: &str,
    ) -> crate::relay::PartOutcome {
        use crate::relay::PartOutcome;
        let mut body = json!({ "content": text, "nonce": nonce });
        if let Some(source) = reply_to {
            put(
                &mut body,
                "message_reference",
                json!({
                    "message_id": source.to_string(),
                    "channel_id": channel.to_string(),
                    "fail_if_not_exists": true,
                }),
            );
        }
        match self.create(channel, body).await {
            Ok(v) => {
                let id = v
                    .get("id")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let linked = reply_to.is_some_and(|source| {
                    let reference = v.get("message_reference");
                    v.get("type").and_then(Value::as_u64) == Some(19)
                        && reference
                            .and_then(|r| r.get("message_id"))
                            .and_then(Value::as_str)
                            .and_then(Snowflake::parse)
                            == Some(source)
                        && reference
                            .and_then(|r| r.get("channel_id"))
                            .and_then(Value::as_str)
                            .and_then(Snowflake::parse)
                            .is_none_or(|c| c == channel)
                });
                PartOutcome::Posted { id, linked }
            }
            Err(e) if e.unknown_message() => PartOutcome::SourceGone,
            Err(e) if matches!(e.status, Some(400 | 404)) => match reply_to {
                Some(source) => match self.message(channel, source).await {
                    Err(check) if check.unknown_message() => PartOutcome::SourceGone,
                    _ => PartOutcome::Rejected(e.why),
                },
                None => PartOutcome::Rejected(e.why),
            },
            Err(e) if e.uncertain => PartOutcome::Uncertain(e.why),
            Err(e) => PartOutcome::Rejected(e.why),
        }
    }
}

/// A JSON array answer as its items; anything else is an error named by `what`.
fn list(v: Value, what: &str) -> Result<Vec<Value>, RestError> {
    match v {
        Value::Array(items) => Ok(items),
        _ => Err(RestError {
            status: None,
            code: None,
            why: what.into(),
            uncertain: false,
        }),
    }
}

/// A request body.
enum Body {
    Json(Value),
    /// A `multipart/form-data` body and its content type with the boundary.
    Form(Vec<u8>, HeaderValue),
}

/// A file uploaded with a message.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Upload<'a> {
    pub(crate) name: &'a str,
    pub(crate) mime: &'a str,
    pub(crate) bytes: &'a [u8],
}

/// The form Discord takes for a message with files: `payload_json`, then `files[n]`; the payload
/// lists each file under `attachments`.
fn form(payload: &Value, files: &[Upload<'_>]) -> Body {
    let boundary = format!("cataly-{}", nonce(&payload.to_string(), files.len()));
    let mut payload = payload.clone();
    let listed: Vec<Value> = files
        .iter()
        .enumerate()
        .map(|(i, f)| json!({ "id": i, "filename": f.name }))
        .collect();
    put(&mut payload, "attachments", Value::Array(listed));
    let mut out = Vec::new();
    let mut part = |headers: String, bytes: &[u8]| {
        out.extend_from_slice(format!("--{boundary}\r\n{headers}\r\n\r\n").as_bytes());
        out.extend_from_slice(bytes);
        out.extend_from_slice(b"\r\n");
    };
    part(
        "Content-Disposition: form-data; name=\"payload_json\"\r\nContent-Type: application/json"
            .into(),
        payload.to_string().as_bytes(),
    );
    for (i, f) in files.iter().enumerate() {
        part(
            format!(
                "Content-Disposition: form-data; name=\"files[{i}]\"; filename=\"{}\"\r\nContent-Type: {}",
                f.name, f.mime
            ),
            f.bytes,
        );
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    let kind = HeaderValue::from_str(&format!("multipart/form-data; boundary={boundary}"))
        .unwrap_or_else(|_| HeaderValue::from_static("multipart/form-data"));
    Body::Form(out, kind)
}

/// Sets one key of a JSON object body.
pub(super) fn put(body: &mut Value, key: &str, value: Value) {
    if let Some(map) = body.as_object_mut() {
        map.insert(key.to_string(), value);
    }
}

/// A create is confirmed only by a body naming a message ID in the expected channel.
fn confirmed(resp: &Response, channel: Snowflake) -> Result<Snowflake, Sent> {
    let body: Value = serde_json::from_slice(&resp.body)
        .map_err(|_| Sent::Uncertain("Discord's acknowledgement was unreadable".into()))?;
    let id = body
        .get("id")
        .and_then(Value::as_str)
        .and_then(Snowflake::parse);
    let same = body
        .get("channel_id")
        .and_then(Value::as_str)
        .and_then(Snowflake::parse)
        == Some(channel);
    match id {
        Some(id) if same => Ok(id),
        _ => Err(Sent::Uncertain(
            "Discord's acknowledgement named no message in this channel".into(),
        )),
    }
}

/// Caches a channel's type; a full cache starts over (`CHANNEL_TYPES_MAX`).
fn cache_type(cache: &mut HashMap<Snowflake, u64>, id: Snowflake, kind: u64) {
    if cache.len() >= CHANNEL_TYPES_MAX {
        cache.clear();
    }
    cache.insert(id, kind);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_type_cache_is_bounded() {
        let mut cache = HashMap::new();
        for n in 1..=10_000u64 {
            cache_type(&mut cache, Snowflake::parse(&n.to_string()).unwrap(), 0);
        }
        assert!(cache.len() <= CHANNEL_TYPES_MAX, "{}", cache.len());
        assert!(!cache.is_empty());
    }

    #[test]
    fn ids_names_and_nonces() {
        assert!(Snowflake::parse("123").is_some());
        assert!(Snowflake::parse("0123").is_none());
        assert!(Snowflake::parse("0").is_none());
        assert_eq!(
            ChannelRef::parse("#general"),
            Some(ChannelRef::Name("general".into()))
        );
        assert!(matches!(ChannelRef::parse("42"), Some(ChannelRef::Id(_))));
        assert_eq!(ChannelRef::parse("#"), None);
        let a = nonce("event:1:dest", 0);
        assert_eq!(a.len(), 25);
        assert_eq!(a, nonce("event:1:dest", 0), "deterministic");
        assert_ne!(a, nonce("event:1:dest", 1));
    }

    #[test]
    fn unknown_message_needs_404_and_10008() {
        let e = |status, code| RestError {
            status: Some(status),
            code,
            why: String::new(),
            uncertain: false,
        };
        assert!(e(404, Some(10_008)).unknown_message());
        assert!(!e(400, Some(10_008)).unknown_message());
        assert!(!e(404, Some(10_003)).unknown_message());
        assert_eq!(Snowflake::at_ms(1_420_070_400_000), 0);
        assert_eq!(Snowflake::at_ms(1_420_070_400_001), 1 << 22);
    }

    #[tokio::test]
    async fn checks_refuse_before_any_request() {
        let base = Base::parse("http://127.0.0.1:1").unwrap();
        let rest = Rest::new(base, "token", None).unwrap();
        let checks = Checks {
            placeholders: Vec::new(),
            banned: vec!['\u{2014}'],
        };
        let dest = ChannelRef::parse("42").unwrap();
        let posted = rest.post(&dest, "x \u{2014} y", "s", &checks).await;
        assert!(matches!(&posted.outcome, Sent::Rejected(w) if w.contains("U+2014")));
        let posted = rest.post(&dest, "hi {name}", "s", &checks).await;
        assert!(matches!(&posted.outcome, Sent::Rejected(w) if w.contains("{name}")));
        let posted = rest
            .post(&ChannelRef::Name("x".into()), "ok", "s", &checks)
            .await;
        assert!(matches!(&posted.outcome, Sent::Rejected(w) if w.contains("guild")));
        assert!(format!("{rest:?}").find("token").is_none());
    }
}
