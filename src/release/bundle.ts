import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { digest } from "../update/source.ts";
import { type ArchiveFile, readArchive } from "./archive.ts";
import { regularFile } from "./files.ts";
import { validateReleaseManifest } from "./manifest.ts";
import type { ReleaseManifest } from "./types.ts";

const API = "https://api.github.com/repos/vntrevx/omp-dori";
const DOWNLOAD = "https://github.com/vntrevx/omp-dori/releases/download";
const TAG = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export type ReleaseSelection = { readonly version?: string; readonly from?: string };
export type VerifiedBundle = { readonly manifest: ReleaseManifest; readonly files: readonly ArchiveFile[] };
type GithubRelease = {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly prerelease: boolean;
  readonly assets: readonly { readonly name: string; readonly browser_download_url: string }[];
};

async function download(url: string, max: number): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { Accept: url.startsWith(API) ? "application/vnd.github+json" : "application/octet-stream" },
    signal: AbortSignal.timeout(120_000),
    redirect: "follow",
  });
  if (!response.ok) {
    if (url === `${API}/releases/latest` && response.status === 404)
      throw new Error("No stable OMP-Dori release exists yet; select an explicit preview with --version vX.Y.Z");
    throw new Error(`Anonymous release download failed (${response.status}): ${url}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!response.body) throw new Error("Release download has no body");
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > max) throw new Error("Release download exceeds its size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function githubJson(path: string): Promise<unknown> {
  return JSON.parse((await download(`${API}${path}`, 4 * 1024 * 1024)).toString("utf8"));
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function githubRelease(version?: string): Promise<GithubRelease> {
  const value = await githubJson(version ? `/releases/tags/${encodeURIComponent(version)}` : "/releases/latest");
  if (
    !object(value) ||
    typeof value["tag_name"] !== "string" ||
    !TAG.test(value["tag_name"]) ||
    value["draft"] !== false ||
    typeof value["prerelease"] !== "boolean" ||
    (!version && value["prerelease"] !== false) ||
    (version && value["tag_name"] !== version) ||
    !Array.isArray(value["assets"])
  )
    throw new Error("GitHub release metadata differs from the requested published release");
  const assets = value["assets"].map((asset: unknown) => {
    if (!object(asset) || typeof asset["name"] !== "string" || typeof asset["browser_download_url"] !== "string")
      throw new Error("Invalid GitHub release asset metadata");
    return { name: asset["name"], browser_download_url: asset["browser_download_url"] };
  });
  return { tag_name: value["tag_name"], draft: false, prerelease: value["prerelease"], assets };
}

async function assertTag(manifest: ReleaseManifest): Promise<void> {
  let value = await githubJson(`/git/ref/tags/${encodeURIComponent(manifest.tag)}`);
  if (!object(value) || !object(value["object"])) throw new Error("Published Git tag is missing");
  let target = value["object"];
  for (let depth = 0; target["type"] === "tag" && depth < 4; depth++) {
    if (typeof target["sha"] !== "string" || !/^[a-f0-9]{40}$/.test(target["sha"]))
      throw new Error("Published annotated tag identity is invalid");
    value = await githubJson(`/git/tags/${target["sha"]}`);
    if (!object(value) || !object(value["object"])) throw new Error("Published annotated tag is incomplete");
    target = value["object"];
  }
  if (target["type"] !== "commit" || target["sha"] !== manifest.commit)
    throw new Error("Release manifest commit differs from its published tag");
  const commit = await githubJson(`/git/commits/${manifest.commit}`);
  if (!object(commit) || !object(commit["tree"]) || commit["tree"]["sha"] !== manifest.tree)
    throw new Error("Release manifest tree differs from its published commit");
}

function checksum(sums: string, name: string, bytes: Uint8Array): void {
  const matches = sums.split("\n").filter((line) => line.endsWith(`  ${name}`));
  if (matches.length !== 1 || matches[0] !== `${digest(bytes)}  ${name}`)
    throw new Error(`Release checksum differs: ${name}`);
}

export async function acquireBundle(selection: ReleaseSelection): Promise<VerifiedBundle> {
  if (selection.version && !TAG.test(selection.version)) throw new Error("--version must be an exact vX.Y.Z tag");
  const remote = selection.from ? undefined : await githubRelease(selection.version);
  const read = async (name: string, max: number): Promise<Buffer> => {
    if (selection.from) {
      const path = join(resolve(selection.from), name);
      if (!regularFile(path)) throw new Error(`Missing release asset: ${path}`);
      const bytes = readFileSync(path);
      if (bytes.byteLength > max) throw new Error(`Release asset exceeds its limit: ${name}`);
      return bytes;
    }
    const url = `${DOWNLOAD}/${remote!.tag_name}/${name}`;
    const matches = remote!.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1 || matches[0]?.browser_download_url !== url)
      throw new Error(`Missing canonical published asset: ${name}`);
    return download(url, max);
  };
  const [metadata, sumsBytes] = await Promise.all([
    read("release-manifest.json", 4 * 1024 * 1024),
    read("SHA256SUMS", 64 * 1024),
  ]);
  const sums = sumsBytes.toString("utf8");
  checksum(sums, "release-manifest.json", metadata);
  const manifest = validateReleaseManifest(JSON.parse(metadata.toString("utf8")));
  if (selection.version && manifest.tag !== selection.version) throw new Error("Local release has a different tag");
  if (remote) {
    if (manifest.tag !== remote.tag_name || manifest.prerelease !== remote.prerelease)
      throw new Error("Release manifest and published release differ");
    await assertTag(manifest);
  }
  const archive = await read(manifest.archive.name, 128 * 1024 * 1024);
  checksum(sums, manifest.archive.name, archive);
  return { manifest, files: readArchive(archive, manifest) };
}
