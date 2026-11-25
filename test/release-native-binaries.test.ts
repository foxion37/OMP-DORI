import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertNativeExecutable,
  assertNativeHosts,
  nativeHosts,
  nativeReleasePath,
  readNativeInputs,
} from "../scripts/release-native.ts";
import { digest } from "../src/update/source.ts";
import { releaseFixture } from "./release-producer-setup.ts";

const [linux, darwin] = nativeHosts;

function elf(machine = 62): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x7f454c46, 0);
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(machine, 18);
  return bytes;
}

function machO(cpu = 0x0100000c): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(cpu, 4);
  bytes.writeUInt32LE(2, 12);
  return bytes;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function input(entries: Record<string, Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), "cataly-native-input-"));
  roots.push(root);
  for (const [path, bytes] of Object.entries(entries)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), bytes);
  }
  return root;
}

test("a public release must bundle an executable native binary for Linux x64 and Darwin arm64", () => {
  const entry = (path: string, executable = true) => ({ path, sha256: digest(path), executable });
  const both = [entry(nativeReleasePath(darwin)), entry(nativeReleasePath(linux))];
  expect(() => assertNativeHosts(releaseFixture(both))).not.toThrow();
  expect(() => assertNativeHosts(releaseFixture([entry(nativeReleasePath(linux))]))).toThrow(/darwin-arm64/);
  expect(() =>
    assertNativeHosts(releaseFixture([entry(nativeReleasePath(darwin), false), entry(nativeReleasePath(linux))])),
  ).toThrow(/darwin-arm64/);
});

test("each host's binary must be that host's executable format", () => {
  expect(() => assertNativeExecutable(linux, elf())).not.toThrow();
  expect(() => assertNativeExecutable(darwin, machO())).not.toThrow();
  expect(() => assertNativeExecutable(linux, elf(183))).toThrow(/linux-x64/);
  expect(() => assertNativeExecutable(linux, machO())).toThrow(/linux-x64/);
  expect(() => assertNativeExecutable(darwin, machO(0x01000007))).toThrow(/darwin-arm64/);
  expect(() => assertNativeExecutable(darwin, elf())).toThrow(/darwin-arm64/);
});

test("the producer accepts only other hosts' binaries, exactly as `release.ts native` lays them out", () => {
  const darwinBinary = machO();
  const accepted = readNativeInputs(input({ "darwin-arm64/cataly": darwinBinary }), linux);
  expect([...accepted.keys()]).toEqual([darwin]);
  expect(accepted.get(darwin)?.equals(darwinBinary)).toBe(true);
  expect(readNativeInputs(undefined, linux).size).toBe(0);

  // The running host's own binary is always rebuilt from committed source, never taken from an input.
  expect(() => readNativeInputs(input({ "darwin-arm64/cataly": machO() }), darwin)).toThrow(/darwin-arm64/);
  expect(() => readNativeInputs(input({ "windows-x64/cataly": elf() }), linux)).toThrow(/windows-x64/);
  expect(() =>
    readNativeInputs(input({ "darwin-arm64/cataly": machO(), "darwin-arm64/extra": machO() }), linux),
  ).toThrow(/only cataly/);
  expect(() => readNativeInputs(input({ "darwin-arm64/cataly": elf() }), linux)).toThrow(/darwin-arm64/);
});
