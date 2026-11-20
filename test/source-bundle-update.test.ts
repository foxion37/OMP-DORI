import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { prepareUlwUpdate, ULW_UPDATE_FILES } from "../src/release/source-bundle-update.ts";
import { checkoutSourceBundle } from "../src/release/source-checkout.ts";
import { digest } from "../src/update/source.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ulw-update-")));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "upstream");
  const old = overlayFixture(source, remote);
  fixtureGit(remote, "branch", "-M", "main");
  fixtureGit(source, "init", "--quiet");
  fixtureGit(source, "add", ".");
  fixtureGit(source, "commit", "--quiet", "-m", "Pinned Dori bundle");
  const original = ULW_UPDATE_FILES.map((file) => readFileSync(join(source, file)));
  const output = join(root, "candidate");
  const advance = (conflict = false) => {
    fixtureGit(remote, "reset", "--hard", old.commit);
    writeFileSync(
      join(remote, conflict ? "index.ts" : "new-upstream.ts"),
      conflict ? 'export const selected = "incoming";\n' : "export const incoming = true;\n",
    );
    fixtureGit(remote, "add", ".");
    fixtureGit(remote, "commit", "--quiet", "-m", "Upstream change");
    return fixtureGit(remote, "rev-parse", "HEAD");
  };
  return { root, source, remote, old, original, output, advance };
}

posix("unchanged ULW ref prepares nothing and leaves source/overlay checkout untouched", async () => {
  const f = fixture();
  const before = fixtureGit(f.remote, "write-tree");
  expect(await prepareUlwUpdate(f.source, f.output, f.remote)).toBeUndefined();
  expect(existsSync(f.output)).toBe(false);
  expect(fixtureGit(f.remote, "write-tree")).toBe(before);
  expect(ULW_UPDATE_FILES.map((file) => readFileSync(join(f.source, file)))).toEqual(f.original);
});

posix("new upstream and local overlay both survive an authenticated three-way candidate", async () => {
  const f = fixture();
  const commit = f.advance();
  const candidate = await prepareUlwUpdate(f.source, f.output, f.remote);
  expect(candidate).toMatchObject({
    commit,
    previous: f.old.commit,
    sourceCommit: fixtureGit(f.source, "rev-parse", "HEAD"),
  });
  expect(readSourceBundle(f.output).identity).toBe(candidate!.identity);
  const selected = join(f.root, "verified-checkout");
  await checkoutSourceBundle(selected, readSourceBundle(f.output), f.root, f.remote);
  expect(readFileSync(join(selected, "index.ts"), "utf8")).toContain('selected = "reviewed-overlay"');
  expect(readFileSync(join(selected, "new-upstream.ts"), "utf8")).toContain("incoming = true");
  expect(fixtureGit(selected, "rev-parse", "HEAD")).toBe(commit);
  expect(ULW_UPDATE_FILES.map((file) => readFileSync(join(f.source, file)))).toEqual(f.original);
  expect(fixtureGit(f.source, "status", "--porcelain")).toBe("");
  await expect(prepareUlwUpdate(f.source, f.output, f.remote)).rejects.toThrow("output already exists");
});

posix("legacy unified patches are normalized without losing their authenticated overlay", async () => {
  const f = fixture();
  const patch = f.old.patch.replace(/^diff --git.*\n|^index .*\n/gm, "");
  writeFileSync(join(f.source, "omp-ulw.patch"), patch);
  writeFileSync(
    join(f.source, "omp-ulw.overlay.lock"),
    `${JSON.stringify({ ...f.old.lock, patchSha256: digest(patch) })}\n`,
  );
  fixtureGit(f.source, "add", ".");
  fixtureGit(f.source, "commit", "--quiet", "-m", "Legacy unified overlay");
  f.advance();
  const candidate = await prepareUlwUpdate(f.source, f.output, f.remote);
  expect(candidate).toBeDefined();
  expect(readFileSync(join(f.output, "omp-ulw.patch"), "utf8")).toMatch(/^index [a-f0-9]{40}\.\.[a-f0-9]{40}/m);
  const checkout = join(f.root, "legacy-verified");
  await checkoutSourceBundle(checkout, readSourceBundle(f.output), f.root, f.remote);
  expect(readFileSync(join(checkout, "index.ts"), "utf8")).toContain('selected = "reviewed-overlay"');
});

posix("a conflicting new upstream holds without a candidate or changed source pins", async () => {
  const f = fixture();
  f.advance(true);
  await expect(prepareUlwUpdate(f.source, f.output, f.remote)).rejects.toThrow(
    'reviewed port: automatic three-way application failed with conflicts in ["index.ts"]',
  );
  expect(existsSync(f.output)).toBe(false);
  expect(ULW_UPDATE_FILES.map((file) => readFileSync(join(f.source, file)))).toEqual(f.original);
  expect(readdirSync(f.root).filter((name) => name.startsWith(".ulw-update-"))).toEqual([]);
});

posix("source lock tampering and uncommitted bound metadata are refused", async () => {
  const f = fixture();
  f.advance();
  writeFileSync(join(f.source, "omp-ulw.lock"), `${"f".repeat(40)}\n`);
  await expect(prepareUlwUpdate(f.source, f.output, f.remote)).rejects.toThrow("pin and overlay differ");
  writeFileSync(join(f.source, "omp-ulw.lock"), f.original[0]!);
  const lock = join(f.source, "omp-ulw.overlay.lock");
  writeFileSync(lock, `${readFileSync(lock, "utf8")}\n`);
  await expect(prepareUlwUpdate(f.source, f.output, f.remote)).rejects.toThrow("local changes");
  expect(existsSync(f.output)).toBe(false);
});

test("rewritten or unreachable upstream is held rather than treated as an automatic downgrade", async () => {
  const f = fixture();
  fixtureGit(f.remote, "reset", "--hard", f.old.commit);
  fixtureGit(f.remote, "checkout", "--orphan", "rewritten");
  fixtureGit(f.remote, "commit", "--quiet", "-m", "Unrelated upstream");
  fixtureGit(f.remote, "branch", "-M", "main");
  await expect(prepareUlwUpdate(f.source, f.output, f.remote)).rejects.toThrow();
  expect(existsSync(f.output)).toBe(false);
  await expect(prepareUlwUpdate(f.source, f.output, join(f.root, "missing"))).rejects.toThrow();
  expect(ULW_UPDATE_FILES.map((file) => readFileSync(join(f.source, file)))).toEqual(f.original);
});
