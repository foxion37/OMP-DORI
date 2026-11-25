use std::path::Path;

use anyhow::{Context as _, Result, ensure};
use reqwest::Url;
use tokio::{
    signal::unix::{SignalKind, signal},
    sync::{mpsc, watch},
};

use super::{
    Options, Snowflake, Transport,
    api::DiscordApi,
    configured_api,
    gateway::{IntakeLink, Link},
    gateway_url,
    inbox::{Inbox, Ledger},
    intake::{Intake, Poll},
    threads::{Discovery, Routes},
    wake::Wake,
};
use crate::harness::{self, discord::Worker};
use crate::omp::Executable;
pub async fn run(omp: &Executable<'_>, cwd: &Path, options: Options) -> Result<()> {
    if options.cataly_state.is_some() {
        // The extension owns the head session: no Rust-owned OMP head or lanes here.
        return Box::pin(super::supervised::run(options)).await;
    }
    let state_dir = options
        .state_dir
        .context("--state-dir is required without --cataly-state")?;
    let owner = Snowflake::try_from(options.owner).map_err(anyhow::Error::msg)?;
    let channels = allowed_channels(options.channel)?;
    let head_channel = head_channel(options.head_channel, &channels)?;
    ensure!(
        options.ask_state.as_deref().is_none_or(Path::is_absolute),
        "ASK state must be absolute"
    );
    let gateway = gateway_url()?;
    let (api, token) = configured_api()?;
    let bot = bot_profile(&api, owner, options.default_avatar.as_deref()).await?;
    let mut discovery = if options.follow_threads {
        Some(Discovery::open(&api, &channels).await?)
    } else {
        None
    };
    ensure!(
        head_channel.is_none_or(|channel| discovery.as_ref().is_none_or(|d| d.readable(channel))),
        "the Discord head channel must be readable, not a forum container"
    );
    let routes = Routes::default();
    let inbox = Inbox::open(
        options.inbox.as_deref().unwrap_or(&state_dir),
        bot,
        owner,
        Ledger::Unresolved,
    )?;
    let mut worker = Worker::new(
        omp,
        harness::Options {
            cwd,
            root: &state_dir,
            max_sessions: 1,
        },
        options.gateway,
    )?;
    worker.bind_head(bot, owner, head_channel)?;
    let (interactions, received) = mpsc::channel(32);
    let wake = Wake::default();
    let (stop_send, stop) = watch::channel(false);
    let mut service = Intake {
        worker,
        transport: Transport {
            api,
            interactions: received,
        },
        bot,
        owner,
        stop,
        ask_state: options.ask_state.as_deref(),
        inbox: &inbox,
    };
    let shutdown = shutdown_signal(&stop_send);
    let link = link(
        &gateway,
        &token,
        options.gateway,
        IntakeLink {
            channels: &channels,
            owner,
            wake: &wake,
            interactions: Some(interactions),
            threads: options.follow_threads.then_some(&routes),
            inbox: &inbox,
            supervision: None,
        },
    );
    let settings = Poll {
        seconds: options.poll_seconds,
        gateway: options.gateway,
        imported: options.import_cursors.as_deref(),
        discovery: discovery.as_mut().map(|d| (d, &routes)),
    };
    let result = {
        let poll = service.run(&channels, &wake, settings);
        tokio::pin!(poll);
        tokio::select! {
            result = &mut poll => result,
            result = shutdown => match result {
                Ok(()) => poll.await,
                Err(error) => Err(error),
            },
            result = link => {
                stop_send.send_replace(true);
                poll.await.and(result)
            }
        }
    };
    service.worker.close_memory().await?;
    result
}

/// The Gateway link; REST mode only keeps the interaction channel alive, as no interactions arrive.
async fn link(url: &Url, token: &str, gateway: bool, intake: IntakeLink<'_>) -> Result<()> {
    if gateway {
        Link {
            url,
            token,
            intake: Some(intake),
        }
        .run()
        .await
    } else {
        let _intake = intake;
        std::future::pending().await
    }
}

fn head_channel(value: Option<String>, channels: &[Snowflake]) -> Result<Option<Snowflake>> {
    let Some(value) = value else { return Ok(None) };
    let channel = Snowflake::try_from(value).map_err(anyhow::Error::msg)?;
    ensure!(
        channels.binary_search(&channel).is_ok(),
        "the Discord head channel must be explicitly allowed"
    );
    Ok(Some(channel))
}

pub(super) async fn bot_profile(
    api: &DiscordApi,
    owner: Snowflake,
    avatar: Option<&Path>,
) -> Result<Snowflake> {
    let profile = api.identity().await?;
    let bot = profile.user;
    ensure!(
        bot.bot && !bot.system && bot.id != owner,
        "Discord native monitor needs a bot token distinct from its owner"
    );
    api.require_message_content().await?;
    if profile.avatar.is_none()
        && let Some(path) = avatar
        && api.set_default_avatar(path).await.is_err()
    {
        eprintln!("DISCORD_DEFAULT_AVATAR_FAILED");
    }
    Ok(bot.id)
}

pub(super) fn allowed_channels(values: Vec<String>) -> Result<Vec<Snowflake>> {
    let mut channels = values
        .into_iter()
        .map(Snowflake::try_from)
        .collect::<Result<Vec<_>, _>>()
        .map_err(anyhow::Error::msg)?;
    channels.sort_unstable();
    channels.dedup();
    ensure!(
        channels.len() <= 64,
        "Discord native monitor accepts at most 64 explicit channels"
    );
    Ok(channels)
}

async fn shutdown_signal(stop: &watch::Sender<bool>) -> Result<()> {
    termination().await?;
    stop.send_replace(true);
    Ok(())
}

pub(super) async fn termination() -> Result<()> {
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    tokio::select! { _ = interrupt.recv() => {}, _ = terminate.recv() => {} }
    Ok(())
}
