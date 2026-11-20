/** One read of a tracked PR through `gh api`: state, head, feedback, commits (when asked) and failing checks. */
import type { PrRef } from "./pr-watch.ts";

type Api = (endpoint: string) => Promise<unknown>;

export type Feedback = {
  readonly key: string;
  readonly kind: string;
  readonly by: string;
  readonly url: string;
  readonly body: string;
};
export type PrCommitAuthors = { readonly sha: string; readonly people: readonly string[] };
export type FailedCheck = {
  readonly key: string;
  readonly name: string;
  readonly conclusion: string;
  readonly url: string;
};
export type PrSnapshot = {
  readonly state: "open" | "merged" | "closed";
  readonly head: string;
  readonly url: string;
  readonly mergeSha?: string;
  readonly feedback: readonly Feedback[];
  /** Read only when the head moved (or on the first read); undefined means "unchanged, not read". */
  readonly commits?: readonly PrCommitAuthors[];
  /** Set when the head is missing from GitHub's capped commit list: the commits new since the head we knew. */
  readonly compared?: PrCompare;
  readonly failed: readonly FailedCheck[];
};
export type PrCompare = { readonly added: readonly PrCommitAuthors[]; readonly rewritten: boolean };

const SHA = /^[a-f0-9]{40}$/i;
const FAILED_CHECK: Readonly<Record<string, true>> = {
  failure: true,
  timed_out: true,
  cancelled: true,
  action_required: true,
  startup_failure: true,
};
const FAILED_STATUS: Readonly<Record<string, true>> = { failure: true, error: true };
// GitHub records commits made in its web UI with this committer; the author is the person.
const WEB_COMMITTER = "web-flow";

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`incomplete ${what}`);
  return value as Record<string, unknown>;
};
const loginOf = (user: unknown): string | undefined => {
  const login = (user as { login?: unknown } | null)?.login;
  return typeof login === "string" && login ? login : undefined;
};
const idOf = (row: Record<string, unknown>, what: string): number => {
  if (!Number.isSafeInteger(row["id"])) throw new Error(`incomplete ${what}`);
  return row["id"] as number;
};
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const MAX_PAGES = 30;

/**
 * Every page of a list endpoint, 100 rows at a time, until a short page or, for counted lists, `total_count` rows.
 * More than 3000 rows is refused rather than read partly; exactly 3000 is read whole.
 */
const pages = async (api: Api, endpoint: string, rows: (body: unknown) => unknown[]): Promise<unknown[]> => {
  const all: unknown[] = [];
  for (let page = 1; ; page++) {
    const body = await api(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    const got = rows(body);
    if (page > MAX_PAGES) {
      if (got.length) throw new Error(`${endpoint}: more than ${MAX_PAGES * 100} rows`);
      return all;
    }
    all.push(...got);
    const total = (body as { total_count?: unknown } | null)?.total_count;
    if (got.length < 100 || (typeof total === "number" && all.length >= total)) return all;
  }
};
const list = (what: string) => (body: unknown) => {
  if (!Array.isArray(body)) throw new Error(`incomplete ${what}`);
  return body;
};
/** A counted list such as check runs or a combined status: the rows sit under `field` beside `total_count`. */
const counted = (field: string, what: string) => (body: unknown) => {
  const value = record(body, what);
  if (!Array.isArray(value[field]) || !Number.isSafeInteger(value["total_count"]))
    throw new Error(`incomplete ${what}`);
  return value[field] as unknown[];
};

const comments = async (api: Api, endpoint: string, kind: string, prefix: string): Promise<Feedback[]> =>
  (await pages(api, endpoint, list(kind))).map((value) => {
    const row = record(value, kind);
    return {
      key: `${prefix}:${idOf(row, kind)}`,
      kind,
      by: loginOf(row["user"]) ?? "ghost",
      url: text(row["html_url"]),
      body: text(row["body"]),
    };
  });

const reviews = async (api: Api, root: string): Promise<Feedback[]> =>
  (await pages(api, `${root}/reviews`, list("review"))).flatMap((value) => {
    const row = record(value, "review");
    const state = text(row["state"]);
    // A pending review is the reviewer's draft; a bare "commented" review carries its words in its review comments.
    if (state === "PENDING" || (state === "COMMENTED" && !text(row["body"]).trim())) return [];
    return [
      {
        // The state is part of the key: an approval later dismissed is the same review id with news in it.
        key: `rv:${idOf(row, "review")}:${state}`,
        kind: `review-${state.toLowerCase() || "unknown"}`,
        by: loginOf(row["user"]) ?? "ghost",
        url: text(row["html_url"]),
        body: text(row["body"]),
      },
    ];
  });

/**
 * A commit's people: the author and, unless GitHub's web committer, the committer. A Git identity linked to no account
 * has no login; its email (`email:<address>`, lowercased) still lets our own configured identity be recognized.
 */
const commitRow = (value: unknown): PrCommitAuthors => {
  const row = record(value, "commit list");
  if (typeof row["sha"] !== "string" || !SHA.test(row["sha"])) throw new Error("incomplete commit list");
  const git = (row["commit"] ?? {}) as Record<string, { email?: unknown } | undefined>;
  const person = (role: "author" | "committer"): string | undefined => {
    const login = loginOf(row[role]);
    if (login) return login === WEB_COMMITTER ? undefined : login;
    const email = git[role]?.email;
    return typeof email === "string" && email ? `email:${email.toLowerCase()}` : "unknown";
  };
  const committer = person("committer");
  const people = [person("author") ?? "unknown", ...(committer ? [committer] : [])];
  return { sha: row["sha"], people: [...new Set(people)] };
};

/** What `head` has that `base` lacks, and whether `base` is still behind it (false after a rewrite). */
const compare = async (api: Api, repo: string, base: string, head: string): Promise<PrCompare> => {
  let status = "";
  let rows: unknown[];
  try {
    rows = await pages(api, `repos/${repo}/compare/${base}...${head}`, (body) => {
      const value = record(body, "compare");
      if (!Array.isArray(value["commits"]) || typeof value["status"] !== "string")
        throw new Error("incomplete compare");
      status = value["status"];
      return value["commits"];
    });
  } catch (e) {
    // An old head GitHub no longer has (gone after a force-push) can never be compared: report the rewrite with no
    // commit to name, instead of holding the PR on that error forever. Other failures are retried as usual.
    if (e instanceof Error && /\bHTTP 404\b/.test(e.message)) return { added: [], rewritten: true };
    throw e;
  }
  return { added: rows.map(commitRow), rewritten: status !== "ahead" };
};

const failedChecks = async (api: Api, repo: string, head: string): Promise<FailedCheck[]> => {
  const runs = await pages(api, `repos/${repo}/commits/${head}/check-runs`, counted("check_runs", "check runs"));
  const statuses = await pages(api, `repos/${repo}/commits/${head}/status`, counted("statuses", "commit status"));
  return [
    ...runs.flatMap((value) => {
      const row = record(value, "check run");
      const conclusion = text(row["conclusion"]);
      return Object.hasOwn(FAILED_CHECK, conclusion)
        ? [{ key: `ck:${idOf(row, "check run")}`, name: text(row["name"]), conclusion, url: text(row["html_url"]) }]
        : [];
    }),
    ...statuses.flatMap((value) => {
      const row = record(value, "commit status");
      const state = text(row["state"]);
      return Object.hasOwn(FAILED_STATUS, state)
        ? [
            {
              key: `st:${idOf(row, "commit status")}`,
              name: text(row["context"]),
              conclusion: state,
              url: text(row["target_url"]),
            },
          ]
        : [];
    }),
  ];
};

const metadata = async (api: Api, root: string): Promise<{ pr: Record<string, unknown>; head: string }> => {
  const pr = record(await api(root), "PR metadata");
  const head = (pr["head"] as { sha?: unknown } | null)?.sha;
  if (
    typeof head !== "string" ||
    !SHA.test(head) ||
    (pr["state"] !== "open" && pr["state"] !== "closed") ||
    typeof pr["merged"] !== "boolean"
  )
    throw new Error("incomplete PR metadata");
  return { pr, head };
};

/** One read of a PR last seen closed unmerged: has it left that state (reopened, or reopened and merged since)? */
export const prLeftClosed = async (api: Api, ref: PrRef): Promise<boolean> => {
  const { pr } = await metadata(api, `repos/${ref.repo}/pulls/${ref.number}`);
  return pr["state"] === "open" || pr["merged"] === true;
};

/** Reads everything first, so a failure part-way changes nothing: the caller records a snapshot or nothing. */
export const fetchPr = async (
  api: Api,
  ref: PrRef,
  knownHead: string | undefined,
  retry = true,
): Promise<PrSnapshot> => {
  const root = `repos/${ref.repo}/pulls/${ref.number}`;
  const { pr, head } = await metadata(api, root);
  const mergeSha = pr["merged"] && typeof pr["merge_commit_sha"] === "string" ? pr["merge_commit_sha"] : undefined;
  const feedback = [
    ...(await comments(api, `${root}/comments`, "review-comment", "rc")),
    ...(await comments(api, `repos/${ref.repo}/issues/${ref.number}/comments`, "comment", "ic")),
    ...(await reviews(api, root)),
  ];
  const commits =
    head === knownHead ? undefined : (await pages(api, `${root}/commits`, list("commit list"))).map(commitRow);
  // The list ends at the head, unless GitHub's 250-commit cap cut it before the head; a head elsewhere in it, or missing
  // from a shorter list, is a push during the read, read once more so the head and commits saved together agree. An
  // empty list (a branch reset to its base) has no head to check and goes on to the compare.
  const at = commits?.findIndex((c) => c.sha === head) ?? -1;
  if (commits?.length && (at >= 0 ? at !== commits.length - 1 : commits.length < 250)) {
    if (retry) return fetchPr(api, ref, knownHead, false);
    throw new Error("the PR head moved while it was read; reading again next pass");
  }
  // GitHub lists at most 250 commits of a PR; past that the head is missing from the list, and a compare names what is
  // new since the head we knew.
  const compared =
    commits && knownHead !== undefined && !commits.some((c) => c.sha === head)
      ? await compare(api, ref.repo, knownHead, head)
      : undefined;
  return {
    ...(compared !== undefined ? { compared } : {}),
    state: pr["merged"] ? "merged" : pr["state"] === "open" ? "open" : "closed",
    head,
    url: text(pr["html_url"]),
    ...(mergeSha !== undefined ? { mergeSha } : {}),
    feedback,
    ...(commits !== undefined ? { commits } : {}),
    failed: await failedChecks(api, ref.repo, head),
  };
};
