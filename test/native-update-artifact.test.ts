import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishNativeUpdate } from "../scripts/update-native-omp-publish.ts";
import { readNativeArtifact } from "../src/release/native-update-artifact.ts";
import { validateNativeDependencies } from "../src/release/native-update-dependencies.ts";
import { prepareNativeUpdate } from "../src/release/native-update.ts";
import { fixtureDependencyFiles, nativeUpdateFixture } from "./native-update-fixture.test.ts";
import { NativeGithubFixture } from "./native-update-publisher-fixture.test.ts";

// POSIX-only: these fixtures require private mode bits, executable shebangs and /bin/sh Git admission.
const posix = test.skipIf(process.platform === "win32");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function candidate(conflict = false) {
  const f = nativeUpdateFixture(roots);
  f.advance("19.0.1", conflict);
  await prepareNativeUpdate(f.source, f.output, f.remote, fixtureDependencyFiles);
  return f;
}

posix("unexpected files, directories, symlinks and oversized receipts never reach the write API", async () => {
  const f = await candidate();
  const github = new NativeGithubFixture(f.source, f.sourceCommit);
  const unexpected = join(f.output, "execute.ts");
  writeFileSync(unexpected, "throw new Error('must not execute')");
  await expect(publishNativeUpdate(f.source, f.output, "12", github.api)).rejects.toThrow("Unexpected");
  rmSync(unexpected);
  mkdirSync(join(f.output, ".github"));
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("Unexpected");
  rmSync(join(f.output, ".github"), { recursive: true });
  symlinkSync(f.source, join(f.output, "escape"));
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("real file");
  rmSync(join(f.output, "escape"));
  writeFileSync(join(f.output, "candidate.json"), "x".repeat(4 * 1024 * 1024 + 1));
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("too large");
  expect(github.writes).toHaveLength(0);
});

posix("manifest scripts cannot change, even when the selected version is otherwise correct", async () => {
  const f = await candidate();
  const path = join(f.output, "extension/package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.scripts.postinstall = "echo attacker";
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("more than");
});

posix("frozen locks reject wrong version, file dependencies and forged workspace pins", async () => {
  const f = await candidate();
  const path = join(f.output, "native-addon/bun.lock");
  const original = readFileSync(path, "utf8");
  const lock = JSON.parse(original);
  lock.packages["@oh-my-pi/pi-natives"][0] = "@oh-my-pi/pi-natives@19.0.2";
  writeFileSync(path, JSON.stringify(lock));
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("exact selected");
  lock.packages["@oh-my-pi/pi-natives"][0] = "@oh-my-pi/pi-natives@19.0.1";
  lock.packages["malicious"] = ["malicious@1.0.0", "file:../../payload", {}, "sha512-AAAA"];
  writeFileSync(path, JSON.stringify(lock));
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("unexpected package source");
  writeFileSync(path, original.replace('"19.0.1"', '"19.0.2"'));
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("workspace");
});

posix("Bun trailing commas are data; quoted strings are never rewritten by lock parsing", async () => {
  const f = await candidate();
  for (const directory of ["native-addon", "extension", "test/fixtures/omp-native-host"]) {
    const path = join(f.output, directory, "bun.lock");
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace(/}$/, ",}"));
  }
  expect(() => validateNativeDependencies(f.source, f.output, "19.0.0", "19.0.1")).not.toThrow();
  const path = join(f.output, "native-addon/bun.lock");
  const lock = JSON.parse(readFileSync(path, "utf8").replace(/,}$/, "}"));
  lock.packages["@oh-my-pi/pi-natives"][2] = { description: "keep ,} and ,] within quoted strings" };
  writeFileSync(path, JSON.stringify(lock));
  expect(() => validateNativeDependencies(f.source, f.output, "19.0.0", "19.0.1")).not.toThrow();
});

posix("receipt injection, wrong previous identity, altered patch and forged conflict bytes are rejected", async () => {
  const f = await candidate();
  const path = join(f.output, "candidate.json");
  const receipt = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...receipt, reason: "clean-three-way-apply\n@attacker" }));
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("receipt");
  writeFileSync(path, JSON.stringify({ ...receipt, previousIdentity: "a".repeat(64) }));
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("previous bundle identity");
  writeFileSync(path, JSON.stringify(receipt));
  writeFileSync(join(f.output, "native-omp.patch"), "altered");
  expect(() => readNativeArtifact(f.source, f.output)).toThrow("patch digest");
  const conflict = await candidate(true);
  writeFileSync(join(conflict.output, "conflicts.patch"), "forged");
  expect(() => readNativeArtifact(conflict.source, conflict.output)).toThrow("conflict artifact digest");
});
