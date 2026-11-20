import { expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readArchive } from "../src/release/archive.ts";
import type { VerifiedBundle } from "../src/release/bundle.ts";
import { installBundle, rollbackRelease } from "../src/release/install.ts";
import { acquireLaunchGate, registerConsumerLaunch } from "../src/release/launch-leases.ts";
import { preflightReferences } from "../src/release/references.ts";
import { releasePath } from "../src/release/state.ts";
import { digest } from "../src/update/source.ts";
import { snapshot } from "../scripts/consumer-smoke-inspect.ts";
import { archive, fixture, withArchive } from "./release-consumer-setup.ts";

// POSIX-only: release installation refuses non-private directories by POSIX mode bits.
const posix = test.skipIf(process.platform === "win32");

const rendererPath = "src/release/references.ts";
const rendererModule = JSON.stringify(resolve(import.meta.dir, "../src/release/references.ts"));

function withRenderer(bundle: VerifiedBundle, text?: string): VerifiedBundle {
  const files = bundle.files.flatMap((file) =>
    file.path !== rendererPath ? [file] : text === undefined ? [] : [{ ...file, bytes: Buffer.from(text) }],
  );
  const entries = files.map((file) => ({ path: file.path, sha256: digest(file.bytes), executable: file.executable }));
  const source = {
    ...bundle.manifest.source,
    files: entries,
    hash: digest(JSON.stringify({ files: entries, ulwPresent: false })),
  };
  const bytes = archive(
    files.map((file) => ({
      name: `${bundle.manifest.archive.root}/${file.path}`,
      bytes: file.bytes,
      mode: file.executable ? 0o755 : 0o644,
    })),
  );
  const manifest = withArchive({ ...bundle.manifest, source }, bytes);
  return { manifest, files: readArchive(bytes, manifest) };
}

// Distinct admitted release renderers deliberately produce different bytes, not two copies of one template.
function renderer(version: string): string {
  return `
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { installIsolatedReferences as render } from ${rendererModule};
export function installIsolatedReferences(paths, source) {
  render(paths, source);
  const file = join(paths.dori, "bin/omp");
  const bytes = readFileSync(file, "utf8") + ${JSON.stringify(`# Release ${version} wrapper\n`)};
  writeFileSync(file, bytes);
  const receipt = join(paths.root, "consumer-references.json");
  const digests = JSON.parse(readFileSync(receipt, "utf8"));
  digests["bin/omp"] = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(receipt, JSON.stringify(digests));
}
`;
}

posix("isolated update and rollback restore exact release-specific wrapper bytes, modes and receipt", async () => {
  const f = fixture(true);
  const first = withRenderer(f.release("one").bundle, renderer("A"));
  const one = await installBundle(f.paths, first, undefined);
  const wrappers = snapshot(join(f.paths.dori, "bin"));
  const receipt = readFileSync(join(f.paths.root, "consumer-references.json"));
  const config = readFileSync(f.paths.config);
  expect(readFileSync(join(f.paths.dori, "bin/omp"), "utf8")).toEndWith("# Release A wrapper\n");
  const second = withRenderer(f.release("two").bundle, renderer("B"));
  const two = await installBundle(f.paths, second, one);
  expect(readFileSync(join(f.paths.dori, "bin/omp"), "utf8")).toEndWith("# Release B wrapper\n");
  expect(snapshot(join(f.paths.dori, "bin"))).not.toBe(wrappers);
  await rollbackRelease(f.paths, two);
  expect(snapshot(join(f.paths.dori, "bin"))).toBe(wrappers);
  expect(readFileSync(join(f.paths.root, "consumer-references.json"))).toEqual(receipt);
  expect(readFileSync(f.paths.config)).toEqual(config);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, one.current));
  preflightReferences(f.paths);
});

posix.each([
  ["missing", undefined, "no authenticated consumer reference renderer"],
  ["missing export", "export const unrelated = true;\n", "has no installer"],
  ["import error", 'throw new Error("renderer import failed");\n', "renderer import failed"],
  [
    "installer error",
    'export function installIsolatedReferences() { throw new Error("renderer failed"); }\n',
    "renderer failed",
  ],
] as const)("a selected renderer with %s holds before activation", async (_name, text, error) => {
  const f = fixture(true);
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const wrappers = snapshot(join(f.paths.dori, "bin"));
  const state = readFileSync(f.paths.state);
  const config = readFileSync(f.paths.config);
  const candidate = withRenderer(f.release("two").bundle, text);
  await expect(installBundle(f.paths, candidate, one)).rejects.toThrow(error);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, one.current));
  expect(readFileSync(f.paths.state)).toEqual(state);
  expect(readFileSync(f.paths.config)).toEqual(config);
  expect(snapshot(join(f.paths.dori, "bin"))).toBe(wrappers);
  acquireLaunchGate(f.paths)();
});

posix("a live launch lease blocks even the target renderer's top-level code", async () => {
  const f = fixture(true);
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const marker = join(f.root, "renderer-imported");
  const next = withRenderer(
    f.release("two").bundle,
    `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported");
     export { installIsolatedReferences } from ${rendererModule};`,
  );
  const unlock = acquireLaunchGate(f.paths);
  try {
    registerConsumerLaunch(f.paths, process.pid);
  } finally {
    unlock();
  }
  await expect(installBundle(f.paths, next, one)).rejects.toThrow("Live consumer launch");
  expect(existsSync(marker)).toBe(false);
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, one.current));
});

posix("a tampered retained renderer is rejected before rollback import or reference publication", async () => {
  const f = fixture(true);
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const two = await installBundle(f.paths, f.release("two").bundle, one);
  const wrappers = snapshot(join(f.paths.dori, "bin"));
  const state = readFileSync(f.paths.state);
  const file = join(releasePath(f.paths, one.current), rendererPath);
  chmodSync(file, 0o600);
  writeFileSync(file, 'throw new Error("tampered renderer executed");\n');
  await expect(rollbackRelease(f.paths, two)).rejects.toThrow("Retained release source bytes");
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, two.current));
  expect(readFileSync(f.paths.state)).toEqual(state);
  expect(snapshot(join(f.paths.dori, "bin"))).toBe(wrappers);
});

posix("postflight reference admission rejects an inconsistent target renderer before activation", async () => {
  const f = fixture(true);
  const one = await installBundle(f.paths, f.release("one").bundle, undefined);
  const candidate = withRenderer(
    f.release("two").bundle,
    `import {writeFileSync} from "node:fs";
     export function installIsolatedReferences(paths) { writeFileSync(paths.dori + "/bin/omp", "unreceipted"); }`,
  );
  await expect(installBundle(f.paths, candidate, one)).rejects.toThrow("Consumer reference changed");
  expect(readlinkSync(f.paths.live)).toBe(releasePath(f.paths, one.current));
});
