import { describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { readQueue } from "../src/inbox-files.ts";
import type { Deps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { href } from "./fake.ts";
import { PANE, setup } from "./inbox-setup.ts";

const OLD = href(PANE);
const TARGET = `headless:${PANE}`;
const REAL_RENAME = fs.renameSync;

/**
 * Another process's flush of `ref`, stopped between reading the queue and writing it back: it holds the inbox lock and
 * has read the queue; `finish` writes back what it read and releases the lock. An entry appended in between is
 * overwritten unless the append waited for the same lock.
 */
function flushInFlight(d: Deps, ref: SessionRef): () => void {
  const release = d.store.lockInbox(ref, d.now());
  if (!release) throw new Error("the inbox lock is taken");
  const read = d.store.queued(ref);
  return () => {
    d.store.saveInbox(ref, read);
    release();
  };
}

const texts = (d: Deps, ref: SessionRef) => d.store.queued(ref).map((m) => m.text);

describe("a message queued while another process rewrites the same inbox", () => {
  test("cataly send to a busy pane during a flush of its inbox keeps the message; it is delivered once", async () => {
    const s = setup();
    s.pane.status = "working";
    const finish = flushInFlight(s.d, OLD);
    expect(await send(s.d, TARGET, "keep me", "cli")).toBe("QUEUED");
    finish();
    expect(texts(s.d, OLD)).toEqual(["keep me"]);
    s.pane.status = "idle";
    expect(await send(s.d, TARGET, "and me", "cli")).toBe("DELIVERED");
    expect(s.pane.received).toEqual([
      "2 messages arrived while you were busy:\n\n(1) from cli:\nkeep me\n\n(2) from cli:\nand me",
    ]);
  });

  test("a message already queued stays, and the new one is added after it, when both meet a flush", async () => {
    const s = setup();
    s.pane.status = "working";
    expect(await send(s.d, TARGET, "first", "cli")).toBe("QUEUED");
    const finish = flushInFlight(s.d, OLD);
    expect(await send(s.d, TARGET, "second", "cli")).toBe("QUEUED");
    finish();
    expect(texts(s.d, OLD)).toEqual(["first", "second"]);
  });

  test("a message spooled for an otherwise empty inbox is found and delivered by the next duty pass", async () => {
    const s = setup();
    const release = s.d.store.lockInbox(OLD, s.d.now())!;
    expect(await send(s.d, TARGET, "spooled", "cli")).toBe("QUEUED");
    release();
    expect(s.d.store.inboxPanes()).toEqual([OLD]);
    await dutyTick(s.d);
    expect(s.pane.received).toEqual(["spooled"]);
    expect(s.d.store.inboxPanes()).toEqual([]);
  });

  test("a spooled message renamed aside by a holder that stopped before appending it is delivered by the next duty pass", async () => {
    const s = setup();
    const release = s.d.store.lockInbox(OLD, s.d.now())!;
    expect(await send(s.d, TARGET, "cut short", "cli")).toBe("QUEUED");
    const dir = `${s.d.store.inboxPath(OLD)}.spool`;
    const [file] = readdirSync(dir);
    renameSync(join(dir, file!), join(dir, `${file}.moving`));
    release();
    expect(s.d.store.inboxPanes()).toEqual([OLD]);
    await dutyTick(s.d);
    expect(s.pane.received).toEqual(["cut short"]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the same text sent twice in one millisecond while the inbox is locked is queued twice, as without the lock", async () => {
    const s = setup();
    s.pane.status = "working";
    expect(await send(s.d, TARGET, "again", "cli")).toBe("QUEUED");
    expect(await send(s.d, TARGET, "again", "cli")).toBe("QUEUED");
    const release = s.d.store.lockInbox(OLD, s.d.now())!;
    expect(await send(s.d, TARGET, "again", "cli")).toBe("QUEUED");
    expect(await send(s.d, TARGET, "again", "cli")).toBe("QUEUED");
    release();
    s.d.store.lockInbox(OLD, s.d.now())!();
    expect(texts(s.d, OLD)).toEqual(["again", "again", "again", "again"]);
  });

  test("a message spooled while a flush holds the lock is in the queue once the flush lets go", async () => {
    const s = setup();
    const release = s.d.store.lockInbox(OLD, s.d.now())!;
    await s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "waits" }, false);
    release();
    expect(readQueue(s.d.store.inboxPath(OLD)).map((m) => m.text)).toEqual(["waits"]);
    expect(readdirSync(`${s.d.store.inboxPath(OLD)}.spool`)).toEqual([]);
  });

  test("a message spooled just after the holder let go is moved into the queue by its sender", async () => {
    const s = setup();
    const release = s.d.store.lockInbox(OLD, s.d.now())!;
    const dir = `${s.d.store.inboxPath(OLD)}.spool`;
    spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).startsWith(dir) && String(to).endsWith(".jsonl")) release();
      return REAL_RENAME(from, to);
    });
    await s.d.store.enqueue(OLD, { at: s.d.now(), from: "cli", text: "late" }, false);
    mock.restore();
    expect(readQueue(s.d.store.inboxPath(OLD)).map((m) => m.text)).toEqual(["late"]);
    expect(readdirSync(dir)).toEqual([]);
  });
});
