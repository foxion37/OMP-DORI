//! `discord-lane-inbox.ts` parity: `<state>/discord-lanes/inbox.sqlite`, shared with the lane extension.
//!
//! The monitor side only adds inputs and drains the reply outbox; the extension claims inputs and fills
//! `reply_outbox`. Schema, pragmas and statements are the TypeScript ones verbatim.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::ErrorKind;
use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _};
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use anyhow::{Context as _, Result, ensure};
use rusqlite::{Connection, OpenFlags, OptionalExtension as _, params};

const SCHEMA: &str = "PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS inbox (session TEXT NOT NULL, channel TEXT NOT NULL, id TEXT NOT NULL, text TEXT,
      PRIMARY KEY (session, channel, id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(session, channel, length(id), id) WHERE text IS NOT NULL;
      CREATE TABLE IF NOT EXISTS reply_requests (
        session TEXT NOT NULL, channel TEXT NOT NULL, id TEXT NOT NULL, bot TEXT NOT NULL, owner TEXT NOT NULL,
        captured INTEGER NOT NULL DEFAULT 0, dispatch INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (session, channel, id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS reply_outbox (
        session TEXT NOT NULL, channel TEXT NOT NULL, id TEXT NOT NULL, part INTEGER NOT NULL, text TEXT NOT NULL,
        PRIMARY KEY (session, channel, id, part)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS native_inputs (
        session TEXT NOT NULL, channel TEXT NOT NULL, id TEXT NOT NULL,
        PRIMARY KEY (session, channel, id)
      ) WITHOUT ROWID;";

const INSERT: &str = "INSERT OR IGNORE INTO inbox(session, channel, id, text) VALUES (?, ?, ?, ?)";
const INSERT_REQUEST: &str =
    "INSERT INTO reply_requests(session, channel, id, bot, owner) VALUES (?, ?, ?, ?, ?)";
const NEXT_REPLY: &str = "SELECT o.id, o.part, o.text FROM reply_outbox AS o JOIN reply_requests AS r USING(session, channel, id)
      WHERE o.session=?1 AND o.channel=?2 AND (?3 IS NULL OR (r.bot=?3 AND r.owner=?4))
      ORDER BY length(o.id), o.id, o.part LIMIT 1";
const ACKNOWLEDGE_REPLY: &str =
    "DELETE FROM reply_outbox WHERE session=? AND channel=? AND id=? AND part=?";
const DISCARD_REPLY: &str = "DELETE FROM reply_outbox WHERE session=? AND channel=? AND id=?";
const PENDING_SESSIONS: &str = "SELECT session, channel, max(hasInput) AS hasInput FROM (
        SELECT i.session, i.channel, 1 AS hasInput
        FROM inbox AS i INDEXED BY inbox_pending CROSS JOIN reply_requests AS r USING(session, channel, id)
        WHERE i.text IS NOT NULL AND r.dispatch=0 AND (?1 IS NULL OR (r.bot=?1 AND r.owner=?2))
        UNION ALL
        SELECT o.session, o.channel, 0 AS hasInput
        FROM reply_outbox AS o CROSS JOIN reply_requests AS r USING(session, channel, id)
        WHERE (?1 IS NULL OR (r.bot=?1 AND r.owner=?2))
      ) GROUP BY session, channel";

/// The bot/owner pair a wake-routed input was accepted for.
#[derive(Clone, Copy)]
pub(super) struct ReplyIdentity<'a> {
    pub(super) bot: &'a str,
    pub(super) owner: &'a str,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ReplyPart {
    pub(super) id: String,
    pub(super) part: i64,
    pub(super) text: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct PendingSession {
    pub(super) session: String,
    pub(super) channel: String,
    pub(super) has_input: bool,
}

/// The connection is behind a mutex so a monitor future that holds the inbox across an await stays `Send`.
pub(super) struct LaneInbox {
    db: Mutex<Connection>,
}

fn check_file(path: &Path, uid: u32) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(stat) => {
            ensure!(
                stat.is_file()
                    && stat.uid() == uid
                    && stat.nlink() == 1
                    && stat.mode().trailing_zeros() >= 6,
                "Discord lane inbox files must be private and owned by this user"
            );
            Ok(())
        }
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

impl LaneInbox {
    /// `openDiscordLaneInbox(stateDir)`.
    pub(super) fn open(state: &Path) -> Result<Self> {
        let dir = state.join("discord-lanes");
        DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)
            .context("creating Discord lane inbox directory")?;
        let uid = rustix::process::getuid().as_raw();
        let directory = fs::symlink_metadata(&dir)?;
        ensure!(
            directory.is_dir() && directory.uid() == uid && directory.mode().trailing_zeros() >= 6,
            "Discord lane inbox directory must be private and owned by this user"
        );
        // SQLITE_OPEN_NOFOLLOW refuses a symlink in any path component, such as macOS's `/var -> /private/var`
        // above `$TMPDIR`. The inbox directory itself is not a link (checked above), so resolve only its ancestors.
        let path = fs::canonicalize(&dir)?.join("inbox.sqlite");
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&path)
        {
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error).context("creating Discord lane inbox"),
        }
        for suffix in ["", "-wal", "-shm", "-journal"] {
            check_file(&crate::util::sibling(&path, suffix), directory.uid())?;
        }
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )?;
        db.execute_batch(SCHEMA)?;
        Ok(Self { db: Mutex::new(db) })
    }

    fn db(&self) -> Result<MutexGuard<'_, Connection>> {
        self.db
            .lock()
            .map_err(|_| anyhow::anyhow!("Discord lane inbox owner failed"))
    }

    /// `add(session, message)`: a plain input, without a reply request, the lane may answer in its own transcript.
    pub(super) fn add(&self, session: &str, channel: &str, id: &str, text: &str) -> Result<()> {
        self.db()?
            .prepare_cached(INSERT)?
            .execute(params![session, channel, id, text])?;
        Ok(())
    }

    /// `add(session, message, { reply })`: a woken lane's input whose reply the monitor posts.
    pub(super) fn add_with_reply(
        &self,
        session: &str,
        channel: &str,
        id: &str,
        text: &str,
        identity: ReplyIdentity<'_>,
    ) -> Result<()> {
        let mut db = self.db()?;
        let transaction = db.transaction()?;
        let inserted = transaction
            .prepare_cached(INSERT)?
            .execute(params![session, channel, id, text])?;
        if inserted > 0 {
            transaction
                .prepare_cached(INSERT_REQUEST)?
                .execute(params![session, channel, id, identity.bot, identity.owner])?;
        }
        transaction.commit()?;
        drop(db);
        Ok(())
    }

    /// `nextReply(session, channel, identity)`.
    pub(super) fn next_reply(
        &self,
        session: &str,
        channel: &str,
        identity: Option<ReplyIdentity<'_>>,
    ) -> Result<Option<ReplyPart>> {
        Ok(self
            .db()?
            .prepare_cached(NEXT_REPLY)?
            .query_row(
                params![
                    session,
                    channel,
                    identity.map(|i| i.bot),
                    identity.map(|i| i.owner)
                ],
                |row| {
                    Ok(ReplyPart {
                        id: row.get(0)?,
                        part: row.get(1)?,
                        text: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    /// `acknowledgeReply(session, channel, part)`.
    pub(super) fn acknowledge_reply(
        &self,
        session: &str,
        channel: &str,
        part: &ReplyPart,
    ) -> Result<()> {
        self.db()?
            .prepare_cached(ACKNOWLEDGE_REPLY)?
            .execute(params![session, channel, part.id, part.part])?;
        Ok(())
    }

    /// `discardReply(session, channel, id)`.
    pub(super) fn discard_reply(&self, session: &str, channel: &str, id: &str) -> Result<()> {
        self.db()?
            .prepare_cached(DISCARD_REPLY)?
            .execute(params![session, channel, id])?;
        Ok(())
    }

    /// `pendingSessions(identity)`.
    pub(super) fn pending_sessions(
        &self,
        identity: Option<ReplyIdentity<'_>>,
    ) -> Result<Vec<PendingSession>> {
        let db = self.db()?;
        let mut statement = db.prepare_cached(PENDING_SESSIONS)?;
        let pending = statement
            .query_map(
                params![identity.map(|i| i.bot), identity.map(|i| i.owner)],
                |row| {
                    Ok(PendingSession {
                        session: row.get(0)?,
                        channel: row.get(1)?,
                        has_input: row.get::<_, i64>(2)? == 1,
                    })
                },
            )?
            .collect::<Result<_, _>>()?;
        drop(statement);
        drop(db);
        Ok(pending)
    }

    #[cfg(test)]
    fn execute(&self, sql: &str) {
        self.db().unwrap().execute_batch(sql).unwrap();
    }

    #[cfg(test)]
    fn count(&self, sql: &str) -> i64 {
        self.db().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "cataly-lane-inbox-{}",
            crate::util::uuid().unwrap()
        ));
        DirBuilder::new().mode(0o700).create(&dir).unwrap();
        dir
    }

    const ME: ReplyIdentity<'static> = ReplyIdentity {
        bot: "9",
        owner: "8",
    };

    #[test]
    fn schema_and_files_are_private() {
        let state = temp();
        let inbox = LaneInbox::open(&state).unwrap();
        drop(inbox);
        let db = state.join("discord-lanes/inbox.sqlite");
        assert_eq!(fs::metadata(&db).unwrap().mode() & 0o777, 0o600);
        assert_eq!(
            fs::metadata(state.join("discord-lanes")).unwrap().mode() & 0o777,
            0o700
        );
        let connection = Connection::open(&db).unwrap();
        let mode: String = connection
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode, "wal");
        let tables: Vec<String> = connection
            .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            tables,
            [
                "inbox",
                "inbox_pending",
                "native_inputs",
                "reply_outbox",
                "reply_requests"
            ]
        );
        drop(connection);
        fs::set_permissions(db, std::os::unix::fs::PermissionsExt::from_mode(0o644)).unwrap();
        assert!(LaneInbox::open(&state).is_err());
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn a_symlinked_ancestor_opens_but_a_symlinked_inbox_directory_does_not() {
        let real = temp();
        let link = real.with_extension("link");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        // macOS's $TMPDIR sits under /var -> /private/var.
        drop(LaneInbox::open(&link).unwrap());
        assert!(real.join("discord-lanes/inbox.sqlite").is_file());
        let aliased = temp();
        DirBuilder::new()
            .mode(0o700)
            .create(real.join("target"))
            .unwrap();
        std::os::unix::fs::symlink(real.join("target"), aliased.join("discord-lanes")).unwrap();
        assert!(LaneInbox::open(&aliased).is_err());
        fs::remove_file(link).unwrap();
        fs::remove_dir_all(real).unwrap();
        fs::remove_dir_all(aliased).unwrap();
    }

    #[test]
    fn add_is_idempotent_and_only_replied_inputs_wake() {
        let state = temp();
        let inbox = LaneInbox::open(&state).unwrap();
        inbox.add("s", "1", "10", "plain").unwrap();
        assert_eq!(inbox.pending_sessions(Some(ME)).unwrap(), []);
        inbox.add_with_reply("s", "1", "11", "first", ME).unwrap();
        inbox.add_with_reply("s", "1", "11", "second", ME).unwrap();
        // A plain row with the same key never gains a reply request.
        inbox.add_with_reply("s", "1", "10", "again", ME).unwrap();
        assert_eq!(
            inbox.count("SELECT count(*) FROM inbox WHERE id='11' AND text='first'"),
            1
        );
        assert_eq!(inbox.count("SELECT count(*) FROM reply_requests"), 1);
        assert_eq!(
            inbox.pending_sessions(Some(ME)).unwrap(),
            [PendingSession {
                session: "s".into(),
                channel: "1".into(),
                has_input: true
            }]
        );
        assert_eq!(
            inbox
                .pending_sessions(Some(ReplyIdentity {
                    bot: "9",
                    owner: "7"
                }))
                .unwrap(),
            []
        );
        // A claimed input (dispatch=1) no longer asks for a wake.
        inbox.execute("UPDATE reply_requests SET dispatch=1");
        assert_eq!(inbox.pending_sessions(Some(ME)).unwrap(), []);
        fs::remove_dir_all(state).unwrap();
    }

    #[test]
    fn replies_drain_in_snowflake_then_part_order() {
        let state = temp();
        let inbox = LaneInbox::open(&state).unwrap();
        inbox.add_with_reply("s", "1", "100", "a", ME).unwrap();
        inbox.add_with_reply("s", "1", "99", "b", ME).unwrap();
        inbox.execute(
            "UPDATE reply_requests SET captured=1, dispatch=1; UPDATE inbox SET text=NULL;
             INSERT INTO reply_outbox VALUES ('s','1','100',0,'x0'),('s','1','99',1,'y1'),('s','1','99',0,'y0');",
        );
        assert_eq!(
            inbox.pending_sessions(Some(ME)).unwrap(),
            [PendingSession {
                session: "s".into(),
                channel: "1".into(),
                has_input: false
            }]
        );
        let first = inbox.next_reply("s", "1", Some(ME)).unwrap().unwrap();
        assert_eq!(
            first,
            ReplyPart {
                id: "99".into(),
                part: 0,
                text: "y0".into()
            }
        );
        inbox.acknowledge_reply("s", "1", &first).unwrap();
        assert_eq!(
            inbox.next_reply("s", "1", Some(ME)).unwrap().unwrap().part,
            1
        );
        assert!(
            inbox
                .next_reply(
                    "s",
                    "1",
                    Some(ReplyIdentity {
                        bot: "1",
                        owner: "8"
                    })
                )
                .unwrap()
                .is_none()
        );
        inbox.discard_reply("s", "1", "99").unwrap();
        assert_eq!(inbox.next_reply("s", "1", None).unwrap().unwrap().id, "100");
        inbox.discard_reply("s", "1", "100").unwrap();
        assert!(inbox.next_reply("s", "1", Some(ME)).unwrap().is_none());
        assert_eq!(inbox.pending_sessions(Some(ME)).unwrap(), []);
        fs::remove_dir_all(state).unwrap();
    }
}
