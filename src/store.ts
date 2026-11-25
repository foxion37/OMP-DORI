import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendQueue,
  doneIds,
  inboxFile,
  markDone,
  pendingQueue,
  queuedRefs,
  readQueue,
  spooled,
  writeQueue,
} from "./inbox-files.ts";
import { lockQueue, mergeOwnSpool, type Queued, queueMessage } from "./inbox-spool.ts";
import type { SessionRef } from "./runtime/types.ts";
import { RootLaneStore, rootStoreHome } from "./store-lanes.ts";
import { readRoles, registerRole, removeRoles } from "./store-roles.ts";
import {
  KEEP_RUNS,
  KEY_RE,
  type Item,
  type LoopRun,
  type QueuedMessage,
  type ReviewReceipt,
  type Role,
} from "./store-types.ts";

export type { HostLoad } from "./store-types.ts";

const checkedId = (id: string): string => {
  if (!KEY_RE.test(id)) throw new Error(`invalid id ${JSON.stringify(id)}: must match ${KEY_RE}`);
  return id;
};

export class Store extends RootLaneStore {
  constructor(root: string = rootStoreHome()) {
    super(root);
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

  roles(): Partial<Record<Role, SessionRef>> {
    return readRoles(this.root);
  }
  setRole(role: Role, ref: SessionRef): void {
    registerRole(this.root, role, ref);
  }
  clearRoles(expected: readonly [Role, SessionRef][]): void {
    removeRoles(this.root, expected);
  }

  briefPath(key: string): string {
    return join(this.root, "briefs", `${key}.md`);
  }

  inboxPath(ref: SessionRef): string {
    return inboxFile(this.root, ref);
  }

  /**
   * Appends under its lock to the inbox of `ref` (inbox-spool.ts),
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

  /** True when entries are spooled beside ref's queue, waiting for the holder of its lock to move them in. */
  mergePending(ref: SessionRef): boolean {
    return spooled(this.inboxPath(ref), true).length > 0;
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
