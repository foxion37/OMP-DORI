import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { acquireBundle } from "../src/release/bundle.ts";
import { replacePointer, saveJson } from "../src/release/files.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { recoverInstalled, releasePath } from "../src/release/state.ts";
import { processIdentity } from "../src/update/deployment-process.ts";
import { fixture } from "./release-consumer-setup.ts";

const linux = test.skipIf(process.platform !== "linux");

test("local release installation preserves config/auth/work and updates every stable reference through one source pointer", async () => {
  const f = fixture();
  const config = '{"stateDir":"~/.dori/state","ompUlwPath":"/owner/custom.ts","defaultModel":"owner/model"}\n';
  writeFileSync(f.paths.config, config, { mode: 0o600 });
  writeFileSync(join(f.paths.dori, "auth.json"), "owner authentication\n", { mode: 0o600 });
  mkdirSync(join(f.paths.dori, "work"), { mode: 0o700 });
  writeFileSync(join(f.paths.dori, "work", "owner.txt"), "owner work\n", { mode: 0o600 });
  const first = f.release("first\n");
  const before = await installBundle(f.paths, await acquireBundle({ from: first.dist }), undefined);
  const old = readlinkSync(f.paths.live);
  const second = f.release("second\n");
  const after = await installBundle(f.paths, await acquireBundle({ from: second.dist }), before);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, second.bundle.manifest));
  expect(after.previous).toEqual(first.bundle.manifest);
  expect(readFileSync(join(old, "payload.txt"), "utf8")).toBe("first\n");
  expect(readFileSync(join(f.paths.live, "payload.txt"), "utf8")).toBe("second\n");
  for (const [path, target] of f.paths.links) expect(readlinkSync(path)).toBe(target);
  expect(readFileSync(f.paths.config, "utf8")).toBe(config);
  expect(readFileSync(join(f.paths.dori, "auth.json"), "utf8")).toBe("owner authentication\n");
  expect(readFileSync(join(f.paths.dori, "work", "owner.txt"), "utf8")).toBe("owner work\n");
});

test("rollback verifies and restores the exact previous release while retaining the displaced one", async () => {
  const f = fixture();
  const first = f.release("first\n");
  const one = await installBundle(f.paths, first.bundle, undefined);
  const firstPath = readlinkSync(f.paths.live);
  const config = readFileSync(f.paths.config);
  const second = f.release("second\n");
  const two = await installBundle(f.paths, second.bundle, one);
  const rolled = await rollbackRelease(f.paths, two, one.current.tag);
  expect(readlinkSync(f.paths.live)).toBe(firstPath);
  expect(rolled.current).toEqual(one.current);
  expect(rolled.previous).toEqual(two.current);
  expect(readFileSync(f.paths.config)).toEqual(config);
  expect(readFileSync(join(f.paths.live, "payload.txt"), "utf8")).toBe("first\n");
  expect(existsSync(releasePath(f.paths, two.current))).toBe(true);
});

linux("a live identity-bound Dori receipt holds both install and rollback without signalling the process", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("first\n").bundle, undefined);
  const two = await installBundle(f.paths, f.release("second\n").bundle, one);
  const pointer = readlinkSync(f.paths.live);
  const state = readFileSync(f.paths.state);
  const runtime = join(f.paths.dori, "state/runtime");
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  saveJson(join(runtime, "owned-pane.json"), { ...processIdentity(process.pid), role: "dori", sessionId: "isolated" });
  await expect(installBundle(f.paths, f.release("third\n").bundle, two)).rejects.toThrow("Live Dori PID");
  await expect(rollbackRelease(f.paths, two)).rejects.toThrow("Live Dori PID");
  expect(processIdentity(process.pid)).toBeDefined();
  expect(readlinkSync(f.paths.live)).toBe(pointer);
  expect(readFileSync(f.paths.state)).toEqual(state);
});

test("tampered rollback executable modes leave the active source and installed-state bytes unchanged", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("first\n").bundle, undefined);
  const two = await installBundle(f.paths, f.release("second\n").bundle, one);
  const pointer = readlinkSync(f.paths.live);
  const state = readFileSync(f.paths.state);
  chmodSync(join(releasePath(f.paths, one.current), "bin-entry.sh"), 0o444);
  await expect(rollbackRelease(f.paths, two)).rejects.toThrow("executable modes");
  expect(readlinkSync(f.paths.live)).toBe(pointer);
  expect(readFileSync(f.paths.state)).toEqual(state);
});

test("interruption after the atomic pointer switch publishes the matching verified state on recovery", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("first\n").bundle, undefined);
  const two = await installBundle(f.paths, f.release("second\n").bundle, one);
  saveJson(f.paths.journal, { version: 1, before: one, after: two });
  saveJson(f.paths.state, one);
  expect(recoverInstalled(f.paths)).toEqual(two);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, two.current));
  expect(JSON.parse(readFileSync(f.paths.state, "utf8"))).toEqual(two);
  expect(existsSync(f.paths.journal)).toBe(false);
});

test("interruption before the pointer switch retains the old source and state and consumes only its journal", async () => {
  const f = fixture();
  const one = await installBundle(f.paths, f.release("first\n").bundle, undefined);
  const two = await installBundle(f.paths, f.release("second\n").bundle, one);
  replacePointer(f.paths.live, releasePath(f.paths, two.current), releasePath(f.paths, one.current));
  saveJson(f.paths.state, one);
  saveJson(f.paths.journal, { version: 1, before: one, after: two });
  expect(recoverInstalled(f.paths)).toEqual(one);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, one.current));
  expect(JSON.parse(readFileSync(f.paths.state, "utf8"))).toEqual(one);
  expect(existsSync(f.paths.journal)).toBe(false);
});

test("consumer status works before user configuration parsing and performs no runtime launch", () => {
  const f = fixture();
  writeFileSync(f.paths.config, "invalid user config\n", { mode: 0o600 });
  const cli = resolve(import.meta.dir, "../skills/dori-mode/scripts/src/cli.ts");
  const result = Bun.spawnSync([process.execPath, cli, "update", "status"], {
    env: { HOME: f.paths.home, PATH: process.env["PATH"], DORI_TELEMETRY: "0", DO_NOT_TRACK: "1" },
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toEqual({ installed: false });
  expect(readFileSync(f.paths.config, "utf8")).toBe("invalid user config\n");
});
