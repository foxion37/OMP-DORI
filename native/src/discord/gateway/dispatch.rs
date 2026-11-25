use anyhow::{Context, Result, ensure};
use reqwest::Url;
use serde::Deserialize;

use super::{Frame, IntakeLink, Link, Resume};
use crate::discord::{
    Interaction, Snowflake, User, intake::cursor_file, threads::ThreadMetadata, wake::Wake,
};

#[derive(Deserialize)]
struct Ready {
    session_id: String,
    resume_gateway_url: String,
}

#[derive(Deserialize)]
struct ThreadEvent {
    id: Snowflake,
    parent_id: Option<Snowflake>,
    thread_metadata: Option<ThreadMetadata>,
}

impl Link<'_> {
    pub(super) fn dispatch(
        &self,
        frame: Frame,
        resume: &mut Option<Resume>,
        ready: &mut bool,
    ) -> Result<Option<&'static str>> {
        match frame.t.as_deref() {
            Some("READY") => {
                let event: Ready = serde_json::from_value(frame.d)?;
                let url = if self.url.scheme() == "ws" {
                    self.url.clone()
                } else {
                    let mut url = Url::parse(&event.resume_gateway_url)
                        .context("invalid Discord resume URL")?;
                    ensure!(
                        url.scheme() == "wss"
                            && url
                                .host_str()
                                .is_some_and(|host| host.ends_with(".discord.gg")
                                    || host == "gateway.discord.gg")
                            && url.username().is_empty()
                            && url.password().is_none(),
                        "invalid Discord resume host"
                    );
                    url.set_query(Some("v=10&encoding=json"));
                    url
                };
                let sequence = frame.s.context("missing Discord sequence")?;
                *resume = Some(Resume {
                    url,
                    id: event.session_id,
                    sequence,
                });
                *ready = true;
                self.established()?;
                return Ok(Some("READY"));
            }
            Some("RESUMED") if resume.is_some() => {
                *ready = true;
                self.established()?;
                return Ok(Some("RESUMED"));
            }
            Some("MESSAGE_CREATE") if *ready || resume.is_some() => {
                if let Some(intake) = &self.intake {
                    intake.message_created(&frame.d)?;
                }
            }
            Some("INTERACTION_CREATE") if *ready || resume.is_some() => {
                if let Some(intake) = &self.intake
                    && let Ok(event) = serde_json::from_value::<Interaction>(frame.d)
                    && event.valid()
                    && let Some(interactions) = &intake.interactions
                    && (intake.channels.contains(&event.channel_id)
                        || intake
                            .threads
                            .is_some_and(|routes| routes.contains(event.channel_id)))
                {
                    // Never block heartbeats on user work or a slow callback.
                    if interactions.try_send(event).is_err() {
                        eprintln!("DISCORD_INTERACTION_QUEUE_FULL");
                    }
                }
            }
            Some(kind @ ("THREAD_CREATE" | "THREAD_UPDATE" | "THREAD_DELETE"))
                if *ready || resume.is_some() =>
            {
                if let Some(intake) = &self.intake
                    && let Ok(event) = serde_json::from_value::<ThreadEvent>(frame.d)
                {
                    intake.thread_changed(kind, event);
                }
            }
            _ => {}
        }
        Ok(None)
    }

    /// READY/RESUMED: replay every channel through REST before the queue is considered synced.
    fn established(&self) -> Result<()> {
        if let Some(intake) = &self.intake {
            if let Some(routes) = intake.threads {
                routes.refresh_soon();
            }
            if let Some(supervision) = &intake.supervision {
                intake
                    .inbox
                    .push_sync()
                    .context("persisting the Discord Gateway backfill marker")?;
                supervision.health.ready();
            }
            intake.wake.send(Wake::ALL);
        }
        Ok(())
    }
}

#[derive(Deserialize)]
struct Notice {
    id: Snowflake,
    channel_id: Snowflake,
    author: User,
    webhook_id: Option<Snowflake>,
    #[serde(rename = "type")]
    kind: u8,
}

impl IntakeLink<'_> {
    fn message_created(&self, raw: &serde_json::Value) -> Result<()> {
        if let Some(supervision) = &self.supervision {
            return self.admit(supervision, raw);
        }
        let Ok(event) = Notice::deserialize(raw) else {
            return Ok(());
        };
        if event.author.id != self.owner
            || event.author.bot
            || event.author.system
            || event.webhook_id.is_some()
            || !matches!(event.kind, 0 | 19)
        {
            return Ok(());
        }
        let exact = self.channels.binary_search(&event.channel_id).ok();
        if exact.is_none()
            && !self
                .threads
                .is_some_and(|routes| routes.contains(event.channel_id))
        {
            return Ok(());
        }
        self.inbox
            .push(event.channel_id, event.id, raw)
            .context("persisting Discord Gateway event")?;
        if let Some(index) = exact {
            self.wake.send(1 << index);
        } else if self
            .threads
            .is_some_and(|routes| routes.wake(event.channel_id))
        {
            self.wake.send(0);
        }
        Ok(())
    }
}
impl IntakeLink<'_> {
    /// `onDispatch` (discord-inbound-live.ts:167-176): every valid message in an accepted conversation is
    /// persisted with its admission cursor and thread scope; delivery filters owners and checkpoints the rest.
    fn admit(&self, supervision: &super::Supervision<'_>, raw: &serde_json::Value) -> Result<()> {
        let id = |key: &str| {
            raw.get(key)
                .and_then(serde_json::Value::as_str)
                .and_then(|id| Snowflake::try_from(id.to_owned()).ok())
        };
        let (Some(message), Some(channel)) = (id("id"), id("channel_id")) else {
            return Ok(());
        };
        let parent = self.threads.and_then(|routes| routes.parent(channel));
        if !supervision.all && self.channels.binary_search(&channel).is_err() && parent.is_none() {
            return Ok(());
        }
        let admitted = cursor_file::read(Some(supervision.cursors), channel)?;
        self.inbox
            .push_scoped(channel, message, raw, admitted, parent)
            .context("persisting Discord Gateway event")?;
        self.wake.send(1);
        Ok(())
    }

    fn thread_changed(&self, kind: &str, event: ThreadEvent) {
        let Some(routes) = self.threads else { return };
        let known = routes.contains(event.id);
        if !known
            && !event
                .parent_id
                .is_some_and(|parent| self.channels.contains(&parent))
        {
            return;
        }
        if kind == "THREAD_DELETE" || event.thread_metadata.is_some_and(|meta| meta.archived) {
            routes.invalidate(event.id);
        } else if !known {
            routes.refresh_soon();
        } else {
            return;
        }
        self.wake.send(0);
    }
}
