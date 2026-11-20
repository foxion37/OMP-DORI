import { Database } from "bun:sqlite";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import { join } from "node:path";
import { type DiscordInboundStore, fileDiscordInboundStore, isDiscordSnowflake } from "./discord-inbound-state.ts";
import { MessengerError } from "./http.ts";

export type DiscordInboundRecord = {
  id: number;
  kind: string;
  payload: string;
  /** Null denotes a legacy row or a channel without an admission cursor, not a delivery receipt. */
  admittedAfter: string | null;
  /** Established thread scope at admission; null for explicit/scope-all and legacy rows. */
  parent: string | null;
};

export type DiscordInboundQueue = {
  push(kind: "sync" | "message", data?: unknown, admittedAfter?: string, parent?: string): void;
  first(): DiscordInboundRecord | null;
  before(id: number): DiscordInboundRecord | null;
  nextOwner(channel: string, owner: string, through: string, after: string, row: number): DiscordInboundRecord | null;
  nextChannel(after: string): string | undefined;
  parentFor(channel: string): string | undefined;
  acknowledge(channel: string, message: string): void;
  /** Admission reads use seed=false so another still-pending older frame cannot be baselined away. */
  storeFor(channelId: string, seed?: boolean): DiscordInboundStore;
  remove(id: number): void;
  close(): void;
};

const storage = <T>(job: () => T): T => {
  try {
    return job();
  } catch (error) {
    if (error instanceof MessengerError) throw error;
    throw new MessengerError(
      "Discord inbound queue storage failed; check ownership, available space, the 256 MiB queue limit and other intake processes",
      0,
    );
  }
};

const privateFile = (stat: Stats) => {
  if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.nlink !== 1) {
    throw new MessengerError("Discord inbound queue must be a private regular file owned by this user", 0);
  }
};

/** Disk-backed FIFO: one decoded record and a bounded SQLite page cache, never one Promise per dispatch. */
export const discordInboundQueue = (stateDir: string): DiscordInboundQueue =>
  storage(() => {
    const dir = join(stateDir, "discord-inbound");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
      throw new MessengerError("Discord inbound queue directory must be private (0700) and owned by this user", 0);
    }
    const path = join(dir, "gateway.sqlite");
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing) privateFile(existing);
    else {
      // Closing an ordinary fd for an existing SQLite inode releases this process's other POSIX locks on it.
      const fd = openSync(
        path,
        constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        0o600,
      );
      try {
        privateFile(fstatSync(fd));
      } finally {
        closeSync(fd);
      }
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      const sidecar = lstatSync(`${path}${suffix}`, { throwIfNoEntry: false });
      if (sidecar) privateFile(sidecar);
    }
    const db = new Database(path);
    try {
      db.exec(
        "PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; " +
          "PRAGMA cache_size=-256; PRAGMA mmap_size=0;",
      );
      const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
      db.exec(`PRAGMA max_page_count=${Math.floor((256 * 1024 * 1024) / pageSize)}`);
      const message = "json_extract(payload, '$.id')";
      const channelId = "json_extract(payload, '$.channel_id')";
      const author = "json_extract(payload, '$.author.id')";
      const order = `length(${message}), ${message}, id`;
      // Additive and atomic: index space counts against the same database budget; no queued payload array.
      db.transaction(() => {
        db.exec(
          "CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL)",
        );
        const columns = db.query<{ name: string }, []>("PRAGMA table_info(pending)").all();
        if (!columns.some((column) => column.name === "admitted_after"))
          db.exec("ALTER TABLE pending ADD COLUMN admitted_after TEXT");
        if (!columns.some((column) => column.name === "thread_parent"))
          db.exec("ALTER TABLE pending ADD COLUMN thread_parent TEXT");
        db.exec(
          `CREATE INDEX IF NOT EXISTS pending_channel ON pending (${channelId}, ${order}) WHERE kind = 'message'; ` +
            `CREATE INDEX IF NOT EXISTS pending_owner ON pending (${channelId}, ${author}, ${order}) WHERE kind = 'message'`,
        );
      })();
      const fields = "id, kind, payload, admitted_after AS admittedAfter, thread_parent AS parent";
      const insert = db.query("INSERT INTO pending (kind, payload, admitted_after, thread_parent) VALUES (?, ?, ?, ?)");
      const first = db.query<DiscordInboundRecord, []>(`SELECT ${fields} FROM pending ORDER BY id LIMIT 1`);
      const before = db.query<DiscordInboundRecord, [number, number]>(
        `SELECT ${fields} FROM pending WHERE kind = 'message' ` +
          `AND ${channelId} = (SELECT ${channelId} FROM pending WHERE id = ?) ` +
          `AND (length(${message}), ${message}) < ` +
          `(SELECT length(${message}), ${message} FROM pending WHERE id = ?) ` +
          `ORDER BY ${order} LIMIT 1`,
      );
      const next = db.query<DiscordInboundRecord, [string, string, number, string, number, string, number]>(
        `SELECT ${fields} FROM pending WHERE kind = 'message' AND ${channelId} = ? AND ${author} = ? ` +
          `AND (length(${message}), ${message}) <= (?, ?) ` +
          `AND (length(${message}), ${message}, id) > (?, ?, ?) ORDER BY ${order} LIMIT 1`,
      );
      const remove = db.query("DELETE FROM pending WHERE id = ?");
      const acknowledge = db.query(
        `DELETE FROM pending WHERE kind = 'message' AND ${channelId} = ? ` +
          `AND length(${message}) = ? AND ${message} = ?`,
      );
      const channel = db.query<{ message: unknown }, [string]>(
        `SELECT ${message} AS message FROM pending WHERE kind = 'message' AND ${channelId} = ? ORDER BY ${order} LIMIT 1`,
      );
      const nextChannel = db.query<{ channel: unknown }, [string]>(
        `SELECT ${channelId} AS channel FROM pending WHERE kind = 'message' AND ${channelId} > ? ` +
          `ORDER BY ${channelId} LIMIT 1`,
      );
      const parent = db.query<{ parent: unknown }, [string]>(
        `SELECT thread_parent AS parent FROM pending WHERE kind = 'message' AND ${channelId} = ? ` +
          "AND thread_parent IS NOT NULL ORDER BY id LIMIT 1",
      );
      return {
        push: (kind, data, admittedAfter, parent) =>
          storage(() => {
            if (admittedAfter !== undefined && admittedAfter !== "0" && !isDiscordSnowflake(admittedAfter))
              throw new MessengerError("Discord inbound queue admission cursor is invalid", 0);
            if (parent !== undefined && !isDiscordSnowflake(parent))
              throw new MessengerError("Discord inbound queue thread parent is invalid", 0);
            insert.run(kind, JSON.stringify(data) ?? "null", admittedAfter ?? null, parent ?? null);
          }),
        first: () => storage(() => first.get()),
        before: (id) => storage(() => before.get(id, id)),
        nextOwner: (channel, owner, through, after, row) =>
          storage(() => next.get(channel, owner, through.length, through, after.length, after, row)),
        nextChannel: (after) =>
          storage(() => {
            const value = nextChannel.get(after)?.channel;
            if (value === undefined) return undefined;
            if (!isDiscordSnowflake(value)) throw new MessengerError("Discord inbound queue channel ID is invalid", 0);
            return value;
          }),
        parentFor: (channel) =>
          storage(() => {
            const value = parent.get(channel)?.parent;
            if (value === undefined) return undefined;
            if (!isDiscordSnowflake(value))
              throw new MessengerError("Discord inbound queue thread parent is invalid", 0);
            return value;
          }),
        acknowledge: (channel, message) =>
          storage(() => {
            acknowledge.run(channel, message.length, message);
          }),
        storeFor: (channelId, seed = true) =>
          storage(() => {
            const store = fileDiscordInboundStore(stateDir, channelId);
            if (seed && store.load() === undefined) {
              const id = channel.get(channelId)?.message;
              if (isDiscordSnowflake(id)) store.save(String(BigInt(id) - 1n));
            }
            return store;
          }),
        remove: (id) =>
          storage(() => {
            remove.run(id);
          }),
        close: () => storage(() => db.close()),
      };
    } catch (error) {
      db.close();
      throw error;
    }
  });
