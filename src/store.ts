import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  appendQueue,
  doneIds,
  inboxFile,
  markDone,
  pendingQueue,
  queuedRefs,
  readQueue,
  writeQueue,
} from "./inbox-files.ts";
import { mergeForwarded, mergePending } from "./inbox-forward.ts";
import { destinationOf, lockQueue, mergeOwnSpool, type Queued, queueMessage } from "./inbox-spool.ts";
import { refFromText, refText, sameSession } from "./refs.ts";
import type { SessionRef } from "./runtime/types.ts";
import {
  KEEP_RUNS,
  KEY_RE,
  type Item,
  type Lane,
  type LoopRun,
  type QueuedMessage,
  type ReviewReceipt,
  type Role,
} from "./store-types.ts";

export type { HostLoad } from "./store-types.ts";

/** A lane file as any binary wrote it: one from before runtimes existed has no `sessionRef`. */
type StoredLane = Omit<Lane, "sessionRef"> & { sessionRef?: SessionRef };

/** Reads a record without `sessionRef` as the herdr pane it names; the same input always gives the same lane. */
const upgrade = (raw: StoredLane): Lane =>
  raw.sessionRef !== undefined
    ? (raw as Lane)
    : { ...raw, sessionRef: { runtime: "herdr", id: raw.paneId, ...(raw.tabId ? { container: raw.tabId } : {}) } };

const checkedId = (id: string): string => {
  if (!KEY_RE.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}: must match ${KEY_RE}`);
  return id;
};

export class Store {
  constructor(readonly root: string = process.env["DORI_HOME"] ?? join(homedir(), ".dori")) {
    for (const d of ["lanes", "inbox", "briefs", "receipts", "backlog", "loop/runs", "duty"])
      mkdirSync(join(root, d), { recursive: true });
  }

  private readJson<T>(path: string): T | undefined {
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : undefined;
  }

  private writeJson(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
  }

  lane(key: string): Lane | undefined {
    const raw = this.readJson<StoredLane>(join(this.root, "lanes", `${key}.json`));
    return raw && upgrade(raw);
  }

  /** Writes `paneId`/`tabId` from `sessionRef` beside it, so an older binary still reads the record. */
  saveLane(lane: Lane): void {
    const { id, container } = lane.sessionRef;
    this.writeJson(join(this.root, "lanes", `${lane.key}.json`), { ...lane, paneId: id, tabId: container ?? "" });
  }

  lanes(): Lane[] {
    return readdirSync(join(this.root, "lanes"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson<StoredLane>(join(this.root, "lanes", f)))
      .filter((l): l is StoredLane => l !== undefined)
      .map(upgrade)
      .sort((a, b) => a.createdAt - b.createdAt || a.key.localeCompare(b.key));
  }

  laneBySession(ref: SessionRef): Lane | undefined {
    return this.lanes().find((l) => sameSession(l.sessionRef, ref) && l.status !== "done");
  }

  /** roles.json holds ref strings (refText), so an older binary still parses it; a bare value is a herdr pane. */
  roles(): Partial<Record<Role, SessionRef>> {
    const raw = this.readJson<Partial<Record<Role, string>>>(join(this.root, "roles.json")) ?? {};
    return Object.fromEntries(Object.entries(raw).map(([role, text]) => [role, refFromText(text)]));
  }

  setRole(role: Role, ref: SessionRef): void {
    const raw = this.readJson<Partial<Record<Role, string>>>(join(this.root, "roles.json")) ?? {};
    this.writeJson(join(this.root, "roles.json"), { ...raw, [role]: refText(ref) });
  }

  briefPath(key: string): string {
    return join(this.root, "briefs", `${key}.md`);
  }

  inboxPath(ref: SessionRef): string {
    return inboxFile(this.root, ref);
  }

  /**
   * Appends under its lock to the inbox `ref` resolves to (the live redirect of a running migration, inbox-spool.ts),
   * or keeps it for the logical lead role (`namedLead`), independent of the current role/session mapping. `recheck`
   * is the sender's name resolved again under the route (a lane or role that switched meanwhile).
   */
  enqueue(ref: SessionRef, msg: QueuedMessage, namedLead: boolean, recheck?: () => SessionRef): Promise<Queued> {
    return queueMessage(this.root, ref, msg, namedLead, recheck);
  }

  /**
   * Queues a duty notice on `inbox` (a destination, its lock held) unless the same id is queued there or left that queue
   * before (`<inbox>.ids`): a duty pass cut short after queueing it queues it again on the next pass. Returns false when
   * it was not queued.
   */
  enqueueOnce(inbox: SessionRef, msg: QueuedMessage & { id: string }): boolean {
    const path = this.inboxPath(inbox);
    if (doneIds(path).has(msg.id) || readQueue(path).some((m) => m.id === msg.id)) return false;
    appendQueue(path, msg);
    return true;
  }

  /** The queue without entries whose id is recorded as gone (`<inbox>.ids`). */
  queued(ref: SessionRef): QueuedMessage[] {
    return pendingQueue(this.inboxPath(ref));
  }

  /** Rewrites the queue (inbox lock held). The ids of `gone` are recorded first and commit it; the spool moves in after. */
  saveInbox(ref: SessionRef, msgs: readonly QueuedMessage[], gone: readonly QueuedMessage[] = []): void {
    markDone(this.inboxPath(ref), gone);
    writeQueue(this.inboxPath(ref), msgs);
    mergeOwnSpool(this.root, ref);
  }

  /** Where the inbox of `ref` lives now: the session the `.forward` chain of a running migration ends at. */
  destination(ref: SessionRef): SessionRef {
    return destinationOf(this.root, ref);
  }

  /** True when entries wait to be moved into ref's queue: spooled beside it, or in old inboxes forwarded into it. */
  mergePending(ref: SessionRef): boolean {
    return mergePending(this.root, ref);
  }

  /** Merges old inboxes forwarded into `ref` into its inbox; call it under ref's inbox lock. */
  mergeForwarded(ref: SessionRef): void {
    mergeForwarded(this.root, ref);
  }

  /**
   * The session's inbox lock (`<inbox>.lock`, inbox-lock.ts), or undefined while another process holds it. Taking it
   * moves the spool into the queue, and so does letting go: a message spooled meanwhile is never left behind.
   */
  lockInbox(ref: SessionRef, now: number): (() => void) | undefined {
    return lockQueue(this.root, ref, now);
  }

  /** Sessions with queued or spooled messages. */
  inboxPanes(): SessionRef[] {
    return queuedRefs(this.root);
  }

  private receiptPath(pr: string, sha: string): string {
    return join(this.root, "receipts", `${pr.replaceAll("/", "__").replace("#", "_")}@${sha}.json`);
  }

  saveReceipt(r: ReviewReceipt): void {
    this.writeJson(this.receiptPath(r.pr, r.sha), r);
  }

  receipt(pr: string, sha: string): ReviewReceipt | undefined {
    return this.readJson(this.receiptPath(pr, sha));
  }

  // ---------- backlog ----------

  itemBrief(id: string): string {
    return join(this.root, "backlog", `${checkedId(id)}.md`);
  }

  item(id: string): Item | undefined {
    return this.readJson<Item>(join(this.root, "backlog", `${checkedId(id)}.json`));
  }

  saveItem(item: Item): void {
    this.writeJson(join(this.root, "backlog", `${checkedId(item.id)}.json`), item);
  }

  items(): Item[] {
    return readdirSync(join(this.root, "backlog"))
      .filter((f) => f.endsWith(".json"))
      .map((f) => this.readJson<Item>(join(this.root, "backlog", f)))
      .filter((i): i is Item => i !== undefined)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  // ---------- hourly loop ----------

  loopPath(name: string): string {
    return join(this.root, "loop", name);
  }

  /** The single-instance lock of the hourly loop (`loop/lock`) or of the duty loop (`duty/lock`). */
  lockPath(of: "loop" | "duty"): string {
    return join(this.root, of, "lock");
  }

  /** The kill switch of the hourly loop (`loop/stop`) or of the duty loop (`duty/stop`). */
  stop(of: "loop" | "duty" = "loop"): { at: number; reason: string } | undefined {
    return this.readJson(join(this.root, of, "stop"));
  }

  setStop(at: number, reason: string, of: "loop" | "duty" = "loop"): void {
    this.writeJson(join(this.root, of, "stop"), { at, reason });
  }

  clearStop(of: "loop" | "duty" = "loop"): void {
    rmSync(join(this.root, of, "stop"), { force: true });
  }

  lastRun(): LoopRun | undefined {
    return this.readJson(this.loopPath("last-run.json"));
  }

  /** Writes the run record and the last-run stamp, keeping the newest KEEP_RUNS records. Pass `name` to rewrite a record. */
  saveRun(run: LoopRun, name?: string): string {
    const dir = this.loopPath("runs");
    if (name === undefined) {
      const stem = new Date(run.at).toISOString().replaceAll(":", "-");
      name = `${stem}.json`;
      for (let n = 2; existsSync(join(dir, name)); n++) name = `${stem}-${n}.json`;
    }
    this.writeJson(join(dir, name), run);
    this.writeJson(this.loopPath("last-run.json"), run);
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) rmSync(join(dir, f), { force: true });
    return name;
  }

  runs(): string[] {
    return readdirSync(this.loopPath("runs"))
      .filter((f) => f.endsWith(".json"))
      .sort();
  }
}
