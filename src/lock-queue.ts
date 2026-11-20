import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { takeFile } from "./lock-claim.ts";
import { OWNERLESS_MS, type OwnerEnv, tryTake } from "./lock-owner.ts";
import { Refusal } from "./refusal.ts";

/**
 * Waiters queue for a lock directory (lock-owner.ts): each writes a ticket into `<root>/state/locks/<name>/`, and only
 * the head (lowest priority number, then first in line) tries the directory. Putting a ticket in line, and the head's
 * check that it is the head followed by its attempt, each run under the queue's guard file `.guard` there, so no ticket
 * joins between a head's check and its take. A shell waiter still tries the directory on its own and may win a free
 * lock; it is never turned away.
 */
export type LockEnv = OwnerEnv & {
  /** One retry interval (RETRY_MS in production). */
  sleep: () => Promise<void>;
};

/** `seq` is the ticket's place in line among the tickets present when it joined: one past the highest of them. */
export type Ticket = { id: string; lane: string; pid: number; at: number; priority: number; seq: number };

export const RETRY_MS = 2_000;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const GUARD = ".guard";

/** A lock name: a letter or digit, then letters, digits, `_`, `.` or `-`, at most 64 in all. */
export const lockName = (name: string): boolean => NAME_RE.test(name);

export function checkName(name: string): string {
  if (!lockName(name)) throw new Refusal(`lock name must match ${NAME_RE}`);
  return name;
}

/** A priority as given: 1 (first) to 9 (last), 5 when none is. Backlog items, lanes and lock waiters share it. */
export function checkPriority(p: number | undefined): number {
  const priority = p ?? 5;
  if (!Number.isInteger(priority) || priority < 1 || priority > 9)
    throw new Refusal("--priority must be 1 (first) to 9 (last)");
  return priority;
}

export const queueDir = (root: string, name: string): string => join(root, "state", "locks", name);

const order = (a: Ticket, b: Ticket): number => a.priority - b.priority || a.seq - b.seq;

/** A ticket as writeTicket writes it; other JSON in the queue dir is not one and is never removed. */
const isTicket = (t: unknown): t is Omit<Ticket, "id"> => {
  const v = (t ?? {}) as Partial<Record<keyof Ticket, unknown>>;
  return (
    typeof v.lane === "string" &&
    (["pid", "at", "priority", "seq"] as const).every((k) => Number.isInteger(v[k])) &&
    (v.pid as number) > 0
  );
};

/** The queue in turn order. Tickets of dead waiters are removed; a file that is not a whole ticket is skipped. */
export function tickets(env: LockEnv, name: string): Ticket[] {
  const dir = queueDir(env.root, name);
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const live: Ticket[] = [];
  for (const f of files) {
    let t: unknown;
    try {
      t = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      continue;
    }
    if (!isTicket(t)) continue;
    if (env.alive(t.pid)) live.push({ ...t, id: f.slice(0, -5) });
    else rmSync(join(dir, f), { force: true });
  }
  return live.sort(order);
}

// Written whole under another name and renamed, so a reader never sees half a ticket.
const writeTicket = (dir: string, t: Ticket): void => {
  const { id, ...body } = t;
  writeFileSync(join(dir, `${id}.tmp`), JSON.stringify(body));
  renameSync(join(dir, `${id}.tmp`), join(dir, `${id}.json`));
};

/** Puts a new ticket last among its priority; the caller holds the guard. */
function publish(env: LockEnv, name: string, lane: string, priority: number): Ticket {
  const seq = Math.max(0, ...tickets(env, name).map((t) => t.seq)) + 1;
  const t: Ticket = {
    id: `${seq}-${env.pid}-${randomUUID().slice(0, 8)}`,
    lane,
    pid: env.pid,
    at: env.now(),
    priority,
    seq,
  };
  writeTicket(queueDir(env.root, name), t);
  return t;
}

/** Runs `step` holding the guard of queue `name`; undefined while another live waiter holds it. */
function guarded<T>(env: LockEnv, name: string, step: () => T): { done: T } | undefined {
  mkdirSync(queueDir(env.root, name), { recursive: true });
  const free = takeFile(env, join(queueDir(env.root, name), GUARD), OWNERLESS_MS);
  if (!free) return undefined;
  try {
    return { done: step() };
  } finally {
    free();
  }
}

/** Puts a ticket in line: the ticket, or undefined while another waiter holds the queue's guard. */
export function enqueue(env: LockEnv, name: string, lane: string, priority: number): Ticket | undefined {
  return guarded(env, name, () => publish(env, name, lane, priority))?.done;
}

/**
 * Queues, waits for this ticket's turn and takes the lock: its owner line, or undefined once `stop` aborts (the
 * ticket is withdrawn either way). A line goes to `log` whenever what it waits on changes.
 */
export async function take(
  env: LockEnv,
  name: string,
  lane: string,
  priority: number,
  stop: AbortSignal,
  log: (line: string) => void = () => {},
): Promise<string | undefined> {
  const { promise: stopped, resolve } = Promise.withResolvers<void>();
  stop.addEventListener("abort", () => resolve(), { once: true });
  let mine: Ticket | undefined;
  let said = "";
  try {
    while (!stop.aborted) {
      const turn = guarded(env, name, (): { owner: string } | { waiting: string } => {
        mine ??= publish(env, name, lane, priority);
        const queue = tickets(env, name);
        const at = queue.findIndex((t) => t.id === mine!.id);
        if (at < 0) writeTicket(queueDir(env.root, name), mine);
        if (at !== 0)
          return { waiting: `${at < 0 ? queue.length + 1 : at + 1} in line after ${queue[0]?.lane ?? "?"}` };
        const got = tryTake(env, name, lane, log);
        return "owner" in got ? got : { waiting: `held by ${got.busy}` };
      })?.done;
      if (turn && "owner" in turn) return turn.owner;
      if (turn && turn.waiting !== said) log(`LOCK ${name}: waiting (p${priority}), ${turn.waiting}`);
      if (turn) said = turn.waiting;
      await Promise.race([env.sleep(), stopped]);
    }
    return undefined;
  } finally {
    if (mine) rmSync(join(queueDir(env.root, name), `${mine.id}.json`), { force: true });
  }
}
