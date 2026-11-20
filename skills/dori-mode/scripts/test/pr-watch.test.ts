import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { PrTracking } from "../src/pr-watch.ts";
import { prWatchPass, type WatchMemory, type WatchOptions } from "../src/pr-watch-tick.ts";
import { type TestState, withState } from "./fakes.ts";
import { type FakeGitHub, type FakePr, fakeGitHub, openPr, row, sha } from "./pr-watch-fakes.ts";

const T0 = Date.parse("2026-11-17T00:00:00Z");
const KEY = "acme/app#7";
let state: TestState;
let pr: FakePr;
let gh: FakeGitHub;
let memory: WatchMemory;
let now = T0;

beforeEach(() => {
  state = withState();
  pr = openPr();
  gh = fakeGitHub({ [KEY]: pr });
  memory = { warned: new Map() };
  now = T0;
  new PrTracking(state.dir).track(
    { repo: "acme/app", number: 7 },
    { source: "test", lane: "fix-7", thread: "discord:1" },
    now,
  );
});
afterEach(() => state.done());

/** One watcher pass the way the CLI runs it: print, then commit the cursor. */
const pass = async (options: WatchOptions = { ignore: new Set() }, commit = true): Promise<string[]> => {
  now += 60_000;
  const r = await prWatchPass(state.dir, gh.run, options, memory, now);
  if (commit) r.commit();
  return r.lines;
};

test("the first pass is a baseline; later feedback from others is reported once, our own never, across restarts", async () => {
  // Given a PR that already has a comment when tracking starts.
  pr.comments.push(row(1, "maintainer", "old remark"));
  expect(await pass()).toEqual([
    "PR_WATCH_BASELINE acme/app#7 lane=fix-7 thread=discord:1 head=aaaaaaa state=open known=1",
  ]);
  // When a review comment, a changes-requested review, an empty approval and our own reply arrive.
  pr.reviewComments.push(row(10, "maintainer", "rename this"));
  pr.reviews.push(row(20, "maintainer", "needs a test", "CHANGES_REQUESTED"), row(21, "bot", "", "APPROVED"));
  pr.reviews.push(row(22, "maintainer", "", "COMMENTED"), row(23, "maintainer", "draft", "PENDING"));
  pr.comments.push(row(2, "me", "fixed in abc"));
  // Then each outside item is one line, with lane and thread for routing.
  expect(await pass()).toEqual([
    "PR_FEEDBACK acme/app#7 lane=fix-7 thread=discord:1 kind=review-comment by=maintainer https://github.com/acme/app/pull/7#c10 | rename this",
    "PR_FEEDBACK acme/app#7 lane=fix-7 thread=discord:1 kind=review-changes_requested by=maintainer https://github.com/acme/app/pull/7#c20 | needs a test",
    "PR_FEEDBACK acme/app#7 lane=fix-7 thread=discord:1 kind=review-approved by=bot https://github.com/acme/app/pull/7#c21 | ",
  ]);
  expect(await pass()).toEqual([]);
  // And a restarted watcher (fresh memory) reads the saved cursor instead of reporting again.
  memory = { warned: new Map() };
  expect(await pass()).toEqual([]);
});

test("a head moved by someone else's commit is reported; our own push is not; a rewrite is flagged", async () => {
  await pass();
  const own = sha("b");
  pr.commits.push({ sha: own, author: "me", committer: "me" });
  pr.head = own;
  expect(await pass()).toEqual([]);
  const theirs = sha("c");
  pr.commits.push({ sha: theirs, author: "me", committer: "maintainer" });
  pr.head = theirs;
  expect(await pass()).toEqual([
    "PR_HEAD_MOVED acme/app#7 lane=fix-7 thread=discord:1 by=maintainer +1 bbbbbbb..ccccccc https://github.com/acme/app/pull/7",
  ]);
  // A force-push that replaces history with someone else's commit: the old head is gone from the PR.
  const rebased = sha("d");
  pr.commits = [{ sha: rebased, author: null, committer: "web-flow" }];
  pr.head = rebased;
  expect(await pass()).toEqual([
    "PR_HEAD_MOVED acme/app#7 lane=fix-7 thread=discord:1 by=unknown +1 ccccccc..ddddddd rewritten https://github.com/acme/app/pull/7",
  ]);
});

test("a failing check or status on the head is reported once; a rerun that fails again is new; others never", async () => {
  pr.checks[pr.head] = [{ id: 1, name: "old", conclusion: "failure", html_url: "https://github.com/x/1" }];
  await pass();
  pr.checks[pr.head]!.push(
    { id: 2, name: "test (macos)", conclusion: "timed_out", html_url: "https://github.com/x/2" },
    { id: 3, name: "lint", conclusion: "success", html_url: "https://github.com/x/3" },
    { id: 4, name: "e2e", conclusion: null, html_url: "https://github.com/x/4" },
  );
  pr.statuses[pr.head] = [
    { id: 9, state: "error", context: "ci/external", target_url: "https://ci.example/9" },
    { id: 8, state: "pending", context: "ci/slow", target_url: "https://ci.example/8" },
  ];
  expect(await pass()).toEqual([
    "PR_CI_FAIL acme/app#7 lane=fix-7 thread=discord:1 conclusion=timed_out head=aaaaaaa https://github.com/x/2 | test (macos)",
    "PR_CI_FAIL acme/app#7 lane=fix-7 thread=discord:1 conclusion=error head=aaaaaaa https://ci.example/9 | ci/external",
  ]);
  pr.checks[pr.head]![3] = { id: 4, name: "e2e", conclusion: "failure", html_url: "https://github.com/x/4" };
  pr.checks[pr.head]!.push({
    id: 5,
    name: "test (macos)",
    conclusion: "cancelled",
    html_url: "https://github.com/x/5",
  });
  expect((await pass()).map((l) => l.split(" | ")[1])).toEqual(["e2e", "test (macos)"]);
});

test("a merge is reported once, then the PR is not read again until it is tracked again", async () => {
  await pass();
  pr.state = "closed";
  pr.merged = true;
  pr.mergeSha = sha("f");
  expect(await pass()).toEqual([`PR_MERGED acme/app#7 lane=fix-7 thread=discord:1 sha=${sha("f")}`]);
  const reads = gh.calls.length;
  expect(await pass()).toEqual([]);
  expect(gh.calls.length).toBe(reads);
  // Tracking it again (here with another lane) reads it once more and reports the final state again.
  new PrTracking(state.dir).track({ repo: "acme/app", number: 7 }, { source: "test", lane: "follow-7" }, now + 1);
  expect(await pass()).toEqual([`PR_MERGED acme/app#7 lane=follow-7 thread=- sha=${sha("f")}`]);
  expect(await pass()).toEqual([]);
});

test("a PR closed without merging is reported as such, and a PR tracked after it closed is reported at once", async () => {
  pr.state = "closed";
  expect(await pass()).toEqual([
    "PR_WATCH_BASELINE acme/app#7 lane=fix-7 thread=discord:1 head=aaaaaaa state=closed known=0",
    "PR_CLOSED acme/app#7 lane=fix-7 thread=discord:1 unmerged",
  ]);
});

test("a failed read warns once per reason and changes nothing; the next good read reports what arrived", async () => {
  await pass();
  gh.failing.set("/reviews", "HTTP 502: Bad Gateway");
  pr.comments.push(row(3, "maintainer", "ping"));
  const warn =
    "PR_WATCH_WARN acme/app#7 gh api repos/acme/app/pulls/7/reviews?per_page=100&page=1: exit 1: HTTP 502: Bad Gateway";
  expect(await pass()).toEqual([warn]);
  expect(await pass()).toEqual([]);
  gh.failing.clear();
  expect(await pass()).toEqual([
    "PR_FEEDBACK acme/app#7 lane=fix-7 thread=discord:1 kind=comment by=maintainer https://github.com/acme/app/pull/7#c3 | ping",
  ]);
  gh.failing.set("/reviews", "HTTP 502: Bad Gateway");
  expect(await pass()).toEqual([warn]);
});

test("lines printed but not committed (a crash) are printed again, never lost", async () => {
  await pass();
  pr.comments.push(row(4, "maintainer", "again"));
  const first = await pass(undefined, false);
  expect(first).toHaveLength(1);
  expect(await pass()).toEqual(first);
});

test("without our own login nothing is read: one hold warning until the account reads back or --self names it", async () => {
  gh = fakeGitHub({ [KEY]: pr }, null);
  expect(await pass()).toEqual([
    "PR_WATCH_WARN self holding: cannot tell our own activity from others (gh api user: exit 1: HTTP 401)",
  ]);
  expect(await pass()).toEqual([]);
  expect(gh.calls.every((c) => c === "user")).toBe(true);
  expect(await pass({ ignore: new Set(), self: "me" })).toHaveLength(1);
});

test("--ignore-author skips a bot's comments and commits; GitHub text stays one line without controls", async () => {
  await pass();
  pr.comments.push(row(5, "ci-bot[bot]", "coverage 91%"));
  pr.comments.push(row(6, "evil\nPR_MERGED", "line one\nline two \u001b[31mred\u001b[0m \u202edlrow\u2028end"));
  pr.comments[1]!.html_url = "https://github.com/acme/app/pull/7 PR_MERGED";
  pr.commits.push({ sha: sha("b"), author: "ci-bot[bot]" });
  pr.head = sha("b");
  expect(await pass({ ignore: new Set(["ci-bot[bot]"]) })).toEqual([
    "PR_FEEDBACK acme/app#7 lane=fix-7 thread=discord:1 kind=comment by=evil_PR_MERGED - | line one line two [31mred [0m dlrow end",
  ]);
});

test("a damaged cursor file holds the watcher and is left for inspection, not reset to a new baseline", async () => {
  await pass();
  const tracking = new PrTracking(state.dir);
  writeFileSync(tracking.statePath, '{"version":1,"prs":{"acme/app#7":{"head":1}}}');
  const lines = await pass();
  expect(lines).toEqual([`PR_WATCH_WARN state holding: ${tracking.statePath}: damaged entry "acme/app#7"`]);
  expect(readFileSync(tracking.statePath, "utf8")).toBe('{"version":1,"prs":{"acme/app#7":{"head":1}}}');
  expect(gh.calls.filter((c) => c !== "user")).toHaveLength(7);
});
