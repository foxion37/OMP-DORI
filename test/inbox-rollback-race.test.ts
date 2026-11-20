import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import { moveBack, moveInbox } from "../src/migrate-inbox.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { href } from "./fake.ts";
import { setup } from "./inbox-setup.ts";

const OLD = href("w1:p2");
const NEW = href("w1:p4");
const opts = { sleep: async () => {}, log: () => {} } as unknown as MigrateOpts;
const REAL_RM = fs.rmSync;
const REAL_EXISTS = fs.existsSync;

afterEach(() => mock.restore());

/**
 * Runs `during` the first time moveBack removes the old inbox's `.forward` marker: the rollback holds the replacement's
 * inbox lock by then and has moved its spool into its queue once. Returns whether it ran.
 */
function atMarkerRemoval(d: Deps, during: () => void): () => boolean {
  let armed = true;
  spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
    if (armed && String(p) === `${d.store.inboxPath(OLD)}.forward`) {
      armed = false;
      during();
    }
    return REAL_RM(p, o);
  }) as never);
  return () => !armed;
}

const spooled = (d: Deps, ref: SessionRef): string[] => {
  try {
    return fs.readdirSync(`${d.store.inboxPath(ref)}.spool`);
  } catch {
    return [];
  }
};

describe("a rollback that puts the inbox back on the old session", () => {
  test("a send to the replacement after the rollback took its lock waits, then queues on that id; no spool is left", async () => {
    const s = setup();
    const next = s.w.addPane("w1:p4", "idle");
    await s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "first" }, false);
    await moveInbox(s.d, OLD, NEW, opts);
    // A wait for the route resolves at once, but only once the rollback in this thread has let go of it.
    const waits = spyOn(Bun, "sleep").mockImplementation(async () => {});
    let sent: Promise<unknown> = Promise.resolve();
    let during: unknown;
    const paused = atMarkerRemoval(s.d, () => {
      sent = s.d.store.enqueue(NEW, { at: s.d.now(), from: "cli", text: "late" }, false);
      during = { spool: spooled(s.d, NEW), queue: s.d.store.queued(NEW).map((m) => m.text) };
    });
    await moveBack(s.d, OLD, NEW, opts);
    expect(paused()).toBe(true);
    expect(during).toEqual({ spool: [], queue: ["first"] });
    expect(await sent).toEqual({ kind: "queued", at: NEW });
    expect(waits).toHaveBeenCalled();
    expect(spooled(s.d, NEW)).toEqual([]);
    expect(s.d.store.queued(OLD).map((m) => m.text)).toEqual(["first"]);
    waits.mockRestore();
    await dutyTick(s.d);
    // The rollback leaves nothing on the replacement's id: the session there now gets what is sent to it.
    expect({ old: s.pane.received, replacement: next.received }).toEqual({ old: ["first"], replacement: ["late"] });
  });

  test("a send to the replacement already writing when the rollback starts is waited for and goes back", async () => {
    const s = setup();
    s.w.addPane("w1:p4", "idle");
    await moveInbox(s.d, OLD, NEW, opts);
    // The sender holds the replacement's route and has found no marker on it; the rollback starts right then.
    let armed = true;
    let rolledBack: Promise<void> = Promise.resolve();
    spyOn(fs, "existsSync").mockImplementation(((p: fs.PathLike) => {
      if (armed && String(p) === `${s.d.store.inboxPath(NEW)}.forward`) {
        armed = false;
        rolledBack = moveBack(s.d, OLD, NEW, opts);
      }
      return REAL_EXISTS(p);
    }) as never);
    expect(await s.d.store.enqueue(NEW, { at: s.d.now(), from: "cli", text: "late" }, false)).toEqual({
      kind: "queued",
      at: NEW,
    });
    expect(armed).toBe(false);
    await rolledBack;
    expect({ spool: spooled(s.d, NEW), queue: s.d.store.queued(NEW) }).toEqual({ spool: [], queue: [] });
    await dutyTick(s.d);
    expect(s.pane.received).toEqual(["late"]);
  });
});
