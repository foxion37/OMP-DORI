import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReleaseJournal } from "../scripts/release-journal.ts";
import { releaseFixture } from "./release-producer-setup.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dori-publication-test-"));
  directories.push(directory);
  return { directory, manifest: releaseFixture() };
}

test("a lost write response is reconciled from observed bytes instead of replaying the write", async () => {
  const f = fixture();
  const journal = new ReleaseJournal(f.directory, f.manifest);
  const uploaded = join(f.directory, "observed-upload");
  let writes = 0;
  await journal.effect(
    "upload:install.sh",
    async () => {
      writes++;
      writeFileSync(uploaded, "verified bytes", { flag: "wx" });
      throw new Error("Connection closed after the remote effect");
    },
    async () => existsSync(uploaded),
  );
  expect(writes).toBe(1);
  expect(new ReleaseJournal(f.directory, f.manifest).pending).toBeUndefined();
});

test("an ambiguous upload intent survives restart and blocks a duplicate effect", async () => {
  const f = fixture();
  let writes = 0;
  const effect = async () => {
    writes++;
    throw new Error("Connection lost");
  };
  await expect(
    new ReleaseJournal(f.directory, f.manifest).effect("upload:install.sh", effect, async () => false),
  ).rejects.toThrow("Ambiguous publication");
  const resumed = new ReleaseJournal(f.directory, f.manifest);
  expect(resumed.pending).toBe("upload:install.sh");
  await expect(resumed.effect("upload:install.sh", effect, async () => true)).rejects.toThrow("Unresolved");
  expect(writes).toBe(1);
});

test("publication intent cannot be reused for another committed source", async () => {
  const f = fixture();
  await expect(
    new ReleaseJournal(f.directory, f.manifest).effect(
      "create",
      async () => {
        throw new Error("Connection lost");
      },
      async () => false,
    ),
  ).rejects.toThrow();
  expect(() => new ReleaseJournal(f.directory, { ...f.manifest, commit: "9".repeat(40) })).toThrow("does not match");
  expect(
    () =>
      new ReleaseJournal(f.directory, {
        ...f.manifest,
        source: { ...f.manifest.source, hash: "9".repeat(64) },
      }),
  ).toThrow("does not match");
});
