import { resolve } from "node:path";
import { buildRelease, verifyDistribution } from "./release-build.ts";
import { RELEASE_REPOSITORY, releaseGate } from "./release-gate.ts";
import { lockPublication } from "./release-journal.ts";
import { git } from "./release-process.ts";
import { publishRelease } from "./release-publish.ts";

async function run(args: string[]): Promise<void> {
  const [operation, ...flags] = args;
  if (!["build", "gate", "publish"].includes(operation ?? "")) {
    throw new Error(
      "Usage: bun scripts/release.ts build --out DIST [--prerelease] | gate --from DIST | publish --from DIST",
    );
  }
  let directory: string | undefined;
  let prerelease = false;
  const option = operation === "build" ? "--out" : "--from";
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === option && !directory && flags[i + 1] && !flags[i + 1]!.startsWith("--")) {
      directory = resolve(flags[++i]!);
    } else if (operation === "build" && flag === "--prerelease" && !prerelease) prerelease = true;
    else throw new Error(`Unknown, duplicate or incomplete release option: ${flag}`);
  }
  if (!directory) throw new Error(`Release ${operation} requires ${option} DIST`);
  const root = resolve(import.meta.dir, "..");
  if (operation === "build") {
    const manifest = await buildRelease(root, directory, prerelease);
    console.log(`Built ${manifest.tag} at ${manifest.commit}; public SourceManifest ${manifest.source.hash}`);
    return;
  }
  const unlock = operation === "publish" ? await lockPublication(directory) : undefined;
  try {
    const distribution = await verifyDistribution(root, directory);
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
