import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pointer, replacePointer, saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { activateRelease, loadInstalled, recoverInstalled, releasePath } from "../src/release/state.ts";
import { processIdentity } from "../src/update/deployment-process.ts";
import { activationFixture, blockStatePublication, interruptedActivation } from "./release-native-recovery-setup.ts";

for (const legacy of [false, true]) {
  const transition = legacy ? "bound-to-legacy" : "bound-to-bound";

  test(`${transition} install and rollback select the matching owned native command and preserve config`, async () => {
    const { f, before, after } = await activationFixture(legacy);
    const omp = join(f.paths.dori, "bin/omp");
    const currentNative = join(releasePath(f.paths, before.current), "scripts/consumer/omp");
    const target = releasePath(f.paths, after.current);
    const config = readFileSync(f.paths.config);
    expect(pointer(omp)).toBe(currentNative);
    expect(await rollbackRelease(f.paths, before)).toEqual(after);
    expect(pointer(f.paths.live)).toBe(target);
    expect(pointer(omp)).toBe(legacy ? undefined : join(target, "scripts/consumer/omp"));
    expect(loadInstalled(f.paths)).toEqual(after);
    expect(recoverInstalled(f.paths)).toEqual(after);
    expect(readFileSync(f.paths.config)).toEqual(config);
    expect((await rollbackRelease(f.paths, after)).current).toEqual(before.current);
    expect(pointer(omp)).toBe(currentNative);
  });

  test(`${transition} preparation failure before journaling preserves the active native command`, async () => {
    const { f, before } = await activationFixture(legacy);
    const source = pointer(f.paths.live);
    const omp = join(f.paths.dori, "bin/omp");
    const native = pointer(omp);
    const state = readFileSync(f.paths.state);
    await expect(
      rollbackRelease(
        {
          ...f.paths,
          get journal(): string {
            throw new Error("injected pre-journal failure");
          },
        },
        before,
      ),
    ).rejects.toThrow("injected pre-journal failure");
    expect(pointer(f.paths.live)).toBe(source);
    expect(pointer(omp)).toBe(native);
    expect(readFileSync(f.paths.state)).toEqual(state);
    expect(existsSync(f.paths.journal)).toBe(false);
    expect(recoverInstalled(f.paths)).toEqual(before);
  });

  test(`${transition} state publication failure rolls back both pointers before recovery`, async () => {
    const { f, before, after } = await activationFixture(legacy);
    const source = releasePath(f.paths, before.current);
    const target = releasePath(f.paths, after.current);
    const omp = join(f.paths.dori, "bin/omp");
    const state = readFileSync(f.paths.state);
    const fault = blockStatePublication(f.paths, f.root, target);
    await expect(rollbackRelease(fault.paths, before)).rejects.toThrow("Expected a real file");
    expect(fault.observed).toEqual([legacy ? undefined : join(target, "scripts/consumer/omp")]);
    expect(pointer(f.paths.live)).toBe(source);
    expect(pointer(omp)).toBe(join(source, "scripts/consumer/omp"));
    expect(readFileSync(f.paths.state)).toEqual(state);
    expect(JSON.parse(readFileSync(f.paths.journal, "utf8"))).toEqual({ version: 1, before, after });
    expect(recoverInstalled(f.paths)).toEqual(before);
    expect(pointer(omp)).toBe(join(source, "scripts/consumer/omp"));
    expect(existsSync(f.paths.journal)).toBe(false);
  });

  test(`${transition} actual activation interruptions recover native, source and state at every publication boundary`, async () => {
    const { f, before, after } = await activationFixture(legacy);
    const omp = join(f.paths.dori, "bin/omp");
    const source = releasePath(f.paths, before.current);
    const target = releasePath(f.paths, after.current);
    const nativeBefore = join(source, "scripts/consumer/omp");
    const nativeAfter = legacy ? undefined : join(target, "scripts/consumer/omp");
    for (const phase of ["journal", "native", "source", "state"]) {
      if (pointer(f.paths.live) === target) activateRelease(f.paths, after, before);
      const result = Bun.spawnSync(
        [process.execPath, "-e", interruptedActivation, JSON.stringify({ home: f.paths.home, before, after, phase })],
        { env: { HOME: f.paths.home, PATH: process.env["PATH"] }, timeout: 10_000 },
      );
      expect(result.exitCode).toBe(73);
      const switched = phase === "source" || phase === "state";
      const recovered = switched ? after : before;
      expect(pointer(f.paths.live)).toBe(switched ? target : source);
      expect(pointer(omp)).toBe(phase === "journal" ? nativeBefore : nativeAfter);
      expect(loadInstalled(f.paths)).toEqual(phase === "state" ? after : before);
      expect(JSON.parse(readFileSync(f.paths.journal, "utf8"))).toEqual({ version: 1, before, after });
      expect(recoverInstalled(f.paths)).toEqual(recovered);
      expect(pointer(omp)).toBe(switched ? nativeAfter : nativeBefore);
      expect(loadInstalled(f.paths)).toEqual(recovered);
      expect(existsSync(f.paths.journal)).toBe(false);
    }
  });
}

test("first activation publication failure restores the absence of both owned pointers and installed state", async () => {
  const { f, before } = await activationFixture(false);
  const source = releasePath(f.paths, before.current);
  const omp = join(f.paths.dori, "bin/omp");
  replacePointer(f.paths.live, source, undefined);
  replacePointer(omp, join(source, "scripts/consumer/omp"), undefined);
  unlinkSync(f.paths.state);
  const fault = blockStatePublication(f.paths, f.root, source);
  expect(() => activateRelease(fault.paths, undefined, before)).toThrow("Expected a real file");
  expect(fault.observed).toEqual([join(source, "scripts/consumer/omp")]);
  expect(pointer(f.paths.live)).toBeUndefined();
  expect(pointer(omp)).toBeUndefined();
  expect(existsSync(f.paths.state)).toBe(false);
  expect(recoverInstalled(f.paths)).toBeUndefined();
  expect(existsSync(f.paths.journal)).toBe(false);
});

test("status, reinstall and rollback hold missing or changed native pointers without replacing user edits", async () => {
  const { f, before, after, bundle } = await activationFixture(false);
  const omp = join(f.paths.dori, "bin/omp");
  const native = pointer(omp);
  const state = readFileSync(f.paths.state);
  const source = pointer(f.paths.live);
  const cli = resolve(import.meta.dir, "../skills/dori-mode/scripts/src/cli.ts");
  for (const changed of [
    undefined,
    join(releasePath(f.paths, after.current), "scripts/consumer/omp"),
    "/owner/custom-omp",
  ]) {
    replacePointer(omp, native, changed);
    expect(() => recoverInstalled(f.paths)).toThrow("native OMP pointer");
    await expect(installBundle(f.paths, bundle, before)).rejects.toThrow("native OMP");
    await expect(rollbackRelease(f.paths, before)).rejects.toThrow("native OMP");
    const result = Bun.spawnSync([process.execPath, cli, "update", "status"], {
      env: { HOME: f.paths.home, PATH: process.env["PATH"], DORI_TELEMETRY: "0", DO_NOT_TRACK: "1" },
      timeout: 10_000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain("native OMP pointer");
    expect(pointer(f.paths.live)).toBe(source);
    expect(pointer(omp)).toBe(changed);
    expect(readFileSync(f.paths.state)).toEqual(state);
    expect(existsSync(f.paths.journal)).toBe(false);
    replacePointer(omp, changed, native);
  }
  replacePointer(omp, native, undefined);
  writeFileSync(omp, "owner native command\n", { mode: 0o700 });
  expect(() => recoverInstalled(f.paths)).toThrow("Unmanaged source/path");
  expect(readFileSync(omp, "utf8")).toBe("owner native command\n");
  expect(readFileSync(f.paths.state)).toEqual(state);
});

test("journal recovery preserves conflicting native edits and unrelated installed records", async () => {
  const { f, before, after } = await activationFixture(false);
  const omp = join(f.paths.dori, "bin/omp");
  const native = pointer(omp);
  const source = pointer(f.paths.live);
  const state = readFileSync(f.paths.state);
  saveJson(f.paths.journal, { version: 1, before, after });
  const journal = readFileSync(f.paths.journal);
  const unrelated = join(f.paths.releases, `${"f".repeat(40)}-${"e".repeat(16)}/scripts/consumer/omp`);
  for (const changed of [undefined, unrelated]) {
    replacePointer(omp, native, changed);
    expect(() => recoverInstalled(f.paths)).toThrow("Native OMP pointer conflicts");
    expect(pointer(omp)).toBe(changed);
    expect(pointer(f.paths.live)).toBe(source);
    expect(readFileSync(f.paths.state)).toEqual(state);
    expect(readFileSync(f.paths.journal)).toEqual(journal);
    replacePointer(omp, changed, native);
  }
  const unrelatedState = { version: 1 as const, current: before.current };
  saveJson(f.paths.state, unrelatedState);
  expect(() => recoverInstalled(f.paths)).toThrow("Installed state conflicts");
  expect(loadInstalled(f.paths)).toEqual(unrelatedState);
  expect(readFileSync(f.paths.journal)).toEqual(journal);
});

test.skipIf(process.platform !== "linux")(
  "native recovery holds a live Dori receipt before changing the command",
  async () => {
    const { f, before, after } = await activationFixture(true);
    const source = pointer(f.paths.live);
    const omp = join(f.paths.dori, "bin/omp");
    const native = pointer(omp);
    const state = readFileSync(f.paths.state);
    const runtime = join(f.paths.dori, "state/runtime");
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const receipt = join(runtime, "owned-pane.json");
    saveJson(receipt, { ...processIdentity(process.pid), role: "dori", sessionId: "isolated" });
    replacePointer(omp, native, undefined);
    saveJson(f.paths.journal, { version: 1, before, after });
    const journal = readFileSync(f.paths.journal);
    expect(() => recoverInstalled(f.paths)).toThrow("Live Dori PID");
    expect(pointer(f.paths.live)).toBe(source);
    expect(pointer(omp)).toBeUndefined();
    expect(readFileSync(f.paths.state)).toEqual(state);
    expect(readFileSync(f.paths.journal)).toEqual(journal);
    unlinkSync(receipt);
    expect(recoverInstalled(f.paths)).toEqual(before);
    expect(pointer(omp)).toBe(native);
  },
);
