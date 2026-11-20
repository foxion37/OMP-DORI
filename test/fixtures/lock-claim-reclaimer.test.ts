import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { takeFile, underClaim } from "../../src/lock-claim.ts";
import { OWNERLESS_MS } from "../../src/lock-owner.ts";
import { lockEnv } from "../../src/lock.ts";

// Only the owning recovery test enables this actual, abruptly exiting producer.
const request = process.env["DORI_TEST_LOCK_RECLAIMER"];
if (request !== undefined) {
  test("producer exits holding its actual file lock or reclaimer claim", () => {
    const { path, claim } = JSON.parse(request) as { path: string; claim: boolean };
    const env = lockEnv(dirname(path));
    if (claim) {
      underClaim(env, path, readFileSync(path, "utf8"), OWNERLESS_MS, () => process.exit(71));
      throw new Error("reclaimer returned without exiting under its claim");
    }
    if (!takeFile(env, path, OWNERLESS_MS)) throw new Error("producer did not acquire its file lock");
    process.exit(71);
  });
}
