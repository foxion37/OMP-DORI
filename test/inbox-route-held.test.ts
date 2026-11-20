import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dutyTick } from "../src/duty.ts";
import type { Deps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import { ready, report } from "../src/lanes.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { href } from "./fake.ts";
import { quietLane } from "./harness-setup.ts";
import { setup } from "./inbox-setup.ts";

// A message for the lead whose route stays held past the wait (a migration of the lead's inbox that does not let go)
// is kept for the lead, not dropped: the next duty pass that finds the route free moves it into the lead's inbox.

afterEach(() => mock.restore());

/** Another live process holding the route of ref's inbox; returns its release. */
function holdRoute(d: Deps, ref: SessionRef): () => void {
  const path = `${d.store.inboxPath(ref)}.route`;
  writeFileSync(path, JSON.stringify({ pid: process.pid, host: hostname(), at: d.now() }));
  return () => rmSync(path);
}

/** Every wait for a held route returns at once; counts the waits. */
const noWait = () => spyOn(Bun, "sleep").mockImplementation(async () => {});

const LEAD = href("w1:p1");

describe("a message for the lead whose route stays held is kept for the lead", () => {
  test("a held-delivery notice: the lead is told once the route is free", async () => {
    const s = setup();
    s.w.promptFails.set("w1:p2", "timeout");
    const free = holdRoute(s.d, LEAD);
    const waits = noWait();
    expect(await send(s.d, "w1:p2", "SECRET instruction", "cli")).toBe("HELD");
    expect(waits.mock.calls.length).toBeGreaterThan(0);
    expect(s.notices()).toEqual([]);
    free();
    await dutyTick(s.d);
    await dutyTick(s.d);
    expect(s.notices()).toHaveLength(1);
    expect(s.notices()[0]).not.toContain("SECRET");
  });

  test("a report and a READY: both reach the lead, in order, once the route is free", async () => {
    const s = await quietLane();
    const free = holdRoute(s.d, LEAD);
    noWait();
    expect((await report(s.d, "talker", "halfway")).sent).toBe("QUEUED");
    expect(await ready(s.d, "talker", "all done", ["acme/app#3"])).toBe("QUEUED");
    expect(s.lead.received).toEqual([]);
    free();
    await s.at(1);
    expect(s.told("REPORT")).toBe(1);
    expect(s.told("READY")).toBe(1);
    const all = s.lead.received.join("\n");
    expect(all.indexOf("[REPORT talker]")).toBeLessThan(all.indexOf("[READY talker]"));
  });

  test("a message kept for the lead is not moved while the route stays held, and is moved once", async () => {
    const s = setup();
    const free = holdRoute(s.d, LEAD);
    noWait();
    expect(await send(s.d, "lead", "kept", "cli")).toBe("QUEUED");
    s.lead.status = "working";
    await dutyTick(s.d);
    expect(s.d.store.queued(LEAD)).toEqual([]);
    free();
    await dutyTick(s.d);
    expect(s.d.store.queued(LEAD).map((m) => m.text)).toEqual(["kept"]);
    await dutyTick(s.d);
    expect(s.d.store.queued(LEAD).map((m) => m.text)).toEqual(["kept"]);
    s.lead.status = "idle";
    await dutyTick(s.d);
    expect(s.lead.received).toEqual(["kept"]);
  });
});

test("a send whose write fails lets go of the route: a later send is not kept waiting behind it", async () => {
  const s = setup();
  const lock = `${s.d.store.inboxPath(href("w1:p2"))}.lock`;
  const real = fs.writeFileSync;
  spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    if (String(file) === lock) throw new Error("disk full");
    return (real as (...a: unknown[]) => unknown)(file, ...rest);
  }) as never);
  await expect(
    s.d.store.enqueue(href("w1:p2"), { at: s.d.now(), from: "cli", text: "lost write" }, false),
  ).rejects.toThrow("disk full");
  mock.restore();
  expect(fs.existsSync(`${s.d.store.inboxPath(href("w1:p2"))}.route`)).toBe(false);
});

test("a send waiting for a held route does not stop the process: other work runs, and the send goes once it is free", async () => {
  const s = setup();
  const free = holdRoute(s.d, href("w1:p2"));
  const waiting = Promise.withResolvers<void>();
  const wake = Promise.withResolvers<void>();
  spyOn(Bun, "sleep").mockImplementation(async () => {
    waiting.resolve();
    await wake.promise;
  });
  const sent = s.d.store.enqueue(href("w1:p2"), { at: s.d.now(), from: "cli", text: "waited" }, false);
  // The route's holder is this process's own other work: it can only let go while the waiting send has yielded.
  await waiting.promise;
  free();
  wake.resolve();
  expect(await sent).toEqual({ kind: "queued", at: href("w1:p2") });
  expect(s.d.store.queued(href("w1:p2")).map((m) => m.text)).toEqual(["waited"]);
});
