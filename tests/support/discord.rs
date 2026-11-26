//! A fake Discord on loopback only (DISC-OUT-27): the REST calls Cataly makes (bot and application
//! identity, the Gateway URL, channels, history, single messages, active threads, message create and
//! edit, reactions, typing, interaction callbacks; for setup the bot account with its avatar and
//! banner, the intent flags, the bot's servers, a server's channels and channel create) and a
//! Gateway WebSocket server. It records
//! every request, deduplicates creates by their enforced nonce as Discord does, keeps a history per
//! channel, answers a reply with message type 19 and its reference, and lets a test script the next
//! create statuses, push dispatches, and send op 7, op 9 or a close code. With a token set, any
//! other token gets 401.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::service::service_fn;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;

pub const BOT: &str = "500000000000000001";
pub const APP: &str = "500000000000000002";
pub const GUILD: &str = "500000000000000003";
/// The user who owns the fake application.
pub const APP_OWNER: &str = "500000000000000004";

/// One request as the server saw it.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub query: String,
    pub authorization: Option<String>,
    /// A JSON body, or a multipart body's `payload_json`.
    pub body: Value,
    /// A multipart body's files, by name, each with its size.
    pub files: Vec<(String, usize)>,
}

/// A command for the Gateway connection.
#[derive(Debug, Clone)]
pub enum Gw {
    Dispatch(&'static str, Value),
    Op7,
    Op9(bool),
    Close(u16),
}

#[derive(Default)]
struct State {
    seen: Vec<Seen>,
    scripted: VecDeque<u16>,
    /// Channel -> statuses for its next message creates, used before `scripted`.
    scripted_in: HashMap<String, VecDeque<u16>>,
    nonces: HashMap<String, u64>,
    next_id: u64,
    created: usize,
    /// Channel -> messages, oldest first.
    history: HashMap<String, Vec<Value>>,
    /// Channel -> its object.
    channels: HashMap<String, Value>,
    threads: Vec<Value>,
    /// Gateway: hello interval, whether heartbeats are acknowledged, the resume URL offered.
    interval_ms: u64,
    no_ack: bool,
    resume_url: Option<String>,
    seq: u64,
    /// "identify" or "resume", one per connection.
    connections: Vec<String>,
    gateway: Option<mpsc::UnboundedSender<Gw>>,
    /// Voice: the voice server endpoint answered to op 4, the guild snapshot sent after READY
    /// when the guilds intent is requested, the op 4 frames and the intents of each identify.
    voice_endpoint: Option<String>,
    guild: Option<Value>,
    voice_ops: Vec<Value>,
    intents: Vec<u64>,
    /// Setup: the token the fake accepts (any when unset), the application's flags, the servers
    /// the bot is in, and the bot's avatar and banner hashes with the data each was set from.
    token: Option<String>,
    app_flags: u64,
    guilds: Vec<Value>,
    profile: HashMap<String, (String, String)>,
    /// Attachments served at `GET /files/<name>` (the owner's uploads, as the CDN would).
    files: HashMap<String, Vec<u8>>,
}

pub struct FakeDiscord {
    pub port: u16,
    pub gateway_port: u16,
    state: Arc<Mutex<State>>,
}

impl FakeDiscord {
    pub fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let gw = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        gw.set_nonblocking(true).unwrap();
        let gateway_port = gw.local_addr().unwrap().port();
        let state = Arc::new(Mutex::new(State {
            next_id: 900_000_000_000_000_000,
            interval_ms: 1_000,
            app_flags: 1 << 18,
            ..State::default()
        }));
        let shared = Arc::clone(&state);
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(listener).unwrap();
                let gw = tokio::net::TcpListener::from_std(gw).unwrap();
                let gw_state = Arc::clone(&shared);
                tokio::spawn(async move {
                    loop {
                        let Ok((stream, _)) = gw.accept().await else {
                            continue;
                        };
                        let state = Arc::clone(&gw_state);
                        tokio::spawn(gateway(stream, state, gateway_port));
                    }
                });
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        continue;
                    };
                    let state = Arc::clone(&shared);
                    tokio::spawn(async move {
                        let service = service_fn(move |req| answer(req, Arc::clone(&state)));
                        let _ = hyper::server::conn::http1::Builder::new()
                            .serve_connection(TokioIo::new(stream), service)
                            .await;
                    });
                }
            });
        });
        let fake = Self {
            port,
            gateway_port,
            state,
        };
        fake.serve_gateway();
        fake
    }

    pub fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn script(&self, statuses: &[u16]) {
        self.state.lock().unwrap().scripted.extend(statuses);
    }

    /// Statuses for the next message creates in one channel (the message is stored regardless).
    pub fn script_in(&self, channel: &str, statuses: &[u16]) {
        self.state
            .lock()
            .unwrap()
            .scripted_in
            .entry(channel.to_string())
            .or_default()
            .extend(statuses);
    }

    pub fn seen(&self) -> Vec<Seen> {
        self.state.lock().unwrap().seen.clone()
    }

    pub fn messages(&self) -> usize {
        self.state.lock().unwrap().created
    }

    pub fn creates(&self) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|s| s.method == "POST" && s.path.ends_with("/messages"))
            .collect()
    }

    /// Requests whose method and path match.
    pub fn calls(&self, method: &str, path_part: &str) -> Vec<Seen> {
        self.seen()
            .into_iter()
            .filter(|s| s.method == method && s.path.contains(path_part))
            .collect()
    }

    pub fn wait_creates(&self, n: usize, limit: Duration) -> Vec<Seen> {
        self.wait(limit, |f| {
            let c = f.creates();
            (c.len() >= n).then_some(c)
        })
    }

    /// Polls `f` every 20 ms for at most `limit`.
    pub fn wait<T>(&self, limit: Duration, mut f: impl FnMut(&Self) -> Option<T>) -> T {
        let deadline = std::time::Instant::now() + limit;
        loop {
            if let Some(v) = f(self) {
                return v;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "condition not met within {limit:?}; requests: {:?}",
                self.seen()
                    .iter()
                    .map(|s| format!("{} {}", s.method, s.path))
                    .collect::<Vec<_>>()
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Declares a channel (type 0 in the guild unless given).
    pub fn channel(&self, id: &str, kind: u64, parent: Option<&str>) {
        let mut v = json!({"id": id, "type": kind, "guild_id": GUILD});
        if let Some(p) = parent {
            v["parent_id"] = json!(p);
        }
        self.state.lock().unwrap().channels.insert(id.into(), v);
    }

    /// An active thread for the listing.
    pub fn thread(&self, id: &str, parent: &str) {
        self.channel(id, 11, Some(parent));
        self.state
            .lock()
            .unwrap()
            .threads
            .push(json!({"id": id, "parent_id": parent, "type": 11,
            "guild_id": GUILD, "thread_metadata": {"archived": false}}));
    }

    /// A message object.
    pub fn message(channel: &str, id: u64, author: &str, content: &str) -> Value {
        json!({"id": id.to_string(), "channel_id": channel, "type": 0, "content": content,
            "author": {"id": author}, "attachments": []})
    }

    /// Adds a message to a channel's history only (seen by catch-up reads, not live).
    pub fn put(&self, message: Value) {
        let channel = message["channel_id"].as_str().unwrap().to_string();
        let mut s = self.state.lock().unwrap();
        let list = s.history.entry(channel).or_default();
        list.push(message);
        list.sort_by_key(|m| m["id"].as_str().unwrap().parse::<u64>().unwrap());
    }

    /// Adds a message to its history and sends it live.
    pub fn say(&self, message: Value) {
        self.put(message.clone());
        self.gw(Gw::Dispatch("MESSAGE_CREATE", message));
    }

    pub fn gw(&self, cmd: Gw) {
        let tx = self.state.lock().unwrap().gateway.clone();
        if let Some(tx) = tx {
            let _ = tx.send(cmd);
        }
    }

    /// "identify" or "resume" for each Gateway connection so far.
    pub fn connections(&self) -> Vec<String> {
        self.state.lock().unwrap().connections.clone()
    }

    pub fn wait_connections(&self, n: usize, limit: Duration) -> Vec<String> {
        self.wait(limit, |f| {
            let c = f.connections();
            (c.len() >= n).then_some(c)
        })
    }

    pub fn set_no_ack(&self, on: bool) {
        self.state.lock().unwrap().no_ack = on;
    }

    /// Answers op 4 with voice-state and voice-server updates naming `endpoint`, and sends `guild`
    /// as `GUILD_CREATE` after `READY` when the guilds intent is requested.
    pub fn set_voice(&self, endpoint: &str, guild: Value) {
        let mut s = self.state.lock().unwrap();
        s.voice_endpoint = Some(endpoint.into());
        s.guild = Some(guild);
    }

    /// The op 4 frames the bot sent.
    pub fn voice_ops(&self) -> Vec<Value> {
        self.state.lock().unwrap().voice_ops.clone()
    }

    /// The intents of each identify.
    pub fn intents(&self) -> Vec<u64> {
        self.state.lock().unwrap().intents.clone()
    }

    /// Only this token is accepted from now on; any other gets 401.
    pub fn set_token(&self, token: &str) {
        self.state.lock().unwrap().token = Some(token.into());
    }

    /// The application's flags (default: the Message Content intent for 100 or more servers).
    pub fn set_app_flags(&self, flags: u64) {
        self.state.lock().unwrap().app_flags = flags;
    }

    pub fn app_flags(&self) -> u64 {
        self.state.lock().unwrap().app_flags
    }

    /// The bot's avatar or banner as its owner set it by hand: `hash`, from unknown data.
    pub fn set_image(&self, field: &str, hash: &str) {
        self.state
            .lock()
            .unwrap()
            .profile
            .insert(field.into(), (hash.into(), String::new()));
    }

    /// Serves `bytes` at `<base>/files/<name>` without authorization, as an attachment's CDN link.
    pub fn serve_file(&self, name: &str, bytes: &[u8]) -> String {
        self.state
            .lock()
            .unwrap()
            .files
            .insert(name.into(), bytes.to_vec());
        format!("{}/files/{name}", self.base())
    }

    /// The bot's avatar or banner, or the application's icon: its hash and the data URI it was set
    /// from.
    pub fn image(&self, field: &str) -> Option<(String, String)> {
        self.state.lock().unwrap().profile.get(field).cloned()
    }

    /// The bot joins a server.
    pub fn join(&self, id: &str, name: &str) {
        self.state
            .lock()
            .unwrap()
            .guilds
            .push(json!({ "id": id, "name": name, "owner": false, "permissions": "0" }));
    }

    /// A named channel of a server, as the channel list shows it.
    pub fn named(&self, id: &str, name: &str, kind: u64, guild: &str) {
        self.state.lock().unwrap().channels.insert(
            id.into(),
            json!({ "id": id, "name": name, "type": kind, "guild_id": guild }),
        );
    }

    pub fn set_resume_url(&self, url: &str) {
        self.state.lock().unwrap().resume_url = Some(url.into());
    }

    /// The messages the bot created in a channel, oldest first.
    pub fn bot_messages(&self, channel: &str) -> Vec<Value> {
        self.state
            .lock()
            .unwrap()
            .history
            .get(channel)
            .map_or_else(Vec::new, |l| {
                l.iter()
                    .filter(|m| m["author"]["id"] == BOT)
                    .cloned()
                    .collect()
            })
    }

    /// The config lines that point the hub at this fake.
    pub fn config(&self, token_file: &std::path::Path, owner: &str, channels: &[&str]) -> String {
        let list: Vec<String> = channels.iter().map(|c| format!("\"{c}\"")).collect();
        format!(
            "[discord]\ntoken_file = \"{}\"\napi_base = \"{}\"\nowner = \"{owner}\"\nchannels = [{}]\n",
            token_file.display(),
            self.base(),
            list.join(", ")
        )
    }
}

async fn gateway(stream: tokio::net::TcpStream, state: Arc<Mutex<State>>, port: u16) {
    let Ok(mut ws) = tokio_tungstenite::accept_async(stream).await else {
        return;
    };
    let (tx, mut rx) = mpsc::unbounded_channel();
    let interval = {
        let mut s = state.lock().unwrap();
        s.gateway = Some(tx);
        s.interval_ms
    };
    let hello = json!({"op": 10, "d": {"heartbeat_interval": interval}});
    if ws.send(Message::text(hello.to_string())).await.is_err() {
        return;
    }
    let next_seq = |state: &Arc<Mutex<State>>| {
        let mut s = state.lock().unwrap();
        s.seq += 1;
        s.seq
    };
    loop {
        tokio::select! {
            incoming = ws.next() => {
                let Some(Ok(Message::Text(text))) = incoming else { return };
                let Ok(frame) = serde_json::from_str::<Value>(text.as_str()) else { continue };
                match frame["op"].as_u64() {
                    Some(1) => {
                        if !state.lock().unwrap().no_ack {
                            let _ = ws.send(Message::text(json!({"op": 11}).to_string())).await;
                        }
                    }
                    Some(2) => {
                        let guild = {
                            let mut s = state.lock().unwrap();
                            let intents = frame["d"]["intents"].as_u64().unwrap_or(0);
                            s.intents.push(intents);
                            s.guild.clone().filter(|_| intents & 1 != 0)
                        };
                        let resume = {
                            let mut s = state.lock().unwrap();
                            s.connections.push("identify".into());
                            s.resume_url.clone().unwrap_or(format!("ws://127.0.0.1:{port}"))
                        };
                        let seq = next_seq(&state);
                        let ready = json!({"op": 0, "s": seq, "t": "READY", "d": {"session_id": "fake-session",
                            "resume_gateway_url": resume, "user": {"id": BOT, "bot": true}}});
                        let _ = ws.send(Message::text(ready.to_string())).await;
                        if let Some(g) = guild {
                            let seq = next_seq(&state);
                            let create = json!({"op": 0, "s": seq, "t": "GUILD_CREATE", "d": g});
                            let _ = ws.send(Message::text(create.to_string())).await;
                        }
                    }
                    Some(4) => {
                        let endpoint = {
                            let mut s = state.lock().unwrap();
                            s.voice_ops.push(frame["d"].clone());
                            s.voice_endpoint.clone()
                        };
                        let channel = frame["d"]["channel_id"].clone();
                        let vs = json!({"guild_id": GUILD, "channel_id": channel, "user_id": BOT,
                            "session_id": "fake-voice-session"});
                        let seq = next_seq(&state);
                        let update = json!({"op": 0, "s": seq, "t": "VOICE_STATE_UPDATE", "d": vs});
                        let _ = ws.send(Message::text(update.to_string())).await;
                        if let (Some(endpoint), false) = (endpoint, channel.is_null()) {
                            let seq = next_seq(&state);
                            let server = json!({"op": 0, "s": seq, "t": "VOICE_SERVER_UPDATE",
                                "d": {"guild_id": GUILD, "token": "fake-voice-token", "endpoint": endpoint}});
                            let _ = ws.send(Message::text(server.to_string())).await;
                        }
                    }
                    Some(6) => {
                        state.lock().unwrap().connections.push("resume".into());
                        let seq = next_seq(&state);
                        let resumed = json!({"op": 0, "s": seq, "t": "RESUMED", "d": {}});
                        let _ = ws.send(Message::text(resumed.to_string())).await;
                    }
                    _ => {}
                }
            }
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { return };
                let frame = match cmd {
                    Gw::Dispatch(kind, d) => json!({"op": 0, "s": next_seq(&state), "t": kind, "d": d}),
                    Gw::Op7 => json!({"op": 7, "d": null}),
                    Gw::Op9(resumable) => json!({"op": 9, "d": resumable}),
                    Gw::Close(code) => {
                        let close = CloseFrame { code: code.into(), reason: "fake".into() };
                        let _ = ws.send(Message::Close(Some(close))).await;
                        return;
                    }
                };
                if ws.send(Message::text(frame.to_string())).await.is_err() {
                    return;
                }
            }
        }
    }
}

/// The application object, owned by [`APP_OWNER`].
fn application(s: &State) -> Value {
    json!({ "id": APP, "flags": s.app_flags, "interactions_endpoint_url": null,
        "icon": s.profile.get("icon").map(|(h, _)| h.clone()),
        "owner": { "id": APP_OWNER, "username": "fake-owner" }, "team": null })
}

fn reply(status: u16, body: &Value) -> Response<Full<Bytes>> {
    let bytes = if status == 204 {
        Bytes::new()
    } else {
        Bytes::from(body.to_string())
    };
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Full::new(bytes))
        .unwrap()
}

fn param(query: &str, key: &str) -> Option<u64> {
    query
        .split('&')
        .find_map(|p| p.strip_prefix(&format!("{key}=")))
        .and_then(|v| v.parse().ok())
}

/// The calls `cataly setup` makes: the bot account (its avatar and banner kept and changed), the
/// application's intent flags, the bot's servers, a server's channels and a new channel.
fn setup_route(
    s: &mut State,
    method: &str,
    parts: &[&str],
    body: &Value,
) -> Option<Response<Full<Bytes>>> {
    Some(match (method, parts) {
        ("PATCH", ["applications", "@me"]) => {
            // Only the limited intent flags may be changed by a bot.
            if let Some(asked) = body["flags"].as_u64() {
                let limited = (1 << 13) | (1 << 15) | (1 << 19);
                s.app_flags = (s.app_flags & !limited) | (asked & limited);
            }
            if let Some(data) = body["icon"].as_str() {
                s.next_id += 1;
                let hash = format!("icon-{}", s.next_id);
                s.profile.insert("icon".into(), (hash, data.into()));
            }
            reply(200, &application(s))
        }
        ("GET" | "PATCH", ["users", "@me"]) => {
            for field in ["avatar", "banner"] {
                if let Some(data) = body[field].as_str() {
                    s.next_id += 1;
                    let hash = format!("{field}-{}", s.next_id);
                    s.profile.insert(field.into(), (hash, data.into()));
                }
            }
            let hash = |f: &str| s.profile.get(f).map(|(h, _)| h.clone());
            reply(
                200,
                &json!({"id": BOT, "username": "fake-bot", "bot": true,
                    "avatar": hash("avatar"), "banner": hash("banner")}),
            )
        }
        ("GET", ["users", "@me", "guilds"]) => reply(200, &Value::Array(s.guilds.clone())),
        ("GET", ["guilds", guild, "channels"]) => {
            let list: Vec<Value> = s
                .channels
                .values()
                .filter(|c| c["guild_id"] == *guild && c.get("name").is_some())
                .cloned()
                .collect();
            reply(200, &Value::Array(list))
        }
        ("POST", ["guilds", guild, "channels"]) => {
            s.next_id += 1;
            let id = s.next_id.to_string();
            let mut channel = json!({ "id": id, "type": body["type"], "name": body["name"],
                "topic": body["topic"], "guild_id": guild });
            if let Some(parent) = body.get("parent_id") {
                channel["parent_id"] = parent.clone();
            }
            s.channels.insert(id, channel.clone());
            reply(201, &channel)
        }
        ("PATCH", ["channels", id]) => match s.channels.get_mut(*id) {
            Some(channel) => {
                if let Some(parent) = body.get("parent_id") {
                    channel["parent_id"] = parent.clone();
                }
                reply(200, channel)
            }
            None => reply(404, &json!({ "message": "Unknown Channel", "code": 10003 })),
        },
        _ => return None,
    })
}

#[allow(clippy::too_many_lines)]
async fn answer(
    req: Request<Incoming>,
    state: Arc<Mutex<State>>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let method = req.method().to_string();
    let path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or_default().to_string();
    let authorization = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let content_type = req.headers().get("content-type").cloned();
    let bytes = req.into_body().collect().await.unwrap().to_bytes();
    let (body, files) = decode(content_type.as_ref().and_then(|v| v.to_str().ok()), &bytes);
    let mut s = state.lock().unwrap();
    let refused = s
        .token
        .as_ref()
        .is_some_and(|t| authorization.as_deref() != Some(format!("Bot {t}").as_str()));
    s.seen.push(Seen {
        method: method.clone(),
        path: path.clone(),
        query: query.clone(),
        authorization,
        body: body.clone(),
        files,
    });
    let parts: Vec<&str> = path.trim_matches('/').split('/').collect();
    if refused {
        return Ok(reply(
            401,
            &json!({ "message": "401: Unauthorized", "code": 0 }),
        ));
    }
    if let Some(r) = setup_route(&mut s, &method, &parts, &body) {
        return Ok(r);
    }
    let unknown = json!({ "message": "Unknown Message", "code": 10008 });
    let response = match (method.as_str(), parts.as_slice()) {
        ("GET", ["applications", "@me"]) => reply(200, &application(&s)),
        ("GET", ["files", name]) => match s.files.get(*name) {
            Some(bytes) => Response::builder()
                .status(200)
                .header("content-type", "application/octet-stream")
                .body(Full::new(Bytes::from(bytes.clone())))
                .unwrap(),
            None => reply(404, &json!({ "message": "Unknown", "code": 0 })),
        },
        ("GET", ["gateway"]) => {
            let url = s
                .channels
                .get("gateway")
                .and_then(|g| g["url"].as_str())
                .unwrap_or_default()
                .to_string();
            reply(200, &json!({ "url": url }))
        }
        ("GET", ["channels", id]) => {
            let channel = s
                .channels
                .get(*id)
                .cloned()
                .unwrap_or(json!({ "id": id, "type": 0, "guild_id": GUILD }));
            reply(200, &channel)
        }
        ("PATCH", ["channels", id]) => patch_channel(&mut s, id, &body),
        ("GET", ["guilds", _, "threads", "active"]) => {
            reply(200, &json!({ "threads": s.threads, "members": [] }))
        }
        ("GET", ["channels", id, "messages"]) => {
            let limit = usize::try_from(param(&query, "limit").unwrap_or(50)).unwrap();
            let before = param(&query, "before");
            let list = s.history.get(*id).cloned().unwrap_or_default();
            let page: Vec<Value> = list
                .iter()
                .rev()
                .filter(|m| {
                    before.is_none_or(|b| m["id"].as_str().unwrap().parse::<u64>().unwrap() < b)
                })
                .take(limit)
                .cloned()
                .collect();
            reply(200, &Value::Array(page))
        }
        ("GET", ["channels", id, "messages", mid]) => {
            match s
                .history
                .get(*id)
                .and_then(|l| l.iter().find(|m| m["id"] == *mid).cloned())
            {
                Some(m) => reply(200, &m),
                None => reply(404, &unknown),
            }
        }
        ("POST", ["channels", id, "messages"]) => create(&mut s, id, &body),
        ("PATCH", ["channels", id, "messages", mid]) => edit_message(&mut s, id, mid, &body),
        (
            "PUT",
            ["channels", _, "messages", _, "reactions", _, "@me"]
            | ["channels", _, "messages", "pins", _],
        ) => reply(204, &Value::Null),
        ("POST", ["channels", _, "typing"] | ["interactions", _, _, "callback"]) => {
            reply(204, &Value::Null)
        }
        _ => reply(404, &json!({ "message": "Unknown", "code": 0 })),
    };
    Ok(response)
}

/// A request body: JSON, or a multipart body's `payload_json` with its files.
fn decode(content_type: Option<&str>, bytes: &[u8]) -> (Value, Vec<(String, usize)>) {
    match content_type.and_then(|c| c.strip_prefix("multipart/form-data; boundary=")) {
        Some(boundary) => multipart(bytes, boundary),
        None => (
            serde_json::from_slice(bytes).unwrap_or(Value::Null),
            Vec::new(),
        ),
    }
}

/// A channel edit: a thread's name or archived flag.
fn patch_channel(s: &mut State, id: &str, body: &Value) -> Response<Full<Bytes>> {
    let channel = s
        .channels
        .entry(id.to_string())
        .or_insert_with(|| json!({ "id": id, "type": 11, "guild_id": GUILD }));
    for key in ["name", "archived"] {
        if let Some(v) = body.get(key) {
            if key == "archived" {
                channel["thread_metadata"] = json!({ "archived": v });
            } else {
                channel[key] = v.clone();
            }
        }
    }
    let channel = channel.clone();
    reply(200, &channel)
}

/// A message edit: its content and components.
fn edit_message(s: &mut State, id: &str, mid: &str, body: &Value) -> Response<Full<Bytes>> {
    if let Some(m) = s
        .history
        .get_mut(id)
        .and_then(|l| l.iter_mut().find(|m| m["id"] == mid))
    {
        for key in ["content", "components", "embeds"] {
            if let Some(c) = body.get(key) {
                m[key] = c.clone();
            }
        }
    }
    reply(200, &json!({ "id": mid, "channel_id": id }))
}

/// A message create: deduplicated by enforced nonce, a reply gets type 19 and its reference.
fn create(s: &mut State, id: &str, body: &Value) -> Response<Full<Bytes>> {
    let nonce = body["nonce"].as_str().unwrap_or_default().to_string();
    let enforced = body["enforce_nonce"] == true;
    let reference = body["message_reference"]["message_id"]
        .as_str()
        .map(str::to_string);
    let source_exists = reference.as_ref().is_none_or(|r| {
        s.history
            .get(id)
            .is_some_and(|l| l.iter().any(|m| m["id"] == r.as_str()))
    });
    if !source_exists && body["message_reference"]["fail_if_not_exists"] == true {
        return reply(400, &json!({"message": "Invalid Form Body", "code": 50035}));
    }
    let existing = s.nonces.get(&nonce).copied().filter(|_| enforced);
    let message = if let Some(m) = existing {
        m
    } else {
        // As on Discord, a new message's ID is above every message already in the channel.
        let newest = s.history.get(id).map_or(0, |l| {
            l.iter()
                .filter_map(|m| m["id"].as_str()?.parse::<u64>().ok())
                .max()
                .unwrap_or(0)
        });
        s.next_id = s.next_id.max(newest) + 1;
        s.created += 1;
        s.next_id
    };
    if enforced && !nonce.is_empty() {
        s.nonces.insert(nonce, message);
    }
    let mut created = json!({ "id": message.to_string(), "channel_id": id, "content": body["content"],
                "author": {"id": BOT, "bot": true}, "type": 0, "components": body["components"],
                "embeds": body["embeds"], "attachments": body["attachments"] });
    if let Some(r) = &reference {
        created["type"] = json!(19);
        created["message_reference"] = json!({"message_id": r, "channel_id": id});
    }
    if existing.is_none() {
        s.history
            .entry((id).to_string())
            .or_default()
            .push(created.clone());
    }
    let scripted = s
        .scripted_in
        .get_mut(id)
        .and_then(VecDeque::pop_front)
        .or_else(|| s.scripted.pop_front());
    if let Some(status) = scripted {
        return reply(status, &json!({ "message": "scripted" }));
    }
    reply(200, &created)
}

/// The `payload_json` part of a multipart body and the name and size of each file part.
fn multipart(bytes: &[u8], boundary: &str) -> (Value, Vec<(String, usize)>) {
    let delimiter = format!("--{boundary}");
    let mut payload = Value::Null;
    let mut files = Vec::new();
    let find = |hay: &[u8], needle: &[u8], from: usize| {
        hay.get(from..)?
            .windows(needle.len())
            .position(|w| w == needle)
            .map(|p| p + from)
    };
    let mut at = 0;
    while let Some(start) = find(bytes, delimiter.as_bytes(), at) {
        let part_start = start + delimiter.len() + 2;
        let Some(end) = find(bytes, delimiter.as_bytes(), part_start) else {
            break;
        };
        let part = &bytes[part_start..end.saturating_sub(2).max(part_start)];
        if let Some(split) = find(part, b"\r\n\r\n", 0) {
            let headers = String::from_utf8_lossy(&part[..split]).to_string();
            let data = &part[split + 4..];
            if headers.contains("name=\"payload_json\"") {
                payload = serde_json::from_slice(data).unwrap_or(Value::Null);
            } else if let Some(name) = headers
                .split("filename=\"")
                .nth(1)
                .and_then(|r| r.split('"').next())
            {
                files.push((name.to_string(), data.len()));
            }
        }
        at = end;
    }
    (payload, files)
}

impl FakeDiscord {
    /// Makes `GET /gateway` name this fake's Gateway.
    pub fn serve_gateway(&self) {
        let url = format!("ws://127.0.0.1:{}", self.gateway_port);
        self.state
            .lock()
            .unwrap()
            .channels
            .insert("gateway".into(), json!({ "url": url }));
    }

    /// A button press interaction from `user` on bot message `message` in `channel`.
    pub fn press(&self, user: &str, channel: &str, message: &str, custom_id: &str) {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let raw = json!({"id": (700_000_000_000_000_000u64 + n).to_string(), "token": format!("tok{n}"),
            "application_id": APP, "channel_id": channel, "type": 3,
            "data": {"component_type": 2, "custom_id": custom_id},
            "message": {"id": message}, "member": {"user": {"id": user}}});
        self.gw(Gw::Dispatch("INTERACTION_CREATE", raw));
    }

    /// Any component or modal interaction: `kind` 3 with `data` holding `component_type` and
    /// `values`, or 5 (modal submit) with its `components`.
    pub fn interact(&self, user: &str, channel: &str, message: &str, kind: u64, data: &Value) {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let raw = json!({"id": (710_000_000_000_000_000u64 + n).to_string(), "token": format!("tik{n}"),
            "application_id": APP, "channel_id": channel, "type": kind, "data": data,
            "message": {"id": message}, "member": {"user": {"id": user}}});
        self.gw(Gw::Dispatch("INTERACTION_CREATE", raw));
    }
}
