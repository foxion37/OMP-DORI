import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { UpdateError } from "./config.ts";
import type { PublicationProcess } from "./publish-process.ts";
import type { PublicationBasis } from "./publish-types.ts";
import { assertSource, digest, sameManifest, sourceManifest } from "./source.ts";
import { saveJson } from "./state.ts";
import type { SourceEntry, SourceManifest, UpdateJob } from "./types.ts";

function publicManifest(stored: SourceManifest): SourceManifest {
  const files = stored.files.filter((file) => file.path !== "ref/omp-ulw" && !file.path.startsWith("ref/omp-ulw/"));
  if (!files.length) throw new UpdateError("public source export is empty");
  return {
    version: 1,
    hash: digest(JSON.stringify({ files, ulwPresent: false })),
    files,
    excluded: stored.ulwPresent ? ["ref/omp-ulw"] : [],
    ulwPresent: false,
  };
}

/** Publication has exactly one source of paths: the checked manifest, never a Git index, ignore rule or source walk. */
export function publicSource(job: UpdateJob): SourceManifest {
  assertSource(job);
  const stored = JSON.parse(readFileSync(join(job.directory, "ported-source.json"), "utf8")) as SourceManifest;
  if (!sameManifest(stored, sourceManifest(job.candidate)) || stored.hash !== job.sourceHash) {
    throw new UpdateError("ported source manifest no longer matches the checked candidate");
  }
  return publicManifest(stored);
}

function bytes(root: string, entry: SourceEntry): Buffer {
  const parts = entry.path.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
    throw new UpdateError("public manifest contains an invalid relative path");
  }
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (!lstatSync(parent).isDirectory()) throw new UpdateError("public source parent changed identity");
  }
  const fd = openSync(join(root, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    const content = readFileSync(fd);
    if (!stat.isFile() || !!(stat.mode & 0o111) !== entry.executable || digest(content) !== entry.sha256) {
      throw new UpdateError("public source bytes or executable mode changed");
    }
    return content;
  } finally {
    closeSync(fd);
  }
}

function materializePublic(job: UpdateJob, manifest: SourceManifest): string {
  const directory = join(job.directory, "publication");
  const output = join(directory, "source");
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const entry of manifest.files) {
    const content = bytes(job.candidate, entry);
    const destination = join(output, entry.path);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (lstatSync(destination, { throwIfNoEntry: false }) === undefined) {
      writeFileSync(destination, content, { flag: "wx", mode: entry.executable ? 0o755 : 0o644 });
      chmodSync(destination, entry.executable ? 0o755 : 0o644);
    } else if (!bytes(output, entry).equals(content)) {
      throw new UpdateError("retained public export differs from the checked candidate");
    }
  }
  assertSource(job);
  if (!sameManifest(sourceManifest(output), manifest))
    throw new UpdateError("public export does not match its manifest");
  saveJson(join(directory, "public-source.json"), manifest);
  return output;
}

type Tree = {
  readonly files: Map<string, { readonly file: SourceEntry; readonly oid: string }>;
  readonly dirs: Map<string, Tree>;
};
const oid = (value: string): string => {
  const sha = value.trim();
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(sha))
    throw new UpdateError("Git returned an invalid public object identity");
  return sha;
};

async function publicTree(process: PublicationProcess, source: string, manifest: SourceManifest): Promise<string> {
  const root: Tree = { files: new Map(), dirs: new Map() };
  for (let at = 0; at < manifest.files.length; at += 128) {
    const files = manifest.files.slice(at, at + 128);
    const hashes = (
      await process.git(["hash-object", "-w", "--no-filters", "--", ...files.map((file) => join(source, file.path))])
    )
      .trim()
      .split("\n");
    if (hashes.length !== files.length) throw new UpdateError("Git omitted public source blobs");
    for (const [index, file] of files.entries()) {
      let node = root;
      const parts = file.path.split("/");
      for (const part of parts.slice(0, -1)) {
        let child = node.dirs.get(part);
        if (!child) {
          child = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, child);
        }
        node = child;
      }
      node.files.set(parts.at(-1)!, { file, oid: oid(hashes[index]!) });
    }
  }
  for (const entry of manifest.files) bytes(source, entry);
  const writeTree = async (node: Tree): Promise<string> => {
    const rows = [...node.files.entries()].map(
      ([name, item]) => `${item.file.executable ? "100755" : "100644"} blob ${item.oid}\t${name}\0`,
    );
    for (const [name, child] of node.dirs) rows.push(`040000 tree ${await writeTree(child)}\t${name}\0`);
    return oid(await process.git(["mktree", "-z"], rows.join("")));
  };
  return writeTree(root);
}

/** The exact frozen local public input must already be the owner main tree before a candidate can replace it. */
export async function publicLocalTree(process: PublicationProcess, job: UpdateJob): Promise<string> {
  assertSource(job);
  const tree = await publicTree(process, join(job.directory, "inputs", "local"), publicManifest(job.inputs!.local));
  assertSource(job);
  return tree;
}

/** Git plumbing writes an exact tree and one parented commit; no checkout/add can import private candidate metadata. */
export async function publicCommit(
  process: PublicationProcess,
  job: UpdateJob,
  manifest: SourceManifest,
  expectedMain: string,
  basis: PublicationBasis,
): Promise<{ readonly commit: string; readonly tree: string }> {
  const source = materializePublic(job, manifest);
  const treeHash = await publicTree(process, source, manifest);
  if (!sameManifest(sourceManifest(source), manifest))
    throw new UpdateError("public export changed while writing Git objects");
  assertSource(job);
  const message = [
    `Port Dori upstream ${job.upstream.slice(0, 12)} to OMP`,
    "",
    `Upstream-Commit: ${job.upstream}`,
    `Upstream-Base: ${job.baseUpstream}`,
    `Dori-Source-SHA256: ${job.sourceHash}`,
    `Dori-Export-SHA256: ${manifest.hash}`,
    ...(basis.kind === "initial-source" ? ["Initial-Source-Basis: historical-replay"] : []),
    "",
  ].join("\n");
  const identity = process.config.author;
  const date = `${Math.floor(Date.parse(job.createdAt) / 1000)} +0000`;
  const commit = oid(
    await process.git(["commit-tree", treeHash, "-p", expectedMain], message, false, {
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    }),
  );
  return { commit, tree: treeHash };
}
