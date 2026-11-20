import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { sendOrThrow } from "../src/inbox.ts";
import { doneIds, owedFile, readQueue, spooled, spoolKey } from "../src/inbox-files.ts";
import { lockRoute } from "../src/inbox-spool.ts";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import { drainForward, moveInbox } from "../src/migrate-inbox.ts";
import { Store } from "../src/store.ts";
import { href } from "./fake.ts";
import { setup } from "./inbox-setup.ts";

const OLD = href("w1:p1");
const NEXT = href("w1:p4");
const opts: MigrateOpts = {
  to: "herdr",
  dryRun: false,
  waitMinutes: 0,
  resume: false,
  sleep: async () => {},
  log: () => {},
};

afterEach(() => mock.restore());

test.each(["replacement", "disappearance"] as const)(
  "a named lead send survives role %s before enqueue while migration routes stay held",
  async (change) => {
    const s = setup();
    const next = s.w.addPane(NEXT.id, "working");
    // Step 6 has moved the inbox; the role switchover races the sender returning its old resolution.
    await moveInbox(s.d, OLD, NEXT, opts);
    const freeOld = lockRoute(s.d.store.root, OLD, s.d.now());
    const freeNext = lockRoute(s.d.store.root, NEXT, s.d.now());
    expect(freeOld).toBeDefined();
    expect(freeNext).toBeDefined();
    const waits = spyOn(Bun, "sleep").mockImplementation(async () => {});
    const readRoles = s.d.store.roles.bind(s.d.store);
    let changed = false;
    const roles = spyOn(s.d.store, "roles").mockImplementation(() => {
      const found = readRoles();
      if (!changed) {
        changed = true;
        if (change === "replacement") s.d.store.setRole("lead", NEXT);
        else fs.writeFileSync(join(s.d.store.root, "roles.json"), "{}\n");
      }
      return found;
    });

    try {
      expect(await sendOrThrow(s.d, "lead", "named lead message", "cli")).toBe("QUEUED");
      expect(changed).toBe(true);
      expect(waits.mock.calls.length).toBeGreaterThan(0);
      roles.mockRestore();

      // A fresh Store must find one durable identity, not an in-memory promise or an old-session append.
      const resumed = { ...s.d, store: new Store(s.d.store.root) };
      const owed = owedFile(resumed.store.root);
      const kept = spooled(owed, true);
      expect(kept).toHaveLength(1);
      const messages = readQueue(kept[0]!);
      expect(messages).toHaveLength(1);
      const message = messages[0]!;
      expect(message).toMatchObject({ at: s.d.now(), from: "cli", text: "named lead message" });
      expect(message.spool).toBeString();
      expect(readQueue(owed)).toEqual([]);
      expect(resumed.store.roles().lead).toEqual(change === "replacement" ? NEXT : undefined);
      expect(resumed.store.queued(OLD)).toEqual([]);
      expect(resumed.store.queued(NEXT)).toEqual([]);
      expect(s.lead.received).toEqual([]);
      expect(next.received).toEqual([]);

      await dutyTick(resumed);
      await dutyTick(resumed);
      expect(spooled(owed, true)).toEqual(kept);
      expect(readQueue(kept[0]!)).toEqual([message]);
      expect(resumed.store.queued(NEXT)).toEqual([]);

      freeOld?.();
      await drainForward(resumed, OLD, NEXT, opts);
      expect(resumed.store.destination(OLD)).toEqual(OLD);
      if (change === "disappearance") resumed.store.setRole("lead", NEXT);
      freeNext?.();
      await dutyTick(resumed);
      expect(spooled(owed, true)).toEqual([]);
      expect(resumed.store.queued(NEXT)).toEqual([message]);
      expect(resumed.store.queued(OLD)).toEqual([]);
      await dutyTick(resumed);
      expect(resumed.store.queued(NEXT)).toEqual([message]);
      expect(next.received).toEqual([]);

      next.status = "idle";
      await dutyTick(resumed);
      await dutyTick({ ...resumed, store: new Store(resumed.store.root) });
      expect(next.received).toEqual(["named lead message"]);
      expect(s.lead.received).toEqual([]);
      expect(resumed.store.queued(OLD)).toEqual([]);
      expect(resumed.store.queued(NEXT)).toEqual([]);
      expect(doneIds(resumed.store.inboxPath(NEXT))).toContain(spoolKey(message.spool!));
    } finally {
      freeNext?.();
      freeOld?.();
    }
  },
);

test.each(["w1:p1", "herdr:w1:p1"])(
  "a fixed session send to %s never becomes a send to a replacement lead",
  async (target) => {
    const s = setup();
    const next = s.w.addPane(NEXT.id, "idle");
    const free = lockRoute(s.d.store.root, OLD, s.d.now());
    expect(free).toBeDefined();
    let switched = false;
    const waits = spyOn(Bun, "sleep").mockImplementation(async () => {
      if (!switched) {
        switched = true;
        s.d.store.setRole("lead", NEXT);
      }
    });

    try {
      // There is no live redirect: OLD still exists, but no longer has the lead role after the first wait.
      await expect(sendOrThrow(s.d, target, "fixed session message", "cli")).rejects.toThrow(
        "the inbox of w1:p1 is being moved; send again",
      );
      expect(switched).toBe(true);
      expect(waits.mock.calls.length).toBeGreaterThan(0);
      expect(spooled(owedFile(s.d.store.root), true)).toEqual([]);
      expect(readQueue(owedFile(s.d.store.root))).toEqual([]);
      expect(s.d.store.queued(OLD)).toEqual([]);
      expect(s.d.store.queued(NEXT)).toEqual([]);
      free?.();
      expect(await sendOrThrow(s.d, target, "fixed session message", "cli")).toBe("DELIVERED");
      await dutyTick(s.d);
      expect(s.lead.received).toEqual(["fixed session message"]);
      expect(next.received).toEqual([]);
      expect(s.d.store.queued(OLD)).toEqual([]);
      expect(s.d.store.queued(NEXT)).toEqual([]);
    } finally {
      free?.();
    }
  },
);
