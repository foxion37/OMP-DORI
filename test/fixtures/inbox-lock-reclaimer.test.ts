import { spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { takeInboxLock } from "../../src/inbox-lock.ts";

// Only the owning crash-chain test enables this isolated subprocess test.
const request = process.env["DORI_TEST_INBOX_RECLAIMER"];
if (request !== undefined) {
  test("inbox reclaimer exits immediately after writing its actual claim", () => {
    const { path, now } = JSON.parse(request) as { path: string; now: number };
    const realWrite = fs.writeFileSync;
    spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      realWrite(file, data, options);
      if (String(file) === path) return;
      // No claim name is predicted: report only a successful production write, then die before its release exists.
      realWrite(1, `INBOX_CLAIM ${JSON.stringify({ claim: String(file), content: fs.readFileSync(file, "utf8") })}\n`);
      process.exit(0);
    });
    const release = takeInboxLock(path, now);
    release?.();
    throw new Error("reclaimer returned without writing a claim; crash hook did not run");
  });
}
