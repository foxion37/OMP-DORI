//! The `admissions` ledger shared with the TypeScript head-admission state (head-admission-state.ts): the
//! same table, indexes and retirement trigger, at most one unresolved row, and the same conflict rules.

use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Deserialize;

use super::{Inbox, Snowflake};
use crate::discord::intake::cursor_file;

pub(in crate::discord) const UNRESOLVED: &str = "HEAD_ADMISSION_UNRESOLVED: Discord head admission is unresolved; the cursor, source and FIFO are retained. Inspect the original native receipt; never replay an attempted input. Stop the original head before explicit abandonment.";

const COLUMNS: &str = "identity, fingerprint, head_file, head_pid, source, outcome, receipt";
const NATIVE: &str = "outcome IN ('accepted','rejected')";
const COMMITTED: &str = "json_extract(source, '$.channel') = ?1 AND (length(json_extract(source, '$.message')) < length(?2) OR (length(json_extract(source, '$.message')) = length(?2) AND json_extract(source, '$.message') <= ?2))";
const UNQUEUED: &str = "NOT EXISTS (SELECT 1 FROM pending WHERE kind = 'message' AND json_extract(payload, '$.channel_id') = json_extract(admissions.source, '$.channel') AND length(json_extract(payload, '$.id')) = length(json_extract(admissions.source, '$.message')) AND json_extract(payload, '$.id') = json_extract(admissions.source, '$.message'))";

/// The head admission is unresolved: cursor, source and FIFO stay retained and nothing is replayed.
#[derive(Debug)]
pub(in crate::discord) struct HeadUnresolved;

impl std::fmt::Display for HeadUnresolved {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(UNRESOLVED)
    }
}

impl std::error::Error for HeadUnresolved {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::discord) enum Outcome {
    Accepted,
    Rejected,
}

impl Outcome {
    pub(in crate::discord) const fn as_str(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Rejected => "rejected",
        }
    }
}

/// One ledger row, as `HeadAdmission` exposes it.
pub(in crate::discord) struct Admission {
    pub(in crate::discord) identity: String,
    pub(in crate::discord) fingerprint: String,
    pub(in crate::discord) head_file: String,
    pub(in crate::discord) source: String,
    pub(in crate::discord) outcome: String,
    pub(in crate::discord) receipt: Option<String>,
}

impl Admission {
    fn read(row: &Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            identity: row.get(0)?,
            fingerprint: row.get(1)?,
            head_file: row.get(2)?,
            source: row.get(4)?,
            outcome: row.get(5)?,
            receipt: row.get(6)?,
        })
    }

    pub(in crate::discord) fn unresolved(&self) -> bool {
        self.outcome == "unresolved"
    }
}

/// The original head attempt for one owner message.
pub(in crate::discord) struct Attempt<'a> {
    pub(in crate::discord) identity: &'a str,
    pub(in crate::discord) fingerprint: &'a str,
    pub(in crate::discord) head_file: &'a str,
    pub(in crate::discord) head_pid: i64,
    pub(in crate::discord) source: &'a str,
}

/// Idempotent DDL, run inside the queue's exclusive initialization transaction.
pub(super) fn create(db: &Connection) -> Result<()> {
    db.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS admissions (identity TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, head_file TEXT NOT NULL, head_pid INTEGER NOT NULL CHECK(head_pid > 0), source TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected','unresolved','abandoned')), receipt TEXT, reason TEXT, attempted_at TEXT NOT NULL, decided_at TEXT, checkpointed INTEGER NOT NULL DEFAULT 0 CHECK(checkpointed IN (0,1)));
        CREATE UNIQUE INDEX IF NOT EXISTS unresolved_admission ON admissions ((1)) WHERE outcome = 'unresolved';
        CREATE INDEX IF NOT EXISTS uncommitted_admission ON admissions (checkpointed) WHERE checkpointed = 0;
        CREATE INDEX IF NOT EXISTS checkpointed_admission ON admissions (json_extract(source, '$.channel'), json_extract(source, '$.message')) WHERE checkpointed = 1 AND {NATIVE};
        CREATE TRIGGER IF NOT EXISTS retire_head_receipt AFTER DELETE ON pending WHEN OLD.kind = 'message' BEGIN DELETE FROM admissions WHERE checkpointed = 1 AND {NATIVE} AND json_extract(source, '$.channel') = json_extract(OLD.payload, '$.channel_id') AND json_extract(source, '$.message') = json_extract(OLD.payload, '$.id') AND {UNQUEUED}; END"
    ))?;
    Ok(())
}

fn find(db: &Connection, identity: &str) -> Result<Option<Admission>> {
    Ok(db
        .query_row(
            &format!("SELECT {COLUMNS} FROM admissions WHERE identity = ?1"),
            [identity],
            Admission::read,
        )
        .optional()?)
}

fn unresolved_row(db: &Connection) -> Result<Option<Admission>> {
    Ok(db
        .query_row(
            &format!("SELECT {COLUMNS} FROM admissions WHERE outcome = 'unresolved'"),
            [],
            Admission::read,
        )
        .optional()?)
}

pub(super) fn assert_clear(db: &Connection) -> Result<()> {
    if unresolved_row(db)?.is_some() {
        return Err(HeadUnresolved.into());
    }
    Ok(())
}

fn prune(db: &Connection, channel: Snowflake, cursor: Snowflake) -> Result<()> {
    let (channel, cursor) = (channel.to_string(), cursor.to_string());
    db.execute(
        &format!("UPDATE admissions SET checkpointed = 1 WHERE checkpointed = 0 AND outcome <> 'unresolved' AND {COMMITTED}"),
        params![channel, cursor],
    )?;
    db.execute(
        &format!("DELETE FROM admissions WHERE checkpointed = 1 AND {NATIVE} AND {COMMITTED} AND {UNQUEUED}"),
        params![channel, cursor],
    )?;
    Ok(())
}

#[derive(Deserialize)]
struct Source {
    channel: Snowflake,
    message: Snowflake,
}

impl Inbox {
    fn ledger(&self) -> Result<()> {
        ensure!(
            self.has_admissions,
            "Discord head admission ledger is unavailable"
        );
        Ok(())
    }

    /// The single unresolved attempt, if any.
    pub(in crate::discord) fn unresolved(&self) -> Result<Option<Admission>> {
        if !self.has_admissions {
            return Ok(None);
        }
        unresolved_row(&*self.lock()?)
    }

    /// The previous attempt for `identity`; another fingerprint for the same identity is a conflict.
    pub(in crate::discord) fn admission(
        &self,
        identity: &str,
        fingerprint: &str,
    ) -> Result<Option<Admission>> {
        if !self.has_admissions {
            return Ok(None);
        }
        let previous = find(&*self.lock()?, identity)?;
        if previous
            .as_ref()
            .is_some_and(|row| row.fingerprint != fingerprint)
        {
            bail!("Discord head admission identity conflict; original record retained");
        }
        Ok(previous)
    }

    /// Records the original attempt before its dispatch; refused while another attempt is unresolved.
    pub(in crate::discord) fn attempt(&self, attempt: &Attempt<'_>) -> Result<()> {
        self.ledger()?;
        let db = self.lock()?;
        if find(&db, attempt.identity)?.is_some() {
            bail!(
                "Discord head admission already attempted; reconcile the original receipt before replay"
            );
        }
        assert_clear(&db)?;
        db.execute(
            "INSERT INTO admissions (identity, fingerprint, head_file, head_pid, source, outcome, attempted_at) VALUES (?1, ?2, ?3, ?4, ?5, 'unresolved', strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
            params![attempt.identity, attempt.fingerprint, attempt.head_file, attempt.head_pid, attempt.source],
        )?;
        drop(db);
        Ok(())
    }

    /// Settles the original attempt; a different settled receipt is a conflict.
    pub(in crate::discord) fn receipt(
        &self,
        identity: &str,
        outcome: Outcome,
        receipt: &str,
    ) -> Result<()> {
        self.ledger()?;
        let db = self.lock()?;
        let previous =
            find(&db, identity)?.context("Discord head receipt has no original attempt")?;
        if !previous.unresolved() {
            ensure!(
                previous.outcome == outcome.as_str()
                    && previous.receipt.as_deref() == Some(receipt),
                "Discord head receipt conflict; original receipt retained"
            );
            return Ok(());
        }
        db.execute(
            "UPDATE admissions SET outcome = ?1, receipt = ?2, reason = NULL, decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE identity = ?3",
            params![outcome.as_str(), receipt, identity],
        )?;
        drop(db);
        Ok(())
    }

    /// `store.save`: refuse while unresolved, publish the TS cursor file, then checkpoint and prune receipts.
    pub(in crate::discord) fn save_cursor(
        &self,
        dir: &Path,
        channel: Snowflake,
        cursor: Snowflake,
    ) -> Result<()> {
        if !self.has_admissions {
            return cursor_file::write(Some(dir), channel, cursor);
        }
        assert_clear(&*self.lock()?)?;
        cursor_file::write(Some(dir), channel, cursor)?;
        prune(&*self.lock()?, channel, cursor)
    }

    /// Publishes each settled-but-uncheckpointed receipt's cursor in ledger order (`commitReceipts`).
    pub(in crate::discord) fn commit_receipts(&self, dir: &Path) -> Result<()> {
        if !self.has_admissions {
            return Ok(());
        }
        assert_clear(&*self.lock()?)?;
        loop {
            let record = self
                .lock()?
                .query_row(
                    &format!("SELECT {COLUMNS} FROM admissions WHERE checkpointed = 0 AND outcome <> 'unresolved' ORDER BY rowid LIMIT 1"),
                    [],
                    Admission::read,
                )
                .optional()?;
            let Some(record) = record else { return Ok(()) };
            let source: Source = serde_json::from_str(&record.source)
                .context("invalid Discord head admission source")?;
            let current = cursor_file::read(Some(dir), source.channel)?;
            let cursor = current.map_or(source.message, |current| current.max(source.message));
            cursor_file::write(Some(dir), source.channel, cursor)?;
            prune(&*self.lock()?, source.channel, cursor)?;
        }
    }
}

#[cfg(test)]
mod tests;
