import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { headlessReleaseProfiles, nativeMetadata } from "../src/release/capabilities.ts";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { isReleaseVersion, releaseVersion } from "../src/release/version.ts";
import { readSourceBundle } from "../src/release/source-bundle.ts";
import { digest, sameManifest, sourceManifest } from "../src/update/source.ts";
import { command, git } from "./release-process.ts";
import { committedSource } from "./release-source.ts";
import {
  buildNativeRelease,
  currentNativeHost,
  nativeHosts,
  nativeReleasePath,
  readNativeInputs,
  readRegularFile as readAsset,
} from "./release-native.ts";

export type Distribution = { manifest: ReleaseManifest; assets: Record<string, Buffer> };

/**
 * Package committed blobs plus the native binaries: the running host's own, rebuilt here, and any other host's from
 * `nativeInput` (see `readNativeInputs`).
 */
export function buildRelease(
  root: string,
  output: string,
  prerelease: boolean,
  nativeInput?: string,
): Promise<ReleaseManifest> {
  return buildReleaseAssets(root, output, prerelease, nativeInput);
}

async function buildReleaseAssets(
  root: string,
  output: string,
  prerelease: boolean,
  nativeInput: string | undefined,
): Promise<ReleaseManifest> {
  const commit = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
  const tree = (await git(root, ["rev-parse", "--verify", `${commit}^{tree}`])).toString().trim();
  return packageReleaseTree({ root, commit, tree }, output, prerelease, nativeInput);
}

/** Package one immutable tree. The publishing gate still independently regenerates from actual committed HEAD. */
export async function packageReleaseTree(
  identity: { readonly root: string; readonly commit: string; readonly tree: string },
  output: string,
  prerelease: boolean,
  nativeInput?: string,
): Promise<ReleaseManifest> {
  if (!isReleaseVersion(releaseVersion)) throw new Error("Canonical package version is not a release version");
  const { root, commit, tree } = identity;
  const local = currentNativeHost();
  const binaries = readNativeInputs(nativeInput, local);
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), "cataly-release-")));
  try {
    const archiveRoot = `cataly-${releaseVersion}`;
    const source = join(temporary, archiveRoot);
    const committed = await committedSource(root, tree, source);
    if (lstatSync(join(source, "native-bin"), { throwIfNoEntry: false }))
      throw new Error("Committed source uses the reserved native-bin release path");
    // Hosts without a native release target still build source-only distributions.
    if (local) binaries.set(local, await buildNativeRelease(source, temporary, local, committed));
    for (const host of nativeHosts) {
      const binary = binaries.get(host);
      if (!binary) continue;
      const artifact = join(source, nativeReleasePath(host));
      mkdirSync(dirname(artifact), { recursive: true, mode: 0o700 });
      writeFileSync(artifact, binary, { flag: "wx" });
      chmodSync(artifact, 0o755);
    }
    const observed = sourceManifest(source);
    const packageData: unknown = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    if (
      typeof packageData !== "object" ||
      packageData === null ||
      (packageData as Record<string, unknown>)["version"] !== releaseVersion
    ) {
      throw new Error("Committed package version differs from the canonical producer version");
    }
    for (const name of [
      "LICENSE",
      "LICENSE.integration",
      "NOTICE",
      "install.sh",
      "native-omp.lock",
      "native-omp.patch",
      "native-addon/package.json",
      "native-addon/bun.lock",
      "scripts/source-dependencies.ts",
      "scripts/consumer/omp",
      nativeMetadata,
    ]) {
      if (!observed.files.some((file) => file.path === name)) throw new Error(`Committed release is missing ${name}`);
    }
    const native = readSourceBundle(source);
    const paths = new Set([archiveRoot]);
    for (const file of observed.files) {
      let parent = dirname(`${archiveRoot}/${file.path}`);
      while (parent !== ".") {
        paths.add(parent);
        parent = dirname(parent);
      }
      paths.add(`${archiveRoot}/${file.path}`);
    }
    const tar = await command(
      [
        "tar",
        "--format=ustar",
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
        "--mode=u=rwX,go=rX",
        "--no-recursion",
        "--hard-dereference",
        "-cf",
        "-",
        "-C",
        temporary,
        "--null",
        "-T",
        "-",
      ],
      temporary,
      `${[...paths].sort().join("\0")}\0`,
    );
    const archive = await command(["gzip", "-n", "-9", "-c"], temporary, tar);
    if (!sameManifest(observed, sourceManifest(source))) throw new Error("Source changed during release packaging");
    const manifest = validateReleaseManifest({
      version: 2,
      product: "cataly",
      releaseVersion,
      tag: `v${releaseVersion}`,
      commit,
      tree,
      prerelease,
      archive: {
        name: `cataly-v${releaseVersion}.tar.gz`,
        root: archiveRoot,
        sha256: digest(archive),
        bytes: archive.length,
      },
      source: observed,
      requirements: { omp: native.lock.nativeVersion },
    });
    const profiles = headlessReleaseProfiles(manifest, readFileSync(join(source, nativeMetadata)));
    for (const host of nativeHosts) {
      if (!profiles.some((profile) => profile.platform === host.platform && profile.arch === host.arch))
        throw new Error(`Release must provide headless on ${host.platform}/${host.arch}`);
    }
    const assets: Record<string, Buffer> = {
      [manifest.archive.name]: archive,
      "install.sh": readFileSync(join(source, "install.sh")),
      "release-manifest.json": Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
    };
    const sums = Object.keys(assets)
      .sort()
      .map((name) => `${digest(assets[name]!)}  ${name}\n`)
      .join("");
    assets["SHA256SUMS"] = Buffer.from(sums);
    mkdirSync(resolve(output), { mode: 0o700 });
    for (const [name, bytes] of Object.entries(assets)) {
      writeFileSync(join(output, name), bytes, { flag: "wx", mode: name === "install.sh" ? 0o755 : 0o644 });
    }
    return manifest;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Regeneration binds every input asset to actual HEAD without extracting any untrusted distribution bytes. Other hosts'
 * binaries cannot be rebuilt here; the same `nativeInput` must reproduce them.
 */
export async function verifyDistribution(root: string, directory: string, nativeInput?: string): Promise<Distribution> {
  const manifest = validateReleaseManifest(JSON.parse(readAsset(directory, "release-manifest.json").toString("utf8")));
  const names = [manifest.archive.name, "install.sh", "release-manifest.json", "SHA256SUMS"];
  const assets = Object.fromEntries(names.map((name) => [name, readAsset(directory, name)]));
  const temporary = mkdtempSync(join(tmpdir(), "cataly-dist-check-"));
  try {
    const expected = await buildReleaseAssets(root, join(temporary, "dist"), manifest.prerelease, nativeInput);
    if (!sameManifest(manifest.source, expected.source))
      throw new Error("Distribution source is not actual committed HEAD");
    for (const name of names) {
      if (!assets[name]!.equals(readAsset(join(temporary, "dist"), name))) {
        throw new Error(`Distribution differs from actual committed HEAD: ${name}`);
      }
    }
    return { manifest, assets };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
