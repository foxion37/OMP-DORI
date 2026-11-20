import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import type { Deps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import { inboxList, releaseHeld, sendToShell } from "../src/inbox-held.ts";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import { drainForward, moveBack, moveInbox } from "../src/migrate-inbox.ts";
import { href } from "./fake.ts";
import { quietLane } from "./harness-setup.ts";
import { setup } from "./inbox-setup.ts";

// A finished migration leaves no redirect behind: herdr pane ids and hc terminal ids are used again for new sessions,
// so a session id that a migration moved away from may name an unrelated session later. A name a sender resolved
// before the migration (a lane key, a role) is resolved again under the route instead.

const OLD = href("w1:p2");
const NEW = href("w1:p4");
const opts = { sleep: async () => {}, log: () => {} } as unknown as MigrateOpts;
const REAL_WRITE = fs.writeFileSync;

afterEach(() => mock.restore());

async function migrated(d: Deps, from = OLD, to = NEW) {
  await moveInbox(d, from, to, opts);
  await drainForward(d, from, to, opts);
}

describe("a session id used again after a migration moved its inbox away", () => {
  test("a send to the reused id reaches the session now at that id, not the replacement", async () => {
    const s = setup();
    const next = s.w.addPane(NEW.id, "idle");
    await migrated(s.d);
    expect(await send(s.d, OLD.id, "for the new pane", "cli")).toBe("DELIVERED");
    expect({ reused: s.pane.received, replacement: next.received }).toEqual({
      reused: ["for the new pane"],
      replacement: [],
    });
  });

  test("inbox list and ack of the reused id act on its own queue", async () => {
    const s = setup();
    s.w.addPane(NEW.id, "working");
    await migrated(s.d);
    s.d.store.saveInbox(NEW, [{ at: 1, from: "cli", text: "the replacement's" }]);
    s.d.store.saveInbox(OLD, [{ at: 2, from: "cli", text: "held", attempt: { at: 2, state: "ambiguous" } }]);
    expect(inboxList(s.d, OLD.id)).toMatchObject({ paneId: OLD.id, entries: [{ state: "held" }] });
    expect(releaseHeld(s.d, OLD.id, 1, "ack")).toBe(OLD.id);
    expect(s.d.store.queued(OLD)).toEqual([]);
    expect(s.d.store.queued(NEW).map((m) => m.text)).toEqual(["the replacement's"]);
  });

  test("after a rollback, a send to the replacement's id, used again, reaches the session at that id", async () => {
    const s = setup();
    const next = s.w.addPane(NEW.id, "idle");
    await moveInbox(s.d, OLD, NEW, opts);
    await moveBack(s.d, OLD, NEW, opts);
    expect(await send(s.d, NEW.id, "for the reused id", "cli")).toBe("DELIVERED");
    expect({ old: s.pane.received, reused: next.received }).toEqual({ old: [], reused: ["for the reused id"] });
  });

  test("a migration there and back leaves no redirect: each id keeps its own messages", async () => {
    const s = setup();
    s.w.addPane(NEW.id, "working");
    s.pane.status = "working";
    await migrated(s.d);
    await migrated(s.d, NEW, OLD);
    await s.d.store.enqueue(OLD, { at: 2, from: "cli", text: "old id" }, false);
    await s.d.store.enqueue(NEW, { at: 2, from: "cli", text: "new id" }, false);
    expect({ old: s.d.store.queued(OLD).map((m) => m.text), new: s.d.store.queued(NEW).map((m) => m.text) }).toEqual({
      old: ["old id"],
      new: ["new id"],
    });
    expect(fs.readdirSync(`${s.d.store.root}/inbox`).filter((f) => /\.(forward|migrated)$/.test(f))).toEqual([]);
  });
});

describe("a name resolved before a migration or a switch finished is resolved again under the route", () => {
  test("a nudge for a lane migrated between the pass reading it and writing the nudge reaches the new session", async () => {
    const s = await quietLane();
    const old = s.lane.sessionRef;
    const next = s.w.addPane(NEW.id, "idle");
    const route = `${s.d.store.inboxPath(old)}.route`;
    let armed = true;
    // Right before the pass takes the old session's route, the whole migration runs: inbox moved, record switched,
    // redirect drained and removed.
    spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (armed && String(file) === route) {
        armed = false;
        void moveInbox(s.d, old, NEW, opts);
        s.d.store.saveLane({ ...s.d.store.lane("talker")!, sessionRef: NEW, migratedFrom: [old] });
        void drainForward(s.d, old, NEW, opts);
      }
      return (REAL_WRITE as (...a: unknown[]) => unknown)(file, ...rest);
    }) as never);
    await s.at(10);
    mock.restore();
    expect(armed).toBe(false);
    expect(s.d.store.queued(old)).toEqual([]);
    expect({ old: s.pane.received.length, new: next.received.length }).toEqual({ old: 0, new: 1 });
  });

  test("dori send --to-shell to a lane whose record switched before the message was queued queues it there", async () => {
    const s = await quietLane();
    const old = s.lane.sessionRef;
    s.w.addPane(NEW.id, "working");
    s.pane.status = "shell";
    // The first probe sees the shell; before typing, the lane's record switches and an agent appears in the old pane.
    let probes = 0;
    s.w.getHook.set(old.id, () => {
      if (++probes === 2) {
        s.d.store.saveLane({ ...s.d.store.lane("talker")!, sessionRef: NEW, migratedFrom: [old] });
        s.pane.status = "working";
      }
    });
    expect(await sendToShell(s.d, "talker", "shell note", "cli")).toBe("QUEUED");
    expect(s.d.store.queued(old)).toEqual([]);
    expect(s.d.store.queued(NEW).map((m) => m.text)).toEqual(["shell note"]);
  });
});
