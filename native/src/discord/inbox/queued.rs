//! Supervised FIFO access in the TypeScript queue's shape (discord-inbound-queue.ts): raw payloads with their
//! admission cursor and thread scope, duplicate detection by raw fingerprint, and per-row removal.

use anyhow::{Context, Result, bail, ensure};
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

use super::{CHANNEL, Inbox, MAX_BYTES, MESSAGE, Snowflake, admissions};
use crate::discord::inbound::raw_fingerprint;

/// One retained `message` row.
pub(in crate::discord) struct Queued {
    pub(in crate::discord) row: i64,
    pub(in crate::discord) id: Snowflake,
    pub(in crate::discord) payload: Value,
    /// `None` is SQL NULL: a channel without an admission cursor. The `"0"` cursor is `FLOOR`.
    pub(in crate::discord) admitted_after: Option<Snowflake>,
    pub(in crate::discord) parent: Option<Snowflake>,
}

fn snowflake(raw: &str, what: &str) -> Result<Snowflake> {
    Snowflake::try_from(raw.to_owned())
        .map_err(|_| anyhow::anyhow!("Discord inbound queue {what} is invalid"))
}

/// The FIFO head (`queue.first()`).
pub(in crate::discord) enum First {
    /// A TypeScript `sync` marker: a REST backfill is owed before it is removed.
    Sync { row: i64 },
    /// A message row; `None` when its channel ID is not a snowflake.
    Message {
        row: i64,
        channel: Option<Snowflake>,
    },
}

impl Inbox {
    pub(in crate::discord) fn first(&self) -> Result<Option<First>> {
        let found: Option<(i64, String, Option<String>)> = self
            .lock()?
            .query_row(
                &format!("SELECT id, kind, {CHANNEL} FROM pending ORDER BY id LIMIT 1"),
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get::<_, Option<String>>(2).ok().flatten(),
                    ))
                },
            )
            .optional()?;
        Ok(found.map(|(row, kind, channel)| {
            if kind == "message" {
                First::Message {
                    row,
                    channel: channel.and_then(|id| Snowflake::try_from(id).ok()),
                }
            } else {
                First::Sync { row }
            }
        }))
    }

    /// The thread scope proven at admission for any retained row of `channel` (`queue.parentFor`).
    pub(in crate::discord) fn parent_for(&self, channel: Snowflake) -> Result<Option<Snowflake>> {
        let parent: Option<Option<String>> = self.lock()?.query_row(
            &format!("SELECT thread_parent FROM pending WHERE kind='message' AND {CHANNEL}=?1 AND thread_parent IS NOT NULL ORDER BY id LIMIT 1"),
            [channel.to_string()],
            |row| row.get(0),
        ).optional()?;
        parent
            .flatten()
            .map(|parent| snowflake(&parent, "thread parent"))
            .transpose()
    }

    /// `queue.push("sync")`: a durable marker that owes one REST backfill (`onReady`, discord-inbound-live.ts:162).
    pub(in crate::discord) fn push_sync(&self) -> Result<()> {
        self.lock()?.execute(
            "INSERT INTO pending (kind, payload, admitted_after, thread_parent) VALUES ('sync', 'null', NULL, NULL)",
            [],
        )?;
        Ok(())
    }

    /// True when any row, including a `sync` marker, is retained (`queue.first()`).
    pub(in crate::discord) fn has_pending(&self) -> Result<bool> {
        Ok(self
            .lock()?
            .query_row("SELECT EXISTS(SELECT 1 FROM pending)", [], |row| row.get(0))?)
    }

    /// The oldest retained message ID for `channel`, used to seed an absent cursor (`storeFor`).
    pub(in crate::discord) fn first_message(
        &self,
        channel: Snowflake,
    ) -> Result<Option<Snowflake>> {
        let id: Option<Option<String>> = self.lock()?.query_row(
            &format!("SELECT {MESSAGE} FROM pending WHERE kind='message' AND {CHANNEL}=?1 ORDER BY length({MESSAGE}),{MESSAGE},id LIMIT 1"),
            [channel.to_string()],
            |row| Ok(row.get::<_, Option<String>>(0).ok().flatten()),
        ).optional()?;
        Ok(id.flatten().and_then(|id| Snowflake::try_from(id).ok()))
    }

    /// A pending message row with exactly this ID exists (`queue.has`).
    pub(in crate::discord) fn has(&self, channel: Snowflake, id: Snowflake) -> Result<bool> {
        let id = id.to_string();
        Ok(self.lock()?.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pending WHERE kind='message' AND {CHANNEL}=?1 AND length({MESSAGE})=length(?2) AND {MESSAGE}=?2)"),
            params![channel.to_string(), id],
            |row| row.get(0),
        )?)
    }

    /// Persists one live owner message before any delivery. A queued duplicate keeps its first payload, admission
    /// cursor and FIFO position; only a raw-fingerprint change is a source identity conflict.
    pub(in crate::discord) fn push_scoped(
        &self,
        channel: Snowflake,
        id: Snowflake,
        payload: &Value,
        admitted_after: Option<Snowflake>,
        parent: Option<Snowflake>,
    ) -> Result<()> {
        let data = serde_json::to_string(payload)?;
        ensure!(
            data.len() <= usize::try_from(MAX_BYTES)?,
            "Discord queued event exceeded the frame limit"
        );
        let db = self.lock()?;
        let previous: Option<(i64, String)> = db.query_row(
            &format!("SELECT id, payload FROM pending WHERE kind='message' AND {CHANNEL}=?1 AND length({MESSAGE})=length(?2) AND {MESSAGE}=?2 ORDER BY id LIMIT 1"),
            params![channel.to_string(), id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional()?;
        if let Some((row, original)) = previous {
            let original: Value =
                serde_json::from_str(&original).context("invalid Discord queued message")?;
            if original != *payload && raw_fingerprint(&original)? != raw_fingerprint(payload)? {
                bail!("Discord inbound source identity conflict; original queued record retained");
            }
            if let Some(parent) = parent {
                db.execute(
                    "UPDATE pending SET thread_parent = ?1 WHERE id = ?2 AND thread_parent IS NULL",
                    params![parent.to_string(), row],
                )?;
            }
            return Ok(());
        }
        db.execute(
            "INSERT INTO pending (kind, payload, admitted_after, thread_parent, cataly_native) VALUES ('message', ?1, ?2, ?3, 1)",
            params![
                data,
                // The TypeScript queue stores a channel without messages as the "0" cursor.
                admitted_after.map(|cursor| if cursor == Snowflake::FLOOR {
                    "0".to_owned()
                } else {
                    cursor.to_string()
                }),
                parent.map(|parent| parent.to_string())
            ],
        )?;
        drop(db);
        Ok(())
    }

    /// The next retained message row for `channel` after `after` in (ID, row) order.
    pub(in crate::discord) fn next_queued(
        &self,
        channel: Snowflake,
        after: Option<(Snowflake, i64)>,
    ) -> Result<Option<Queued>> {
        type Row = (
            i64,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        );
        let (after_id, after_row) =
            after.map_or_else(|| ("0".to_owned(), 0), |(id, row)| (id.to_string(), row));
        let found: Option<Row> = self.lock()?.query_row(
            &format!("SELECT id, {MESSAGE}, CASE WHEN length(CAST(payload AS BLOB)) <= {MAX_BYTES} THEN payload ELSE NULL END, admitted_after, thread_parent FROM pending WHERE kind='message' AND {CHANNEL}=?1 AND (length({MESSAGE}),{MESSAGE},id)>(length(?2),?2,?3) ORDER BY length({MESSAGE}),{MESSAGE},id LIMIT 1"),
            params![channel.to_string(), after_id, after_row],
            |row| Ok((row.get(0)?, row.get::<_, Option<String>>(1).ok().flatten(), row.get(2)?, row.get::<_, Option<String>>(3).ok().flatten(), row.get::<_, Option<String>>(4).ok().flatten())),
        ).optional()?;
        let Some((row, id, payload, admitted_after, parent)) = found else {
            return Ok(None);
        };
        let id = snowflake(&id.unwrap_or_default(), "message ID")?;
        let payload = payload.context("Discord queued event exceeded the frame limit")?;
        let admitted_after = match admitted_after.as_deref() {
            None => None,
            Some("0") => Some(Snowflake::FLOOR),
            Some(cursor) => Some(snowflake(cursor, "admission cursor")?),
        };
        let parent = parent
            .map(|parent| snowflake(&parent, "thread parent"))
            .transpose()?;
        Ok(Some(Queued {
            row,
            id,
            payload: serde_json::from_str(&payload).context("invalid Discord queued message")?,
            admitted_after,
            parent,
        }))
    }

    /// Distinct channels with retained message rows, at most `limit`.
    pub(in crate::discord) fn queued_channels(&self, limit: usize) -> Result<Vec<Snowflake>> {
        let rows = self
            .lock()?
            .prepare(&format!(
                "SELECT DISTINCT {CHANNEL} FROM pending WHERE kind='message' ORDER BY 1 LIMIT ?1"
            ))?
            .query_map([i64::try_from(limit)?], |row| {
                Ok(row.get::<_, Option<String>>(0).ok().flatten())
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut channels = Vec::new();
        for channel in rows {
            channels.push(snowflake(&channel.unwrap_or_default(), "channel ID")?);
        }
        Ok(channels)
    }

    /// Removes one row that is no longer in scope; refused while an admission is unresolved.
    pub(in crate::discord) fn remove(&self, row: i64) -> Result<()> {
        let db = self.lock()?;
        if self.has_admissions {
            admissions::assert_clear(&db)?;
        }
        db.execute("DELETE FROM pending WHERE id = ?1", [row])?;
        drop(db);
        Ok(())
    }
}
