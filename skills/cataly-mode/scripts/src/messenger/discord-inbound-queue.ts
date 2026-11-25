import { isDeepStrictEqual } from "node:util";
import type { Message } from "./discord-inbound-api.ts";
import { openDiscordQueue } from "./discord-inbound-database.ts";
import { type DiscordInboundStore, fileDiscordInboundStore, isDiscordSnowflake } from "./discord-inbound-state.ts";
import { discordRawFingerprint } from "./discord-source-fingerprint.ts";
import { headAdmissionState, type HeadAdmissionStore } from "./head-admission-state.ts";
import { MessengerError } from "./http.ts";

export type DiscordInboundRecord = {
  id: number;
  kind: string;
  payload: string;
  /** Null denotes a channel without an admission cursor, not a delivery receipt. */
  admittedAfter: string | null;
  /** Established thread scope at admission; null for explicit and scope-all rows. */
  parent: string | null;
};

export type DiscordInboundFifo = {
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

export type DiscordInboundQueue = DiscordInboundFifo &
  Pick<HeadAdmissionStore, "unresolved" | "admission" | "attempt" | "receipt" | "abandon"> & {
    has(channel: string, message: string): boolean;
    commitReceipts(): void;
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

/** Disk-backed FIFO: one decoded record and a bounded SQLite page cache, never one Promise per dispatch. */
export const discordInboundQueue = (stateDir: string, nativeAdmission = false): DiscordInboundQueue =>
  storage(() => {
    const db = openDiscordQueue(stateDir);
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
      // Atomic: index space counts against the same database budget; no queued payload array.
      db.transaction(() => {
        db.exec(
          "CREATE TABLE IF NOT EXISTS pending (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, " +
            "admitted_after TEXT, thread_parent TEXT)",
        );
        db.exec(
          `CREATE INDEX IF NOT EXISTS pending_channel ON pending (${channelId}, ${order}) WHERE kind = 'message'; ` +
            `CREATE INDEX IF NOT EXISTS pending_owner ON pending (${channelId}, ${author}, ${order}) WHERE kind = 'message'`,
        );
      })();
      let admissions =
        nativeAdmission || db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admissions'").get()
          ? headAdmissionState(db, storage)
          : undefined;
      const ledger = () => (admissions ??= headAdmissionState(db, storage));
      const priorMessage = db.query<{ id: number; payload: string }, [string, number, string]>(
        `SELECT id, payload FROM pending WHERE kind = 'message' AND ${channelId} = ? AND length(${message}) = ? AND ${message} = ? ORDER BY id LIMIT 1`,
      );
      const rememberParent = db.query("UPDATE pending SET thread_parent = ? WHERE id = ? AND thread_parent IS NULL");
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
      const commitReceipts = () =>
        storage(() => {
          const head = admissions;
          if (!head) return;
          head.assertClear();
          for (let record = head.uncommittedReceipt(); record; record = head.uncommittedReceipt()) {
            const source = JSON.parse(record.source) as { channel: string; message: string };
            const store = fileDiscordInboundStore(stateDir, source.channel);
            const current = store.load();
            const cursor = current !== undefined && BigInt(current) > BigInt(source.message) ? current : source.message;
            store.save(cursor);
            head.pruneReceipts(source.channel, cursor);
          }
        });
      return {
        commitReceipts,
        unresolved: () => admissions?.unresolved() ?? null,
        admission: (identity, fingerprint) => admissions?.admission(identity, fingerprint) ?? null,
        attempt: (input) => ledger().attempt(input),
        receipt: (identity, outcome, receipt) => ledger().receipt(identity, outcome, receipt),
        abandon: (identity, reason) =>
          storage(() => {
            const decision = ledger().abandon(identity, reason);
            commitReceipts();
            return decision;
          }),
        has: (channel, message) => storage(() => priorMessage.get(channel, message.length, message) !== null),
        push: (kind, data, admittedAfter, parent) =>
          storage(() => {
            if (admittedAfter !== undefined && admittedAfter !== "0" && !isDiscordSnowflake(admittedAfter))
              throw new MessengerError("Discord inbound queue admission cursor is invalid", 0);
            if (parent !== undefined && !isDiscordSnowflake(parent))
              throw new MessengerError("Discord inbound queue thread parent is invalid", 0);
            if (
              admissions &&
              kind === "message" &&
              data !== null &&
              typeof data === "object" &&
              "id" in data &&
              "channel_id" in data &&
              isDiscordSnowflake(data.id) &&
              isDiscordSnowflake(data.channel_id)
            ) {
              const previous = priorMessage.get(data.channel_id, data.id.length, data.id);
              if (previous) {
                if (
                  !isDeepStrictEqual(JSON.parse(previous.payload), data) &&
                  discordRawFingerprint(JSON.parse(previous.payload)) !== discordRawFingerprint(data as Message)
                )
                  throw new MessengerError(
                    "Discord inbound source identity conflict; original queued record retained",
                    0,
                  );
                // Scope proof can grow; the first payload, admission cursor and FIFO position do not change.
                if (parent !== undefined) rememberParent.run(parent, previous.id);
                return;
              }
            }
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
            admissions?.assertClear();
            acknowledge.run(channel, message.length, message);
          }),
        storeFor: (channelId, seed = true) =>
          storage(() => {
            const disk = fileDiscordInboundStore(stateDir, channelId);
            const store: DiscordInboundStore = {
              load: () => disk.load(),
              save: (cursor) =>
                storage(() => {
                  admissions?.assertClear();
                  disk.save(cursor);
                  admissions?.pruneReceipts(channelId, cursor);
                }),
            };
            if (seed && store.load() === undefined) {
              const id = channel.get(channelId)?.message;
              if (isDiscordSnowflake(id)) store.save(String(BigInt(id) - 1n));
            }
            return store;
          }),

        remove: (id) =>
          storage(() => {
            admissions?.assertClear();
            remove.run(id);
          }),
        close: () => storage(() => db.close()),
      };
    } catch (error) {
      db.close();
      throw error;
    }
  });
