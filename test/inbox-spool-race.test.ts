import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { hostname } from "node:os";
import { sep } from "node:path";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import { drainForward, moveInbox } from "../src/migrate-inbox.ts";
import { Refusal } from "../src/refusal.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { removeJournal, writeJournal } from "../src/store-journal.ts";
import { href } from "./fake.ts";
import { quietLane } from "./harness-setup.ts";
import { setup } from "./inbox-setup.ts";

const OLD = href("w1:p2");
const NEW = href("w1:p4");
const opts = { sleep: async () => {}, log: () => {} } as unknown as MigrateOpts;

afterEach(() => mock.restore());

const REAL = {
  existsSync: fs.existsSync,
  renameSync: fs.renameSync,
  appendFileSync: fs.appendFileSync,
  rmSync: fs.rmSync,
};

/**
 * The first call of fs[name] whose path matches `hit` runs `first` before it goes on: another process's steps run
 * there (the caller was paused at that point), or `first` throws (the caller stopped there). Returns whether it ran.
 */
function onceAt(name: keyof typeof REAL, hit: (p: string) => boolean, first: () => void): () => boolean {
  const real = REAL[name] as (...a: unknown[]) => unknown;
  let armed = true;
  spyOn(fs, name).mockImplementation(((...a: unknown[]) => {
    if (armed && hit(String(a[0]))) {
      armed = false;
      first();
    }
    return real(...a);
  }) as never);
  return () => !armed;
}

/**
 * Steps (6)-(8) of a migration moving `from`'s inbox to `to`, as swapAgent runs them under its journal (no flush of
 * either session meanwhile): move, `between` (the switch), then the final drain that removes the marker; a drain that
 * finds a lock held tries again once the move is done.
 */
function migrateInbox(d: Deps, from: SessionRef, to: SessionRef, between = () => {}): Promise<unknown> {
  writeJournal(d.store.root, { name: "m", kind: "role", phase: "opened", from, to: "herdr", newRef: to, at: d.now() });
  const moved = moveInbox(d, from, to, opts);
  between();
  const drained = drainForward(d, from, to, { ...opts, sleep: () => moved });
  return Promise.all([moved, drained]).then(() => removeJournal(d.store.root, "m"));
}

/** Another live process holding the route of ref's inbox (the lock a send holds from finding its inbox to writing). */
function holdRoute(d: Deps, ref: SessionRef): () => void {
  const path = `${d.store.inboxPath(ref)}.route`;
  fs.writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), at: d.now() }));
  return () => fs.rmSync(path);
}

const texts = (d: Deps, ref: SessionRef) => d.store.queued(ref).map((m) => m.text);

describe("a send to a session whose inbox a migration moves meanwhile reaches the new session", () => {
  test("paused after finding no forward marker, before taking the lock: delivered on the new session", async () => {
    const s = setup();
    const next = s.w.addPane("w1:p4", "idle");
    let migrated: Promise<unknown> = Promise.resolve();
    const paused = onceAt(
      "existsSync",
      (p) => p === `${s.d.store.inboxPath(OLD)}.forward`,
      () => {
        migrated = migrateInbox(s.d, OLD, NEW);
      },
    );
    await s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "late" }, false);
    expect(paused()).toBe(true);
    await migrated;
    await dutyTick(s.d);
    expect({ old: s.pane.received, new: next.received }).toEqual({ old: [], new: ["late"] });
    expect(s.d.store.inboxPanes()).toEqual([]);
  });

  test("spooled while a flush held the old lock, paused before publishing: delivered on the new session", async () => {
    const s = setup();
    const next = s.w.addPane("w1:p4", "idle");
    const release = s.d.store.lockInbox(OLD, s.d.now())!;
    let migrated: Promise<unknown> = Promise.resolve();
    const paused = onceAt(
      "renameSync",
      (p) => p.startsWith(`${s.d.store.inboxPath(OLD)}.spool${sep}`) && p.endsWith(".tmp"),
      () => {
        release();
        migrated = migrateInbox(s.d, OLD, NEW);
      },
    );
    await s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "late" }, false);
    expect(paused()).toBe(true);
    await migrated;
    await dutyTick(s.d);
    expect({ old: s.pane.received, new: next.received }).toEqual({ old: [], new: ["late"] });
    expect(s.d.store.inboxPanes()).toEqual([]);
  });

  test("a LOST notice for a lead moved while duty was writing it reaches the new lead, once", async () => {
    const { w, d, lane, lead } = await quietLane();
    const lead2 = w.addPane("w1:p4", "idle");
    let migrated: Promise<unknown> = Promise.resolve();
    w.panes.delete(lane.paneId);
    // The pass probes the lane, finds it gone and resolves the lead's inbox for the LOST notice: the lead moves then.
    let probed = false;
    const get = w.panes.get.bind(w.panes);
    spyOn(w.panes, "get").mockImplementation((id) => {
      if (id === lane.paneId) probed = true;
      return get(id);
    });
    const paused = onceAt(
      "existsSync",
      (p) => probed && p === `${d.store.inboxPath(href("w1:p1"))}.forward`,
      () => {
        migrated = migrateInbox(d, href("w1:p1"), NEW, () => d.store.setRole("lead", NEW));
      },
    );
    await dutyTick(d);
    expect(paused()).toBe(true);
    await migrated;
    await dutyTick(d);
    await dutyTick(d);
    expect(lead.received).toEqual([]);
    expect(lead2.received.join("\n").split("[LOST talker]")).toHaveLength(2);
  });

  test("a send waits while a migration holds the old inbox's route, then goes where the marker it wrote points", async () => {
    const s = setup();
    const route = holdRoute(s.d, OLD);
    const waits = spyOn(Bun, "sleep").mockImplementation(async () => {
      route();
      await moveInbox(s.d, OLD, NEW, opts);
    });
    await s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "waited" }, false);
    expect(waits).toHaveBeenCalledTimes(1);
    expect({ old: texts(s.d, OLD), new: texts(s.d, NEW) }).toEqual({ old: [], new: ["waited"] });
  });

  test("a send whose route stays held is refused and queues nothing", async () => {
    const s = setup();
    holdRoute(s.d, OLD);
    spyOn(Bun, "sleep").mockImplementation(async () => {});
    await expect(send(s.d, "w1:p2", "refused", "cli")).rejects.toBeInstanceOf(Refusal);
    expect(s.d.store.inboxPanes()).toEqual([]);
    expect(s.pane.received).toEqual([]);
  });
});

describe("a spooled message moved by a holder that stopped part way is queued exactly once", () => {
  /**
   * "same" queued, then "same" again at the same millisecond while another process held the lock: two messages. The
   * holder never let go (it died holding the lock, now judged stale), so the second still waits in the spool.
   */
  async function twoEqual() {
    const s = setup();
    const msg = { at: s.d.now(), from: "cli", text: "same" };
    await s.d.store.enqueue(OLD, msg, false);
    const lock = `${s.d.store.inboxPath(OLD)}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: hostname(), at: s.d.now() }));
    await s.d.store.enqueue(OLD, msg, false);
    fs.rmSync(lock);
    return s;
  }

  test("renamed aside, stopped before its append, beside an equal queued message: it is still added", async () => {
    const s = await twoEqual();
    onceAt(
      "appendFileSync",
      (p) => p === s.d.store.inboxPath(OLD),
      () => {
        throw new Error("stopped before the append");
      },
    );
    expect(() => s.d.store.lockInbox(OLD, s.d.now())).toThrow("stopped before the append");
    mock.restore();
    s.d.store.lockInbox(OLD, s.d.now())!();
    expect(texts(s.d, OLD)).toEqual(["same", "same"]);
    expect(fs.readdirSync(`${s.d.store.inboxPath(OLD)}.spool`)).toEqual([]);
  });

  test("appended, stopped before removing its file, beside an equal queued message: it is not added again", async () => {
    const s = await twoEqual();
    onceAt(
      "rmSync",
      (p) => p.endsWith(".moving"),
      () => {
        throw new Error("stopped before the remove");
      },
    );
    expect(() => s.d.store.lockInbox(OLD, s.d.now())).toThrow("stopped before the remove");
    mock.restore();
    s.d.store.lockInbox(OLD, s.d.now())!();
    expect(texts(s.d, OLD)).toEqual(["same", "same"]);
    expect(fs.readdirSync(`${s.d.store.inboxPath(OLD)}.spool`)).toEqual([]);
  });

  test("a migration carries both equal messages, the spooled one included, to the new inbox", async () => {
    const s = await twoEqual();
    await migrateInbox(s.d, OLD, NEW);
    expect(texts(s.d, NEW)).toEqual(["same", "same"]);
  });
});
