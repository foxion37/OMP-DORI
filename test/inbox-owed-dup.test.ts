import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { flushInbox } from "../src/inbox.ts";
import { owedFile } from "../src/inbox-files.ts";
import { payLead } from "../src/inbox-merge.ts";
import { LEAD_REF as LEAD, setup } from "./inbox-setup.ts";

// payLead renames each spooled notice aside (`.moving`), appends it, then removes the file. A run cut short between the
// append and the removal leaves the notice queued and its `.moving` file behind. A lead flush in another process can
// deliver that copy before the next payer pass; recovery of the leftover file then finds no queued copy and appends it
// again, so the lead is told twice (inbox-lock-order.md rule 3: a spool identity is settled when its entry leaves).

const REAL_RM = fs.rmSync;

afterEach(() => mock.restore());

/** Keeps the `.moving` file the payer removes, as a process stopped just before the removal would. */
function keepMovingFile(): () => boolean {
  let armed = true;
  spyOn(fs, "rmSync").mockImplementation(((p: fs.PathLike, o?: fs.RmOptions) => {
    if (armed && String(p).endsWith(".moving")) {
      armed = false;
      return undefined as never;
    }
    return REAL_RM(p, o);
  }) as never);
  return () => !armed;
}

/** The state payLead exists to clear: a notice spooled for the lead while its route stayed held. */
function spooledNotice(s: ReturnType<typeof setup>): string {
  const owed = owedFile(s.d.store.root);
  fs.mkdirSync(`${owed}.spool`, { recursive: true });
  const name = "000000001000000-000000000-fixed";
  fs.writeFileSync(
    join(`${owed}.spool`, `${name}.jsonl`),
    `${JSON.stringify({ at: s.d.now(), from: "cli", text: "kept notice", spool: name })}\n`,
  );
  return name;
}

const pay = (s: ReturnType<typeof setup>) => {
  const release = s.d.store.lockInbox(LEAD, s.d.now());
  expect(release).toBeDefined();
  payLead(s.d.store.root, s.d.store.inboxPath(LEAD));
  release?.();
};

describe("a kept lead notice whose payer stopped before removing its .moving file", () => {
  test("is delivered once: the leftover file is not appended again after a flush settled the copy", async () => {
    const s = setup();
    const name = spooledNotice(s);
    const kept = keepMovingFile();
    pay(s);
    expect(kept()).toBe(true);
    expect(fs.existsSync(`${owedFile(s.d.store.root)}.spool/${name}.jsonl.moving`)).toBe(true);
    // Another process flushes the lead now, before the next payer pass: the queued copy is delivered.
    expect(await flushInbox(s.d, LEAD)).toBe("delivered");
    expect(s.lead.received.join("\n")).toContain("kept notice");
    // The next pass recovers the leftover file; it must not queue the same message again.
    pay(s);
    await flushInbox(s.d, LEAD);
    expect(s.lead.received.join("\n").split("kept notice").length - 1).toBe(1);
  });
});
