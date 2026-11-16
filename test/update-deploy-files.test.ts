import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeploymentConfig } from "../src/update/deployment.ts";
import { capturePointer, restorePointer, saveDeploymentJson, switchPointer } from "../src/update/deployment-files.ts";
import { processIdentity, sameProcess } from "../src/update/deployment-process.ts";
import { stopRecordedMonitors } from "../src/update/deployment-native.ts";
import { fixture } from "./update-deploy-setup.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

test("legacy source survives its inode-preserving rename, stable switch and exact rollback", () => {
  const { root, config } = fixture();
  const next = join(root, "next");
  mkdirSync(next);
  writeFileSync(join(next, "owner.ts"), "export const owner = 'next';\n");
  const inode = lstatSync(config.liveSource).ino;
  const pointer = capturePointer(config.liveSource, next, "owned-transaction");
  const journal = join(root, "transaction.json");
  saveDeploymentJson(journal, pointer);
  switchPointer(pointer);
  expect(lstatSync(pointer.backup).ino).toBe(inode);
  expect(readFileSync(join(pointer.backup, "owner.ts"), "utf8")).toContain("original");
  expect(readlinkSync(config.liveSource)).toBe(next);
  switchPointer(JSON.parse(readFileSync(journal, "utf8")));
  restorePointer(pointer);
  restorePointer(pointer);
  expect(lstatSync(config.liveSource).ino).toBe(inode);
  expect(readFileSync(join(config.liveSource, "owner.ts"), "utf8")).toContain("original");
  expect(readlinkSync(pointer.displaced)).toBe(next);
  expect(readFileSync(join(next, "owner.ts"), "utf8")).toContain("next");
});

test("interruption after preserving the directory resumes without moving it twice", () => {
  const { root, config } = fixture();
  const target = join(root, "prepared");
  mkdirSync(target);
  const pointer = capturePointer(config.liveSource, target, "interrupted-switch");
  renameSync(config.liveSource, pointer.backup);
  switchPointer(pointer);
  expect(lstatSync(pointer.backup).ino).toBe(pointer.original!.ino);
  restorePointer(pointer);
  expect(lstatSync(config.liveSource).isDirectory()).toBe(true);
});

test("rollback restores exact previous shim targets and leaves a changed third-party pointer alone", () => {
  const { root } = fixture();
  const shim = join(root, "shim");
  symlinkSync("original-target", shim);
  const pointer = capturePointer(shim, "managed-target", "shim-switch");
  expect(pointer.original?.target).toBe("original-target");
  switchPointer(pointer);
  renameSync(shim, join(root, "managed-link-preserved"));
  symlinkSync("owner-changed-target", shim);
  expect(() => restorePointer(pointer)).toThrow("live pointer changed");
  expect(readlinkSync(shim)).toBe("owner-changed-target");
  expect(readlinkSync(pointer.backup)).toBe("original-target");
});

test("dangling shim rollback preserves both symlink inodes without following their targets", () => {
  const { root } = fixture();
  const shim = join(root, "dangling-shim");
  symlinkSync("missing-original", shim);
  const original = lstatSync(shim).ino;
  const pointer = capturePointer(shim, "missing-managed", "dangling-rollback");
  switchPointer(pointer);
  const installed = lstatSync(shim).ino;
  expect(lstatSync(pointer.backup).ino).toBe(original);
  expect(readlinkSync(pointer.backup)).toBe("missing-original");
  restorePointer(pointer);
  expect(lstatSync(shim).ino).toBe(original);
  expect(readlinkSync(shim)).toBe("missing-original");
  expect(lstatSync(pointer.displaced).ino).toBe(installed);
  expect(readlinkSync(pointer.displaced)).toBe("missing-managed");
});

test("parser and config identity remain stable when the source becomes a symlink", () => {
  const { root, config } = fixture();
  const original = JSON.stringify(config);
  const target = join(root, "prepared");
  mkdirSync(target);
  switchPointer(capturePointer(config.liveSource, target, "config-stability"));
  expect(JSON.stringify(parseDeploymentConfig(JSON.parse(original), root))).toBe(original);
  expect(() => parseDeploymentConfig({ ...config, releaseRoot: join(config.liveSource, "generated") }, root)).toThrow();
  expect(() => parseDeploymentConfig({ ...config, stopTimeoutMs: null }, root)).toThrow();
});

posix("monitor cleanup never signals a reused PID receipt", async () => {
  const { config } = fixture();
  // Linux PID/start identity needs a real child; its keepalive timer duration is never awaited.
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    const identity = processIdentity(child.pid)!;
    expect(identity).toBeDefined();
    await stopRecordedMonitors(config, [
      { ...identity, startTicks: `${BigInt(identity.startTicks) + 1n}`, name: "owned", argv: [] },
    ]);
    expect(sameProcess(identity)).toBe(true);
    await stopRecordedMonitors(config, [{ ...identity, name: "owned", argv: [] }]);
    await child.exited;
    expect(processIdentity(child.pid)).toBeUndefined();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await child.exited;
  }
});

test("stable source switches remain continuously readable to a concurrent consumer", async () => {
  const { root, config } = fixture();
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  switchPointer(capturePointer(config.liveSource, first, "initial-conversion"));
  const stop = join(root, "reader-stop");
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      `
    import { existsSync, realpathSync } from "node:fs";
    let samples = 0, missing = 0;
    for (;;) {
      if (existsSync(process.env.STOP)) break;
      try { realpathSync(process.env.SOURCE); }
      catch (error) { if (error.code === "ENOENT") missing++; else throw error; }
      samples++;
      if (samples === 1) console.log("READY");
    }
    console.log(JSON.stringify({ samples, missing }));
  `,
    ],
    {
      env: { HOME: config.home, PATH: "/usr/bin:/bin", SOURCE: config.liveSource, STOP: stop },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    let initial = "";
    while (!initial.includes("\n")) {
      const next = await reader.read();
      if (next.done) throw new Error("source consumer exited before its first observation");
      initial += decoder.decode(next.value);
    }
    for (let index = 0; index < 60; index++)
      switchPointer(capturePointer(config.liveSource, index % 2 === 0 ? second : first, `race-${index}`));
    writeFileSync(stop, "stop");
    let result = initial.slice(initial.indexOf("\n") + 1);
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      result += decoder.decode(next.value);
    }
    expect(await child.exited).toBe(0);
    const observed = JSON.parse(result) as { samples: number; missing: number };
    expect(observed.samples).toBeGreaterThan(0);
    expect(observed.missing).toBe(0);
  } finally {
    writeFileSync(stop, "stop");
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await child.exited;
  }
});
