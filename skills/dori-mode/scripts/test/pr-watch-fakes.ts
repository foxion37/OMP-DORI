import type { Runner } from "../src/run.ts";

/** A GitHub stand-in for `gh api --method GET`: one repository's PRs, read the way `dori pr watch` reads them. */
export type Row = { id: number; user: { login: string } | null; html_url: string; body: string | null; state?: string };
export type FakeCommit = { sha: string; author: string | null; committer?: string; email?: string };
export type FakePr = {
  state: "open" | "closed";
  merged: boolean;
  mergeSha?: string;
  head: string;
  commits: FakeCommit[];
  reviewComments: Row[];
  comments: Row[];
  reviews: Row[];
  checks: Record<string, { id: number; name: string; conclusion: string | null; html_url: string }[]>;
  statuses: Record<string, { id: number; state: string; context: string; target_url: string }[]>;
};

export const sha = (c: string): string => c.repeat(40);

export const openPr = (head = sha("a"), author = "me"): FakePr => ({
  state: "open",
  merged: false,
  head,
  commits: [{ sha: head, author, committer: author }],
  reviewComments: [],
  comments: [],
  reviews: [],
  checks: {},
  statuses: {},
});

export const row = (id: number, login: string, body: string, state?: string): Row => ({
  id,
  user: { login },
  html_url: `https://github.com/acme/app/pull/7#c${id}`,
  body,
  ...(state !== undefined ? { state } : {}),
});

const ok = (value: unknown) => ({ code: 0, out: JSON.stringify(value), err: "" });

export type FakeGitHub = {
  readonly run: Runner;
  readonly calls: string[];
  /** Endpoint part → error text: every matching read fails until removed. */
  readonly failing: Map<string, string>;
  /** Endpoint part → change made once, just before the first matching read (a push racing the watcher). */
  readonly before: Map<string, () => void>;
};

export const fakeGitHub = (prs: Record<string, FakePr>, login: string | null = "me"): FakeGitHub => {
  const calls: string[] = [];
  const failing = new Map<string, string>();
  const before = new Map<string, () => void>();
  const run: Runner = async (argv) => {
    if (argv.slice(0, 4).join(" ") !== "gh api --method GET" || argv.length !== 5) throw new Error(`argv ${argv}`);
    const endpoint = argv[4]!;
    calls.push(endpoint);
    for (const [part, change] of [...before])
      if (endpoint.includes(part)) {
        before.delete(part);
        change();
      }
    for (const [part, err] of failing) if (endpoint.includes(part)) return { code: 1, out: "", err };
    if (endpoint === "user") return login ? ok({ login }) : { code: 1, out: "", err: "HTTP 401" };
    const [path, query = ""] = endpoint.split("?");
    const page = Number(new URLSearchParams(query).get("page") ?? 1);
    const slice = <T>(rows: T[]) => rows.slice((page - 1) * 100, page * 100);
    // A commit committed by its author unless stated; `email` is the Git identity GitHub could not link to an account.
    const commitJson = (c: FakeCommit) => {
      const committer = c.committer ?? c.author;
      return {
        sha: c.sha,
        author: c.author ? { login: c.author } : null,
        committer: committer ? { login: committer } : null,
        commit: { author: { email: c.email ?? "" }, committer: { email: c.email ?? "" } },
      };
    };
    const compared = /^repos\/[^/]+\/[^/]+\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/.exec(path!);
    if (compared) {
      // Linear history only: what follows base in the one PR whose commits hold both, else a diverged rewrite.
      const pr = Object.values(prs).find((p) => p.commits.some((c) => c.sha === compared[2]));
      const at = pr?.commits.findIndex((c) => c.sha === compared[1]) ?? -1;
      const upto = pr?.commits.findIndex((c) => c.sha === compared[2]) ?? -1;
      const added = at >= 0 ? pr!.commits.slice(at + 1, upto + 1) : (pr?.commits.slice(0, upto + 1) ?? []);
      return ok({ status: at >= 0 ? "ahead" : "diverged", commits: slice(added).map(commitJson) });
    }
    const m = /^repos\/([^/]+\/[^/]+)\/(pulls|issues|commits)\/([^/]+)(?:\/(.+))?$/.exec(path!);
    if (!m) throw new Error(`unexpected read ${endpoint}`);
    const [, repo, kind, id, rest] = m;
    if (kind === "commits") {
      const pr = Object.values(prs).find((p) => p.checks[id!] || p.statuses[id!] || p.head === id);
      if (rest === "check-runs") {
        const runs = pr?.checks[id!] ?? [];
        return ok({ total_count: runs.length, check_runs: slice(runs) });
      }
      if (rest === "status") {
        const statuses = pr?.statuses[id!] ?? [];
        return ok({ state: "pending", total_count: statuses.length, statuses: slice(statuses) });
      }
    }
    const pr = prs[`${repo}#${id}`];
    if (!pr) return { code: 1, out: "", err: "HTTP 404: Not Found" };
    if (kind === "issues" && rest === "comments") return ok(slice(pr.comments));
    if (kind === "pulls" && rest === undefined)
      return ok({
        state: pr.state,
        merged: pr.merged,
        merge_commit_sha: pr.mergeSha ?? null,
        head: { sha: pr.head },
        html_url: `https://github.com/${repo}/pull/${id}`,
      });
    if (kind === "pulls" && rest === "comments") return ok(slice(pr.reviewComments));
    if (kind === "pulls" && rest === "reviews") return ok(slice(pr.reviews));
    // GitHub lists only the first 250 commits of a PR.
    if (kind === "pulls" && rest === "commits") return ok(slice(pr.commits.slice(0, 250)).map(commitJson));
    throw new Error(`unexpected read ${endpoint}`);
  };
  return { run, calls, failing, before };
};
