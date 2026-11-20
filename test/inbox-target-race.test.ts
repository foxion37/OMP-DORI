import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { send } from "../src/inbox.ts";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import { drainForward, moveInbox } from "../src/migrate-inbox.ts";
import { href } from "./fake.ts";
import { quietLane } from "./harness-setup.ts";

// A send resolves its target (a lane key) to a session, then takes that session's route. A migration that runs in
// between moves the inbox: the route the sender then takes belongs to the old inbox, whose marker the migration has
// already removed, so the message is queued for a session that is never flushed and the send still says QUEUED
// (inbox-lock-order.md rule 1: re-resolve the destination under the route, and follow the redirect).

const NEW = href("w1:p4");
const opts = { sleep: async () => {}, log: () => {} } as unknown as MigrateOpts;

afterEach(() => mock.restore());

describe("a send to a lane key whose session is migrated while the name resolves", () => {
  test("the message reaches the new session, and nothing is left in the old inbox", async () => {
    const s = await quietLane();
    const old = s.lane.sessionRef;
    const next = s.w.addPane("w1:p4", "idle");
    let migrated: Promise<unknown> = Promise.resolve();
    // The lane record is read next by the sender; the whole migration runs there, marker removed and all.
    let armed = true;
    const realLane = s.d.store.lane.bind(s.d.store);
    spyOn(s.d.store, "lane").mockImplementation(((key: string) => {
      if (armed) {
        armed = false;
        const lane = realLane(key);
        migrated = (async () => {
          await moveInbox(s.d, old, NEW, opts);
          await drainForward(s.d, old, NEW, opts);
          s.d.store.saveLane({ ...realLane(key)!, sessionRef: NEW, migratedFrom: [old] });
          return lane;
        })();
        return lane;
      }
      return realLane(key);
    }) as never);
    const result = await send(s.d, "talker", "late", "cli");
    expect(armed).toBe(false);
    await migrated;
    // The new session is idle, so the message is delivered there; what matters is where it did not stay.
    expect(["DELIVERED", "QUEUED"]).toContain(result);
    expect(s.d.store.queued(old)).toEqual([]);
    await s.at(1);
    expect(next.received.join("\n")).toContain("late");
    expect(s.pane.received.join("\n")).not.toContain("late");
  });
});
