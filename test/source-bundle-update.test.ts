import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateSourceBundle } from "../src/release/source-bundle-update.ts";
import { digest } from "../src/update/source.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";

// POSIX-only: the fixture keeps private modes on its Git checkouts.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cataly-bundle-capture-")));
  roots.push(root);
  const remote = join(root, "upstream");
  return { root, remote, old: overlayFixture(join(root, "source"), remote) };
}

posix("shared metadata capture binds full blob identities and the reviewed staged tree", async () => {
  const f = fixture();
  const path = join(f.root, "captured.patch");
  const lock = await generateSourceBundle(f.remote, path, f.old.lock.repository, f.root);
  expect(lock.commit).toBe(f.old.commit);
  expect(lock.resultTree).toBe(fixtureGit(f.remote, "write-tree"));
  expect(lock.patchSha256).toBe(digest(readFileSync(path)));
  expect(lock.files).toEqual(f.old.lock.files);
  expect(readFileSync(path, "utf8")).toMatch(/^index [a-f0-9]{40}\.\.[a-f0-9]{40}/m);
});

posix("shared metadata capture holds empty overlays instead of inventing a no-overlay identity", async () => {
  const f = fixture();
  fixtureGit(f.remote, "reset", "--hard", f.old.commit);
  await expect(
    generateSourceBundle(f.remote, join(f.root, "empty.patch"), f.old.lock.repository, f.root),
  ).rejects.toThrow("reviewed no-overlay migration");
});
