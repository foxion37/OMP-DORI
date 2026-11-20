import { afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareUlwUpdate, ULW_UPDATE_FILES } from "../src/release/source-bundle-update.ts";
import { fixtureGit, overlayFixture } from "./source-bundle-setup.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const hash = (path: string) => {
  const bytes = readFileSync(path);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
};
const repository = "vntrevx/Cataly";
const baseTree = "b".repeat(40),
  tree = "d".repeat(40),
  advancedBase = "1".repeat(40),
  advancedTree = "2".repeat(40);

export async function ulwPublicationFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ulw-publish-")));
  roots.push(root);
  const source = join(root, "source"),
    remote = join(root, "upstream");
  const old = overlayFixture(source, remote);
  fixtureGit(remote, "branch", "-M", "main");
  writeFileSync(join(source, "README.md"), "Trusted base\n");
  fixtureGit(source, "init", "--quiet");
  fixtureGit(source, "add", ".");
  fixtureGit(source, "commit", "--quiet", "-m", "Pinned bundle");
  fixtureGit(remote, "reset", "--hard", old.commit);
  writeFileSync(join(remote, "new.ts"), "export {};\n");
  fixtureGit(remote, "add", ".");
  fixtureGit(remote, "commit", "--quiet", "-m", "Next upstream");
  const directory = join(root, "candidate");
  const candidate = (await prepareUlwUpdate(source, directory, remote))!;
  const branch = `automation/ulw-${candidate.commit}-${candidate.previousIdentity.slice(0, 12)}`;
  const commit = "c".repeat(40);
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const pull = () => ({
    number: 999,
    state: "open",
    html_url: `https://github.com/${repository}/pull/999`,
    head: { sha: commit, ref: branch, repo: { full_name: repository } },
    base: { ref: "main", repo: { full_name: repository } },
  });
  const state = {
    branch: false,
    pull: undefined as ReturnType<typeof pull> | undefined,
    runs: [] as { head_sha: string }[],
    main: candidate.sourceCommit,
    foreign: false,
    dispatchFail: false,
    ancestor: true,
    previousMetadataChanged: false,
    candidateMetadataChanged: false,
    unrelatedTreeChanged: false,
  };
  const entries = (next: boolean) => [
    ...ULW_UPDATE_FILES.map((path) => ({
      path,
      mode: "100644",
      type: "blob",
      sha: hash(join(next ? directory : source, path)),
    })),
    { path: "README.md", mode: "100644", type: "blob", sha: "9".repeat(40) },
  ];
  const api = async (path: string, method = "GET", body?: unknown): Promise<unknown> => {
    calls.push({ path, method, body });
    if (path.endsWith("/git/ref/heads/main")) return { object: { sha: state.main } };
    if (path.endsWith(`/git/commits/${candidate.sourceCommit}`))
      return { sha: candidate.sourceCommit, tree: { sha: baseTree } };
    if (path.endsWith(`/git/commits/${state.main}`)) return { sha: state.main, tree: { sha: advancedBase } };
    if (path.endsWith("/git/blobs")) return { sha: "e".repeat(40) };
    if (path.endsWith("/git/trees")) return { sha: state.main === candidate.sourceCommit ? tree : advancedTree };
    if (path.endsWith(`/git/trees/${baseTree}`) || path.endsWith(`/git/trees/${tree}`)) {
      const next = path.endsWith(`/git/trees/${tree}`),
        values = entries(next);
      if (next ? state.candidateMetadataChanged : state.previousMetadataChanged) values[0]!.sha = "f".repeat(40);
      if (next && state.unrelatedTreeChanged) values[3]!.sha = "f".repeat(40);
      return { sha: next ? tree : baseTree, truncated: false, tree: values };
    }
    if (path.includes("/compare/"))
      return {
        status: state.ancestor ? "ahead" : "diverged",
        ahead_by: 1,
        behind_by: state.ancestor ? 0 : 1,
        base_commit: { sha: candidate.sourceCommit },
        merge_base_commit: { sha: candidate.sourceCommit },
      };
    if (path.includes("/git/matching-refs/"))
      return state.branch ? [{ ref: `refs/heads/${branch}`, object: { sha: commit } }] : [];
    if (path.endsWith(`/git/commits/${commit}`))
      return {
        sha: commit,
        tree: { sha: state.foreign ? "f".repeat(40) : tree },
        parents: [{ sha: candidate.sourceCommit }],
      };
    if (path.endsWith("/git/commits")) return { sha: commit };
    if (path.endsWith("/git/refs")) {
      state.branch = true;
      return {};
    }
    if (path.includes("/pulls?")) return state.pull ? [state.pull] : [];
    if (path.endsWith("/pulls")) {
      state.pull = pull();
      return state.pull;
    }
    if (path.includes("/runs?")) return { workflow_runs: state.runs };
    if (path.endsWith(`/git/ref/heads/${branch}`)) return { object: { sha: commit } };
    if (path.endsWith("/dispatches")) {
      if (state.dispatchFail) throw new Error("Dispatch unavailable");
      state.runs.push({ head_sha: commit });
      return undefined;
    }
    throw new Error(`Unexpected API: ${method} ${path}`);
  };
  const advanceMain = async () => {
    writeFileSync(join(source, "README.md"), "Accepted unrelated main change\n");
    fixtureGit(source, "add", ".");
    fixtureGit(source, "commit", "--quiet", "-m", "Accepted main advancement");
    const output = join(root, "next-candidate");
    const next = (await prepareUlwUpdate(source, output, remote))!;
    state.main = next.sourceCommit;
    return { directory: output, candidate: next };
  };
  return { source, directory, candidate, branch, commit, calls, state, api, advanceMain };
}
