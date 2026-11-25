//! TS-compatible Discord intake for the OMP extension (`--cataly-state`): owner messages go to ASK routing,
//! then lane inboxes, then the live head through the admission protocol (cli-discord.ts:84-243). No OMP session
//! is started for the head here; `--wake-lanes` lanes are started by the Lanes slice.

use std::fs::DirBuilder;
use std::os::unix::fs::DirBuilderExt as _;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context as _, Result, bail, ensure};
use reqwest::Url;
use tokio::time::{Instant, MissedTickBehavior, interval, sleep_until};

use super::{
    Options, Snowflake,
    activity::Activity,
    admission::{self, Head},
    api::RestStatus,
    configured_api,
    context::Context,
    gateway::{Health, IntakeLink, Link, Supervision},
    gateway_url,
    inbox::{First, Inbox, Ledger, admissions::HeadUnresolved},
    ipc::{Disconnected, Ipc},
    lanes::{LaneHold, Lanes},
    monitor::{bot_profile, termination},
    recall::Recall,
    receiver::Receiver,
    threads::{Discovery, Routes},
    wake::Wake,
};

mod poll;
mod session;

use poll::Scope;
use session::{ActivityFailed, Relay, Session};

/// The ASK receiver route's channel bound (discord-ask-receiver.ts `MAX_CHANNELS`).
const CHANNEL_LIMIT: usize = 1_024;

/// A Gateway backfill failure, retried with backoff when transient (discord-inbound-live.ts:63-81).
#[derive(Debug)]
struct Backfill;

impl std::fmt::Display for Backfill {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Discord inbound backfill failed")
    }
}

/// `transientRetryDelay`: only a known rejection or a read failure is retried.
fn transient(error: &anyhow::Error) -> bool {
    if error.downcast_ref::<HeadUnresolved>().is_some()
        || error.downcast_ref::<ActivityFailed>().is_some()
    {
        return false;
    }
    if let Some(status) = error.downcast_ref::<RestStatus>() {
        return status.status == 429 || status.status >= 500;
    }
    error.downcast_ref::<reqwest::Error>().is_some()
}

/// ``console.log(`WARN ${message}`.slice(0, 300))``.
fn warn(error: &anyhow::Error) {
    let line: String = format!("WARN {error:#}").chars().take(300).collect();
    println!("{line}");
}

fn relay(ipc: Option<&Ipc>, cataly: &Path) -> Relay {
    match std::env::var("CATALY_ASK_ROUTING_STATE") {
        Ok(advertised) if !advertised.is_empty() => {
            if ipc.is_some() && Path::new(&advertised) == cataly {
                Relay::Supervisor
            } else {
                Relay::Unavailable
            }
        }
        _ => Relay::Native,
    }
}

/// Explicit targets in command-line order without duplicates (`[...new Set(channelIds)]`), which is also the
/// `INBOUND_READY` and receiver route order.
fn explicit_channels(values: &[String]) -> Result<Vec<Snowflake>> {
    let mut channels = Vec::new();
    for value in values {
        let id = Snowflake::try_from(value.clone()).map_err(anyhow::Error::msg)?;
        if !channels.contains(&id) {
            channels.push(id);
        }
        ensure!(
            channels.len() <= CHANNEL_LIMIT,
            "Discord intake accepts at most {CHANNEL_LIMIT} explicit channels"
        );
    }
    Ok(channels)
}

/// Validated paths and identities from the command line.
fn arguments(options: &Options) -> Result<(PathBuf, Snowflake, Vec<Snowflake>)> {
    let cataly = options
        .cataly_state
        .clone()
        .context("--cataly-state is required")?;
    ensure!(
        cataly.is_absolute(),
        "--cataly-state must be an absolute path"
    );
    ensure!(
        !options.wake_lanes || (!options.gateway && options.poll_seconds > 0),
        "--wake-lanes requires continuous Discord REST intake"
    );
    admission::check_mode(options.supervised)?;
    let owner = Snowflake::try_from(options.owner.clone()).map_err(anyhow::Error::msg)?;
    Ok((cataly, owner, explicit_channels(&options.channel)?))
}

/// Resolves with an error once the supervising channel is gone (exitOnDisconnect); never without one.
async fn disconnected(ipc: Option<&Ipc>) -> Result<()> {
    let Some(ipc) = ipc else {
        return std::future::pending().await;
    };
    ipc.disconnected().await;
    Err(Disconnected.into())
}

pub(super) async fn run(options: Options) -> Result<()> {
    let (cataly, owner, explicit) = arguments(&options)?;
    let gateway = gateway_url()?;
    let (api, token) = configured_api()?;
    let ipc = options.supervised.then(Ipc::open).transpose()?;
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&cataly)
        .context("creating the Cataly state directory")?;
    let cursors = cataly.join("discord-inbound");
    let bot = bot_profile(&api, owner, options.default_avatar.as_deref()).await?;
    let ledger = if options.supervised {
        Ledger::Forced
    } else {
        Ledger::Existing
    };
    let inbox = Inbox::open(&cursors, bot, owner, ledger)?;
    let head = Head {
        ipc: ipc.as_ref(),
        protocol: admission::PROTOCOL,
    };
    head.reconcile(&inbox, &cursors).await?;
    if !options.gateway && inbox.has_pending()? {
        bail!("Discord inbound has pending Gateway work; restart with --gateway before REST mode");
    }
    let activity = options
        .activity_file
        .as_deref()
        .map(Activity::open)
        .transpose()?;
    let follow = options.follow_threads && !options.scope_all;
    let discovery = if follow {
        Some(Discovery::open(&api, &explicit).await?)
    } else {
        None
    };
    let routes = Routes::default();
    let receiver = (options.gateway || options.poll_seconds > 0)
        .then(|| {
            let window = (!options.gateway).then(|| options.poll_seconds * 1000 + 15_000);
            Receiver::open(&cataly, &token, owner, &explicit, window)
        })
        .transpose()?;
    let mut session = Session {
        api: &api,
        bot,
        owner,
        cataly: &cataly,
        cursors: &cursors,
        inbox: &inbox,
        relay: relay(ipc.as_ref(), &cataly),
        head,
        lanes: Lanes::open(&cataly, bot, owner, options.wake_lanes)?,
        context: options.context.then(|| Context::new(&cataly)),
        recall: options
            .recall_retention_days
            .map(|days| Recall::open(&cataly, days, bot, owner))
            .transpose()?,
        activity,
        scope: Scope::new(explicit, options.scope_all, discovery, &routes),
    };
    session.refresh(true, true).await?;
    let watching = if options.scope_all {
        "all".to_owned()
    } else {
        let ids: Vec<String> = session
            .scope
            .watched
            .iter()
            .map(ToString::to_string)
            .collect();
        ids.join(",")
    };
    println!(
        "INBOUND_READY discord owner={owner} channel={watching} bot={bot}{}",
        if options.gateway { " mode=gateway" } else { "" }
    );
    let intake = async {
        if options.gateway {
            let link = Endpoint {
                url: &gateway,
                token: &token,
                all: options.scope_all,
                follow,
            };
            live(&mut session, link, receiver.as_ref()).await
        } else {
            rest(&mut session, options.poll_seconds, receiver.as_ref()).await
        }
    };
    tokio::select! {
        result = intake => result,
        result = disconnected(ipc.as_ref()) => result,
        result = termination() => result,
    }
}

/// The Gateway connection settings for live intake.
struct Endpoint<'a> {
    url: &'a Url,
    token: &'a str,
    all: bool,
    follow: bool,
}

/// `every(pollMinutes, tick, retry)` (cli-discord.ts:179-194, cli-context.ts:46-63).
async fn rest(session: &mut Session<'_>, seconds: u64, receiver: Option<&Receiver>) -> Result<()> {
    let period = Duration::from_secs(seconds);
    loop {
        let tick = async {
            session.poll(false).await?;
            if let Some(receiver) = receiver {
                receiver.refresh(&session.scope.watched);
            }
            let watched = session.scope.watched.clone();
            session.lanes.service(session.api, &watched).await?;
            session.healthy()
        }
        .await;
        if let Err(error) = tick {
            if let Some(receiver) = receiver {
                receiver.suspend();
            }
            if error.downcast_ref::<ActivityFailed>().is_some() {
                return Err(error);
            }
            session.unavailable()?;
            if error.downcast_ref::<LaneHold>().is_none() && !transient(&error) {
                return Err(error);
            }
            // A lane hold or a transient failure keeps the interval; REST already waited Discord's short floor.
            warn(&error);
        }
        if seconds == 0 {
            return Ok(());
        }
        tokio::time::sleep(period).await;
    }
}

/// One drain round: the startup recovery backfill, the FIFO in order, then thread following. Returns whether a
/// backfill completed.
async fn round(session: &mut Session<'_>, recover: &mut bool) -> Result<bool> {
    let mut backfilled = if *recover {
        session.sync().await.context(Backfill)?;
        *recover = false;
        true
    } else {
        false
    };
    backfilled |= session.drain().await?;
    session.follow().await.context(Backfill)?;
    Ok(backfilled)
}

/// `discordInboundLive` (discord-inbound-live.ts): the durable FIFO is drained in order, a `sync` marker owes a
/// backfill, and the receiver is healthy only after a synced, empty queue on the current connection.
async fn live(
    session: &mut Session<'_>,
    endpoint: Endpoint<'_>,
    receiver: Option<&Receiver>,
) -> Result<()> {
    let health = Health::default();
    let wake = Wake::default();
    // The Gateway admits by binary search.
    let mut explicit = session.scope.explicit.clone();
    explicit.sort_unstable();
    let (inbox, cursors, routes) = (session.inbox, session.cursors, session.scope.routes);
    let link = Link {
        url: endpoint.url,
        token: endpoint.token,
        intake: Some(IntakeLink {
            channels: &explicit,
            owner: session.owner,
            wake: &wake,
            threads: endpoint.follow.then_some(routes),
            inbox,
            interactions: None,
            supervision: Some(Supervision {
                cursors,
                all: endpoint.all,
                health: &health,
            }),
        }),
    };
    let link = link.run();
    tokio::pin!(link);
    let mut ticks = interval(Duration::from_secs(30));
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut recover = matches!(session.inbox.first()?, Some(First::Message { .. }));
    let mut synced = None;
    let mut retry_at: Option<Instant> = None;
    let mut delay = Duration::from_secs(2);
    let mut seen = health.snapshot();
    loop {
        tokio::select! {
            biased;
            result = &mut link => return result,
            _ = wake.receive() => {}
            () = health.changed() => {}
            _ = ticks.tick() => {}
            () = async { if let Some(at) = retry_at { sleep_until(at).await } else { std::future::pending().await } } => {}
        }
        if retry_at.is_some_and(|at| at > Instant::now()) {
            continue;
        }
        retry_at = None;
        let before = health.snapshot();
        if before != seen {
            seen = before;
            synced = None;
            session.unavailable()?;
            if !before.0
                && let Some(receiver) = receiver
            {
                receiver.suspend();
            }
        }
        // The Gateway keeps heartbeating and persisting dispatches while a round awaits admission.
        let round = tokio::select! {
            biased;
            result = &mut link => return result,
            round = round(session, &mut recover) => round,
        };
        match round {
            Ok(backfilled) => {
                delay = Duration::from_secs(2);
                let after = health.snapshot();
                if backfilled && after.0 && after == before {
                    synced = Some(after.1);
                    if let Some(receiver) = receiver {
                        receiver.refresh(&session.scope.watched);
                    }
                }
                if after.0 && synced == Some(after.1) && !session.inbox.has_pending()? {
                    session.healthy()?;
                }
            }
            Err(error) if error.downcast_ref::<Backfill>().is_some() && transient(&error) => {
                if let Some(receiver) = receiver {
                    receiver.suspend();
                }
                println!(
                    "DISCORD_GATEWAY_BACKFILL_RETRY discord retry_in={}s",
                    delay.as_secs()
                );
                retry_at = Some(Instant::now() + delay);
                delay = (delay * 2).min(Duration::from_secs(30));
            }
            Err(error) => {
                if let Some(receiver) = receiver {
                    receiver.suspend();
                }
                drop(session.unavailable());
                return Err(error);
            }
        }
    }
}
