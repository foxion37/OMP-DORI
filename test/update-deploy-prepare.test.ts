import { expect, spyOn, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deployRelease } from "../src/update/deployment.ts";
import { prepareRelease, validateDeploymentInput } from "../src/update/deployment-prepare.ts";
import type { DeploymentRecord } from "../src/update/deployment-types.ts";
import { sourceManifest } from "../src/update/source.ts";
import { preparationFixture } from "./update-deploy-prepare-setup.ts";
import { git } from "./update-setup.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

test("published clone provisions frozen dependencies privately and carries only the admitted opaque pin", async () => {
  const f = preparationFixture();
  const candidateBefore = sourceManifest(f.candidate);
  await prepareRelease(f.config, f.input, f.record);
  expect(git(f.record.releasePath, "rev-parse", "HEAD")).toBe(f.input.commit);
  expect(git(f.record.releasePath, "rev-parse", "HEAD^{tree}")).toBe(f.input.tree);
  expect(sourceManifest(f.record.releasePath).hash).toBe(candidateBefore.hash);
  expect(sourceManifest(f.candidate)).toEqual(candidateBefore);
  expect(readFileSync(join(f.record.releasePath, "ref/omp-ulw/index.ts"), "utf8")).toContain("preserved");
  expect(lstatSync(join(f.record.releasePath, "skills/dori-mode/scripts/src/cli.ts")).mode & 0o111).toBe(0o111);
  expect(readFileSync(join(f.home, ".dori/config.json"), "utf8")).toBe('{"owner":"unchanged"}\n');
  expect(readFileSync(join(f.home, ".dori/state/owner.json"), "utf8")).toBe('{"cursor":17}\n');
  expect(lstatSync(f.config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
  f.record.preparedAt = new Date().toISOString();
  await prepareRelease(f.config, f.input, f.record);
  expect(sourceManifest(f.record.releasePath).hash).toBe(candidateBefore.hash);
});

test("actual published tree mismatch is held before operator source or state changes", async () => {
  const f = preparationFixture();
  f.put("src/app.ts", "export const release = 'moved';\n");
  git(f.remote, "add", "--", "src/app.ts");
  git(f.remote, "commit", "-m", "Concurrent published movement");
  const input = { ...f.input, commit: git(f.remote, "rev-parse", "HEAD") };
  await expect(prepareRelease(f.config, input, f.record)).rejects.toThrow("commit or tree");
  expect(lstatSync(f.config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(join(f.home, ".dori/state/owner.json"), "utf8")).toContain('"cursor":17');
});

test("a Git tree containing excluded runtime data is rejected even when its admitted source hash matches", async () => {
  const f = preparationFixture();
  f.put("state/unpublished.txt", "synthetic runtime marker\n");
  git(f.remote, "add", "--", "state/unpublished.txt");
  git(f.remote, "commit", "-m", "Unexpected runtime data in published tree");
  const input = {
    ...f.input,
    commit: git(f.remote, "rev-parse", "HEAD"),
    tree: git(f.remote, "rev-parse", "HEAD^{tree}"),
  };
  await expect(prepareRelease(f.config, input, f.record)).rejects.toThrow("outside its admitted manifest");
  expect(lstatSync(f.config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
});

test("changed opaque candidate pin invalidates preparation without rewriting the candidate", () => {
  const f = preparationFixture();
  const path = join(f.candidate, "ref/omp-ulw/index.ts");
  writeFileSync(path, "export const opaquePin = 'changed';\n");
  expect(() => validateDeploymentInput(f.input)).toThrow("candidate no longer matches");
  expect(readFileSync(path, "utf8")).toContain("changed");
});

posix.each([
  ["clone", "recover"],
  ["fetch", "recover"],
  ["install", "recover"],
  ["clone", "expire"],
  ["fetch", "expire"],
  ["install", "expire"],
] as const)("pre-stop %s command failure can %s without native effects", async (mode, outcome) => {
  const f = preparationFixture();
  const tools = join(f.directory, "private-tools");
  mkdirSync(tools);
  const marker = join(tools, "fail-command");
  const native = join(tools, "native-observation");
  writeFileSync(marker, mode);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  const bin = (name: string, body: string): string => {
    const path = join(tools, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return path;
  };
  bin(
    "git",
    `for arg in "$@"; do
  if [ "$arg" = ${quote(mode)} ] && [ -f ${quote(marker)} ]; then exit 75; fi
done
exec /usr/bin/git "$@"`,
  );
  const bun = bin(
    "bun",
    `if [ "$1" = install ] && [ ${quote(mode)} = install ] && [ -f ${quote(marker)} ]; then exit 75; fi
exec ${quote(process.execPath)} "$@"`,
  );
  const herdr = bin("herdr", `printf observed >> ${quote(native)}\nexit 1`);
  const config = { ...f.config, bun, herdr };
  const signals = spyOn(process, "kill");
  let clock = Date.now();
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  let saved: DeploymentRecord | undefined;
  const persist = (value: DeploymentRecord): void => {
    saved = structuredClone(value);
  };
  try {
    const first = await deployRelease(config, f.input, undefined, persist);
    expect(first).toMatchObject({ status: "held", step: "prepare", retryableHold: true });
    expect(saved).toEqual(first);
    expect(first.preparedAt).toBeUndefined();
    expect(first.stopRequestedAt).toBeUndefined();
    expect(first.launchRequestedAt).toBeUndefined();
    expect(first.oldRuntime).toBeUndefined();
    expect(lstatSync(native, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(config.launcherPath, { throwIfNoEntry: false })).toBeUndefined();
    expect(signals).not.toHaveBeenCalled();
    const deadline = first.retryDeadlineAt!;
    expect(Date.parse(deadline)).toBeGreaterThan(clock);
    expect(Date.parse(deadline)).toBeLessThanOrEqual(clock + 3_600_000);
    clock = Date.parse(deadline) - 1;
    const repeated = await deployRelease(config, f.input, saved, persist);
    expect(repeated).toMatchObject({ status: "held", retryableHold: true, retryDeadlineAt: deadline });
    expect(lstatSync(native, { throwIfNoEntry: false })).toBeUndefined();
    if (outcome === "expire") {
      clock++;
      const stale = structuredClone(first);
      delete stale.retryDeadlineAt;
      const held = await deployRelease(config, f.input, stale, persist);
      expect(saved).toEqual(held);
      expect(held).toMatchObject({ status: "held", step: "prepare", retryDeadlineAt: deadline });
      expect(held.retryableHold).toBeUndefined();
      expect(held.error).toContain("retry deadline");
      expect(held.stopRequestedAt).toBeUndefined();
      expect(held.launchRequestedAt).toBeUndefined();
      expect(lstatSync(native, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
      expect(lstatSync(config.launcherPath, { throwIfNoEntry: false })).toBeUndefined();
      expect(signals).not.toHaveBeenCalled();
      expect(readFileSync(join(f.home, ".dori/state/owner.json"), "utf8")).toBe('{"cursor":17}\n');
      return;
    }
    rmSync(marker);
    const resumed = await deployRelease(config, f.input, saved, persist);
    expect(resumed.id).toBe(first.id);
    expect(resumed.preparedAt).toBeString();
    expect(sourceManifest(resumed.releasePath).hash).toBe(f.input.sourceHash);
    expect(resumed).toMatchObject({ status: "held", step: "prepare" });
    expect(resumed.retryableHold).toBeUndefined();
    expect(resumed.stopRequestedAt).toBeUndefined();
    expect(readFileSync(native, "utf8")).toContain("observed");
    expect(signals).not.toHaveBeenCalled();
    expect(readFileSync(join(f.home, ".dori/state/owner.json"), "utf8")).toBe('{"cursor":17}\n');
  } finally {
    signals.mockRestore();
    now.mockRestore();
  }
});

test.each(["tree", "admission"])("pre-stop %s violations remain terminal holds", async (mode) => {
  const f = preparationFixture();
  if (mode === "admission") writeFileSync(join(f.candidate, "auth.json"), '{"fixture":"excluded"}\n');
  const input = mode === "tree" ? { ...f.input, tree: "b".repeat(40) } : f.input;
  const signals = spyOn(process, "kill");
  try {
    const held = await deployRelease(f.config, input, undefined, () => {});
    expect(held.status).toBe("held");
    expect(held.retryableHold).toBeUndefined();
    expect(held.retryDeadlineAt).toBeUndefined();
    expect(held.stopRequestedAt).toBeUndefined();
    expect(lstatSync(f.config.liveSource, { throwIfNoEntry: false })).toBeUndefined();
    expect(signals).not.toHaveBeenCalled();
  } finally {
    signals.mockRestore();
  }
});
