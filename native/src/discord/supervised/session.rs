//! Per-message routing in the TypeScript order (cli-discord.ts:140-175): activity, ASK, lane, head.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context as _, Result, bail};
use serde_json::{Map, Value, json};

use super::poll::Scope;
use crate::discord::{
    Snowflake,
    activity::Activity,
    admission::{Head, Plan},
    api::DiscordApi,
    context::Context,
    inbound::Inbound,
    inbox::Inbox,
    lanes::Lanes,
    owes,
    recall::Recall,
};
use crate::routing::ask;

const ASK_PROTOCOL: &str = "cataly-ask-routing-v1";
const ASK_WAIT: Duration = Duration::from_secs(12);

/// ASK routing selected by `CATALY_ASK_ROUTING_STATE` (discord-ask-relay.ts:19-23).
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Relay {
    /// Not advertised: route natively in this process.
    Native,
    /// The supervisor advertised exactly this state over its live IPC channel.
    Supervisor,
    /// Advertised for another state, or without a channel: every routable reply fails unsettled.
    Unavailable,
}

/// The source-activity record could not be published (TS `InboundActivityError`): never retried.
#[derive(Debug)]
pub(super) struct ActivityFailed;

impl std::fmt::Display for ActivityFailed {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(
            "Discord inbound activity could not be published; the cursor was not advanced",
        )
    }
}

pub(super) struct Session<'a> {
    pub(super) api: &'a DiscordApi,
    pub(super) bot: Snowflake,
    pub(super) owner: Snowflake,
    pub(super) cataly: &'a Path,
    pub(super) cursors: &'a Path,
    pub(super) inbox: &'a Inbox,
    pub(super) head: Head<'a>,
    pub(super) relay: Relay,
    pub(super) lanes: Lanes,
    pub(super) context: Option<Context>,
    pub(super) recall: Option<Recall>,
    pub(super) activity: Option<Activity>,
    pub(super) scope: Scope<'a>,
}

impl Session<'_> {
    /// `storeFor(channel, seed).load()`: an absent cursor is seeded from the oldest queued message minus one.
    pub(super) fn cursor(&self, channel: Snowflake, seed: bool) -> Result<Option<Snowflake>> {
        if let Some(cursor) =
            crate::discord::intake::cursor_file::read(Some(self.cursors), channel)?
        {
            return Ok(Some(cursor));
        }
        if seed && let Some(first) = self.inbox.first_message(channel)? {
            let cursor = first.preceding().unwrap_or(Snowflake::FLOOR);
            self.save(channel, cursor)?;
            return Ok(Some(cursor));
        }
        Ok(None)
    }

    /// The watched channel's cursor, which intake never deletes.
    pub(super) fn current(&self, channel: Snowflake) -> Result<Snowflake> {
        self.cursor(channel, false)?
            .context("Discord inbound cursor disappeared; restore its state before retrying")
    }

    /// `store.save`: the cursor file, then receipt checkpoints for that channel.
    pub(super) fn save(&self, channel: Snowflake, cursor: Snowflake) -> Result<()> {
        self.inbox.save_cursor(self.cursors, channel, cursor)
    }

    pub(super) fn healthy(&mut self) -> Result<()> {
        self.activity.as_mut().map_or(Ok(()), |activity| {
            activity.healthy().context(ActivityFailed)
        })
    }

    pub(super) fn unavailable(&mut self) -> Result<()> {
        self.activity.as_mut().map_or(Ok(()), |activity| {
            activity.unavailable().context(ActivityFailed)
        })
    }

    /// Failure to add a read receipt must not replay the owner's request (discord-inbound.ts:33-43).
    async fn mark_seen(&self, inbound: &Inbound) {
        if self
            .api
            .react_seen(inbound.channel, inbound.message)
            .await
            .is_err()
        {
            eprintln!(
                "Discord read receipt failed for {}/{}",
                inbound.channel, inbound.message
            );
        }
    }

    /// `routeDiscordAsk` (discord-ask-routing.ts): the supervisor's relay when advertised, else native routing.
    async fn ask(&self, inbound: &Inbound) -> Result<bool> {
        let plain = inbound.unreferenced_text;
        if inbound.reference.is_none() && !plain {
            return Ok(false);
        }
        if self.relay == Relay::Unavailable {
            bail!("Native ASK supervisor binding is unavailable");
        }
        if self.relay == Relay::Native {
            return ask::route(
                self.cataly,
                &ask::Reply {
                    channel: inbound.channel,
                    message: inbound.message,
                    reference: inbound.reference,
                    owner: self.owner,
                    text: inbound.text.as_str().into(),
                    plain,
                },
            );
        }
        let ipc = self
            .head
            .ipc
            .context("Native ASK supervisor binding is unavailable")?;
        let mut message = Map::new();
        message.insert("protocol".to_owned(), json!(ASK_PROTOCOL));
        message.insert("channel".to_owned(), json!(inbound.channel));
        message.insert("message".to_owned(), json!(inbound.message));
        message.insert("reference".to_owned(), json!(inbound.reference));
        message.insert("text".to_owned(), json!(inbound.text));
        message.insert("owner".to_owned(), json!(self.owner));
        message.insert("plain".to_owned(), json!(plain));
        let reply = tokio::time::timeout(ASK_WAIT, ipc.exchange(message)).await;
        match reply {
            Ok(Ok(reply))
                if reply.get("protocol").and_then(Value::as_str) == Some(ASK_PROTOCOL) =>
            {
                match reply.get("routed") {
                    Some(Value::Bool(routed)) => Ok(*routed),
                    _ => bail!("Native ASK routing stopped; delivery remains unsettled"),
                }
            }
            _ => bail!("Native ASK routing stopped; delivery remains unsettled"),
        }
    }

    /// One owner message. Returning `Ok` lets the caller advance the cursor; any error retains it.
    pub(super) async fn emit(&mut self, inbound: &Inbound) -> Result<()> {
        if let Some(activity) = self.activity.as_mut() {
            activity.received().context(ActivityFailed)?;
        }
        if self.ask(inbound).await? {
            self.mark_seen(inbound).await;
            return Ok(());
        }
        if self.lanes.route(inbound).await? {
            self.mark_seen(inbound).await;
            return Ok(());
        }
        self.head.reconcile(self.inbox, self.cursors).await?;
        let cursor = self.cursor(inbound.channel, true)?;
        let plan = Head::plan(
            self.inbox,
            inbound,
            cursor,
            inbound.identity(self.bot, self.owner),
        )?;
        if matches!(plan, Plan::Skip) {
            return Ok(());
        }
        let mut text = inbound.format();
        if let Some(context) = self.context.as_mut() {
            text.push('\n');
            text.push_str(&context.line(self.api, inbound).await);
        }
        owes::record(self.cataly, &text).await?;
        if let Some(recall) = &self.recall {
            let space = self.inbox.parent_for(inbound.channel).map_or_else(
                |_| {
                    eprintln!("WARN recall: Discord conversation scope was not available");
                    None
                },
                |admitted| self.scope.space(inbound.channel, admitted),
            );
            if let Some(line) = recall.recall(inbound, space) {
                text.push('\n');
                text.push_str(&line);
            }
        }
        self.head.admit(self.inbox, inbound, plan, text).await
    }
}
