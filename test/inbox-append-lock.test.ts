import { describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dutyTick } from "../src/duty.ts";
import { readQueue } from "../src/inbox-files.ts";
import type { Deps } from "../src/harness.ts";
import { send } from "../src/inbox.ts";
import { sendToShell } from "../src/inbox-held.ts";
import { moveBack, moveInbox } from "../src/migrate-inbox.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { href } from "./fake.ts";
import { setup } from "./inbox-setup.ts";

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
  test("dori send to a busy pane during a flush of its inbox keeps the message; it is delivered once", async () => {
    const s = setup();
    s.pane.status = "working";
    const finish = flushInFlight(s.d, href("w1:p2"));
    expect(await send(s.d, "w1:p2", "keep me", "cli")).toBe("QUEUED");
    finish();
    expect(texts(s.d, href("w1:p2"))).toEqual(["keep me"]);
    s.pane.status = "idle";
    expect(await send(s.d, "w1:p2", "and me", "cli")).toBe("DELIVERED");
    expect(s.pane.received).toEqual([
      "2 messages arrived while you were busy:\n\n(1) from cli:\nkeep me\n\n(2) from cli:\nand me",
    ]);
  });

  test("a message already queued stays, and the new one is added after it, when both meet a flush", async () => {
    const s = setup();
    s.pane.status = "working";
    expect(await send(s.d, "w1:p2", "first", "cli")).toBe("QUEUED");
    const finish = flushInFlight(s.d, href("w1:p2"));
    expect(await send(s.d, "w1:p2", "second", "cli")).toBe("QUEUED");
    finish();
    expect(texts(s.d, href("w1:p2"))).toEqual(["first", "second"]);
  });

  test("dori send --to-shell whose agent appears before typing, during a flush of the inbox, keeps the message", async () => {
    const s = setup();
    s.pane.status = "shell";
    // The first probe sees the shell; the re-read before typing sees an agent, so nothing is typed and it is queued.
    s.w.getHook.set("w1:p2", (n) => {
      if (n >= 2) s.pane.status = "working";
    });
    const finish = flushInFlight(s.d, href("w1:p2"));
    expect(await sendToShell(s.d, "w1:p2", "shell note", "cli")).toBe("QUEUED");
    finish();
    expect(texts(s.d, href("w1:p2"))).toEqual(["shell note"]);
  });

  test("a message spooled for an otherwise empty inbox is found and delivered by the next duty pass", async () => {
    const s = setup();
    const release = s.d.store.lockInbox(href("w1:p2"), s.d.now())!;
    expect(await send(s.d, "w1:p2", "spooled", "cli")).toBe("QUEUED");
    release();
    expect(s.d.store.inboxPanes()).toEqual([href("w1:p2")]);
    await dutyTick(s.d);
    expect(s.pane.received).toEqual(["spooled"]);
    expect(s.d.store.inboxPanes()).toEqual([]);
  });

  test("a spooled message renamed aside by a holder that stopped before appending it is delivered by the next duty pass", async () => {
    const s = setup();
    const release = s.d.store.lockInbox(href("w1:p2"), s.d.now())!;
    expect(await send(s.d, "w1:p2", "cut short", "cli")).toBe("QUEUED");
    const dir = `${s.d.store.inboxPath(href("w1:p2"))}.spool`;
    const [file] = readdirSync(dir);
    renameSync(join(dir, file!), join(dir, `${file}.moving`));
    release();
    expect(s.d.store.inboxPanes()).toEqual([href("w1:p2")]);
    await dutyTick(s.d);
    expect(s.pane.received).toEqual(["cut short"]);
    expect(readdirSync(dir)).toEqual([]);
  });

  test("the same text sent twice in one millisecond while the inbox is locked is queued twice, as without the lock", async () => {
    const s = setup();
    s.pane.status = "working";
    expect(await send(s.d, "w1:p2", "again", "cli")).toBe("QUEUED");
    expect(await send(s.d, "w1:p2", "again", "cli")).toBe("QUEUED");
    const release = s.d.store.lockInbox(href("w1:p2"), s.d.now())!;
    expect(await send(s.d, "w1:p2", "again", "cli")).toBe("QUEUED");
    expect(await send(s.d, "w1:p2", "again", "cli")).toBe("QUEUED");
    release();
    s.d.store.lockInbox(href("w1:p2"), s.d.now())!();
    expect(texts(s.d, href("w1:p2"))).toEqual(["again", "again", "again", "again"]);
  });

  test("a message spooled for an inbox forwarded meanwhile is moved to the new inbox by its lock holder, once", async () => {
    const s = setup();
    s.pane.status = "working";
    const release = s.d.store.lockInbox(href("w1:p2"), s.d.now())!;
    expect(await send(s.d, "w1:p2", "moving", "cli")).toBe("QUEUED");
    const old = s.d.store.inboxPath(href("w1:p2"));
    writeFileSync(`${old}.forward`, "w1:p4\n");
    release();
    // Forwarded: the old inbox's next lock holder leaves its spool to the holder of the new inbox's lock.
    s.d.store.lockInbox(href("w1:p2"), s.d.now())!();
    expect(readdirSync(`${old}.spool`)).toHaveLength(1);
    expect(s.d.store.mergePending(href("w1:p4"))).toBe(true);
    const into = s.d.store.lockInbox(href("w1:p4"), s.d.now())!;
    s.d.store.mergeForwarded(href("w1:p4"));
    s.d.store.mergeForwarded(href("w1:p4"));
    into();
    expect(texts(s.d, href("w1:p4"))).toEqual(["moving"]);
    expect(s.d.store.mergePending(href("w1:p4"))).toBe(false);
  });

  test("a message spooled while a flush holds the lock is in the queue once the flush lets go", async () => {
    const s = setup();
    const release = s.d.store.lockInbox(href("w1:p2"), s.d.now())!;
    await s.d.store.enqueue(href("w1:p2"), { at: s.d.now(), from: "cli", text: "waits" }, false);
    release();
    expect(readQueue(s.d.store.inboxPath(href("w1:p2"))).map((m) => m.text)).toEqual(["waits"]);
    expect(readdirSync(`${s.d.store.inboxPath(href("w1:p2"))}.spool`)).toEqual([]);
  });

  test("a message spooled just after the holder let go is moved into the queue by its sender", async () => {
    const s = setup();
    const release = s.d.store.lockInbox(href("w1:p2"), s.d.now())!;
    const dir = `${s.d.store.inboxPath(href("w1:p2"))}.spool`;
    spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).startsWith(dir) && String(to).endsWith(".jsonl")) release();
      return REAL_RENAME(from, to);
    });
    await s.d.store.enqueue(href("w1:p2"), { at: s.d.now(), from: "cli", text: "late" }, false);
    mock.restore();
    expect(readQueue(s.d.store.inboxPath(href("w1:p2"))).map((m) => m.text)).toEqual(["late"]);
    expect(readdirSync(dir)).toEqual([]);
  });
});

/** A message another sender spooled for `ref` while its lock was held, still waiting for the next holder. */
function spoolFor(d: Deps, ref: SessionRef, text: string, attempt?: { at: number; state: "typed" }): void {
  const dir = `${d.store.inboxPath(ref)}.spool`;
  mkdirSync(dir, { recursive: true });
  const m = { at: d.now(), from: "cli", text, ...(attempt ? { attempt } : {}) };
  writeFileSync(join(dir, `${String(m.at).padStart(15, "0")}-000000000-x.jsonl`), `${JSON.stringify(m)}\n`);
}

describe("a migration moving an inbox carries its spooled messages", () => {
  const opts = { sleep: async () => {}, log: () => {} } as unknown as Parameters<typeof moveInbox>[3];

  test("moveInbox: a typed entry spooled for the old inbox is held on the new one, like its queued entries", async () => {
    const s = setup();
    spoolFor(s.d, href("w1:p2"), "typed", { at: 1, state: "typed" });
    await moveInbox(s.d, href("w1:p2"), href("w1:p4"), opts);
    expect(s.d.store.queued(href("w1:p4")).map((m) => [m.text, m.attempt?.state])).toEqual([["typed", "ambiguous"]]);
  });

  test("moveBack: a message spooled for the new inbox goes back to the old one with the queue", async () => {
    const s = setup();
    await moveInbox(s.d, href("w1:p2"), href("w1:p4"), opts);
    spoolFor(s.d, href("w1:p4"), "late");
    await moveBack(s.d, href("w1:p2"), href("w1:p4"), opts);
    expect(texts(s.d, href("w1:p2"))).toEqual(["late"]);
    expect(s.d.store.inboxPanes()).toEqual([href("w1:p2")]);
  });
});
