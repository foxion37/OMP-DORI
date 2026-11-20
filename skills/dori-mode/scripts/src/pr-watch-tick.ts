/** `dori pr watch`: one pass over the tracked PRs, turning what is new since the last pass into PR_* lines. */
import { fetchPr, type PrSnapshot, prLeftClosed } from "./pr-watch-fetch.ts";
import { PrTracking, type PrWatchEntry, prKey, prName, type TrackedPr, UNSAFE } from "./pr-watch.ts";
import type { Runner } from "./run.ts";
import { ghGet } from "./verify-pr.ts";

export type WatchOptions = {
  /** The account whose own comments and commits are not news; read from `gh api user` when absent. */
  readonly self?: string;
  /** Lowercase logins whose comments and commits are skipped (bots). */
  readonly ignore: ReadonlySet<string>;
  /** Lowercase Git emails that are ours (the configured `repoIdentities`), for commits whose email has no account. */
  readonly selfEmails?: ReadonlySet<string>;
};
/** What one watcher process remembers between passes: the resolved account and the last warning per subject. */
export type WatchMemory = { self?: string; readonly warned: Map<string, string> };
export type WatchPass = { readonly lines: string[]; readonly commit: () => void };

// oxlint-disable-next-line no-control-regex -- the pattern deliberately matches control characters to strip them
const UNPRINTABLE = /[\s\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g;
/** Text from GitHub is data: one line, no terminal or bidi controls, cut to a readable length. */
const excerpt = (value: string, max = 160): string => {
  const chars = [...value.replace(UNPRINTABLE, " ").trim()];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : chars.join("");
};
const word = (value: string): string => excerpt(value, 100).replace(/ /g, "_") || "-";
const link = (value: string): string => (value.startsWith("https://") && !UNSAFE.test(value) ? value : "-");

const subject = (pr: TrackedPr): string => `${prName(pr)} lane=${pr.lane ?? "-"} thread=${pr.thread ?? "-"}`;

const isSelfOrIgnored = (person: string, self: string, options: WatchOptions): boolean =>
  person.startsWith("email:")
    ? options.selfEmails?.has(person.slice(6)) === true
    : person.toLowerCase() === self.toLowerCase() || options.ignore.has(person.toLowerCase());
// An email is used only to recognize our own commits; it is never printed.
const personWord = (person: string): string => (person.startsWith("email:") ? "unknown" : word(person));

/** The lines for one PR and its next cursor. The first read is a baseline: nothing already there is reported. */
export const diffPr = (
  pr: TrackedPr,
  prev: PrWatchEntry | undefined,
  snap: PrSnapshot,
  self: string,
  options: WatchOptions,
  now: string,
): { lines: string[]; entry: PrWatchEntry } => {
  const lines: string[] = [];
  const seen = new Set(prev?.seen ?? []);
  const commits = snap.commits?.map((c) => c.sha) ?? prev?.commits ?? [];
  for (const item of snap.feedback) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    if (prev && !isSelfOrIgnored(item.by, self, options))
      lines.push(
        `PR_FEEDBACK ${subject(pr)} kind=${word(item.kind)} by=${word(item.by)} ${link(item.url)} | ${excerpt(item.body)}`,
      );
  }
  if (prev && snap.head !== prev.head && snap.commits) {
    const known = new Set(prev.commits);
    const added = snap.compared?.added ?? snap.commits.filter((c) => !known.has(c.sha));
    const others = [...new Set(added.flatMap((c) => c.people.filter((p) => !isSelfOrIgnored(p, self, options))))];
    const rewritten = snap.compared?.rewritten ?? !commits.includes(prev.head);
    // Our own pushes are not news; someone else's commits, or a head moved with no new commit to explain it, are.
    if (others.length || !added.length)
      lines.push(
        `PR_HEAD_MOVED ${subject(pr)} by=${[...new Set(others.map(personWord))].join(",") || "unknown"} +${added.length} ${prev.head.slice(0, 7)}..${snap.head.slice(0, 7)}${rewritten ? " rewritten" : ""} ${link(snap.url)}`,
      );
  }
  for (const check of snap.failed) {
    if (seen.has(check.key)) continue;
    seen.add(check.key);
    if (prev)
      lines.push(
        `PR_CI_FAIL ${subject(pr)} conclusion=${word(check.conclusion)} head=${snap.head.slice(0, 7)} ${link(check.url)} | ${excerpt(check.name)}`,
      );
  }
  if (!prev)
    lines.push(`PR_WATCH_BASELINE ${subject(pr)} head=${snap.head.slice(0, 7)} state=${snap.state} known=${seen.size}`);
  if (prev && prev.state !== "open" && snap.state === "open") lines.push(`PR_REOPENED ${subject(pr)}`);
  // A closed PR is read whole only on its first pass, when it closed, or when tracked again (see `due`): each is news.
  if (snap.state !== "open")
    lines.push(
      snap.state === "merged"
        ? `PR_MERGED ${subject(pr)} sha=${snap.mergeSha ?? "unknown"}`
        : `PR_CLOSED ${subject(pr)} unmerged`,
    );
  return {
    lines,
    entry: {
      since: pr.since,
      head: snap.head,
      commits,
      seen: [...seen],
      state: snap.state,
      polledAt: now,
      ...(snap.state === "open" ? {} : { closedAt: now }),
    },
  };
};

/** A closed PR is read whole again only when tracked again after the watcher saw it close (or when it reopens). */
const due = (pr: TrackedPr, entry: PrWatchEntry | undefined): boolean =>
  !entry || entry.state === "open" || entry.closedAt === undefined || entry.closedAt < pr.trackedAt;

/**
 * One pass. Lines come back with `commit`, which saves the cursor: the caller prints the lines first, so a crash
 * between the two repeats a line rather than losing it. A failed read changes nothing for that PR and warns once per
 * distinct reason until it reads again.
 */
export const prWatchPass = async (
  stateDir: string,
  run: Runner,
  options: WatchOptions,
  memory: WatchMemory,
  now: number,
): Promise<WatchPass> => {
  const lines: string[] = [];
  const warn = (about: string, reason: string, key = about) => {
    const short = excerpt(reason, 300);
    if (memory.warned.get(key) !== short) lines.push(`PR_WATCH_WARN ${about} ${short}`);
    memory.warned.set(key, short);
  };
  const quiet = (about: string) => memory.warned.delete(about);
  const nothing = { lines, commit: () => {} };
  const tracking = new PrTracking(stateDir);
  const read = tracking.read();
  // Each damaged line is its own subject, so two of them are named once each rather than on every pass.
  for (const problem of read.problems) warn("-", `tracking record damaged: ${problem}`, `record:${problem}`);
  let state: Record<string, PrWatchEntry>;
  try {
    state = tracking.loadState();
    quiet("state");
  } catch (e) {
    warn("state", `holding: ${e instanceof Error ? e.message : String(e)}`);
    return nothing;
  }
  // A cursor belongs to one tracking: after an untrack and a new track, even between two passes, it starts afresh.
  const cursor = (pr: TrackedPr) => {
    const entry = state[prKey(pr)];
    return entry?.since === pr.since ? entry : undefined;
  };
  const api = ghGet(run);
  if (memory.self === undefined && options.self !== undefined) memory.self = options.self;
  if (memory.self === undefined && read.prs.some((pr) => due(pr, cursor(pr)) || cursor(pr)?.state === "closed")) {
    try {
      const login = (await api("user")) as { login?: unknown } | null;
      if (typeof login?.login !== "string" || !login.login) throw new Error("gh api user: no login");
      memory.self = login.login;
      quiet("self");
    } catch (e) {
      // Without our own login every push of ours would read as someone else's; hold rather than guess.
      warn("self", `holding: cannot tell our own activity from others (${e instanceof Error ? e.message : String(e)})`);
      return nothing;
    }
  }
  const next: Record<string, PrWatchEntry> = {};
  const at = new Date(now).toISOString();
  for (const pr of read.prs) {
    const key = prKey(pr);
    const prev = cursor(pr);
    if (prev) next[key] = prev;
    try {
      if (!due(pr, prev)) {
        // A merge is final, but a PR closed unmerged can be reopened (and merged before the next pass): one metadata
        // read per pass notices either. A read finding it still closed ends an earlier warning; a reopened PR's
        // warning ends only when its full read succeeds.
        if (prev?.state !== "closed") continue;
        if (!(await prLeftClosed(api, pr))) {
          quiet(prName(pr));
          continue;
        }
      }
      const snap = await fetchPr(api, pr, prev?.head);
      const diff = diffPr(pr, prev, snap, memory.self!, options, at);
      lines.push(...diff.lines);
      next[key] = diff.entry;
      quiet(prName(pr));
    } catch (e) {
      warn(prName(pr), e instanceof Error ? e.message : String(e));
    }
  }
  // Untracked PRs leave the cursor, so tracking one again starts from a fresh baseline.
  return { lines, commit: () => tracking.saveState(next) };
};
