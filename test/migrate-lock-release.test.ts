import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import type { MigrateOpts } from "../src/migrate-capture.ts";
import { moveInbox } from "../src/migrate-inbox.ts";
import { href } from "./fake.ts";
import { setup } from "./inbox-setup.ts";

// A migration takes several locks in turn. A take that throws part way (a permission error, a full disk) must not
// leave the locks taken before it held: a long-running process would hold them until it exits, and every send and flush
// of those inboxes would wait for it (inbox-lock-order.md rule 2: acquisitions inside the protected region).

const OLD = href("w1:p2");
const NEW = href("w1:p4");
const opts = { sleep: async () => {}, log: () => {} } as unknown as MigrateOpts;
const REAL_WRITE = fs.writeFileSync;

afterEach(() => mock.restore());

/** The inbox lock of the new session fails to be taken, as an I/O error in the second take would. */
function failTakingNewInbox(): () => boolean {
  let armed = true;
  spyOn(fs, "writeFileSync").mockImplementation(((p: fs.PathOrFileDescriptor, data: string, o?: never) => {
    if (armed && String(p).endsWith(".lock")) {
      armed = false;
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    }
    return REAL_WRITE(p, data, o as never);
  }) as never);
  return () => !armed;
}

const held = (d: ReturnType<typeof setup>["d"]) =>
  fs.readdirSync(join(d.store.root, "inbox")).filter((f) => /\.(lock|route)$/.test(f));

describe("a migration whose later lock take throws", () => {
  test("releases the locks it already took, so the inboxes are not left locked", async () => {
    const s = setup();
    s.w.addPane("w1:p4", "idle");
    const before = held(s.d);
    const armed = failTakingNewInbox();
    await expect(moveInbox(s.d, OLD, NEW, opts)).rejects.toThrow(/EACCES/);
    expect(armed()).toBe(true);
    expect(held(s.d)).toEqual(before);
  });
});
