import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digest } from "../src/update/source.ts";
import { buildRelease, verifyDistribution } from "./release-build.ts";
import { RELEASE_REPOSITORY, releaseGate } from "./release-gate.ts";
import { lockPublication } from "./release-journal.ts";
import { assertNativeHosts, buildReproducibleNative, nativeHostName } from "./release-native.ts";
import { git } from "./release-process.ts";
import { publishRelease } from "./release-publish.ts";

const USAGE =
  "Usage: bun scripts/release.ts build --out DIST [--prerelease] [--native DIR] | gate --from DIST [--native DIR] | " +
  "publish --from DIST [--native DIR] | native --out DIR";

async function run(args: string[]): Promise<void> {
  const [operation, ...flags] = args;
  if (!["build", "gate", "publish", "native"].includes(operation ?? "")) throw new Error(USAGE);
  let directory: string | undefined;
  let nativeInput: string | undefined;
  let prerelease = false;
  const option = operation === "build" || operation === "native" ? "--out" : "--from";
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    const value = flags[i + 1] && !flags[i + 1]!.startsWith("--") ? flags[i + 1] : undefined;
    if (flag === option && !directory && value) {
      directory = resolve(value);
      i++;
    } else if (flag === "--native" && operation !== "native" && !nativeInput && value) {
      nativeInput = resolve(value);
      i++;
    } else if (operation === "build" && flag === "--prerelease" && !prerelease) prerelease = true;
    else throw new Error(`Unknown, duplicate or incomplete release option: ${flag}`);
  }
  if (!directory) throw new Error(`Release ${operation} requires ${option} DIR`);
  const root = resolve(import.meta.dir, "..");
  if (operation === "native") {
    // Runs on the host that owns the binary; the Linux x64 producer receives it as `--native DIR`.
    const { host, binary } = await buildReproducibleNative(root);
    const target = join(directory, nativeHostName(host));
    mkdirSync(target, { recursive: true, mode: 0o700 });
    writeFileSync(join(target, "cataly"), binary, { flag: "wx", mode: 0o755 });
    console.log(`Built reproducible ${nativeHostName(host)} native Cataly ${digest(binary)}`);
    return;
  }
  if (operation === "build") {
    const manifest = await buildRelease(root, directory, prerelease, nativeInput);
    console.log(`Built ${manifest.tag} at ${manifest.commit}; public SourceManifest ${manifest.source.hash}`);
    return;
  }
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("Public release gating and publication require the Linux x64 native producer");
  const unlock = operation === "publish" ? await lockPublication(directory) : undefined;
  try {
    const distribution = await verifyDistribution(root, directory, nativeInput);
    assertNativeHosts(distribution.manifest);
    if (
      (process.env["GITHUB_REPOSITORY"] && process.env["GITHUB_REPOSITORY"] !== RELEASE_REPOSITORY) ||
      (process.env["GITHUB_REF"]?.startsWith("refs/tags/") &&
        process.env["GITHUB_REF"] !== `refs/tags/${distribution.manifest.tag}`)
    ) {
      throw new Error("Workflow repository/tag differs from the canonical release");
    }
    const tagged = (await git(root, ["rev-parse", "--verify", `refs/tags/${distribution.manifest.tag}^{commit}`]))
      .toString()
      .trim();
    if (tagged !== distribution.manifest.commit)
      throw new Error("Local version tag does not identify actual committed HEAD");
    if (operation === "gate") await releaseGate(distribution.manifest);
    else await publishRelease(directory, distribution);
    console.log(`${operation} succeeded for ${distribution.manifest.tag} at ${distribution.manifest.commit}`);
  } finally {
    await unlock?.();
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
