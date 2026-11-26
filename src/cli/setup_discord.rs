//! The Discord part of `cataly setup`. Discord leaves three steps to the owner, because they need
//! his own Discord login: making the application, copying its bot token, and adding the bot to a
//! server through the invite link. Everything else runs here on the bot's token: the token is
//! checked (`GET /users/@me`); the Message Content intent is read from the application and switched
//! on (`PATCH /applications/@me` may set the intent flag of a bot in fewer than 100 servers); the
//! invite link carries exactly the permissions Cataly uses; the servers the bot is in are read until
//! it joins one; text channels named `cataly` and `cataly-ops` are found, and missing ones are
//! created only once the owner said yes to the setup; no other channel is touched. The owner is the
//! application's owner unless `--owner` or the config names someone. Every fact is read again on
//! each run and a setting is written only when it differs, so a second run changes nothing.
//!
//! At a terminal the token is asked for without echo; a script saves it in the token file. A step
//! that still needs the owner ends the run with exit status 1 and names that step.

use std::path::Path;
use std::time::Duration;

use serde_json::{Value, json};

use super::args::Parsed;
use super::out;
use super::setup::{self, Terminal};
use crate::config::{self, Config, Destination, sha256_hex};
use crate::relay::discord::{API, ChannelRef, Rest, Snowflake};
use crate::relay::http::Base;
use crate::sys::paths::Paths;

const PORTAL: &str = "https://discord.com/developers/applications";
const INVITE: &str = "https://discord.com/oauth2/authorize";
/// The Message Content intent: the flag for bots in 100 or more servers (granted after review),
/// and the one for bots in fewer.
const MESSAGE_CONTENT: u64 = 1 << 18;
const MESSAGE_CONTENT_LIMITED: u64 = 1 << 19;
/// The application flags a bot may set itself: the presence, members and message content intents
/// of a bot in fewer than 100 servers.
const LIMITED_INTENTS: u64 = (1 << 13) | (1 << 15) | MESSAGE_CONTENT_LIMITED;
/// What Cataly does in its server: manage channels (setup creates its two), add reactions, view
/// channels, send messages, read message history, manage threads, create public threads, send
/// messages in threads, pin messages (the ops panel pins its message; it works unpinned without).
const PERMISSIONS: u64 = (1 << 4)
    | (1 << 6)
    | (1 << 10)
    | (1 << 11)
    | (1 << 16)
    | (1 << 34)
    | (1 << 35)
    | (1 << 38)
    | (1 << 51);
/// The lead's channel and the job notices' channel (also the name of the destination for it).
pub(super) const LEAD: &str = "cataly";
pub(super) const OPS: &str = "cataly-ops";
/// How often the server list is read while waiting for the bot to join.
const POLL: Duration = Duration::from_secs(3);
/// How long a run at a terminal waits for the bot to join, unless `--wait` says otherwise.
const JOIN_WAIT: Duration = Duration::from_mins(10);
/// The longest `--wait`.
const WAIT_MAX: Duration = Duration::from_hours(1);
/// Tries at one step before the run stops and asks for a new run.
const TRIES: usize = 5;

/// What the run found, for the report.
#[derive(Default)]
pub(super) struct Found {
    stage: &'static str,
    token_file: String,
    bot: Option<Value>,
    application: Option<Snowflake>,
    message_content: Option<&'static str>,
    invite: Option<String>,
    guilds: Vec<Value>,
    guild: Option<Value>,
    channels: Vec<Value>,
    /// The category the channels go in: its name, ID (`null` until made) and state; `null` when
    /// the config opts out.
    category: Option<Value>,
    owner: Option<Value>,
}

impl Found {
    pub(super) fn report(&self, next: Option<&str>) -> Value {
        json!({
            "stage": self.stage,
            "next": next,
            "token_file": self.token_file,
            "bot": self.bot,
            "application": self.application.map(|a| a.to_string()),
            "message_content": self.message_content,
            "invite": self.invite,
            "guilds": self.guilds,
            "guild": self.guild,
            "channels": self.channels,
            "category": self.category,
            "owner": self.owner,
        })
    }
}

/// The owner as `--owner` names him.
#[derive(Clone, Copy)]
enum OwnerFlag {
    Id(Snowflake),
    Application,
}

/// The `--guild`, `--owner` and `--wait` flags, checked.
pub(super) struct Flags {
    guild: Option<Snowflake>,
    owner: Option<OwnerFlag>,
    wait: Option<Duration>,
}

impl Flags {
    pub(super) fn parse(p: &Parsed) -> Result<Self, String> {
        let wait = p
            .value("--wait")
            .map(|w| {
                config::parse_duration(w)
                    .filter(|d| *d <= WAIT_MAX)
                    .ok_or("--wait: expected a duration up to 1h, such as 5m")
            })
            .transpose()?;
        let guild = p
            .value("--guild")
            .map(|g| Snowflake::parse(g).ok_or("--guild: expected the server's Discord ID"))
            .transpose()?;
        let owner = p
            .value("--owner")
            .map(|o| match o {
                "app" => Ok(OwnerFlag::Application),
                id => Snowflake::parse(id)
                    .map(OwnerFlag::Id)
                    .ok_or("--owner: expected your Discord user ID, or app"),
            })
            .transpose()?;
        Ok(Self { guild, owner, wait })
    }
}

/// Discord once every step that needs the owner is done: what the config gets.
pub(super) struct Discord {
    rest: Rest,
    pub(super) found: Found,
    pub(super) bot: String,
    /// The bot account as Discord reported it (its avatar and banner hashes among it).
    me: Value,
    /// The application as Discord reported it (its icon hash among it).
    app: Value,
    pub(super) guild: Snowflake,
    pub(super) server: String,
    /// The two channels; `None` until created.
    pub(super) lead: Option<Snowflake>,
    pub(super) ops: Option<Snowflake>,
    /// The category the two channels belong in, when the config asks for one.
    grouping: Option<Grouping>,
    pub(super) owner: Snowflake,
    pub(super) owner_source: &'static str,
}

/// The category for `#cataly` and `#cataly-ops` (`[discord] category`; issue #278).
struct Grouping {
    name: String,
    /// The category channel; `None` until created.
    id: Option<Snowflake>,
    /// Existing channels of the two that sit outside every category; only these are moved in.
    loose: Vec<(&'static str, Snowflake)>,
}

/// What the channel step found.
struct Channels {
    lead: Option<Snowflake>,
    ops: Option<Snowflake>,
    grouping: Option<Grouping>,
}

/// Why the run stopped: the report so far and the step that still needs the owner.
pub(super) type Stop = (Value, String);

struct Flow<'a> {
    paths: &'a Paths,
    config: &'a Config,
    term: Option<&'a Terminal>,
    as_json: bool,
    flags: &'a Flags,
    found: Found,
}

/// Runs the Discord steps against `config` (the config file as it is now).
pub(super) async fn discover(
    paths: &Paths,
    config: &Config,
    term: Option<&Terminal>,
    as_json: bool,
    flags: &Flags,
) -> Result<Discord, Stop> {
    let mut flow = Flow {
        paths,
        config,
        term,
        as_json,
        flags,
        found: Found::default(),
    };
    match flow.steps().await {
        Ok((
            rest,
            (app, me),
            (guild, server),
            Channels {
                lead,
                ops,
                grouping,
            },
            (owner, owner_source),
        )) => {
            flow.found.stage = "ready";
            Ok(Discord {
                rest,
                found: flow.found,
                bot: me
                    .get("username")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
                    .to_string(),
                me,
                app,
                guild,
                server,
                lead,
                ops,
                grouping,
                owner,
                owner_source,
            })
        }
        Err(next) => Err((flow.found.report(Some(&next)), next)),
    }
}

type Steps = (
    Rest,
    // The application and the bot account.
    (Value, Value),
    (Snowflake, String),
    Channels,
    (Snowflake, &'static str),
);

impl Flow<'_> {
    async fn steps(&mut self) -> Result<Steps, String> {
        let rest = self.token().await?;
        let (app, me) = self.intent(&rest).await?;
        let server = self.server(&rest).await?;
        let channels = self.channels(&rest, server.0).await?;
        let owner = self.owner_id(&app)?;
        Ok((rest, (app, me), server, channels, owner))
    }

    fn say(&self, line: &str) {
        if !self.as_json {
            out::line(line);
        }
    }

    fn stop(&mut self, stage: &'static str, next: String) -> String {
        self.found.stage = stage;
        next
    }

    /// A REST client on a token Discord accepts as a bot's.
    async fn token(&mut self) -> Result<Rest, String> {
        let path = crate::jobs::owner::health::token_path(self.config, &self.paths.config_file);
        self.found.token_file = path.display().to_string();
        let base = match &self.config.discord.api_base {
            Some(b) => b.clone(),
            None => Base::parse(API).map_err(|e| self.stop("token", e))?,
        };
        let mut told = false;
        for _ in 0..TRIES {
            let stored = crate::sys::fs::read_private(&path, 64 * 1024);
            let token = match stored {
                Ok(Some(bytes)) => {
                    let Ok(text) = String::from_utf8(bytes) else {
                        let why = format!("{} is not text", path.display());
                        return Err(self.stop("token", why));
                    };
                    text.trim().to_string()
                }
                Ok(None) => String::new(),
                Err(e) => return Err(self.stop("token", format!("token file: {e}"))),
            };
            if !token.is_empty() {
                match bot(&base, &token).await {
                    Ok(rest) => return Ok(rest),
                    Err((true, why)) => {
                        let line = format!(
                            "Discord refused the token in {} ({why}). In the Developer Portal: \
                             Bot, Reset Token, then copy the new one.",
                            path.display()
                        );
                        if self.term.is_none() {
                            return Err(self.stop("token", line));
                        }
                        self.say(&line);
                    }
                    Err((false, why)) => {
                        return Err(self.stop("token", format!("cannot reach Discord: {why}")));
                    }
                }
            } else if !told {
                told = true;
                for line in portal_steps(&path, self.term.is_some()) {
                    self.say(&line);
                }
            }
            let Some(term) = self.term else {
                let next = format!(
                    "make the bot in the Developer Portal ({PORTAL}) and save its token in {} (chmod 600), then run cataly setup again",
                    path.display()
                );
                return Err(self.stop("token", next));
            };
            let Some(typed) = term.hidden("Bot token (not shown):") else {
                return Err(self.stop(
                    "token",
                    format!(
                        "no token given; save it in {} and run cataly setup again",
                        path.display()
                    ),
                ));
            };
            if typed.is_empty() {
                continue;
            }
            match bot(&base, &typed).await {
                Ok(rest) => {
                    store_token(&path, &typed).map_err(|e| self.stop("token", e))?;
                    self.say(&format!("token saved in {}", path.display()));
                    return Ok(rest);
                }
                Err((true, why)) => self.say(&format!("Discord refused that token ({why})")),
                Err((false, why)) => {
                    return Err(self.stop("token", format!("cannot reach Discord: {why}")));
                }
            }
        }
        Err(self.stop(
            "token",
            "no token Discord accepts yet; run cataly setup again".into(),
        ))
    }

    /// The application, with its Message Content intent switched on, and the bot's account.
    async fn intent(&mut self, rest: &Rest) -> Result<(Value, Value), String> {
        let me = rest
            .me()
            .await
            .map_err(|e| self.stop("token", format!("reading the bot: {e}")))?;
        let bot_id = me.get("id").and_then(Value::as_str).unwrap_or_default();
        let bot_name = me
            .get("username")
            .and_then(Value::as_str)
            .unwrap_or("?")
            .to_string();
        self.found.bot = Some(json!({ "id": bot_id, "username": bot_name }));
        let mut app = self.application(rest).await?;
        if intent_on(&app) {
            self.found.message_content = Some("on");
            return Ok((app, me));
        }
        // Cataly cannot read the owner's messages without it: switch it on, no question.
        let flags = app.get("flags").and_then(Value::as_u64).unwrap_or(0);
        match rest
            .set_application_flags((flags & LIMITED_INTENTS) | MESSAGE_CONTENT_LIMITED)
            .await
        {
            Ok(_) => app = self.application(rest).await?,
            Err(e) => self.say(&format!(
                "Discord did not take the Message Content intent ({e})"
            )),
        }
        if intent_on(&app) {
            self.found.message_content = Some("switched on");
            self.say("Message Content intent: switched on");
            return Ok((app, me));
        }
        self.found.message_content = Some("off");
        let place = format!(
            "turn on the Message Content intent: Developer Portal ({PORTAL}), your application, Bot, \
             Privileged Gateway Intents, Message Content Intent, Save Changes"
        );
        for _ in 0..TRIES {
            let Some(term) = self.term else { break };
            self.say(&format!("Please {place}."));
            if term.ask("Press Enter once it is on:").is_none() {
                break;
            }
            app = self.application(rest).await?;
            if intent_on(&app) {
                self.found.message_content = Some("on");
                return Ok((app, me));
            }
        }
        Err(self.stop("intent", format!("{place}; then run cataly setup again")))
    }

    async fn application(&mut self, rest: &Rest) -> Result<Value, String> {
        let app = rest
            .application()
            .await
            .map_err(|e| self.stop("intent", format!("reading the application: {e}")))?;
        self.found.application = app
            .get("id")
            .and_then(Value::as_str)
            .and_then(Snowflake::parse);
        Ok(app)
    }

    /// The invite link: the bot scope with Cataly's permissions.
    fn invite(&mut self) -> String {
        let id = self
            .found
            .application
            .map_or_else(String::new, |a| a.to_string());
        let link = format!("{INVITE}?client_id={id}&scope=bot&permissions={PERMISSIONS}");
        self.found.invite = Some(link.clone());
        link
    }

    /// The server the bot is in, after the owner added it through the invite link.
    async fn server(&mut self, rest: &Rest) -> Result<(Snowflake, String), String> {
        let wanted = self.flags.guild.or(self.config.discord.guild);
        let mut guilds = self.guild_list(rest).await?;
        let present = |list: &[(Snowflake, String)]| match wanted {
            Some(w) => list.iter().any(|(id, _)| *id == w),
            None => !list.is_empty(),
        };
        let link = self.invite();
        if !present(&guilds) {
            self.say(&format!(
                "Add the bot to your server: open {link}, pick the server, then Authorize."
            ));
            self.say(
                "The link asks for Pin Messages so the ops panel can pin its message; without it the panel still works, unpinned.",
            );
            let wait = self.flags.wait.unwrap_or(if self.term.is_some() {
                JOIN_WAIT
            } else {
                Duration::ZERO
            });
            if !wait.is_zero() {
                let secs = wait.as_secs();
                let span = if secs < 120 {
                    format!("{secs} s")
                } else {
                    format!("{} min", secs.div_ceil(60))
                };
                self.say(&format!(
                    "Waiting up to {span} for the bot to join (Ctrl-C stops; run setup again later)."
                ));
            }
            let deadline = tokio::time::Instant::now() + wait;
            while !present(&guilds) && tokio::time::Instant::now() + POLL <= deadline {
                tokio::time::sleep(POLL).await;
                guilds = self.guild_list(rest).await?;
            }
            if !present(&guilds) {
                let what = wanted.map_or_else(
                    || "the bot is in no server yet".to_string(),
                    |w| format!("the bot is not in server {w}"),
                );
                return Err(self.stop(
                    "guild",
                    format!("{what}: open {link}, add it, then run cataly setup again"),
                ));
            }
        }
        let chosen = match (wanted, guilds.as_slice()) {
            (Some(w), list) => list.iter().find(|(id, _)| *id == w).cloned(),
            (None, [one]) => Some(one.clone()),
            (None, list) => self.pick(list),
        };
        let Some((id, name)) = chosen else {
            let names: Vec<String> = guilds.iter().map(|(id, n)| format!("{n} ({id})")).collect();
            return Err(self.stop(
                "guild",
                format!(
                    "the bot is in {} servers: {}; name yours with --guild <id>",
                    guilds.len(),
                    names.join(", ")
                ),
            ));
        };
        self.found.guild = Some(json!({ "id": id.to_string(), "name": name }));
        Ok((id, name))
    }

    async fn guild_list(&mut self, rest: &Rest) -> Result<Vec<(Snowflake, String)>, String> {
        let list = rest
            .guilds()
            .await
            .map_err(|e| self.stop("guild", format!("reading the bot's servers: {e}")))?;
        let guilds: Vec<(Snowflake, String)> = list
            .iter()
            .filter_map(|g| {
                let id = g
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(Snowflake::parse)?;
                let name = g.get("name").and_then(Value::as_str).unwrap_or("?");
                Some((id, name.to_string()))
            })
            .collect();
        self.found.guilds = guilds
            .iter()
            .map(|(id, name)| json!({ "id": id.to_string(), "name": name }))
            .collect();
        Ok(guilds)
    }

    /// The owner's choice among several servers, at the terminal.
    fn pick(&self, list: &[(Snowflake, String)]) -> Option<(Snowflake, String)> {
        let term = self.term?;
        self.say("The bot is in several servers:");
        for (i, (id, name)) in list.iter().enumerate() {
            self.say(&format!("  {}. {name} ({id})", i + 1));
        }
        for _ in 0..TRIES {
            let answer = term.ask(&format!("Which one is yours? [1-{}]", list.len()))?;
            if let Some(g) = answer
                .parse::<usize>()
                .ok()
                .and_then(|n| n.checked_sub(1))
                .and_then(|i| list.get(i))
            {
                return Some(g.clone());
            }
        }
        None
    }

    /// `#cataly` and `#cataly-ops`: the text channels with those names; `None` for one to create.
    /// With a `[discord] category`, also the category of that name (a type 4 channel, matched
    /// exactly like the channel names: Discord lowercases text channel names, a category keeps its
    /// case) and which of the two channels sit outside every category.
    async fn channels(&mut self, rest: &Rest, guild: Snowflake) -> Result<Channels, String> {
        let all = rest
            .guild_channels(guild)
            .await
            .map_err(|e| self.stop("channels", format!("reading the server's channels: {e}")))?;
        let id_of = |c: &Value| {
            c.get("id")
                .and_then(Value::as_str)
                .and_then(Snowflake::parse)
        };
        let mut ids = Vec::new();
        let mut loose = Vec::new();
        for name in [LEAD, OPS] {
            let same: Vec<&Value> = all
                .iter()
                .filter(|c| {
                    c.get("type").and_then(Value::as_u64) == Some(0)
                        && c.get("name").and_then(Value::as_str) == Some(name)
                })
                .collect();
            match same.as_slice() {
                [one] => {
                    let id = id_of(one);
                    if let Some(id) = id
                        && one.get("parent_id").is_none_or(Value::is_null)
                    {
                        loose.push((name, id));
                    }
                    self.found.channels.push(json!({
                        "name": name,
                        "id": id.map(|id| id.to_string()),
                        "state": "existing",
                    }));
                    ids.push(id);
                }
                [] => {
                    self.found
                        .channels
                        .push(json!({ "name": name, "id": null, "state": "missing" }));
                    ids.push(None);
                }
                more => {
                    return Err(self.stop(
                        "channels",
                        format!(
                            "{} text channels are named #{name}; rename all but one, then run setup again",
                            more.len()
                        ),
                    ));
                }
            }
        }
        let grouping = match self.config.discord.category.clone() {
            None => None,
            Some(name) => {
                let same: Vec<&Value> = all
                    .iter()
                    .filter(|c| {
                        c.get("type").and_then(Value::as_u64) == Some(4)
                            && c.get("name").and_then(Value::as_str) == Some(name.as_str())
                    })
                    .collect();
                let id = match same.as_slice() {
                    [one] => id_of(one),
                    [] => None,
                    more => {
                        return Err(self.stop(
                            "channels",
                            format!(
                                "{} categories are named {name}; rename all but one, or set [discord] category, then run setup again",
                                more.len()
                            ),
                        ));
                    }
                };
                self.found.category = Some(json!({
                    "name": name,
                    "id": id.map(|id| id.to_string()),
                    "state": if id.is_some() { "existing" } else { "missing" },
                }));
                Some(Grouping { name, id, loose })
            }
        };
        Ok(Channels {
            lead: ids.first().copied().flatten(),
            ops: ids.get(1).copied().flatten(),
            grouping,
        })
    }

    /// The owner's user ID: `--owner`, else the config's, else the application's owner, else
    /// typed in at the terminal.
    fn owner_id(&mut self, app: &Value) -> Result<(Snowflake, &'static str), String> {
        let candidate = app_owner(app);
        let (id, source) = match (self.flags.owner, self.config.discord.owner, &candidate) {
            (Some(OwnerFlag::Id(id)), _, _) => (id, "--owner"),
            (None, Some(id), _) => (id, "config"),
            (_, _, Some((id, _))) => (*id, "application owner"),
            (Some(OwnerFlag::Application), _, None) => {
                return Err(self.stop(
                    "owner",
                    "the application names no owner; pass --owner <your Discord user ID>".into(),
                ));
            }
            (None, None, None) => self.ask_owner()?,
        };
        let bot = self
            .found
            .bot
            .as_ref()
            .and_then(|b| b.get("id"))
            .and_then(Value::as_str)
            .and_then(Snowflake::parse);
        if bot == Some(id) {
            return Err(self.stop("owner", "the owner cannot be the bot itself".into()));
        }
        self.found.owner = Some(json!({ "id": id.to_string(), "source": source }));
        Ok((id, source))
    }

    fn ask_owner(&mut self) -> Result<(Snowflake, &'static str), String> {
        if let Some(term) = self.term {
            for _ in 0..TRIES {
                let Some(answer) = term.ask(
                    "Your Discord user ID (Discord settings, Advanced, Developer Mode on; then right-click your name, Copy User ID):",
                ) else {
                    break;
                };
                if let Some(id) = Snowflake::parse(&answer) {
                    return Ok((id, "entered"));
                }
            }
        }
        Err(self.stop(
            "owner",
            "the application names no owner; pass --owner <your Discord user ID>".into(),
        ))
    }
}

impl Discord {
    /// Whether the channels are where setup wants them: both exist and none waits to be moved
    /// into its category.
    pub(super) fn grouped(&self) -> bool {
        self.lead.is_some()
            && self.ops.is_some()
            && self.grouping.as_ref().is_none_or(|g| g.loose.is_empty())
    }

    /// Creates the channels and the category that are missing, and moves existing channels that
    /// sit outside every category into it (after the owner's yes). A channel in any category stays
    /// there; no other channel is changed.
    pub(super) async fn create_missing(&mut self) -> Result<(Snowflake, Snowflake), String> {
        let parent = self.settle_category().await?;
        if self.lead.is_none() {
            self.lead = Some(self.create_one(LEAD, parent).await?);
        }
        if self.ops.is_none() {
            self.ops = Some(self.create_one(OPS, parent).await?);
        }
        if let Some(parent) = parent {
            let loose = self
                .grouping
                .as_mut()
                .map_or_default(|g| std::mem::take(&mut g.loose));
            for (name, id) in loose {
                self.move_one(name, id, parent).await?;
            }
        }
        match (self.lead, self.ops) {
            (Some(lead), Some(ops)) => Ok((lead, ops)),
            _ => Err("the channels could not be settled".into()),
        }
    }

    /// The category the channels go in, made when it is needed and missing; `None` without one.
    async fn settle_category(&mut self) -> Result<Option<Snowflake>, String> {
        let needed = self.lead.is_none()
            || self.ops.is_none()
            || self.grouping.as_ref().is_some_and(|g| !g.loose.is_empty());
        let Some(g) = self.grouping.as_ref().filter(|_| needed) else {
            return Ok(None);
        };
        if g.id.is_some() {
            return Ok(g.id);
        }
        let name = g.name.clone();
        match self.rest.create_category(self.guild, &name).await {
            Ok(v) => {
                let id = v
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(Snowflake::parse)
                    .filter(|_| v.get("name").and_then(Value::as_str) == Some(name.as_str()))
                    .ok_or_else(|| {
                        format!("Discord's answer named no category {name}; run setup again, it finds the category if it was made")
                    })?;
                self.found.category =
                    Some(json!({ "name": name, "id": id.to_string(), "state": "created" }));
                if let Some(g) = &mut self.grouping {
                    g.id = Some(id);
                }
                Ok(Some(id))
            }
            Err(e) if e.status == Some(403) => Err(format!(
                "the bot may not create channels ({e}): give it Manage Channels by opening {}, \
                 or create the category {name} yourself, then run setup again",
                self.found.invite.as_deref().unwrap_or(INVITE)
            )),
            Err(e) if e.uncertain => Err(format!(
                "Discord did not confirm the category {name} ({e}); run setup again, it finds the category if it was made"
            )),
            Err(e) => Err(format!("creating the category {name}: {e}")),
        }
    }

    /// Moves the existing channel `name` into the category.
    async fn move_one(
        &mut self,
        name: &'static str,
        id: Snowflake,
        parent: Snowflake,
    ) -> Result<(), String> {
        match self.rest.move_channel(id, parent).await {
            Ok(_) => {
                for c in &mut self.found.channels {
                    if c.get("name").and_then(Value::as_str) == Some(name) {
                        *c = json!({ "name": name, "id": id.to_string(), "state": "moved" });
                    }
                }
                Ok(())
            }
            Err(e) if e.status == Some(403) => Err(format!(
                "the bot may not move #{name} ({e}): give it Manage Channels by opening {}, \
                 or move the channel yourself, then run setup again",
                self.found.invite.as_deref().unwrap_or(INVITE)
            )),
            Err(e) => Err(format!("moving #{name} into its category: {e}")),
        }
    }

    async fn create_one(
        &mut self,
        name: &'static str,
        parent: Option<Snowflake>,
    ) -> Result<Snowflake, String> {
        let topic = if name == LEAD {
            "Talk with Cataly's lead here."
        } else {
            "Cataly's status panel and alerts."
        };
        match self
            .rest
            .create_text_channel(self.guild, name, topic, parent)
            .await
        {
            Ok(v) => {
                let id = v
                    .get("id")
                    .and_then(Value::as_str)
                    .and_then(Snowflake::parse)
                    .filter(|_| v.get("name").and_then(Value::as_str) == Some(name))
                    .ok_or_else(|| {
                        format!("Discord's answer named no #{name}; run setup again, it finds the channel if it was made")
                    })?;
                for c in &mut self.found.channels {
                    if c.get("name").and_then(Value::as_str) == Some(name) {
                        *c = json!({ "name": name, "id": id.to_string(), "state": "created" });
                    }
                }
                Ok(id)
            }
            Err(e) if e.status == Some(403) => Err(format!(
                "the bot may not create channels ({e}): give it Manage Channels by opening {}, \
                 or create #{name} yourself, then run setup again",
                self.found.invite.as_deref().unwrap_or(INVITE)
            )),
            Err(e) if e.uncertain => Err(format!(
                "Discord did not confirm #{name} ({e}); run setup again, it finds the channel if it was made"
            )),
            Err(e) => Err(format!("creating #{name}: {e}")),
        }
    }

    /// What the profile step does with the bot's avatar and banner and the application's icon. An
    /// image is set when there is none, when it is the one Cataly set earlier but Cataly's default
    /// changed since, or always with `force` (`--profile`); one the owner set by hand is kept.
    pub(super) fn profile_plan(&self, state_dir: &Path, force: bool) -> ProfilePlan {
        let record = read_record(state_dir, &self.me);
        let mut plan = ProfilePlan::default();
        for (field, bytes) in IMAGES {
            let holder = if field == APP_ICON {
                &self.app
            } else {
                &self.me
            };
            let current = holder.get(field).and_then(Value::as_str);
            let mine = record.get(field);
            let ours = current.is_some()
                && mine.and_then(|m| m.get("hash")).and_then(Value::as_str) == current;
            let fresh = mine.and_then(|m| m.get("image")).and_then(Value::as_str)
                == Some(sha256_hex(bytes).as_str());
            // An image the owner chose in chat (`onboarding.avatar`) is recorded like Cataly's own
            // but stays his: a changed default never replaces it.
            let chosen = ours && mine.and_then(|m| m.get("chosen")) == Some(&Value::Bool(true));
            if force || current.is_none() || (ours && !fresh && !chosen) {
                plan.set.push(field);
            } else if ours && !chosen {
                plan.cataly.push(field);
            } else {
                plan.kept.push(field);
            }
        }
        plan
    }

    /// Sets Cataly's images for `fields` (the bot's through its account, the icon through the
    /// application) and records the hashes Discord gave them, so a later run can tell them from
    /// images the owner set himself.
    pub(super) async fn set_profile(
        &self,
        state_dir: &Path,
        fields: &[&'static str],
    ) -> Result<(), String> {
        let data =
            |bytes: &[u8]| Value::String(format!("data:image/jpeg;base64,{}", base64(bytes)));
        let chosen = || IMAGES.iter().filter(|(f, _)| fields.contains(f));
        let mut user = serde_json::Map::new();
        let mut app = serde_json::Map::new();
        for (field, bytes) in chosen() {
            let body = if *field == APP_ICON {
                &mut app
            } else {
                &mut user
            };
            body.insert((*field).to_string(), data(bytes));
        }
        let mut set = serde_json::Map::new();
        for (body, is_app) in [(user, false), (app, true)] {
            if body.is_empty() {
                continue;
            }
            let answer = if is_app {
                self.rest.set_application(Value::Object(body)).await
            } else {
                self.rest.set_profile(Value::Object(body)).await
            };
            if let Value::Object(v) = answer.map_err(|e| e.to_string())? {
                set.extend(v);
            }
        }
        let images: Vec<(&str, &[u8])> = chosen().map(|(f, b)| (*f, *b)).collect();
        record_images(state_dir, &self.me, &images, &set, false)
    }
}

/// Records that Cataly set `images` (Discord field, bytes) on the bot `me`, with the hashes Discord
/// answered in `set`, so a later setup run tells them from images the owner set himself. `chosen`
/// marks images the owner picked in chat: setup keeps those even when its own default changes.
pub(crate) fn record_images(
    state_dir: &Path,
    me: &Value,
    images: &[(&str, &[u8])],
    set: &serde_json::Map<String, Value>,
    chosen: bool,
) -> Result<(), String> {
    let mut record = read_record(state_dir, me);
    record.insert("bot".into(), me.get("id").cloned().unwrap_or(Value::Null));
    for (field, bytes) in images {
        let entry = if chosen {
            json!({ "hash": set.get(*field), "image": sha256_hex(bytes), "chosen": true })
        } else {
            json!({ "hash": set.get(*field), "image": sha256_hex(bytes) })
        };
        record.insert((*field).to_string(), entry);
    }
    let text = serde_json::to_string(&record).map_err(|e| e.to_string())?;
    crate::sys::fs::write_atomic(&state_dir.join(PROFILE_RECORD), text.as_bytes())
        .map_err(|e| e.to_string())
}

/// Cataly's default profile images: Discord's field and the bundled JPEG. The application's icon
/// is the avatar image.
const IMAGES: [(&str, &[u8]); 3] = [
    ("avatar", include_bytes!("../../assets/avatar.jpg")),
    ("banner", include_bytes!("../../assets/banner.jpg")),
    (APP_ICON, include_bytes!("../../assets/avatar.jpg")),
];
/// The image set on the application rather than the bot account.
const APP_ICON: &str = "icon";
/// The file in the state folder that records which images Cataly set on which bot.
const PROFILE_RECORD: &str = "discord-profile.json";

/// The profile step for the avatar and the banner (Discord's field names).
#[derive(Default)]
pub(super) struct ProfilePlan {
    /// Cataly sets its image.
    pub(super) set: Vec<&'static str>,
    /// Cataly's image is there already.
    pub(super) cataly: Vec<&'static str>,
    /// The owner's own image stays.
    pub(super) kept: Vec<&'static str>,
}

impl ProfilePlan {
    /// One line for the setup summary.
    pub(super) fn summary(&self) -> String {
        let mut parts = Vec::new();
        for (fields, what) in [
            (&self.set, "Cataly's (to set)"),
            (&self.cataly, "Cataly's"),
            (&self.kept, "yours, kept (--profile sets Cataly's)"),
        ] {
            if !fields.is_empty() {
                parts.push(format!("{}: {what}", fields.join(" and ")));
            }
        }
        parts.join("; ")
    }
}

/// What Cataly recorded setting on this bot; empty for another bot or no record.
fn read_record(state_dir: &Path, me: &Value) -> serde_json::Map<String, Value> {
    crate::sys::fs::read_private(&state_dir.join(PROFILE_RECORD), 64 * 1024)
        .ok()
        .flatten()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Map<String, Value>>(&bytes).ok())
        .filter(|r| r.get("bot").is_some() && r.get("bot") == me.get("id"))
        .unwrap_or_default()
}

/// Standard base64 with padding.
pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk.first().copied().unwrap_or(0),
            chunk.get(1).copied().unwrap_or(0),
            chunk.get(2).copied().unwrap_or(0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        for (i, shift) in [18u32, 12, 6, 0].into_iter().enumerate() {
            if i <= chunk.len() {
                let index = usize::try_from((n >> shift) & 63).unwrap_or(0);
                out.push(char::from(TABLE.get(index).copied().unwrap_or(b'A')));
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// The config with the guild, owner, the lead's channel and the `cataly-ops` destination; a
/// setting is written only when the file says something else.
pub(super) fn config_text(
    config: &Config,
    mut text: String,
    d: &Discord,
    lead: Snowflake,
    ops: Snowflake,
) -> String {
    let c = &config.discord;
    if c.guild != Some(d.guild) {
        text = setup::set_key(&text, "discord", "guild", &d.guild.to_string());
    }
    if c.owner != Some(d.owner) {
        text = setup::set_key(&text, "discord", "owner", &d.owner.to_string());
    }
    if !c.channels.contains(&lead) {
        let mut channels = c.channels.clone();
        channels.push(lead);
        let quoted: Vec<String> = channels
            .iter()
            .map(|c| setup::toml_string(&c.to_string()))
            .collect();
        text = setup::set_rendered(
            &text,
            "discord",
            "channels",
            &format!("[{}]", quoted.join(", ")),
        );
        if channels.len() > 1 && c.home.is_none() {
            text = setup::set_key(&text, "discord", "home", &lead.to_string());
        }
    }
    let dest = Destination::Discord {
        channel: ChannelRef::Id(ops),
    };
    if config.destinations.get(OPS) != Some(&dest) {
        let section = format!("destinations.{OPS}");
        text = setup::set_key(&text, &section, "kind", "discord");
        text = setup::set_key(&text, &section, "channel", &ops.to_string());
    }
    text
}

/// Whether the application has either Message Content flag.
fn intent_on(app: &Value) -> bool {
    app.get("flags")
        .and_then(Value::as_u64)
        .is_some_and(|f| f & (MESSAGE_CONTENT | MESSAGE_CONTENT_LIMITED) != 0)
}

/// The application's owner: the team's owner for a team application, else its owning user.
fn app_owner(app: &Value) -> Option<(Snowflake, String)> {
    if let Some(team) = app.get("team").filter(|t| !t.is_null()) {
        let id = team
            .get("owner_user_id")
            .and_then(Value::as_str)
            .and_then(Snowflake::parse)?;
        let name = team
            .get("members")
            .and_then(Value::as_array)
            .and_then(|m| {
                m.iter().find_map(|member| {
                    let user = member.get("user")?;
                    (user.get("id").and_then(Value::as_str) == Some(id.to_string().as_str()))
                        .then(|| user.get("username").and_then(Value::as_str))
                        .flatten()
                })
            })
            .unwrap_or("the team owner");
        return Some((id, name.to_string()));
    }
    let owner = app.get("owner")?;
    let id = owner
        .get("id")
        .and_then(Value::as_str)
        .and_then(Snowflake::parse)?;
    let name = owner.get("username").and_then(Value::as_str).unwrap_or("?");
    Some((id, name.to_string()))
}

/// A client for `token` once Discord accepted it as a bot's. The error says whether Discord
/// refused the token (`true`) or could not be asked.
async fn bot(base: &Base, token: &str) -> Result<Rest, (bool, String)> {
    let rest = Rest::new(base.clone(), token, None).map_err(|e| (true, e))?;
    match rest.me().await {
        Ok(me) if me.get("bot").and_then(Value::as_bool) == Some(true) => Ok(rest),
        Ok(_) => Err((true, "it is not a bot's token".into())),
        Err(e) if e.status == Some(401) => Err((true, e.why)),
        Err(e) => Err((false, e.why)),
    }
}

/// Saves the token in its owner-only file, in an owner-only folder.
fn store_token(path: &Path, token: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        crate::sys::fs::ensure_private_dir(dir).map_err(|e| e.to_string())?;
    }
    let bytes = format!("{token}\n");
    let written = if std::fs::symlink_metadata(path).is_ok() {
        crate::sys::fs::write_atomic(path, bytes.as_bytes())
    } else {
        crate::sys::fs::create_atomic(path, bytes.as_bytes())
    };
    written.map_err(|e| e.to_string())
}

/// The Developer Portal steps only the owner can take.
fn portal_steps(path: &Path, at_terminal: bool) -> Vec<String> {
    let last = if at_terminal {
        "Paste it below; setup checks it and saves it in".to_string()
    } else {
        "Save it, alone, in".to_string()
    };
    vec![
        format!("Make Cataly's bot in the Discord Developer Portal, {PORTAL}:"),
        "  1. New Application, give it a name, Create.".to_string(),
        "  2. Bot, Reset Token, copy the token.".to_string(),
        format!("  3. {last} {} (only you may read it).", path.display()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invite_permissions_are_the_ones_cataly_uses() {
        assert_eq!(PERMISSIONS, 2_252_126_231_268_432);
    }

    #[test]
    fn base64_matches_the_standard_and_the_images_are_jpegs() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        for (field, bytes) in IMAGES {
            assert!(bytes.starts_with(&[0xFF, 0xD8, 0xFF]), "{field}");
            assert!(bytes.len() <= 512 * 1024, "{field}");
        }
    }

    #[test]
    fn the_owner_comes_from_the_team_or_the_user() {
        let user =
            json!({ "owner": { "id": "100000000000000001", "username": "me" }, "team": null });
        assert_eq!(
            app_owner(&user).map(|(id, n)| (id.to_string(), n)),
            Some(("100000000000000001".into(), "me".into()))
        );
        let team = json!({ "owner": { "id": "100000000000000009", "username": "team123" },
            "team": { "owner_user_id": "100000000000000002",
                "members": [{ "user": { "id": "100000000000000002", "username": "lead" } }] } });
        assert_eq!(
            app_owner(&team).map(|(id, n)| (id.to_string(), n)),
            Some(("100000000000000002".into(), "lead".into()))
        );
        assert!(intent_on(&json!({ "flags": MESSAGE_CONTENT_LIMITED })));
        assert!(!intent_on(&json!({ "flags": 1 << 23 })));
    }
}
