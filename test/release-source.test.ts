import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { sourceManifest } from "../src/update/source.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test.each(["0000", "0002", "0077"])("release source admits bound payloads under umask %s", async (mask) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "dori-release-source-test-")));
  directories.push(directory);
  const source = join(directory, "source");
  overlayFixture(source, join(directory, "upstream"), true);
  writeFileSync(join(source, "install.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fixtureGit(source, "init", "--quiet");
  fixtureGit(source, "add", ".");
  fixtureGit(source, "commit", "--quiet", "-m", "Committed producer fixture");
  const commit = fixtureGit(source, "rev-parse", "HEAD");
  const destination = join(directory, "materialized");
  const script = `
    import { committedSource } from ${JSON.stringify(resolve(import.meta.dir, "../scripts/release-source.ts"))};
    import { readSourceBundle } from ${JSON.stringify(resolve(import.meta.dir, "../src/release/source-bundle.ts"))};
    const before = process.umask();
    const manifest = await committedSource(${JSON.stringify(source)}, ${JSON.stringify(commit)}, ${JSON.stringify(destination)});
    const bundle = readSourceBundle(${JSON.stringify(destination)}, true);
    console.log(JSON.stringify({ before, after: process.umask(), hash: manifest.hash, identity: bundle.identity }));
  `;
  const child = Bun.spawn(
    ["/bin/sh", "-c", 'umask "$1"; shift; exec "$@"', "release-source-test", mask, process.execPath, "-e", script],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toEqual({
    before: Number.parseInt(mask, 8),
    after: Number.parseInt(mask, 8),
    hash: sourceManifest(source).hash,
    identity: readSourceBundle(source, true).identity,
  });
  expect(sourceManifest(destination).files.find((file) => file.path === "install.sh")?.executable).toBe(true);
});
