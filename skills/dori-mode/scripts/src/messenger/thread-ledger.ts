import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { takeLock } from "../checkpoint-lock.ts";
import { MessengerError } from "./http.ts";

export const tsAfter = (a: string, b: string): boolean => Number(a) > Number(b);

export type SlackScope = { readonly teamId: string; readonly userId: string };
export const slackScope = (teamId: unknown, userId: unknown): SlackScope => {
  if (
    typeof teamId !== "string" ||
    typeof userId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(teamId) ||
    !/^[A-Za-z0-9_-]+$/.test(userId)
  )
    throw new MessengerError("invalid Slack workspace/account identity", 0);
  return Object.freeze({ teamId, userId });
};
export type LedgerThread = { readonly channel: string; readonly rootTs: string; readonly seenTs: string };
type ScopedThread = LedgerThread & { readonly scope: SlackScope };
type Threads = Map<string, ScopedThread>;
type Adoption = { readonly scope: SlackScope; readonly at: string; readonly count: number };
type State = { threads: Threads; legacy: LedgerThread[]; adopted?: Adoption };

const LOCK_RETRY_MS = 20;
const LOCK_WAIT_MS = 10_000;
const keyOf = (scope: SlackScope, channel: string, rootTs: string): string =>
  JSON.stringify([scope.teamId, scope.userId, channel, rootTs]);
const sameScope = (a: SlackScope, b: SlackScope): boolean => a.teamId === b.teamId && a.userId === b.userId;
const invalid = (): never => {
  throw new MessengerError("slack thread ledger has invalid data", 0);
};
const object = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : invalid();
const threadOf = (value: unknown): LedgerThread => {
  const row = object(value);
  const { channel, rootTs, seenTs } = row;
  if (
    typeof channel !== "string" ||
    !channel ||
    typeof rootTs !== "string" ||
    !rootTs ||
    typeof seenTs !== "string" ||
    !seenTs
  )
    return invalid();
  return { channel, rootTs, seenTs };
};

/** Slack's authenticated user is the authority; this does not introduce an owner filter or tenant boundary. */
export class ThreadLedger {
  constructor(
    private readonly file: string,
    private readonly wait: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
  ) {}

  private read(): State {
    const state: State = { threads: new Map(), legacy: [] };
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return state;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) {
      state.legacy = value.map(threadOf);
      return state;
    }
    const doc = object(value);
    if (doc["version"] !== 2 || !Array.isArray(doc["threads"])) return invalid();
    for (const value of doc["threads"]) {
      const row = object(value);
      const identity = object(row["scope"]);
      const scope = slackScope(identity["teamId"], identity["userId"]);
      const thread = { ...threadOf(row), scope };
      const key = keyOf(scope, thread.channel, thread.rootTs);
      if (state.threads.has(key)) return invalid();
      state.threads.set(key, thread);
    }
    if (doc["adopted"] !== undefined) {
      const receipt = object(doc["adopted"]);
      const identity = object(receipt["scope"]);
      const { at, count } = receipt;
      if (
        typeof at !== "string" ||
        !Number.isFinite(Date.parse(at)) ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count <= 0
      )
        return invalid();
      state.adopted = { scope: slackScope(identity["teamId"], identity["userId"]), at, count };
    }
    return state;
  }

  private scoped(): State {
    const state = this.read();
    if (state.legacy.length)
      throw new MessengerError(
        "unscoped Slack threads: confirm their account, then run dori inbound slack --adopt-legacy-threads WORKSPACE:ACCOUNT",
        0,
      );
    return state;
  }

  /** Check before posting: legacy records must never be silently assigned to the current token's account. */
  assertScoped(): void {
    this.scoped();
  }

  /** Readers always reload; writers serialize the read/merge/atomic replace with the existing checkpoint lock. */
  private async lock(): Promise<() => void> {
    mkdirSync(dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    const fail = (message: string) => new MessengerError(`slack thread ledger lock ${message}`, 0);
    for (let waited = 0; ; waited += LOCK_RETRY_MS) {
      const held = takeLock(lock, Date.now(), fail);
      if (typeof held !== "string") return held;
      if (waited >= LOCK_WAIT_MS) throw new MessengerError(`slack thread ledger ${lock} stayed locked (${held})`, 0);
      await this.wait(LOCK_RETRY_MS);
    }
  }

  private save(state: State): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    // An envelope makes old array-only writers fail closed instead of dropping another account's rows.
    writeFileSync(
      tmp,
      JSON.stringify(
        { version: 2, threads: [...state.threads.values()], ...(state.adopted ? { adopted: state.adopted } : {}) },
        null,
        1,
      ),
    );
    renameSync(tmp, this.file);
  }

  private async update(change: (threads: Threads) => boolean): Promise<void> {
    const release = await this.lock();
    try {
      const state = this.scoped();
      if (change(state.threads)) this.save(state);
    } finally {
      release();
    }
  }

  /** Only an explicit operator decision can attach the old account-free array to an authenticated scope. */
  async adoptLegacy(scope: SlackScope): Promise<Adoption> {
    const release = await this.lock();
    try {
      const state = this.read();
      if (state.adopted) {
        if (!sameScope(state.adopted.scope, scope))
          throw new MessengerError("legacy Slack threads were already adopted by another account", 0);
        return state.adopted;
      }
      if (!state.legacy.length) throw new MessengerError("no unscoped Slack threads to adopt", 0);
      for (const thread of state.legacy) {
        const key = keyOf(scope, thread.channel, thread.rootTs);
        if (state.threads.has(key)) return invalid();
        state.threads.set(key, { ...thread, scope });
      }
      const receipt = { scope, at: new Date().toISOString(), count: state.legacy.length };
      state.adopted = receipt;
      state.legacy = [];
      this.save(state);
      return receipt;
    } finally {
      release();
    }
  }

  /** Later posts keep the receiver's position, so an earlier undelivered reply remains visible. */
  async record(scope: SlackScope, channel: string, rootTs: string, postedTs: string): Promise<void> {
    await this.update((threads) => {
      const key = keyOf(scope, channel, rootTs);
      if (threads.has(key)) return false;
      threads.set(key, { scope, channel, rootTs, seenTs: postedTs });
      return true;
    });
  }

  async markSeen(
    scope: SlackScope,
    updates: readonly { channel: string; rootTs: string; ts: string }[],
  ): Promise<void> {
    if (updates.length === 0) return;
    await this.update((threads) => {
      let changed = false;
      for (const { channel, rootTs, ts } of updates) {
        const key = keyOf(scope, channel, rootTs);
        const prev = threads.get(key);
        if (!prev || !tsAfter(ts, prev.seenTs)) continue;
        threads.set(key, { ...prev, seenTs: ts });
        changed = true;
      }
      return changed;
    });
  }

  async list(scope: SlackScope): Promise<LedgerThread[]> {
    return [...this.scoped().threads.values()]
      .filter((t) => sameScope(t.scope, scope))
      .map(({ channel, rootTs, seenTs }) => ({ channel, rootTs, seenTs }));
  }
}
