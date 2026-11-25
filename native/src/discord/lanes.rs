//! Discord lane routing, the lane inbox, the reply outbox and `--wake-lanes` for the supervised monitor.
//!
//! Parity sources: `messenger/discord-lane-routing.ts`, `messenger/discord-lane-inbox.ts`, `discord-lane-monitor.ts`,
//! `discord-lane-wake*.ts`, `delivery-lock.ts`, `checkpoint-lock.ts`, `registry.ts`, `lane-state.ts`, `lane-run.ts`
//! and `discord-lane-headless-state.ts`. Every file and lock is shared with the TypeScript CLI and the lane extension.

use std::collections::{BTreeSet, HashSet};
use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Result, bail};
use sha2::{Digest as _, Sha256};

use super::api::{DiscordApi, PartPost, RestStatus};
use super::inbound::Inbound;
use crate::harness::discord::Snowflake;

mod command;
mod guard;
mod headless;
mod inbox;
pub(in crate::discord) mod lock;
mod registry;
mod route;
mod transcript;
mod wake;

use inbox::{LaneInbox, ReplyIdentity, ReplyPart};
use lock::{Lock, take_lock};

/// A routed message that must not advance its Discord cursor; the caller logs it and retries on a later tick.
#[derive(Debug)]
pub(super) struct LaneHold(pub(super) String);

impl fmt::Display for LaneHold {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for LaneHold {}

pub(super) struct Lanes {
    state: PathBuf,
    bot: String,
    owner: String,
    wake: Option<WakeMonitor>,
    inbox: Option<LaneInbox>,
}

/// `--wake-lanes` state: the single-monitor lock, the resolved launch context and the once-per-state warnings.
struct WakeMonitor {
    _lock: Lock,
    launch: wake::Launch,
    unresolved: HashSet<String>,
    warned: HashSet<String>,
}

/// The idempotency nonce of one reply part: a reply may already exist remotely although its local receipt is
/// still pending.
fn reply_nonce(bot: &str, channel: &str, part: &ReplyPart) -> String {
    let digest = Sha256::digest(format!(
        "cataly-lane:{bot}:{channel}:{}:{}",
        part.id, part.part
    ));
    crate::util::hex(&digest[..12])
}

impl Lanes {
    /// Opens lane routing for one bot/owner pair. With `wake`, takes `<state>/discord-lane-monitor.lock` (one wake
    /// monitor per state directory), resolves the launch context from the Cataly CLI and opens the lane inbox.
    pub(super) fn open(
        cataly_state: &Path,
        bot: Snowflake,
        owner: Snowflake,
        wake: bool,
    ) -> Result<Self> {
        crate::util::absolute(cataly_state, "--cataly-state")?;
        let wake = if wake {
            let launch = wake::Launch::from_env()?;
            let Ok(lock) = take_lock(&cataly_state.join("discord-lane-monitor.lock"), true)? else {
                bail!("Another Discord lane wake monitor is running for this state directory");
            };
            Some(WakeMonitor {
                _lock: lock,
                launch,
                unresolved: HashSet::new(),
                warned: HashSet::new(),
            })
        } else {
            None
        };
        let inbox = wake
            .is_some()
            .then(|| LaneInbox::open(cataly_state))
            .transpose()?;
        Ok(Self {
            state: cataly_state.to_owned(),
            bot: bot.to_string(),
            owner: owner.to_string(),
            wake,
            inbox,
        })
    }

    /// `enqueueDiscordLane` for one owner message: `Ok(true)` once the lane inbox holds it for the owning session,
    /// `Ok(false)` when no lane owns its channel, a `LaneHold` error when the cursor must not advance.
    pub(super) async fn route(&mut self, inbound: &Inbound) -> Result<bool> {
        let channel = inbound.channel.to_string();
        let message = inbound.message.to_string();
        let text = inbound.format();
        let wake = self.wake.is_some();
        let identity = ReplyIdentity {
            bot: &self.bot,
            owner: &self.owner,
        };
        let state = &self.state;
        let slot = &mut self.inbox;
        route::enqueue(state, &channel, wake, route::DELIVERY_WAIT, |session| {
            if slot.is_none() {
                *slot = Some(LaneInbox::open(state)?);
            }
            let Some(inbox) = slot.as_ref() else {
                bail!("Discord lane inbox is unavailable");
            };
            if wake {
                inbox.add_with_reply(session, &channel, &message, &text, identity)
            } else {
                inbox.add(session, &channel, &message, &text)
            }
        })
        .await
    }

    /// `discordLaneMonitor`: wakes lanes with pending opted-in input and posts one reply part per pending session.
    /// A no-op without `--wake-lanes`.
    pub(super) async fn service(&mut self, api: &DiscordApi, watched: &[Snowflake]) -> Result<()> {
        let (Some(monitor), Some(inbox)) = (self.wake.as_mut(), self.inbox.as_ref()) else {
            return Ok(());
        };
        let identity = ReplyIdentity {
            bot: &self.bot,
            owner: &self.owner,
        };
        let scope: BTreeSet<String> = watched.iter().map(ToString::to_string).collect();
        for pending in inbox.pending_sessions(Some(identity))? {
            if !scope.contains(&pending.channel) {
                continue;
            }
            let thread = format!("discord:{}", pending.channel);
            let lane = route::unique(&self.state, &thread)?;
            let Some(lane) = lane
                .filter(|lane| lane.session() == Some(pending.session.as_str()) && !lane.closing())
            else {
                continue;
            };
            let key = lane.key().to_owned();
            if pending.has_input {
                match wake::wake(&self.state, &monitor.launch, &lane).await {
                    Ok(wake::Wake::Unconfirmed) => {
                        if monitor.unresolved.insert(key.clone()) {
                            eprintln!("DISCORD_LANE_WAKE_UNCONFIRMED key={key}");
                        }
                    }
                    Ok(wake::Wake::Started) => {
                        monitor.unresolved.remove(&key);
                    }
                    Ok(wake::Wake::Held) => {}
                    Err(_) => {
                        if monitor.unresolved.insert(key.clone()) {
                            eprintln!("DISCORD_LANE_WAKE_HELD key={key}");
                        }
                    }
                }
            }
            match post_reply(&self.state, api, inbox, identity, &pending, &key).await {
                Ok(true) => {
                    monitor.warned.remove(&key);
                }
                Ok(false) => {}
                Err(error) => {
                    if monitor.warned.insert(key.clone()) {
                        let detail = error
                            .downcast_ref::<RestStatus>()
                            .map_or_else(String::new, |status| {
                                format!(" status={}", status.status)
                            });
                        eprintln!("DISCORD_LANE_WORK_HELD key={key}{detail}");
                    }
                }
            }
        }
        Ok(())
    }
}

/// One reply part under the lane's delivery lock (no wait). `Ok(false)`: the lock was busy.
async fn post_reply(
    state: &Path,
    api: &DiscordApi,
    inbox: &LaneInbox,
    identity: ReplyIdentity<'_>,
    pending: &inbox::PendingSession,
    key: &str,
) -> Result<bool> {
    let Some(lock) = route::delivery_lock(state, key, Duration::ZERO).await? else {
        return Ok(false);
    };
    let result = post_locked(state, api, inbox, identity, pending, key).await;
    let released = lock.release();
    result?;
    released?;
    Ok(true)
}

/// Re-reads the owner under the lock, then posts the next part and settles its outbox row.
async fn post_locked(
    state: &Path,
    api: &DiscordApi,
    inbox: &LaneInbox,
    identity: ReplyIdentity<'_>,
    pending: &inbox::PendingSession,
    key: &str,
) -> Result<()> {
    let thread = format!("discord:{}", pending.channel);
    let current = route::unique(state, &thread)?;
    if !current.is_some_and(|current| {
        current.key() == key
            && current.session() == Some(pending.session.as_str())
            && !current.closing()
    }) {
        return Ok(());
    }
    let Some(part) = inbox.next_reply(&pending.session, &pending.channel, Some(identity))? else {
        return Ok(());
    };
    let nonce = reply_nonce(identity.bot, &pending.channel, &part);
    let channel = Snowflake::try_from(pending.channel.clone()).map_err(anyhow::Error::msg)?;
    let reference = Snowflake::try_from(part.id.clone()).map_err(anyhow::Error::msg)?;
    match api
        .post_part(channel, reference, &part.text, &nonce)
        .await?
    {
        PartPost::Sent(_) => inbox.acknowledge_reply(&pending.session, &pending.channel, &part),
        PartPost::SourceMissing => {
            inbox.discard_reply(&pending.session, &pending.channel, &part.id)?;
            eprintln!("DISCORD_LANE_REPLY_SOURCE_DELETED key={key}");
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nonce_matches_the_typescript_derivation() {
        // createHash("sha256").update("cataly-lane:11:22:33:0").digest("hex").slice(0, 24)
        let part = ReplyPart {
            id: "33".into(),
            part: 0,
            text: String::new(),
        };
        assert_eq!(reply_nonce("11", "22", &part), "ca542282507c3958fdb9d2db");
    }
}
