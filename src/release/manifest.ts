import { hasControl, object } from "../update/config.ts";
import { digest } from "../update/source.ts";
import type { SourceEntry, SourceManifest } from "../update/types.ts";
import type { ReleaseManifest } from "./types.ts";
import { isReleaseVersion } from "./version.ts";

const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const PRIVATE: Readonly<Record<string, true>> = {
  ".git": true,
  node_modules: true,
  ".cataly": true,
  ".omp-cataly": true,
  ".omp": true,
  ".omo": true,
  ".cache": true,
  ".DS_Store": true,
  ".env": true,
  "auth.json": true,
  "credentials.json": true,
};
const RUNTIME: Readonly<Record<string, true>> = {
  "config.json": true,
  state: true,
  sessions: true,
  auth: true,
  bin: true,
  cache: true,
  tmp: true,
  globalextensions: true,
  ref: true,
  ".qa-home": true,
  evidence: true,
};
/** Every release ships its bound native OMP payload, headless profiles and consumer launcher. */
const REQUIRED = [
  "native-omp.lock",
  "native-omp.patch",
  "native-addon/package.json",
  "native-addon/bun.lock",
  "release-headless.json",
  "scripts/source-dependencies.ts",
  "scripts/previous-install/cli.ts",
  "scripts/consumer/omp",
] as const;

function record(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (!object(value) || Object.keys(value).sort().join("\0") !== keys.sort().join("\0")) {
    throw new Error(`Invalid release ${label}`);
  }
  return value;
}

const matches = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value);

/** Matches the existing source snapshot exclusions, with every external ref excluded from public assets. */
export function publicReleasePath(path: string): boolean {
  const parts = path.split("/");
  return (
    !hasControl(path, true) &&
    !path.includes("\\") &&
    !path.includes(":") &&
    parts.every((part) => part !== "" && part !== "." && part !== "..") &&
    RUNTIME[parts[0]!] !== true &&
    !parts.some(
      (part) =>
        PRIVATE[part] === true || /^\.env\.(?!example$|sample$)/.test(part) || /\.(?:pem|key|p12|pfx|tmp)$/.test(part),
    )
  );
}

function sourceManifest(value: unknown): SourceManifest {
  const source = record(value, ["version", "hash", "files", "excluded"], "source manifest");
  if (
    source["version"] !== 1 ||
    !matches(source["hash"], HASH) ||
    !Array.isArray(source["files"]) ||
    !source["files"].length ||
    !Array.isArray(source["excluded"]) ||
    source["excluded"].length > 0
  ) {
    throw new Error("Release source must be a complete public SourceManifest");
  }
  const files: SourceEntry[] = [];
  const paths = new Set<string>();
  for (const value of source["files"]) {
    const entry = record(value, ["path", "sha256", "executable"], "source entry");
    const path = entry["path"];
    if (
      typeof path !== "string" ||
      !publicReleasePath(path) ||
      !matches(entry["sha256"], HASH) ||
      typeof entry["executable"] !== "boolean" ||
      (files.length > 0 && files.at(-1)!.path >= path) ||
      path
        .split("/")
        .slice(0, -1)
        .some((_, i, parts) => paths.has(parts.slice(0, i + 1).join("/")))
    ) {
      throw new Error("Release source contains an unsafe, unordered or conflicting path/digest/mode");
    }
    paths.add(path);
    files.push({ path, sha256: entry["sha256"], executable: entry["executable"] });
  }
  if (digest(JSON.stringify({ files })) !== source["hash"]) {
    throw new Error("Release source manifest hash does not match its files and executable modes");
  }
  return { version: 1, hash: source["hash"], files, excluded: [] };
}

/** Validates metadata before any archive download, extraction, dependency fetch or source activation. */
export function validateReleaseManifest(value: unknown): ReleaseManifest {
  const manifest = record(
    value,
    [
      "version",
      "product",
      "releaseVersion",
      "tag",
      "commit",
      "tree",
      "prerelease",
      "archive",
      "source",
      "requirements",
    ],
    "manifest",
  );
  const version = manifest["releaseVersion"];
  if (
    manifest["version"] !== 2 ||
    manifest["product"] !== "cataly" ||
    !isReleaseVersion(version) ||
    manifest["tag"] !== `v${version}` ||
    !matches(manifest["commit"], COMMIT) ||
    !matches(manifest["tree"], COMMIT) ||
    typeof manifest["prerelease"] !== "boolean"
  ) {
    throw new Error("Release identity/version/tag/commit/tree is invalid");
  }
  const archive = record(manifest["archive"], ["name", "root", "sha256", "bytes"], "archive");
  if (
    archive["name"] !== `cataly-v${version}.tar.gz` ||
    archive["root"] !== `cataly-${version}` ||
    !matches(archive["sha256"], HASH) ||
    typeof archive["bytes"] !== "number" ||
    !Number.isSafeInteger(archive["bytes"]) ||
    archive["bytes"] <= 0
  ) {
    throw new Error("Release archive name/root/digest/size is invalid");
  }
  const requirements = record(manifest["requirements"], ["omp"], "requirements");
  const omp = requirements["omp"];
  if (!matches(omp, /^19\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/))
    throw new Error("Release requirements do not match the supported runtime");
  const publicSource = sourceManifest(manifest["source"]);
  for (const path of REQUIRED)
    if (!publicSource.files.some((file) => file.path === path))
      throw new Error(`Release source bundle is incomplete: ${path}`);
  if (!publicSource.files.find((file) => file.path === "scripts/consumer/omp")?.executable)
    throw new Error("Release source bundle OMP wrapper must be executable");
  return {
    version: 2,
    product: "cataly",
    releaseVersion: version,
    tag: `v${version}`,
    commit: manifest["commit"],
    tree: manifest["tree"],
    prerelease: manifest["prerelease"],
    archive: {
      name: `cataly-v${version}.tar.gz`,
      root: `cataly-${version}`,
      sha256: archive["sha256"],
      bytes: archive["bytes"],
    },
    source: publicSource,
    requirements: { omp },
  };
}
