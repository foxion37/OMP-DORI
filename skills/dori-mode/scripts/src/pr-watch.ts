/**
 * PR follow-up tracking: which pull requests `dori pr watch` keeps reading after their lane has moved on, and what it
 * has already seen on each. pr-watch.jsonl is the tracking record (one O_APPEND write per change, so the lead and a
 * lane's auto-tracking can write at once). pr-watch-state.json is the watcher's own cursor; only the watcher writes it.
 */
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export type PrRef = { readonly repo: string; readonly number: number };
export type TrackedPr = PrRef & {
  /** When this tracking began: the first track since the PR was last untracked. Its cursor carries the same time. */
  readonly since: string;
  /** The latest track; a PR the watcher saw close is read again when tracked after that. */
  readonly trackedAt: string;
  readonly source: string;
  readonly lane?: string;
  readonly thread?: string;
};
export type PrWatchEntry = {
  readonly since: string;
  readonly head: string;
  readonly commits: readonly string[];
  readonly seen: readonly string[];
  readonly state: "open" | "merged" | "closed";
  readonly polledAt: string;
  readonly closedAt?: string;
};
export type PrWatchState = Readonly<Record<string, PrWatchEntry>>;
type TrackEvent =
  | ({ readonly op: "track"; readonly at: string } & PrRef & {
        readonly source: string;
        readonly lane?: string;
        readonly thread?: string;
      })
  | ({ readonly op: "untrack"; readonly at: string } & PrRef);

export class PrWatchError extends Error {}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const validRepo = (repo: string): boolean => {
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((part) => NAME.test(part) && !/^\.+$/.test(part));
};
const prNumber = (text: string): number | undefined => {
  const n = Number(text);
  return /^[1-9][0-9]{0,9}$/.test(text) && Number.isSafeInteger(n) ? n : undefined;
};

/** `owner/repo#N` or a `https://github.com/owner/repo/pull/N` link (any trailing path, query or fragment). */
export const parsePrRef = (text: string): PrRef | undefined => {
  const m =
    /^([^/#\s]+\/[^/#\s]+)#(\d+)$/.exec(text.trim()) ??
    /^https:\/\/github\.com\/([^/#?\s]+\/[^/#?\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/.exec(text.trim());
  const number = m ? prNumber(m[2]!) : undefined;
  return m && number !== undefined && validRepo(m[1]!) ? { repo: m[1]!, number } : undefined;
};

/** Every pull-request link in free text, once each; `owner/repo#N` is not read here, since it may name an issue. */
export const prLinks = (text: string): PrRef[] => {
  const found = new Map<string, PrRef>();
  for (const m of text.matchAll(/https:\/\/github\.com\/[^/#?\s]+\/[^/#?\s]+\/pull\/\d+(?![\w-])/g)) {
    const ref = parsePrRef(m[0]);
    if (ref && !found.has(prKey(ref))) found.set(prKey(ref), ref);
  }
  return [...found.values()];
};

/** GitHub owner and repository names are case-insensitive, so one PR has one key however it was typed. */
export const prKey = (ref: PrRef): string => `${ref.repo.toLowerCase()}#${ref.number}`;
export const prName = (ref: PrRef): string => `${ref.repo}#${ref.number}`;

// One whitespace-free token for lane keys and thread refs: they are printed inside space-separated event lines.
// oxlint-disable-next-line no-control-regex -- the pattern deliberately matches control characters to reject them
export const UNSAFE = /[\s\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/;
export const isToken = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 200 && !UNSAFE.test(value);
const line = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 400 &&
  // oxlint-disable-next-line no-control-regex -- the pattern deliberately matches control characters to reject them
  !/[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(value);
const isoTime = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

const parseEvent = (value: unknown): TrackEvent => {
  const r = value as Record<string, unknown> | null;
  if (typeof r !== "object" || r === null || Array.isArray(r)) throw new PrWatchError("record must be a JSON object");
  const allowed = r["op"] === "track" ? ["source", "lane", "thread"] : r["op"] === "untrack" ? [] : undefined;
  if (!allowed) throw new PrWatchError('field "op" must be track or untrack');
  const unknown = Object.keys(r).find((name) => !["op", "at", "repo", "number", ...allowed].includes(name));
  if (unknown !== undefined) throw new PrWatchError(`unknown field "${unknown}"`);
  if (!isoTime(r["at"])) throw new PrWatchError('field "at" must be an ISO time as toISOString writes it');
  if (typeof r["repo"] !== "string" || !validRepo(r["repo"])) throw new PrWatchError('field "repo" must be owner/repo');
  if (!Number.isSafeInteger(r["number"]) || Number(r["number"]) < 1)
    throw new PrWatchError('field "number" must be a positive integer');
  if (r["op"] === "track" && !line(r["source"])) throw new PrWatchError('field "source" must be one line');
  for (const name of ["lane", "thread"])
    if (r[name] !== undefined && !isToken(r[name])) throw new PrWatchError(`field "${name}" must be one token`);
  return r as TrackEvent;
};

const RECORD_START = '{"op":"';
const isTorn = (text: string): boolean => text.startsWith(RECORD_START) || RECORD_START.startsWith(text);

export type TrackingRead = { readonly prs: TrackedPr[]; readonly problems: string[] };

export class PrTracking {
  readonly path: string;
  readonly statePath: string;

  constructor(readonly stateDir: string) {
    this.path = join(stateDir, "pr-watch.jsonl");
    this.statePath = join(stateDir, "pr-watch-state.json");
  }

  read(): TrackingRead {
    const prs = new Map<string, TrackedPr>();
    const problems: string[] = [];
    const text = existsSync(this.path) ? readFileSync(this.path, "utf8") : "";
    for (const [index, raw] of text.split("\n").entries()) {
      if (!raw.trim()) continue;
      try {
        const event = parseEvent(JSON.parse(raw));
        const { op: _op, at, ...rest } = event;
        const since = prs.get(prKey(event))?.since ?? at;
        if (event.op === "untrack") prs.delete(prKey(event));
        else prs.set(prKey(event), { ...(rest as Omit<TrackedPr, "since" | "trackedAt">), since, trackedAt: at });
      } catch (error) {
        if (error instanceof SyntaxError && isTorn(raw)) continue; // a write cut off halfway
        if (!(error instanceof SyntaxError || error instanceof PrWatchError)) throw error;
        problems.push(`${this.path}:${index + 1}: ${error.message}`);
      }
    }
    return { prs: [...prs.values()], problems };
  }

  /**
   * Track one PR, or track it again: a new lane or thread replaces the old one, and a PR the watcher saw close is read
   * once more. The tracking (and its cursor) carries on; only an untrack ends it.
   */
  track(ref: PrRef, from: { source: string; lane?: string; thread?: string }, now: number): TrackedPr {
    this.append({ op: "track", at: new Date(now).toISOString(), repo: ref.repo, number: ref.number, ...from });
    return this.read().prs.find((pr) => prKey(pr) === prKey(ref)) ?? this.lost(ref);
  }

  /** The tracking it ended, or undefined when the PR was not tracked. */
  untrack(ref: PrRef, now: number): TrackedPr | undefined {
    const current = this.read().prs.find((pr) => prKey(pr) === prKey(ref));
    if (current) this.append({ op: "untrack", at: new Date(now).toISOString(), repo: ref.repo, number: ref.number });
    return current;
  }

  /** The watcher's cursor; a file that cannot be read is an error, never an empty state that would re-baseline. */
  loadState(): Record<string, PrWatchEntry> {
    if (!existsSync(this.statePath)) return {};
    let value: { version?: unknown; prs?: unknown } | null;
    try {
      value = JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new PrWatchError(`${this.statePath}: ${error.message}`);
    }
    if (value?.version !== 1 || typeof value.prs !== "object" || value.prs === null || Array.isArray(value.prs))
      throw new PrWatchError(`${this.statePath}: not a pr-watch state file`);
    const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
    for (const [key, raw] of Object.entries(value.prs)) {
      const e = raw as Partial<Record<keyof PrWatchEntry, unknown>> | null;
      if (
        !isoTime(e?.since) ||
        typeof e?.head !== "string" ||
        !strings(e.commits) ||
        !strings(e.seen) ||
        !["open", "merged", "closed"].includes(e.state as string) ||
        !isoTime(e.polledAt) ||
        (e.closedAt !== undefined && !isoTime(e.closedAt))
      )
        throw new PrWatchError(`${this.statePath}: damaged entry ${JSON.stringify(key)}`);
    }
    return value.prs as Record<string, PrWatchEntry>;
  }

  saveState(prs: PrWatchState): void {
    mkdirSync(this.stateDir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, `${JSON.stringify({ version: 1, prs }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.statePath);
    } finally {
      rmSync(tmp, { force: true });
    }
  }

  private lost(ref: PrRef): never {
    throw new PrWatchError(`${prName(ref)} did not read back from ${this.path}`);
  }

  private append(event: TrackEvent): void {
    parseEvent(event);
    mkdirSync(this.stateDir, { recursive: true });
    const fd = openSync(this.path, "a+", 0o600);
    try {
      // A writer that stopped mid-record left no newline: start on a fresh line so only the torn line is damaged.
      const size = fstatSync(fd).size;
      const last = Buffer.alloc(1);
      const torn = size > 0 && readSync(fd, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
      writeSync(fd, `${torn ? "\n" : ""}${JSON.stringify(event)}\n`);
    } finally {
      closeSync(fd);
    }
  }
}
