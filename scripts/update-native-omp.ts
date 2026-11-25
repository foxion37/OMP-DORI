import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { regularFile } from "../src/release/files.ts";
import { prepareNativeUpdate } from "../src/release/native-update.ts";
import { assertSourceBundle, bundleGit, readSourceBundle, type SourceBundle } from "../src/release/source-bundle.ts";
import { generateSourceBundle } from "../src/release/source-bundle-update.ts";

/** Maintainer capture mode preserves the reviewed staged overlay, never stages or resolves changes. */
export async function captureNativeUpdate(source: string, checkout: string, commit: string, version: string) {
  if (!/^[a-f0-9]{40}$/.test(commit) || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
    throw new Error("Native capture requires an exact commit and stable semantic version");
  source = realpathSync(source);
  checkout = realpathSync(checkout);
  const previous = readSourceBundle(source).lock;
  const launcher = previous.launcher;
  if (
    typeof launcher !== "string" ||
    !regularFile(join(checkout, launcher)) ||
    (lstatSync(join(checkout, launcher)).mode & 0o111) === 0
  )
    throw new Error("Native source lock requires an existing executable launcher");
  const manifest = join(checkout, "packages/coding-agent/package.json");
  if (!regularFile(manifest) || JSON.parse(readFileSync(manifest, "utf8")).version !== version)
    throw new Error("Native package version differs from the requested release");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "cataly-native-metadata-")));
  try {
    if ((await bundleGit(["rev-parse", "--verify", "HEAD^{commit}"], checkout, home)) !== commit)
      throw new Error("Native checkout differs from the exact requested commit");
    const patchPath = join(home, "native-omp.patch");
    const captured = await generateSourceBundle(checkout, patchPath, previous.repository, home);
    const lock: SourceBundle = { ...captured, nativeVersion: version, launcher };
    const text = `${JSON.stringify(lock, null, 2)}\n`;
    writeFileSync(join(home, "native-omp.lock"), text, { mode: 0o600 });
    assertSourceBundle(checkout, readSourceBundle(home), home);
    writeFileSync(join(source, "native-omp.patch"), readFileSync(patchPath));
    writeFileSync(join(source, "native-omp.lock"), text);
    return { commit, version, resultTree: lock.resultTree, files: lock.files.length };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      strict: true,
      options: {
        checkout: { type: "string" },
        source: { type: "string" },
        commit: { type: "string" },
        version: { type: "string" },
        out: { type: "string" },
      },
    });
    const source = resolve(values.source ?? join(import.meta.dir, ".."));
    if (values.out && !values.checkout && !values.commit && !values.version) {
      console.log(JSON.stringify((await prepareNativeUpdate(source, resolve(values.out))) ?? { status: "unchanged" }));
    } else if (!values.out && values.checkout && values.commit && values.version) {
      console.log(
        JSON.stringify(await captureNativeUpdate(source, resolve(values.checkout), values.commit, values.version)),
      );
    } else {
      throw new Error(
        "Usage: bun scripts/update-native-omp.ts --out DIRECTORY [--source SOURCE] | --checkout CHECKOUT --commit EXACT_SHA --version VERSION [--source SOURCE]",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
