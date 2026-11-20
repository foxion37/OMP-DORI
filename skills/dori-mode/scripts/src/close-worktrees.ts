import { existsSync } from "node:fs";
import type { FlowDeps } from "./done-flow.ts";
import type { Lane } from "./registry.ts";
import { repoGit, type Runner } from "./run.ts";

const NOT_REPOSITORY = "fatal: not a git repository (or any ";

const findWorktrees = async (
  lane: Lane,
  run: Runner,
  extraRoots: readonly string[],
  onUnreadable?: (root: string) => void,
): Promise<string[]> => {
  const found = new Set<string>(lane.worktrees ?? []);
  const ours = (name: string) => name === lane.key || name.startsWith(`${lane.key}-`);
  for (const root of new Set([lane.cwd ?? "", ...extraRoots].filter(Boolean))) {
    const r = await repoGit(run, root, ["worktree", "list", "--porcelain"]);
    if (r.code !== 0) {
      if (!r.err.startsWith(NOT_REPOSITORY)) onUnreadable?.(root);
      continue;
    }
    let path = "";
    for (const line of r.out.split("\n")) {
      if (line.startsWith("worktree ")) path = line.slice(9);
      else if (
        line.startsWith("branch ") &&
        path !== root &&
        (ours(line.split("/").pop() ?? "") || ours(path.split("/").pop() ?? ""))
      )
        found.add(path);
    }
  }
  return [...found];
};

// Cleanup remains best effort; only preflight needs to hold on incomplete discovery.
export const discoverWorktrees = (lane: Lane, run: Runner, extraRoots: readonly string[] = []): Promise<string[]> =>
  findWorktrees(lane, run, extraRoots);

export const unpushedWork = async (deps: FlowDeps, lane: Lane): Promise<string[]> => {
  const exists = deps.exists ?? existsSync;
  const reasons: string[] = [];
  // Check owned worktrees instead of blocking on changes in the human's checkout.
  // If the lane works directly in its cwd, that checkout must be checked instead.
  const unreadableRoots = new Set<string>();
  const owned = await findWorktrees(lane, deps.run, [deps.config.defaultCwd], (root) => {
    if (exists(root)) unreadableRoots.add(root);
  });
  const unreadable = (root: string) => `unpushed work in ${root} (git state unreadable)`;
  for (const root of unreadableRoots) reasons.push(unreadable(root));
  const roots = owned.length ? owned : [lane.cwd ?? deps.config.defaultCwd];
  for (const wt of roots) {
    if (unreadableRoots.has(wt) || !exists(wt)) continue;
    // Only the fallback cwd may be skipped when it is not a checkout (#42).
    if (!owned.length) {
      const inside = await repoGit(deps.run, wt, ["rev-parse", "--is-inside-work-tree"]);
      if (inside.code !== 0 && !inside.err.startsWith(NOT_REPOSITORY)) reasons.push(unreadable(wt));
      if (inside.code !== 0 || inside.out.trim() !== "true") continue;
    }
    const dirty = await repoGit(deps.run, wt, ["status", "--porcelain", "--untracked-files=no"]);
    const ahead = await repoGit(deps.run, wt, ["rev-list", "--count", "HEAD", "--not", "--remotes"]);
    if (dirty.code !== 0 || ahead.code !== 0) reasons.push(unreadable(wt));
    else if (dirty.out.trim() || Number(ahead.out.trim()) > 0) reasons.push(`unpushed work in ${wt}`);
  }
  return reasons;
};
