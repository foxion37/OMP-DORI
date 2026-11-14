import type { ReleaseManifest } from "../src/release/types.ts";
import { object } from "../src/update/config.ts";
import { digest } from "../src/update/source.ts";
import { RELEASE_REPOSITORY } from "./release-gate.ts";
import { githubApi, githubAsset, githubPages } from "./release-process.ts";

export type Release = Record<string, unknown>;
const PREFIX = `repos/${RELEASE_REPOSITORY}`;

export function releaseIdentity(manifest: ReleaseManifest) {
  return {
    tag_name: manifest.tag,
    target_commitish: manifest.commit,
    name: `OMP-Dori ${manifest.tag}`,
    prerelease: manifest.prerelease,
  };
}

export function updateReleaseMetadata(
  manifest: ReleaseManifest,
  id: number,
  body: string,
  draft: boolean,
): Promise<unknown> {
  return githubApi(`${PREFIX}/releases/${id}`, "PATCH", {
    ...releaseIdentity(manifest),
    body,
    draft,
    make_latest: draft || manifest.prerelease ? "false" : "true",
  });
}

export function notes(manifest: ReleaseManifest): string {
  return [
    `OMP-Dori ${manifest.tag}${manifest.prerelease ? " Linux x64 preview" : ""}.`,
    "Supported consumer runtime: Linux x64, herdr, Discord. Other CI platforms do not imply consumer support.",
    `Requires existing Bun ${manifest.requirements.bun}, OMP ${manifest.requirements.omp}, git and herdr.`,
    `Commit: \`${manifest.commit}\`. SourceManifest: \`${manifest.source.hash}\`.`,
    `Pinned external omp-ulw: \`${manifest.ompUlw.commit}\`; dependency bodies are not bundled.`,
    `Verify all files in \`SHA256SUMS\` before running \`bash install.sh --version ${manifest.tag}\` from this release.`,
    `Installation, prerequisites and support limits: https://github.com/${RELEASE_REPOSITORY}/blob/${manifest.commit}/docs/releases.md`,
    `Publication requires all four trusted own-main CI jobs at this exact commit: https://github.com/${RELEASE_REPOSITORY}/commit/${manifest.commit}/checks`,
    "Installation starts no messenger, watcher, service or model work. Existing user configuration remains user-owned.",
    "Stop Dori before install/update/rollback; activation holds while a live actor is detected.",
  ].join("\n\n");
}

export function marker(body: string, operation: string): string {
  return `${body}\n\n<!-- omp-dori-publication:${operation} -->`;
}

export async function findRelease(manifest: ReleaseManifest): Promise<Release | undefined> {
  const matches = (await githubPages(`${PREFIX}/releases?per_page=100`)).filter(
    (value) => object(value) && value["tag_name"] === manifest.tag,
  );
  if (matches.length > 1) throw new Error("Multiple releases bind this tag; publication is ambiguous");
  if (!matches.length) return undefined;
  return getRelease(manifest, (matches[0] as Release)["id"]);
}

export async function getRelease(manifest: ReleaseManifest, id: unknown): Promise<Release> {
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("Release ID is invalid");
  const release = await githubApi(`${PREFIX}/releases/${id}`);
  if (!object(release) || release["id"] !== id || release["tag_name"] !== manifest.tag) {
    throw new Error("GitHub release identity changed during readback");
  }
  return release;
}

export function validateRelease(release: Release, manifest: ReleaseManifest, body: string, names: string[]): void {
  const allowedBodies = [body, marker(body, "publish"), ...names.map((name) => marker(body, `upload:${name}`))];
  if (
    release["tag_name"] !== manifest.tag ||
    release["target_commitish"] !== manifest.commit ||
    release["name"] !== `OMP-Dori ${manifest.tag}` ||
    release["prerelease"] !== manifest.prerelease ||
    typeof release["draft"] !== "boolean" ||
    !allowedBodies.includes(String(release["body"])) ||
    (release["draft"] === false && release["body"] !== body)
  ) {
    throw new Error("Existing release metadata is not this producer's immutable committed release");
  }
}

export async function assets(release: Release, expected: Record<string, Buffer>): Promise<Map<string, Release>> {
  const observed = new Map<string, Release>();
  for (const asset of await githubPages(`${PREFIX}/releases/${release["id"]}/assets?per_page=100`)) {
    if (
      !object(asset) ||
      typeof asset["name"] !== "string" ||
      !Object.hasOwn(expected, asset["name"]) ||
      observed.has(asset["name"]) ||
      typeof asset["id"] !== "number" ||
      !Number.isSafeInteger(asset["id"]) ||
      asset["id"] <= 0 ||
      asset["state"] !== "uploaded"
    ) {
      throw new Error("Release has an unexpected, ambiguous or incomplete asset; nothing is overwritten");
    }
    const bytes = expected[asset["name"]]!;
    const hash = digest(bytes);
    if (
      asset["size"] !== bytes.length ||
      (asset["digest"] != null && asset["digest"] !== `sha256:${hash}`) ||
      digest(await githubAsset(RELEASE_REPOSITORY, asset["id"])) !== hash
    ) {
      throw new Error(`Release asset digest differs from committed distribution: ${asset["name"]}`);
    }
    observed.set(asset["name"], asset);
  }
  return observed;
}
