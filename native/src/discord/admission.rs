//! The child half of the head admission protocol (messenger/head-admission.ts): reconcile retained attempts
//! over IPC before any intake, then prepare → attempt → dispatch → receipt for each head-bound owner message.

use std::path::Path;

use anyhow::{Result, ensure};
use serde_json::{Map, Value, json};

use super::inbound::Inbound;
use super::inbox::Inbox;
use super::inbox::admissions::{Attempt, HeadUnresolved, Outcome};
use super::ipc::Ipc;

pub(super) const PROTOCOL: &str = "cataly-head-admission-v1";

/// `CATALY_MONITOR_ADMISSION` (head-admission.ts).
pub(super) fn mode() -> Option<String> {
    std::env::var("CATALY_MONITOR_ADMISSION").ok()
}

enum Reply {
    Ready {
        head_file: String,
        head_pid: i64,
    },
    Settled {
        outcome: Outcome,
        head_file: String,
        head_pid: i64,
        receipt: String,
    },
    Unresolved,
}

/// The head side of one admission: IPC to the extension, or stdout when unsupervised.
pub(super) struct Head<'a> {
    pub(super) ipc: Option<&'a Ipc>,
    pub(super) protocol: &'static str,
}

/// What the cursor and ledger already say about a head-bound message.
pub(super) enum Plan {
    /// Delivered or settled before: emit nothing.
    Skip,
    Admit {
        identity: String,
        fingerprint: String,
        /// The head file of an earlier unresolved attempt for this identity.
        previous: Option<String>,
    },
}

fn unresolved() -> anyhow::Error {
    HeadUnresolved.into()
}

impl Head<'_> {
    /// One IPC exchange with every reply validation rule of head-admission.ts:50-68. A disconnect, a
    /// protocol mismatch or a malformed reply is an unresolved admission.
    async fn exchange(&self, input: Map<String, Value>) -> Result<Reply> {
        let ipc = self.ipc.ok_or_else(unresolved)?;
        let mut message = input;
        message.insert("protocol".to_owned(), json!(self.protocol));
        let Ok(raw) = ipc.exchange(message).await else {
            return Err(unresolved());
        };
        if raw.get("protocol").and_then(Value::as_str) != Some(self.protocol) {
            return Err(unresolved());
        }
        let Some(outcome) = raw.get("outcome") else {
            return Err(unresolved());
        };
        let outcome = outcome.as_str();
        if outcome == Some("unresolved") {
            return Ok(Reply::Unresolved);
        }
        let head_file = match raw.get("headFile") {
            Some(Value::String(file)) if file.starts_with('/') => file.clone(),
            _ => return Err(unresolved()),
        };
        let head_pid = match raw.get("headPid").and_then(Value::as_i64) {
            Some(pid) if (1..=(1_i64 << 53) - 1).contains(&pid) => pid,
            _ => return Err(unresolved()),
        };
        if outcome == Some("ready") {
            return Ok(Reply::Ready {
                head_file,
                head_pid,
            });
        }
        let outcome = match outcome {
            Some("accepted") => Outcome::Accepted,
            Some("rejected") => Outcome::Rejected,
            _ => return Err(unresolved()),
        };
        match raw.get("receipt") {
            Some(Value::String(receipt)) if !receipt.is_empty() => Ok(Reply::Settled {
                outcome,
                head_file,
                head_pid,
                receipt: receipt.clone(),
            }),
            _ => Err(unresolved()),
        }
    }

    /// `reconcileHead` (head-admission.ts:81-101): settle the retained attempt from its original receipt, never
    /// dispatching, then publish every settled receipt's cursor.
    pub(super) async fn reconcile(&self, inbox: &Inbox, cursors: &Path) -> Result<()> {
        while let Some(pending) = inbox.unresolved()? {
            if self.ipc.is_none() || mode().as_deref() != Some("1") {
                return Err(unresolved());
            }
            let mut input = Map::new();
            input.insert("op".to_owned(), json!("reconcile"));
            input.insert("identity".to_owned(), json!(pending.identity));
            input.insert("fingerprint".to_owned(), json!(pending.fingerprint));
            input.insert("headFile".to_owned(), json!(pending.head_file));
            match self.exchange(input).await? {
                Reply::Settled {
                    outcome,
                    head_file,
                    receipt,
                    ..
                } if head_file == pending.head_file => {
                    inbox.receipt(&pending.identity, outcome, &receipt)?;
                }
                _ => return Err(unresolved()),
            }
        }
        inbox.commit_receipts(cursors)
    }

    /// `headEmitter` steps 2-3 (head-admission.ts:116-126), after `reconcile`. `cursor` is the channel's
    /// seeded cursor loaded after reconciliation.
    pub(super) fn plan(
        inbox: &Inbox,
        inbound: &Inbound,
        cursor: Option<super::Snowflake>,
        identity: String,
    ) -> Result<Plan> {
        if cursor.is_some_and(|cursor| inbound.message <= cursor)
            && !inbox.has(inbound.channel, inbound.message)?
        {
            return Ok(Plan::Skip);
        }
        let fingerprint = inbound.fingerprint();
        let previous = inbox.admission(&identity, &fingerprint)?;
        if previous.as_ref().is_some_and(|row| !row.unresolved()) {
            return Ok(Plan::Skip);
        }
        Ok(Plan::Admit {
            identity,
            fingerprint,
            previous: previous.map(|row| row.head_file),
        })
    }

    /// `headEmitter` steps 5-10 (head-admission.ts:129-154).
    pub(super) async fn admit(
        &self,
        inbox: &Inbox,
        inbound: &Inbound,
        plan: Plan,
        content: String,
    ) -> Result<()> {
        let Plan::Admit {
            identity,
            fingerprint,
            previous,
        } = plan
        else {
            return Ok(());
        };
        if self.ipc.is_none() {
            // Console output cannot settle any earlier native attempt.
            println!("{content}");
            return Ok(());
        }
        let mut input = Map::new();
        input.insert("identity".to_owned(), json!(identity));
        input.insert("fingerprint".to_owned(), json!(fingerprint));
        input.insert("content".to_owned(), json!(content));
        let mut prepare = input.clone();
        prepare.insert("op".to_owned(), json!("prepare"));
        let mut head_file = previous.clone();
        if let Some(file) = &head_file {
            prepare.insert("headFile".to_owned(), json!(file));
        }
        let source = inbound.source_json();
        let reply = match self.exchange(prepare).await? {
            Reply::Unresolved => return Err(unresolved()),
            Reply::Ready {
                head_file: file,
                head_pid,
            } => {
                // Absence of a receipt never authorizes another dispatch.
                if previous.is_some() || head_file.as_ref().is_some_and(|known| *known != file) {
                    return Err(unresolved());
                }
                inbox.attempt(&Attempt {
                    identity: &identity,
                    fingerprint: &fingerprint,
                    head_file: &file,
                    head_pid,
                    source: &source,
                })?;
                let mut dispatch = input;
                dispatch.insert("op".to_owned(), json!("dispatch"));
                dispatch.insert("headFile".to_owned(), json!(file));
                head_file = Some(file);
                self.exchange(dispatch).await?
            }
            Reply::Settled {
                outcome,
                head_file: file,
                head_pid,
                receipt,
            } => {
                if head_file.as_ref().is_some_and(|known| *known != file) {
                    return Err(unresolved());
                }
                if previous.is_none() {
                    // The receipt was found on disk although the ledger row was lost.
                    inbox.attempt(&Attempt {
                        identity: &identity,
                        fingerprint: &fingerprint,
                        head_file: &file,
                        head_pid,
                        source: &source,
                    })?;
                    head_file = Some(file.clone());
                }
                Reply::Settled {
                    outcome,
                    head_file: file,
                    head_pid,
                    receipt,
                }
            }
        };
        match reply {
            Reply::Settled {
                outcome,
                head_file: file,
                receipt,
                ..
            } if head_file.as_deref() == Some(file.as_str()) => {
                inbox.receipt(&identity, outcome, &receipt)
            }
            _ => Err(unresolved()),
        }
    }
}

/// Startup validation of the admission environment (cli-discord.ts:85-87, head-admission.ts:110-113).
pub(super) fn check_mode(supervised: bool) -> Result<()> {
    match mode().as_deref() {
        None => ensure!(
            !supervised,
            "--supervised requires CATALY_MONITOR_ADMISSION=1"
        ),
        Some("1") => ensure!(supervised, "{}", super::inbox::admissions::UNRESOLVED),
        Some(_) => return Err(unresolved()),
    }
    Ok(())
}
