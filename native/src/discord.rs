use std::path::PathBuf;

use anyhow::{Context, Result, ensure};
use clap::Args;
use reqwest::Url;
use serde::Deserialize;

use crate::harness::discord::Snowflake;

mod activity;
mod admission;
mod api;
mod context;
#[cfg(any(target_os = "macos", test))]
mod darwin;
mod gateway;
mod inbound;
mod inbox;
mod intake;
mod ipc;
mod lanes;
mod monitor;
mod owes;
mod presence;
mod recall;
mod receiver;
mod scope;
mod send;
mod supervised;
mod threads;
mod wake;
pub use api::{Destination, ReplyExtras};
pub use presence::presence;
pub use send::{SendOptions, send};

// Each bool is an independent clap CLI flag; grouping them would change the command line.
#[allow(clippy::struct_excessive_bools)]
#[derive(Args, Debug)]
pub struct Options {
    /// Import the TypeScript monitor's per-channel cursor only when the native cursor is absent, and mirror it.
    #[arg(long)]
    import_cursors: Option<PathBuf>,
    /// Private directory for Discord cursors, OMP sessions and confirmed replies.
    #[arg(
        long,
        required_unless_present = "cataly_state",
        conflicts_with = "cataly_state"
    )]
    state_dir: Option<PathBuf>,
    /// Absolute Cataly state directory: TS-compatible intake that hands head messages to the OMP extension.
    #[arg(long, conflicts_with_all = ["import_cursors", "head_channel", "ask_state", "inbox"])]
    cataly_state: Option<PathBuf>,
    /// Admit head messages over the supervising extension's IPC channel on standard input.
    #[arg(long, requires = "cataly_state")]
    supervised: bool,
    /// Watch every guild text channel, active thread and the owner DM instead of only explicit channels.
    #[arg(long, requires = "cataly_state")]
    scope_all: bool,
    /// Append an `INBOUND_CONTEXT` line with channel metadata and purposes to each head message.
    #[arg(long, requires = "cataly_state")]
    context: bool,
    /// Start lane OMP sessions for messages routed to sleeping Discord lanes (continuous REST only).
    #[arg(long, requires = "cataly_state", conflicts_with = "gateway")]
    wake_lanes: bool,
    /// Absolute source-activity record for update scheduling.
    #[arg(long, requires = "cataly_state")]
    activity_file: Option<PathBuf>,
    /// Enable owner recall with this retention in days.
    #[arg(long, requires = "cataly_state", value_parser = clap::value_parser!(u32).range(1..=3650))]
    recall_retention_days: Option<u32>,
    /// Bundled JPEG to use only when the bot has no avatar.
    #[arg(long)]
    default_avatar: Option<PathBuf>,
    /// Discord owner user ID.
    #[arg(long, env = "CATALY_DISCORD_OWNER_ID")]
    owner: String,
    /// An explicitly allowed channel or thread ID (repeatable).
    #[arg(long, required_unless_present = "scope_all")]
    channel: Vec<String>,
    /// Bind this explicitly allowed conversation to the Rust-owned OMP head.
    #[arg(long)]
    head_channel: Option<String>,
    /// Read ASK mailboxes in this absolute Cataly state directory before dispatching to OMP.
    #[arg(long)]
    ask_state: Option<PathBuf>,
    /// Existing Discord FIFO directory; defaults to the native state directory.
    #[arg(long)]
    inbox: Option<PathBuf>,
    /// Use the Gateway for immediate wakeups and interactive decisions.
    #[arg(long)]
    gateway: bool,
    /// Follow active Discord threads under explicitly allowed parent channels.
    #[arg(long)]
    follow_threads: bool,
    /// REST polling interval in seconds; zero means one poll in REST mode.
    #[arg(long, default_value_t = 3, value_parser = clap::value_parser!(u64).range(0..=3600))]
    poll_seconds: u64,
}

#[derive(Deserialize)]
struct User {
    id: Snowflake,
    #[serde(default)]
    bot: bool,
    #[serde(default)]
    system: bool,
}

#[derive(Deserialize)]
struct BotProfile {
    #[serde(flatten)]
    user: User,
    avatar: Option<String>,
}

#[derive(Deserialize)]
struct Message {
    id: Snowflake,
    channel_id: Snowflake,
    #[serde(rename = "type")]
    kind: u8,
    author: User,
    webhook_id: Option<Snowflake>,
    content: Option<String>,
    #[serde(rename = "message_reference")]
    reference: Option<MessageReference>,
    #[serde(
        rename = "referenced_message",
        default,
        deserialize_with = "field_present"
    )]
    has_reference_snapshot: bool,
    #[serde(
        rename = "message_snapshots",
        default,
        deserialize_with = "field_present"
    )]
    forwarded: bool,
    #[serde(default)]
    attachments: Vec<serde::de::IgnoredAny>,
}

fn field_present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<bool, D::Error> {
    serde::de::IgnoredAny::deserialize(deserializer)?;
    Ok(true)
}

#[derive(Clone, Copy, Deserialize)]
struct MessageReference {
    #[serde(rename = "type", default)]
    kind: u8,
    message_id: Option<Snowflake>,
    channel_id: Option<Snowflake>,
}

#[derive(Deserialize)]
pub struct Interaction {
    id: Snowflake,
    token: String,
    application_id: Snowflake,
    channel_id: Snowflake,
    #[serde(rename = "type")]
    kind: u8,
    data: Component,
    message: InteractionMessage,
    user: Option<User>,
    member: Option<Member>,
}

#[derive(Deserialize)]
struct Component {
    component_type: u8,
    custom_id: String,
}

#[derive(Deserialize)]
struct InteractionMessage {
    id: Snowflake,
}

#[derive(Deserialize)]
struct Member {
    user: User,
}

impl Interaction {
    pub(crate) fn decision(
        &self,
        button: &crate::harness::discord::ApprovalCard,
    ) -> Option<crate::rpc::tools::Decision> {
        use crate::rpc::tools::Decision;
        let user = self
            .member
            .as_ref()
            .map(|member| &member.user)
            .or(self.user.as_ref())?;
        if user.id != button.origin.owner
            || user.bot
            || user.system
            || self.application_id != button.origin.bot
            || self.channel_id != button.origin.channel
            || self.message.id != button.message
        {
            return None;
        }
        let key = self.data.custom_id.strip_prefix("cataly-readme:")?;
        let (stamp, decision) = key.rsplit_once(':')?;
        if stamp != button.stamp {
            return None;
        }
        match decision {
            "approve" => Some(Decision::Approve),
            "deny" => Some(Decision::Deny),
            _ => None,
        }
    }

    fn valid(&self) -> bool {
        self.kind == 3
            && self.data.component_type == 2
            && self.data.custom_id.starts_with("cataly-readme:")
            && self.token.len() <= 512
            && !self.token.is_empty()
            && self
                .token
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    }
}

fn endpoint(var: &str, default: &str, scheme: &str) -> Result<Url> {
    let Ok(raw) = std::env::var(var) else {
        return Ok(Url::parse(default)?);
    };
    if raw.is_empty() {
        return Ok(Url::parse(default)?);
    }
    let url = Url::parse(&raw).with_context(|| format!("invalid {var}"))?;
    ensure!(
        url.scheme() == scheme
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
            && url.query().is_none()
            && url.host_str().is_some_and(|host| host == "localhost"
                || host
                    .trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())),
        "{var} must be a loopback {scheme} endpoint without credentials, query or fragment"
    );
    Ok(url)
}

fn gateway_url() -> Result<Url> {
    let mut url = endpoint(
        "CATALY_DISCORD_GATEWAY_URL",
        "wss://gateway.discord.gg/",
        "ws",
    )?;
    url.set_query(Some("v=10&encoding=json"));
    Ok(url)
}

fn configured_api() -> Result<(api::DiscordApi, String)> {
    let mut base = endpoint(
        "CATALY_DISCORD_API_BASE",
        "https://discord.com/api/v10/",
        "http",
    )?;
    if !base.path().ends_with('/') {
        let path = format!("{}/", base.path());
        base.set_path(&path);
    }
    let token = discord_token()?;
    Ok((api::DiscordApi::new(base, &token)?, token))
}

fn discord_token() -> Result<String> {
    let token = std::env::var("CATALY_DISCORD_TOKEN")
        .context("set CATALY_DISCORD_TOKEN for native Discord")?;
    ensure!(
        !token.is_empty(),
        "set CATALY_DISCORD_TOKEN for native Discord"
    );
    Ok(token)
}

pub struct Transport {
    api: api::DiscordApi,
    interactions: tokio::sync::mpsc::Receiver<Interaction>,
}

impl Transport {
    pub(crate) async fn reply(
        &self,
        origin: Destination,
        text: &str,
        extras: ReplyExtras<'_>,
    ) -> Result<Snowflake> {
        self.api.reply(origin, text, extras).await
    }

    pub(crate) async fn clear(&self, origin: Destination) -> Result<()> {
        self.api.clear(origin.channel, origin.message).await
    }

    pub(crate) async fn interaction(&mut self) -> Option<Interaction> {
        self.interactions.recv().await
    }

    pub(crate) async fn callback(&self, event: &Interaction, accepted: bool) -> Result<()> {
        self.api.callback(event, accepted).await
    }
}

pub use monitor::run;

pub async fn stopped(stop: &mut tokio::sync::watch::Receiver<bool>) {
    drop(stop.wait_for(|value| *value).await);
}
