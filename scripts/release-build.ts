import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateReleaseManifest } from "../src/release/manifest.ts";
import type { ReleaseManifest } from "../src/release/types.ts";
import { isReleaseVersion, releaseVersion } from "../src/release/version.ts";
import { digest, sameManifest, sourceManifest } from "../src/update/source.ts";
import { command, git } from "./release-process.ts";
import { committedSource } from "./release-source.ts";

export type Distribution = { manifest: ReleaseManifest; assets: Record<string, Buffer> };

function readAsset(directory: string, name: string): Buffer {
  if (!lstatSync(directory).isDirectory()) throw new Error("Distribution must be a real directory");
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Release asset must be a regular file: ${name}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Only committed blobs selected by the public SourceManifest policy ever enter the archive. */
export async function buildRelease(root: string, output: string, prerelease: boolean): Promise<ReleaseManifest> {
  if (!isReleaseVersion(releaseVersion)) throw new Error("Canonical package version is not a release version");
  const commit = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).toString().trim();
  const tree = (await git(root, ["rev-parse", "--verify", `${commit}^{tree}`])).toString().trim();
  const temporary = mkdtempSync(join(tmpdir(), "omp-dori-release-"));
  try {
    const archiveRoot = `omp-dori-${releaseVersion}`;
    const source = join(temporary, archiveRoot);
    const observed = await committedSource(root, commit, source);
    const packageData: unknown = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    if (
      typeof packageData !== "object" ||
      packageData === null ||
      (packageData as Record<string, unknown>)["version"] !== releaseVersion
    ) {
      throw new Error("Committed package version differs from the canonical producer version");
    }
    for (const name of ["LICENSE", "LICENSE.omp-dori", "NOTICE", "install.sh", "omp-ulw.lock"]) {
      if (!observed.files.some((file) => file.path === name)) throw new Error(`Committed release is missing ${name}`);
    }
    const pin = readFileSync(join(source, "omp-ulw.lock"), "utf8").trim();
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
      [...paths].sort().join("\0") + "\0",
    );
    const archive = await command(["gzip", "-n", "-9", "-c"], temporary, tar);
    if (!sameManifest(observed, sourceManifest(source))) throw new Error("Source changed during release packaging");
    const manifest = validateReleaseManifest({
      version: 1,
      product: "omp-dori",
      releaseVersion,
      tag: `v${releaseVersion}`,
      commit,
      tree,
      prerelease,
      archive: {
        name: `omp-dori-v${releaseVersion}.tar.gz`,
        root: archiveRoot,
        sha256: digest(archive),
        bytes: archive.length,
      },
      source: observed,
      requirements: {
        platform: "linux",
        arch: "x64",
        bun: "1.4.4",
        omp: "18.18.8",
        runtime: "herdr",
        messenger: "discord",
      },
      ompUlw: { repository: "https://github.com/dbc-hbin/omp-ulw.git", commit: pin },
    });
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

/** Regeneration binds every input asset to actual HEAD without extracting any untrusted distribution bytes. */
export async function verifyDistribution(root: string, directory: string): Promise<Distribution> {
  const manifest = validateReleaseManifest(JSON.parse(readAsset(directory, "release-manifest.json").toString("utf8")));
  const names = [manifest.archive.name, "install.sh", "release-manifest.json", "SHA256SUMS"];
  const assets = Object.fromEntries(names.map((name) => [name, readAsset(directory, name)]));
  const temporary = mkdtempSync(join(tmpdir(), "omp-dori-dist-check-"));
  try {
    const expected = await buildRelease(root, join(temporary, "dist"), manifest.prerelease);
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
