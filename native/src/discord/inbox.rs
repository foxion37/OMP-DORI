use std::fs::{self, DirBuilder, OpenOptions};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use serde::Deserialize;
use serde_json::Value;

use super::{Message, Snowflake};
use crate::routing::head::{Action, receipt};

pub(super) mod admissions;
mod queued;
pub(super) use queued::First;

const MAX_BYTES: i64 = 1024 * 1024;
const QUEUE_BYTES: i64 = 256 * MAX_BYTES;
const CHANNEL: &str = "json_extract(payload, '$.channel_id')";
const MESSAGE: &str = "json_extract(payload, '$.id')";

/// How the queue treats the head admission ledger.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Ledger {
    /// The Rust-owned head: settle an unresolved row from its original OMP transcript.
    Unresolved,
    /// TS non-native intake: use an existing ledger, never settle it locally.
    Existing,
    /// Supervised admission: create the ledger (discord-inbound-queue.ts:81-85); IPC reconciles it.
    Forced,
}

pub(super) struct Inbox {
    db: Mutex<Connection>,
    has_admissions: bool,
    source_prefix: String,
}

fn check_file(path: &Path, uid: u32) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            ensure!(
                metadata.is_file()
                    && metadata.uid() == uid
                    && metadata.nlink() == 1
                    && metadata.mode().trailing_zeros() >= 6,
                "Discord queue needs owned private files: {}",
                path.display()
            );
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
}

impl Inbox {
    pub(super) fn open(
        root: &Path,
        bot: Snowflake,
        owner: Snowflake,
        ledger: Ledger,
    ) -> Result<Self> {
        match DirBuilder::new().mode(0o700).create(root) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error).context("creating Discord queue directory"),
        }
        let uid = rustix::process::geteuid().as_raw();
        let directory = fs::symlink_metadata(root)?;
        ensure!(
            directory.is_dir() && directory.uid() == uid && directory.mode().trailing_zeros() >= 6,
            "Discord queue directory must be owned and private"
        );
        // SQLITE_OPEN_NOFOLLOW refuses a symlink in any path component, such as macOS's `/var -> /private/var`
        // above `$TMPDIR`. The queue directory itself is not a link (checked above), so resolve only its ancestors.
        let root = fs::canonicalize(root)?;
        let path = root.join("gateway.sqlite");
        if !check_file(&path, uid)? {
            match OpenOptions::new()
                .create_new(true)
                .write(true)
                .mode(0o600)
                .open(&path)
            {
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    ensure!(check_file(&path, uid)?, "Discord queue file disappeared");
                }
                Err(error) => return Err(error.into()),
            }
        }
        for suffix in ["wal", "shm", "journal"] {
            check_file(&root.join(format!("gateway.sqlite-{suffix}")), uid)?;
        }
        let mut db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        db.busy_timeout(Duration::from_millis(100))?;
        db.execute_batch("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA cache_size=-256; PRAGMA mmap_size=0;")
            .context("opening Discord FIFO; stop the other receiver before switching")?;
        let pages: i64 = db.query_row("PRAGMA page_size", [], |row| row.get(0))?;
        db.pragma_update(None, "max_page_count", QUEUE_BYTES / pages)?;
        let source_prefix = format!("{bot}:{owner}:");
        let has_admissions = initialize(&mut db, &source_prefix, ledger == Ledger::Forced)?;
        let inbox = Self {
            db: Mutex::new(db),
            has_admissions,
            source_prefix,
        };
        if ledger == Ledger::Unresolved {
            inbox.reconcile()?;
        }
        Ok(inbox)
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| anyhow::anyhow!("Discord FIFO owner failed"))
    }

    pub(super) fn push(&self, channel: Snowflake, id: Snowflake, payload: &Value) -> Result<()> {
        let data = serde_json::to_string(payload)?;
        ensure!(
            data.len() <= usize::try_from(MAX_BYTES)?,
            "Discord queued event exceeded the frame limit"
        );
        let channel = channel.to_string();
        let id = id.to_string();
        self.lock()?.execute(&format!("INSERT INTO pending(kind,payload,cataly_native) SELECT 'message',?1,1 WHERE NOT EXISTS (SELECT 1 FROM pending WHERE kind='message' AND {CHANNEL}=?2 AND length({MESSAGE})=length(?3) AND {MESSAGE}=?3)"), params![data, channel, id])?;
        Ok(())
    }

    pub(super) fn next(
        &self,
        channel: Snowflake,
        after: Option<Snowflake>,
    ) -> Result<Option<(Message, bool)>> {
        let after = after.map_or_else(|| "0".to_owned(), |id| id.to_string());
        let raw = self.lock()?.query_row(&format!("SELECT CASE WHEN length(CAST(payload AS BLOB)) <= {MAX_BYTES} THEN payload ELSE NULL END,cataly_native FROM pending WHERE kind='message' AND {CHANNEL}=?1 AND (length({MESSAGE}),{MESSAGE})>(length(?2),?2) ORDER BY length({MESSAGE}),{MESSAGE},id LIMIT 1"),
            params![channel.to_string(), after],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, bool>(1)?)),
        ).optional()?;
        raw.map(|(text, native)| {
            let text = text.context("Discord queued event exceeded the frame limit")?;
            Ok((
                serde_json::from_str(&text).context("invalid Discord queued message")?,
                native,
            ))
        })
        .transpose()
    }

    pub(super) fn acknowledge(&self, channel: Snowflake, through: Snowflake) -> Result<()> {
        let db = self.lock()?;
        if self.has_admissions {
            admissions::assert_clear(&db)?;
        }
        db.execute(&format!("DELETE FROM pending WHERE kind='message' AND {CHANNEL}=?1 AND length({MESSAGE})=length(?2) AND {MESSAGE}=?2"), params![channel.to_string(), through.to_string()])?;
        drop(db);
        Ok(())
    }

    pub(super) fn clear_sync(&self) -> Result<()> {
        self.lock()?.execute("DELETE FROM pending WHERE kind='sync' AND NOT EXISTS(SELECT 1 FROM pending WHERE kind='message')", [])?;
        Ok(())
    }

    pub(super) fn settled(&self, channel: Snowflake, id: Snowflake) -> Result<bool> {
        if !self.has_admissions {
            return Ok(false);
        }
        let identity = format!("{}{channel}:{id}", self.source_prefix);
        let result = self.lock()?.query_row("SELECT outcome, json_extract(source,'$.channel'), json_extract(source,'$.message') FROM admissions WHERE identity=?1", [identity],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))).optional()?;
        let Some((outcome, source_channel, source_id)) = result else {
            return Ok(false);
        };
        ensure!(
            source_channel == channel.to_string()
                && source_id == id.to_string()
                && matches!(outcome.as_str(), "accepted" | "rejected" | "abandoned"),
            "Discord admission does not have an exact settled source"
        );
        Ok(true)
    }

    fn reconcile(&self) -> Result<()> {
        if !self.has_admissions {
            return Ok(());
        }
        // The guard is released before reading the OMP transcript; the update below
        // only settles a row that is still unresolved.
        let pending = self.lock()?.query_row("SELECT identity,fingerprint,head_file,source FROM admissions WHERE outcome='unresolved'", [], |row|
            Ok((row.get::<_, String>(0)?,row.get::<_, String>(1)?,row.get::<_, String>(2)?,row.get::<_, String>(3)?))).optional()?;
        let Some((identity, fingerprint, head_file, source)) = pending else {
            return Ok(());
        };
        let source: AdmissionSource = serde_json::from_str(&source)?;
        ensure!(
            identity
                == format!(
                    "{}{}:{}",
                    self.source_prefix, source.channel, source.message
                ),
            "unresolved Discord admission belongs to another receiver"
        );
        let file = Path::new(&head_file);
        ensure!(
            file.is_absolute(),
            "unresolved Discord head path must be absolute"
        );
        let (outcome, entry) = match receipt(file, &identity, &fingerprint)
            .context("HEAD_ADMISSION_UNRESOLVED: reading original OMP receipt")?
        {
            Some(Action::Accepted { receipt }) => ("accepted", receipt),
            Some(Action::Rejected { receipt }) => ("rejected", receipt),
            _ => anyhow::bail!(
                "HEAD_ADMISSION_UNRESOLVED: original OMP receipt absent; queued work retained"
            ),
        };
        self.lock()?.execute("UPDATE admissions SET outcome=?1, receipt=?2, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE identity=?3 AND outcome='unresolved'", params![outcome, entry, identity])?;
        Ok(())
    }
}

#[derive(Deserialize)]
struct AdmissionSource {
    channel: Snowflake,
    message: Snowflake,
}

fn initialize(db: &mut Connection, source: &str, native: bool) -> Result<bool> {
    // Force an exclusive write acquisition even for an already initialized queue.
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Exclusive)
        .context("acquiring the Discord FIFO; stop the other receiver before switching")?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, admitted_after TEXT, thread_parent TEXT);
        CREATE TABLE IF NOT EXISTS cataly_native_receiver (key INTEGER PRIMARY KEY CHECK(key=1), source TEXT NOT NULL);")?;
    // The TypeScript receiver creates the same queue without the Rust-only column.
    let native_column: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('pending') WHERE name='cataly_native')",
        [],
        |row| row.get(0),
    )?;
    if !native_column {
        tx.execute_batch(
            "ALTER TABLE pending ADD COLUMN cataly_native INTEGER NOT NULL DEFAULT 0",
        )?;
    }
    tx.execute_batch(&format!("CREATE INDEX IF NOT EXISTS pending_channel ON pending ({CHANNEL},length({MESSAGE}),{MESSAGE},id) WHERE kind='message';
        CREATE INDEX IF NOT EXISTS pending_owner ON pending ({CHANNEL},json_extract(payload, '$.author.id'),length({MESSAGE}),{MESSAGE},id) WHERE kind='message'"))?;
    tx.execute(
        "INSERT OR IGNORE INTO cataly_native_receiver(key,source) VALUES (1,?1)",
        [source],
    )?;
    let saved: String = tx.query_row(
        "SELECT source FROM cataly_native_receiver WHERE key=1",
        [],
        |row| row.get(0),
    )?;
    ensure!(
        saved == source,
        "Discord FIFO belongs to another bot or owner"
    );
    let existing: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='admissions')",
        [],
        |row| row.get(0),
    )?;
    // An existing ledger also gets its indexes and retirement trigger, exactly as headAdmissionState does.
    let has_admissions = native || existing;
    if has_admissions {
        admissions::create(&tx)?;
    }
    tx.commit()?;
    Ok(has_admissions)
}
