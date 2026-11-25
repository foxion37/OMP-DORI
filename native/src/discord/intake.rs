use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use tokio::{
    sync::watch,
    time::{MissedTickBehavior, interval},
};

use super::{
    Message, Snowflake, Transport,
    inbox::Inbox,
    threads::{Discovery, Routes},
    wake::Wake,
};
use crate::harness::discord::{Origin, Worker};
use crate::routing::ask;
pub(super) mod cursor_file;

const PAGE: u8 = 100;
const PAGE_LIMIT: usize = 20;

pub(super) struct Poll<'a> {
    pub(super) seconds: u64,
    pub(super) gateway: bool,
    pub(super) imported: Option<&'a Path>,
    pub(super) discovery: Option<(&'a mut Discovery, &'a Routes)>,
}

pub(super) struct Intake<'a, 'b> {
    pub(super) worker: Worker<'a, 'b>,
    pub(super) transport: Transport,
    pub(super) bot: Snowflake,
    pub(super) owner: Snowflake,
    pub(super) stop: watch::Receiver<bool>,
    pub(super) ask_state: Option<&'a Path>,
    pub(super) inbox: &'a Inbox,
}

struct Backlog {
    highest: Snowflake,
    requests: BTreeMap<Snowflake, Request>,
}

struct Request {
    queued: bool,
    text: String,
    reference: Option<Snowflake>,
    plain: bool,
}

impl Intake<'_, '_> {
    pub(super) async fn run(
        &mut self,
        channels: &[Snowflake],
        wake: &Wake,
        settings: Poll<'_>,
    ) -> Result<()> {
        let Poll {
            seconds: poll_seconds,
            gateway,
            imported,
            mut discovery,
        } = settings;
        for &channel in channels {
            if discovery.as_ref().is_none_or(|(d, _)| d.readable(channel)) {
                self.seed(channel, imported).await?;
            }
        }
        println!(
            "INBOUND_READY discord owner={} bot={} mode=rust-{}",
            self.owner,
            self.bot,
            if gateway { "gateway" } else { "rest" }
        );
        let mut ticks = interval(Duration::from_secs(if gateway {
            30
        } else {
            poll_seconds.max(1)
        }));
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        loop {
            let pending = tokio::select! {
                biased;
                () = super::stopped(&mut self.stop) => return Ok(()),
                Some(event) = self.transport.interaction() => {
                    // Expired or replayed cards are never forwarded to OMP while no turn is pending.
                    if self.transport.callback(&event, false).await.is_err() {
                        eprintln!("DISCORD_EXPIRED_INTERACTION_CALLBACK_FAILED");
                    }
                    continue;
                }
                _ = ticks.tick() => {
                    wake.take();
                    Wake::ALL
                }
                pending = wake.receive(), if gateway => pending,
            };
            let (threads, baseline) = match discovery.as_mut() {
                Some((discovery, routes)) => {
                    let refreshed = discovery.refresh(&self.transport.api, routes).await;
                    (
                        routes.take(refreshed || pending == Wake::ALL),
                        Some((discovery.startup, *routes)),
                    )
                }
                None => (BTreeSet::new(), None),
            };
            let exact = channels.iter().enumerate().filter_map(|(index, &id)| {
                (pending & (1 << index) != 0
                    && discovery.as_ref().is_none_or(|(d, _)| d.readable(id)))
                .then_some((id, None))
            });
            let discovered = threads.into_iter().filter_map(|id| {
                channels
                    .binary_search(&id)
                    .is_err()
                    .then_some((id, baseline))
            });
            for (channel, route) in exact.chain(discovered) {
                if !self
                    .process_channel(channel, route, imported, gateway || poll_seconds > 0)
                    .await?
                {
                    return Ok(());
                }
            }
            if pending == Wake::ALL {
                self.inbox.clear_sync()?;
            }
            if !gateway && poll_seconds == 0 {
                return Ok(());
            }
        }
    }

    async fn process_channel(
        &mut self,
        channel: Snowflake,
        route: Option<(Snowflake, &Routes)>,
        imported: Option<&Path>,
        continuous: bool,
    ) -> Result<bool> {
        let allowed = || route.is_none_or(|(_, routes)| routes.contains(channel));
        if !allowed() {
            return Ok(true);
        }
        let origin = self.origin(channel, Snowflake::FLOOR);
        let cursor = match (self.worker.cursor(origin)?, route) {
            (Some(cursor), _) => cursor,
            (None, Some((startup, _))) => {
                let cursor = self.initial_cursor(channel, imported)?.unwrap_or(startup);
                self.worker.advance(self.origin(channel, cursor))?;
                cursor
            }
            (None, None) => anyhow::bail!("Discord cursor disappeared during intake"),
        };
        let backlog = match self.backfill(channel, cursor).await {
            Ok(backlog) => backlog,
            Err(error) if continuous => {
                eprintln!("DISCORD_INTAKE_HELD channel={channel}: {error:#}");
                return Ok(true);
            }
            Err(error) => return Err(error),
        };
        let mut committed = cursor;
        for (
            id,
            Request {
                queued,
                text,
                reference,
                plain,
            },
        ) in backlog.requests
        {
            if *self.stop.borrow() {
                return Ok(false);
            }
            if !allowed() {
                return Ok(true);
            }
            let origin = self.origin(channel, id);
            if self.inbox.settled(channel, id)? {
                self.confirm(origin, &mut committed, imported, queued)?;
                continue;
            }
            if let Some(state) = self.ask_state
                && ask::route(
                    state,
                    &ask::Reply {
                        channel,
                        message: id,
                        reference,
                        owner: self.owner,
                        text: text.as_str().into(),
                        plain,
                    },
                )?
            {
                self.confirm(origin, &mut committed, imported, queued)?;
                continue;
            }
            match self
                .worker
                .run_message(&mut self.transport, origin, text.trim(), &mut self.stop)
                .await
            {
                Ok(true) => self.confirm(origin, &mut committed, imported, queued)?,
                Ok(false) => return Ok(false),
                Err(error) if continuous => {
                    eprintln!("DISCORD_LANE_HELD channel={channel} request={id}: {error:#}");
                    return Ok(true);
                }
                Err(error) => return Err(error),
            }
        }
        if backlog.highest > committed && allowed() {
            self.confirm(
                self.origin(channel, backlog.highest),
                &mut committed,
                imported,
                false,
            )?;
        }
        Ok(true)
    }

    async fn seed(&self, channel: Snowflake, imported: Option<&Path>) -> Result<()> {
        if self
            .worker
            .cursor(self.origin(channel, Snowflake::FLOOR))?
            .is_none()
        {
            let latest = match self.initial_cursor(channel, imported)? {
                Some(cursor) => cursor,
                None => self
                    .transport
                    .api
                    .history(channel, None, 1)
                    .await?
                    .first()
                    .map_or(Snowflake::FLOOR, |message| message.id),
            };
            self.worker.advance(self.origin(channel, latest))?;
        }
        Ok(())
    }

    fn initial_cursor(
        &self,
        channel: Snowflake,
        imported: Option<&Path>,
    ) -> Result<Option<Snowflake>> {
        if let Some(cursor) = cursor_file::read(imported, channel)? {
            return Ok(Some(cursor));
        }
        Ok(self
            .inbox
            .next(channel, None)?
            .map(|(message, _)| message.id.preceding().unwrap_or(Snowflake::FLOOR)))
    }

    fn confirm(
        &self,
        origin: Origin,
        committed: &mut Snowflake,
        imported: Option<&Path>,
        queued: bool,
    ) -> Result<()> {
        if origin.message > *committed {
            cursor_file::write(imported, origin.channel, origin.message)?;
            self.worker.advance(origin)?;
            *committed = origin.message;
        }
        if queued {
            self.inbox.acknowledge(origin.channel, origin.message)?;
        }
        Ok(())
    }

    const fn origin(&self, channel: Snowflake, message: Snowflake) -> Origin {
        Origin {
            bot: self.bot,
            owner: self.owner,
            channel,
            message,
        }
    }

    async fn backfill(&self, channel: Snowflake, cursor: Snowflake) -> Result<Backlog> {
        let mut batch = Backlog {
            highest: cursor,
            requests: BTreeMap::new(),
        };
        let mut bytes = 0usize;
        let mut before = None;
        for _ in 0..PAGE_LIMIT {
            let page = self.transport.api.history(channel, before, PAGE).await?;
            let oldest = page.iter().map(|message| message.id).min();
            let complete = page.len() < usize::from(PAGE) || oldest.is_some_and(|id| id <= cursor);
            ensure!(
                before.is_none_or(|bound| page.iter().all(|message| message.id < bound)),
                "Discord history did not advance its page boundary"
            );
            for message in page.into_iter().filter(|message| message.id > cursor) {
                self.collect(&mut batch, channel, message, false, &mut bytes)?;
            }
            if complete {
                self.merge_queued(&mut batch, channel, cursor, &mut bytes)?;
                return Ok(batch);
            }
            before = oldest;
        }
        anyhow::bail!("Discord backlog exceeds the bounded history window; no cursor was advanced")
    }

    fn merge_queued(
        &self,
        batch: &mut Backlog,
        channel: Snowflake,
        cursor: Snowflake,
        bytes: &mut usize,
    ) -> Result<()> {
        let mut after = None;
        for _ in 0..PAGE_LIMIT * usize::from(PAGE) {
            let Some((message, native)) = self.inbox.next(channel, after)? else {
                return Ok(());
            };
            after = Some(message.id);
            if !native && message.id <= cursor {
                self.inbox.acknowledge(channel, message.id)?;
            } else {
                self.collect(batch, channel, message, true, bytes)?;
            }
        }
        ensure!(
            self.inbox.next(channel, after)?.is_none(),
            "Discord FIFO exceeded the bounded processing window"
        );
        Ok(())
    }

    fn collect(
        &self,
        batch: &mut Backlog,
        channel: Snowflake,
        message: Message,
        queued: bool,
        bytes: &mut usize,
    ) -> Result<()> {
        batch.highest = batch.highest.max(message.id);
        if let Some(previous) = batch.requests.remove(&message.id) {
            *bytes -= previous.text.len();
        }
        let valid = message.author.id == self.owner
            && !message.author.bot
            && !message.author.system
            && message.webhook_id.is_none()
            && matches!(message.kind, 0 | 19);
        let text = if valid {
            message.content.context(
                "Discord owner message content unavailable: check Message Content Intent",
            )?
        } else {
            String::new()
        };
        if text.trim().is_empty() {
            if queued {
                self.inbox.acknowledge(channel, message.id)?;
            }
            return Ok(());
        }
        *bytes += text.len();
        ensure!(
            *bytes <= 8 * 1024 * 1024,
            "Discord owner backlog exceeded its byte limit"
        );
        let reply = message.reference.filter(|reference| reference.kind == 0);
        if self.ask_state.is_some() {
            ensure!(
                reply
                    .and_then(|reference| reference.channel_id)
                    .is_none_or(|id| id == channel),
                "Discord reply belongs to a different conversation"
            );
        }
        batch.requests.insert(
            message.id,
            Request {
                queued,
                text,
                reference: reply.and_then(|reference| reference.message_id),
                plain: message.kind == 0
                    && message.reference.is_none()
                    && !message.has_reference_snapshot
                    && !message.forwarded
                    && message.attachments.is_empty(),
            },
        );
        Ok(())
    }
}
