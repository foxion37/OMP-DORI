import { expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { consumerPaths, initialize, saveJson } from "../src/release/files.ts";
import { installBundle } from "../src/release/install.ts";
import { fixture } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

test.each([".cataly/nested", ".", ".cataly/.."])("consumer side home %s cannot overlap primary ownership", (target) => {
  expect(() => consumerPaths("/sandbox/home", join("/sandbox/home", target))).toThrow("primary");
});

posix("a custom home recovers references interrupted before publishing any wrapper", async () => {
  const f = fixture(true);
  const location = join(f.paths.home, "custom side");
  const custom = consumerPaths(f.paths.home, location);
  initialize(custom);
  const bundle = f.release("first\n").bundle;
  const before = await installBundle(custom, bundle, undefined);
  const receipt = join(custom.root, "consumer-references.json");
  const pending = join(custom.root, "consumer-references-pending.json");
  const recorded = JSON.parse(readFileSync(receipt, "utf8"));
  const references = Object.fromEntries(
    Object.keys(recorded).map((path) => [
      path,
      { bytes: readFileSync(join(location, path), "utf8"), executable: path.startsWith("bin/") },
    ]),
  );
  for (const path of Object.keys(references)) unlinkSync(join(location, path));
  unlinkSync(receipt);
  unlinkSync(custom.live);
  unlinkSync(custom.state);
  saveJson(pending, { before: {}, references });
  const recoveredPaths = consumerPaths(f.paths.home, location);
  const after = await installBundle(recoveredPaths, bundle, undefined);
  expect(after).toEqual(before);
  expect(existsSync(pending)).toBe(false);
  expect(JSON.parse(readFileSync(receipt, "utf8"))).toEqual(recorded);
  expect(existsSync(join(location, "bin/cataly"))).toBe(true);
});

posix("a custom side home holds when receipt inventories disagree", () => {
  const f = fixture();
  const location = join(f.paths.home, "ambiguous side");
  const paths = consumerPaths(f.paths.home, location);
  initialize(paths);
  const digest = "a".repeat(64);
  saveJson(join(paths.root, "consumer-references.json"), {
    "bin/cataly": digest,
    "bin/cataly-harness": digest,
    "bin/omp": digest,
    "bin/omp-cataly": digest,
    "omp.yml": digest,
  });
  saveJson(join(paths.root, "consumer-references-pending.json"), {
    before: {},
    references: Object.fromEntries(
      ["bin/cataly", "bin/cataly-harness", "bin/omp", "bin/omp-cataly", "omp.yml"].map((path) => [
        path,
        { bytes: "pending reference\n", executable: path.startsWith("bin/") },
      ]),
    ),
  });
  expect(() => consumerPaths(f.paths.home, location)).toThrow("Invalid consumer reference receipt");
});
