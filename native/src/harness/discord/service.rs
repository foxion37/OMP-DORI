use std::fs::{self, File, OpenOptions};
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::PathBuf;
use std::pin::pin;

use anyhow::{Result, ensure};
use sha2::{Digest, Sha256};
use tokio::sync::{mpsc, oneshot, watch};

use super::{DeliveryReply, Origin, Snowflake, memory::Memory, reply_parts};
use crate::discord::{Destination, ReplyExtras, Transport};
use crate::harness::{
    Harness, Options, SessionKey,
    store::{HeadSource, Store},
    work::RunOptions,
};
use crate::omp::Executable;
use crate::rpc::tools::Approval;

pub struct Worker<'a, 'b> {
    harness: Harness<'a, 'b>,
    readme: bool,
    memory: Option<Memory>,
    head_channel: Option<Snowflake>,
}

pub struct ApprovalCard {
    pub(crate) origin: Origin,
    pub(crate) message: Snowflake,
    pub(crate) stamp: String,
}

impl<'a, 'b> Worker<'a, 'b> {
    pub(crate) fn new(
        omp: &'a Executable<'b>,
        options: Options<'a>,
        gateway: bool,
    ) -> Result<Self> {
        let harness = Harness::new(omp, options)?;
        let memory = Memory::start(harness.store.root(), harness.cwd)?;
        Ok(Self {
            harness,
            readme: gateway,
            head_channel: None,
            memory,
        })
    }

    pub(crate) fn bind_head(
        &mut self,
        bot: Snowflake,
        owner: Snowflake,
        channel: Option<Snowflake>,
    ) -> Result<()> {
        self.harness
            .store
            .bind_discord_head(channel.map(|channel| HeadSource {
                bot,
                owner,
                channel,
            }))?;
        self.head_channel = channel;
        Ok(())
    }

    pub(crate) async fn close_memory(&mut self) -> Result<()> {
        if let Some(memory) = self.memory.take() {
            memory.close().await?;
        }
        Ok(())
    }

    fn session_bytes(&self, origin: Origin) -> Result<u64> {
        let key = if self.head_channel == Some(origin.channel) {
            SessionKey("head".to_owned())
        } else {
            origin.key()
        };
        match self.harness.store.read(&key.0)? {
            crate::harness::store::Record::Bound(binding) => {
                Ok(fs::metadata(binding.session.file)?.len())
            }
            crate::harness::store::Record::New | crate::harness::store::Record::Starting => Ok(0),
        }
    }

    fn memory_context(&self, origin: Origin) -> Option<String> {
        let memory = self.memory.as_ref()?;
        match self
            .session_bytes(origin)
            .and_then(|bytes| memory.context(origin, bytes))
        {
            Ok(context) => context,
            Err(error) => {
                eprintln!("CATALY_MEMORY_RECALL_HELD: {error:#}");
                None
            }
        }
    }

    fn checkpoint(&self, origin: Origin, text: &str) {
        if let Some(memory) = &self.memory
            && let Err(error) = self
                .session_bytes(origin)
                .and_then(|bytes| memory.record(origin, text, bytes))
        {
            eprintln!("CATALY_MEMORY_CHECKPOINT_HELD: {error:#}");
        }
    }

    pub(crate) fn cursor(&self, origin: Origin) -> Result<Option<Snowflake>> {
        let path = self.harness.store.discord_cursor_path(origin);
        let raw = match fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let cursor = Snowflake::try_from(raw).map_err(anyhow::Error::msg)?;
        Ok(Some(cursor))
    }

    pub(crate) fn advance(&self, origin: Origin) -> Result<()> {
        self.harness.store.advance_discord_cursor(origin)
    }

    pub(crate) async fn run_message(
        &mut self,
        transport: &mut Transport,
        origin: Origin,
        text: &str,
        stop: &mut watch::Receiver<bool>,
    ) -> Result<bool> {
        if text.starts_with("!remember ") {
            let receipt = self.harness.remember_discord(origin, text, || {
                self.memory
                    .as_ref()
                    .map_or(Ok("Local memory is disabled."), |memory| {
                        memory.remember(origin, text)
                    })
            })?;
            return self.deliver(transport, origin, &receipt, stop).await;
        }
        let explicit = text
            .strip_prefix("!cataly ")
            .map(str::trim)
            .filter(|text| !text.is_empty());
        let readme = self.readme && explicit.is_some();
        // Retain the same mode on replay even if the installed OMP now advertises different features.
        let discord_head = self.head_channel == Some(origin.channel);
        let mut run = origin.run(explicit.unwrap_or(text).to_owned());
        if discord_head {
            run.key = SessionKey("head".to_owned());
        }
        let readme = self
            .harness
            .discord_readme_mode(origin, &run.key)?
            .unwrap_or(readme);
        let id = origin.id();
        let (send, mut approvals) = mpsc::channel(1);
        let (cancel, cancel_signal) = oneshot::channel();
        let options = RunOptions {
            cancel: Some(cancel_signal),
            approvals: readme.then_some(send),
            memory_context: self.memory_context(origin),
            fenced_replies: true,
            discord_head,
        };
        let mut card = None;
        let mut typing = Some(transport.start_typing(origin.channel));

        let result = {
            let run = self.harness.execute(run, options);
            let mut run = pin!(run);
            let mut cancel = Some(cancel);
            loop {
                tokio::select! {
                    biased;
                    result = &mut run => break result,
                    () = crate::discord::stopped(stop), if cancel.is_some() => {
                        if let Some(cancel) = cancel.take() && cancel.send(()).is_err() {
                            eprintln!("DISCORD_TURN_ALREADY_SETTLED id={}", id.as_str());
                        }
                    }
                    Some(approval) = approvals.recv(), if cancel.is_some() => {
                        if let Ok(pending) = issue_card(transport, origin, approval).await {
                            drop(typing.take());
                            card = Some(pending);
                        } else {
                            eprintln!("DISCORD_APPROVAL_CARD_FAILED id={}", id.as_str());
                            if let Some(cancel) = cancel.take() && cancel.send(()).is_err() {
                                eprintln!("DISCORD_TURN_ALREADY_SETTLED id={}", id.as_str());
                            }
                        }

                    }
                    Some(event) = transport.interaction() => {
                        let decision = card.as_ref().and_then(|(card, _)| event.decision(card));
                        if transport.callback(&event, decision.is_some()).await.is_ok() {
                            if let Some(decision) = decision
                                && let Some((_, approval)) = card.take()
                            {
                                if approval.decision.send(decision).is_err() {
                                    eprintln!("DISCORD_APPROVAL_ALREADY_SETTLED id={}", id.as_str());
                                } else {
                                    typing = Some(transport.start_typing(origin.channel));
                                }
                            }
                        } else {
                            eprintln!("DISCORD_INTERACTION_CALLBACK_FAILED id={}", id.as_str());
                        }
                    }

                }
            }
        };
        drop(typing);
        if let Some((card, _)) = card
            && transport
                .clear(Destination {
                    channel: card.origin.channel,
                    message: card.message,
                })
                .await
                .is_err()
        {
            eprintln!("DISCORD_APPROVAL_CLEAR_FAILED id={}", id.as_str());
        }
        if *stop.borrow() {
            return Ok(false);
        }
        // No delivery without a Rust receipt bound to this message and lane.
        let receipt = result?;
        if receipt.completed() {
            self.checkpoint(origin, text);
        }
        self.deliver(transport, origin, &receipt, stop).await
    }

    async fn deliver(
        &self,
        transport: &Transport,
        origin: Origin,
        receipt: &crate::harness::work::RunReceipt,
        stop: &watch::Receiver<bool>,
    ) -> Result<bool> {
        let destination = Destination {
            channel: origin.channel,
            message: origin.message,
        };
        let id = origin.id();
        let parts = reply_parts(receipt);
        let mut next = 0;
        loop {
            if *stop.borrow() {
                return Ok(false);
            }
            match self
                .harness
                .store
                .next_discord_part(origin, &id, &parts, next)?
            {
                DeliveryReply::Done => return Ok(true),
                DeliveryReply::Held { part } => {
                    eprintln!("DISCORD_REPLY_HELD id={} part={part}", origin.id().as_str());
                    return Ok(true);
                }
                DeliveryReply::Part { part, text, nonce } => {
                    let Ok(remote) = transport
                        .reply(destination, &text, ReplyExtras::Part { nonce: &nonce })
                        .await
                    else {
                        eprintln!("DISCORD_REPLY_HELD id={} part={part}", origin.id().as_str());
                        return Ok(true);
                    };
                    self.harness
                        .store
                        .ack_discord_part(origin, &id, part, remote)?;
                    next = part + 1;
                }
                DeliveryReply::Acknowledged { .. } => {
                    anyhow::bail!("unexpected Discord delivery state")
                }
            }
        }
    }
}

async fn issue_card(
    transport: &Transport,
    origin: Origin,
    approval: Approval,
) -> Result<(ApprovalCard, Approval)> {
    let digest = format!(
        "{:x}",
        Sha256::digest(format!("{}:{}:{}", origin.bot, origin.message, approval.id))
    );
    let stamp = digest[..32].to_owned();
    let message = transport.reply(Destination { channel: origin.channel, message: origin.message },
        "Cataly requests permission to read this workspace's README.md. Approval sends it to the configured OMP model; the final answer is visible in this channel.",
        ReplyExtras::Approval { stamp: &stamp }).await?;
    Ok((
        ApprovalCard {
            origin,
            message,
            stamp,
        },
        approval,
    ))
}

impl Store {
    fn discord_cursor_path(&self, origin: Origin) -> PathBuf {
        self.root().join(format!("{}.cursor", origin.key().0))
    }

    fn advance_discord_cursor(&self, origin: Origin) -> Result<()> {
        let path = self.discord_cursor_path(origin);
        let temporary = path.with_extension("cursor.tmp");
        match fs::remove_file(&temporary) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)?;
        write!(file, "{}", origin.message)?;
        file.sync_all()?;
        ensure!(
            temporary.parent() == path.parent(),
            "Discord cursor paths diverged"
        );
        fs::rename(temporary, path)?;
        File::open(self.root())?.sync_all()?;
        Ok(())
    }
}
