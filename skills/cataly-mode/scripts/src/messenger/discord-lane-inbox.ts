import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { readPaneState } from "../lane-state.ts";
import type { Lane } from "../registry.ts";
import type { DiscordInbound } from "./discord-inbound-api.ts";
import { formatDiscordInbound } from "./discord-inbound.ts";
import { isDiscordSnowflake } from "./discord-inbound-state.ts";

export type LaneMessage = { readonly id: string; readonly text: string; readonly reply?: true };
type LaneReplyIdentity = { readonly bot: string; readonly owner: string };
type LaneReplyPart = { readonly id: string; readonly part: number; readonly text: string };
type PendingLaneSession = { readonly session: string; readonly channel: string; readonly hasInput: boolean };

export type DiscordLaneInbox = {
  add(session: string, message: DiscordInbound, options?: { readonly reply: LaneReplyIdentity }): void;
  next(session: string, channel: string, options?: { readonly optedInOnly: true }): LaneMessage | null;
  outstanding(session: string, channel: string): boolean;
  claimInput(session: string, channel: string, id: string, plain?: boolean): boolean;
  holdInput(session: string, channel: string, id: string): void;
  acknowledge(session: string, channel: string, id: string): void;
  enqueueReply(
    session: string,
    channel: string,
    message: { readonly id: string; readonly parts: readonly string[] },
  ): void;
  nextReply(session: string, channel: string, identity?: LaneReplyIdentity): LaneReplyPart | null;
  acknowledgeReply(session: string, channel: string, part: LaneReplyPart): void;
  discardReply(session: string, channel: string, id: string): void;
  pendingSessions(identity?: LaneReplyIdentity): PendingLaneSession[];
  close(): void;
};

export function openDiscordLaneInbox(stateDir: string): DiscordLaneInbox {
  const dir = join(stateDir, "discord-lanes");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const directory = lstatSync(dir);
  if (!directory.isDirectory() || directory.uid !== process.getuid?.() || (directory.mode & 0o077) !== 0)
    throw new Error("Discord lane inbox directory must be private and owned by this user");
  const path = join(dir, "inbox.sqlite");
  try {
    closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const stat = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.uid !== directory.uid || stat.nlink !== 1 || (stat.mode & 0o077) !== 0))
      throw new Error("Discord lane inbox files must be private and owned by this user");
  }
  const db = new Database(path);
  try {
    db.exec(`PRAGMA busy_timeout=1500; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
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
      ) WITHOUT ROWID;`);
    const insert = db.query("INSERT OR IGNORE INTO inbox(session, channel, id, text) VALUES (?, ?, ?, ?)");
    const insertRequest = db.query(
      "INSERT INTO reply_requests(session, channel, id, bot, owner) VALUES (?, ?, ?, ?, ?)",
    );
    const addWithReply = db.transaction((session: string, message: DiscordInbound, identity: LaneReplyIdentity) => {
      const { channel, message: id } = message;
      if (insert.run(session, channel, id, formatDiscordInbound(message)).changes)
        insertRequest.run(session, channel, id, identity.bot, identity.owner);
    });
    const acknowledge = db.query("UPDATE inbox SET text=NULL WHERE session=? AND channel=? AND id=?");
    // A crash between claim and OMP's receipt must not re-run a possibly consumed input.
    const claim = db.query(
      "UPDATE reply_requests SET dispatch=1 WHERE session=? AND channel=? AND id=? AND dispatch=0",
    );
    const claimNative = db.query("INSERT OR IGNORE INTO native_inputs(session, channel, id) VALUES (?, ?, ?)");
    const outstanding = db.query("SELECT 1 FROM inbox WHERE session=? AND channel=? AND text IS NOT NULL LIMIT 1");
    const hold = db.query("UPDATE reply_requests SET dispatch=2 WHERE session=? AND channel=? AND id=? AND dispatch=1");
    const next = db.query<Omit<LaneMessage, "reply"> & { optedIn: 0 | 1 }, [string, string, 0 | 1]>(
      `SELECT i.id, i.text, (r.id IS NOT NULL) AS optedIn
      FROM inbox AS i LEFT JOIN reply_requests AS r USING(session, channel, id)
      WHERE i.session=? AND i.channel=? AND i.text IS NOT NULL AND coalesce(r.dispatch, 0)=0
      AND NOT EXISTS (SELECT 1 FROM native_inputs AS n WHERE n.session=i.session AND n.channel=i.channel AND n.id=i.id)
      AND (?=0 OR r.id IS NOT NULL)
      ORDER BY length(i.id), i.id LIMIT 1`,
    );
    const capture = db.query(
      "UPDATE reply_requests SET captured=1 WHERE session=? AND channel=? AND id=? AND captured=0",
    );
    const insertPart = db.query("INSERT INTO reply_outbox(session, channel, id, part, text) VALUES (?, ?, ?, ?, ?)");
    const enqueueReply = db.transaction(
      (session: string, channel: string, message: { readonly id: string; readonly parts: readonly string[] }) => {
        const { id, parts } = message;
        // First capture wins, even after all its parts have been sent and removed.
        if (parts.length === 0 || capture.run(session, channel, id).changes === 0) return;
        for (const [part, text] of parts.entries()) insertPart.run(session, channel, id, part, text);
        acknowledge.run(session, channel, id);
      },
    );
    const nextReply = db.query<LaneReplyPart, [string, string, string | null, string | null]>(
      `SELECT o.id, o.part, o.text FROM reply_outbox AS o JOIN reply_requests AS r USING(session, channel, id)
      WHERE o.session=?1 AND o.channel=?2 AND (?3 IS NULL OR (r.bot=?3 AND r.owner=?4))
      ORDER BY length(o.id), o.id, o.part LIMIT 1`,
    );
    const acknowledgeReply = db.query("DELETE FROM reply_outbox WHERE session=? AND channel=? AND id=? AND part=?");
    const discardReply = db.query("DELETE FROM reply_outbox WHERE session=? AND channel=? AND id=?");
    // Start both arms from pending work, not the historical reply-request tombstones.
    const pendingSessions = db.query<
      { session: string; channel: string; hasInput: 0 | 1 },
      [string | null, string | null]
    >(
      `SELECT session, channel, max(hasInput) AS hasInput FROM (
        SELECT i.session, i.channel, 1 AS hasInput
        FROM inbox AS i INDEXED BY inbox_pending CROSS JOIN reply_requests AS r USING(session, channel, id)
        WHERE i.text IS NOT NULL AND r.dispatch=0 AND (?1 IS NULL OR (r.bot=?1 AND r.owner=?2))
        UNION ALL
        SELECT o.session, o.channel, 0 AS hasInput
        FROM reply_outbox AS o CROSS JOIN reply_requests AS r USING(session, channel, id)
        WHERE (?1 IS NULL OR (r.bot=?1 AND r.owner=?2))
      ) GROUP BY session, channel`,
    );
    return {
      add(session: string, message: DiscordInbound, options?: { readonly reply: LaneReplyIdentity }) {
        if (options?.reply) addWithReply(session, message, options.reply);
        else insert.run(session, message.channel, message.message, formatDiscordInbound(message));
      },
      next(session: string, channel: string, options?: { readonly optedInOnly: true }): LaneMessage | null {
        const row = next.get(session, channel, options?.optedInOnly ? 1 : 0);
        if (!row) return null;
        const { id, text, optedIn } = row;
        return optedIn === 1 ? { id, text, reply: true } : { id, text };
      },
      outstanding: (session, channel) => outstanding.get(session, channel) !== null,
      claimInput: (session, channel, id, plain) =>
        (plain ? claimNative : claim).run(session, channel, id).changes === 1,
      holdInput: (session, channel, id) => hold.run(session, channel, id),
      acknowledge: (session: string, channel: string, id: string) => acknowledge.run(session, channel, id),
      enqueueReply,
      nextReply: (session: string, channel: string, identity?: LaneReplyIdentity) =>
        nextReply.get(session, channel, identity?.bot ?? null, identity?.owner ?? null),
      acknowledgeReply: (session: string, channel: string, part: LaneReplyPart) =>
        acknowledgeReply.run(session, channel, part.id, part.part),
      discardReply: (session, channel, id) => discardReply.run(session, channel, id),
      pendingSessions: (identity?: LaneReplyIdentity) =>
        pendingSessions.all(identity?.bot ?? null, identity?.owner ?? null).map(({ session, channel, hasInput }) => ({
          session,
          channel,
          hasInput: hasInput === 1,
        })),
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

export function hasDiscordLaneMessages(
  stateDir: string,
  session: string,
  channel: string,
  includeHeld = false,
): boolean {
  if (!existsSync(join(stateDir, "discord-lanes", "inbox.sqlite"))) return false;
  const inbox = openDiscordLaneInbox(stateDir);
  try {
    return includeHeld ? inbox.outstanding(session, channel) : inbox.next(session, channel) !== null;
  } finally {
    inbox.close();
  }
}

export function pendingDiscordLane(stateDir: string, lane: Lane): boolean {
  const headless = lane.sessionRef?.runtime === "headless";
  const pane = !headless && lane.sessionRef ? readPaneState(stateDir, lane.sessionRef.id) : undefined;
  const native = pane?.role === "lane" && (!lane.session || lane.session === pane.sessionId) ? pane : undefined;
  const session =
    lane.session ?? (native?.discordLaneKey === lane.key || native?.discordLaneReceiver ? native.sessionId : undefined);
  if (!session) return false;
  const channel = lane.thread.startsWith("discord:") ? lane.thread.slice(8) : undefined;
  if (isDiscordSnowflake(channel) && hasDiscordLaneMessages(stateDir, session, channel, headless)) return true;
  const receiver = native?.discordLaneReceiver;
  return receiver !== undefined && hasDiscordLaneMessages(receiver.stateDir, session, receiver.channel);
}
