import { afterEach, beforeEach, expect, test } from "bun:test";
import { PrTracking } from "../src/pr-watch.ts";
import { prWatchPass, type WatchMemory } from "../src/pr-watch-tick.ts";
import { type TestState, withState } from "./fakes.ts";
import { type FakeGitHub, type FakePr, fakeGitHub, openPr, row, sha } from "./pr-watch-fakes.ts";

const REF = { repo: "acme/app", number: 7 };
let state: TestState;
let pr: FakePr;
let gh: FakeGitHub;
let memory: WatchMemory;
let now = Date.parse("2026-11-17T00:00:00Z");
/** The test clock, moved forward before each step so every record and pass has its own time. */
const later = (ms: number): number => {
  now += ms;
  return now;
};

beforeEach(() => {
  state = withState();
  pr = openPr();
  gh = fakeGitHub({ "acme/app#7": pr });
  memory = { warned: new Map() };
  track();
});
afterEach(() => state.done());

const track = (lane = "fix-7") => new PrTracking(state.dir).track(REF, { source: "test", lane }, later(1000));
const pass = async (): Promise<string[]> => {
  const r = await prWatchPass(state.dir, gh.run, { ignore: new Set() }, memory, later(60_000));
  r.commit();
  return r.lines;
};
const hex = (n: number): string => n.toString(16).padStart(40, "0");

test("an approval later dismissed is news: the review's state is part of what was seen", async () => {
  pr.reviews.push(row(20, "maintainer", "", "APPROVED"));
  await pass();
  pr.reviews[0]!.state = "DISMISSED";
  expect(await pass()).toEqual([
    "PR_FEEDBACK acme/app#7 lane=fix-7 thread=- kind=review-dismissed by=maintainer https://github.com/acme/app/pull/7#c20 | ",
  ]);
  expect(await pass()).toEqual([]);
});

test("a PR closed unmerged is checked for a reopen with one read per pass, then followed again", async () => {
  await pass();
  pr.state = "closed";
  expect(await pass()).toEqual(["PR_CLOSED acme/app#7 lane=fix-7 thread=- unmerged"]);
  const reads = gh.calls.length;
  expect(await pass()).toEqual([]);
  expect(gh.calls.slice(reads)).toEqual(["repos/acme/app/pulls/7"]);
  pr.state = "open";
  pr.comments.push(row(3, "maintainer", "reopened, see review"));
  // The cursor carries on: the comment that arrived while it was closed is new, not a new baseline.
  expect(await pass()).toEqual([
    "PR_FEEDBACK acme/app#7 lane=fix-7 thread=- kind=comment by=maintainer https://github.com/acme/app/pull/7#c3 | reopened, see review",
    "PR_REOPENED acme/app#7 lane=fix-7 thread=-",
  ]);
  pr.comments.push(row(4, "maintainer", "and again"));
  expect(await pass()).toHaveLength(1);
});

test("a PR closed unmerged, then reopened and merged between two passes, is reported merged", async () => {
  await pass();
  pr.state = "closed";
  await pass();
  pr.merged = true;
  pr.mergeSha = sha("e");
  pr.comments.push(row(6, "maintainer", "merging after all"));
  expect(await pass()).toEqual([
    "PR_FEEDBACK acme/app#7 lane=fix-7 thread=- kind=comment by=maintainer https://github.com/acme/app/pull/7#c6 | merging after all",
    `PR_MERGED acme/app#7 lane=fix-7 thread=- sha=${sha("e")}`,
  ]);
  const reads = gh.calls.length;
  expect(await pass()).toEqual([]);
  expect(gh.calls.length).toBe(reads);
});

test("past 250 commits, an old head GitHub no longer has is a rewrite with no commit named, not a stuck PR", async () => {
  pr.commits = Array.from({ length: 250 }, (_, i) => ({ sha: hex(i + 1), author: "me" }));
  pr.head = hex(250);
  await pass();
  pr.commits = Array.from({ length: 251 }, (_, i) => ({ sha: hex(i + 1001), author: "me" }));
  pr.head = hex(1251);
  gh.failing.set("/compare/", "gh: Not Found (HTTP 404)");
  expect(await pass()).toEqual([
    `PR_HEAD_MOVED acme/app#7 lane=fix-7 thread=- by=unknown +0 ${hex(250).slice(0, 7)}..${hex(1251).slice(0, 7)} rewritten https://github.com/acme/app/pull/7`,
  ]);
  gh.failing.set("/compare/", "HTTP 502: Bad Gateway");
  pr.commits.push({ sha: hex(1252), author: "me" });
  pr.head = hex(1252);
  expect((await pass())[0]).toStartWith("PR_WATCH_WARN acme/app#7 gh api repos/acme/app/compare/");
});

test("a closed PR's one-read check that succeeds ends its warning, so the same failure later warns again", async () => {
  await pass();
  pr.state = "closed";
  await pass();
  const warn = "PR_WATCH_WARN acme/app#7 gh api repos/acme/app/pulls/7: exit 1: HTTP 502: Bad Gateway";
  gh.failing.set("pulls/7", "HTTP 502: Bad Gateway");
  expect(await pass()).toEqual([warn]);
  gh.failing.clear();
  expect(await pass()).toEqual([]);
  gh.failing.set("pulls/7", "HTTP 502: Bad Gateway");
  expect(await pass()).toEqual([warn]);
});

test("a reopened PR whose full read keeps failing warns once, not on every pass", async () => {
  await pass();
  pr.state = "closed";
  await pass();
  pr.state = "open";
  gh.failing.set("/pulls/7/comments", "HTTP 502: Bad Gateway");
  expect(await pass()).toHaveLength(1);
  expect(await pass()).toEqual([]);
  expect(await pass()).toEqual([]);
});

test("an open PR with no commits (its branch reset to the base) is followed, not held", async () => {
  pr.commits = [];
  expect(await pass()).toHaveLength(1);
  pr.comments.push(row(7, "maintainer", "branch is empty now"));
  expect(await pass()).toHaveLength(1);
});

test("our push landing between the head read and the commit list is read again, never saved as a stranger's", async () => {
  const push = () => {
    pr.commits.push({ sha: sha("b"), author: "me" });
    pr.head = sha("b");
  };
  gh.before.set("/pulls/7/commits", push);
  expect(await pass()).toEqual(["PR_WATCH_BASELINE acme/app#7 lane=fix-7 thread=- head=bbbbbbb state=open known=0"]);
  expect(await pass()).toEqual([]);
  // A branch that keeps moving through the second read too is retried on the next pass, with a warning.
  pr.commits.push({ sha: sha("c"), author: "me" });
  pr.head = sha("c");
  gh.before.set("/pulls/7/commits", () => {
    pr.commits.push({ sha: sha("d"), author: "me" });
    pr.head = sha("d");
    gh.before.set("/pulls/7/commits", () => {
      pr.commits.push({ sha: sha("e"), author: "me" });
      pr.head = sha("e");
    });
  });
  expect(await pass()).toEqual([
    "PR_WATCH_WARN acme/app#7 the PR head moved while it was read; reading again next pass",
  ]);
  expect(await pass()).toEqual([]);
});

test("a push that takes the list to exactly 250 commits during the read is read again too", async () => {
  pr.commits = Array.from({ length: 249 }, (_, i) => ({ sha: hex(i + 1), author: "me" }));
  pr.head = hex(249);
  gh.before.set("/pulls/7/commits", () => {
    pr.commits.push({ sha: hex(250), author: "me" });
    pr.head = hex(250);
  });
  expect(await pass()).toEqual([
    `PR_WATCH_BASELINE acme/app#7 lane=fix-7 thread=- head=${hex(250).slice(0, 7)} state=open known=0`,
  ]);
  expect(await pass()).toEqual([]);
});

test("tracking a merged PR again with the same lane reads it once more; a merge is never polled after", async () => {
  await pass();
  pr.state = "closed";
  pr.merged = true;
  expect(await pass()).toEqual(["PR_MERGED acme/app#7 lane=fix-7 thread=- sha=unknown"]);
  const reads = gh.calls.length;
  expect(await pass()).toEqual([]);
  expect(gh.calls.length).toBe(reads);
  track();
  expect(await pass()).toEqual(["PR_MERGED acme/app#7 lane=fix-7 thread=- sha=unknown"]);
});

test("our own commit under an email with no GitHub account is recognized by the configured identity, never printed", async () => {
  await pass();
  pr.commits.push({ sha: sha("b"), author: null, email: "12345+me@users.noreply.github.com" });
  pr.head = sha("b");
  const options = { ignore: new Set<string>(), selfEmails: new Set(["12345+me@users.noreply.github.com"]) };
  let r = await prWatchPass(state.dir, gh.run, options, memory, later(60_000));
  expect(r.lines).toEqual([]);
  r.commit();
  pr.commits.push({ sha: sha("c"), author: null, email: "someone@example.com" });
  pr.head = sha("c");
  r = await prWatchPass(state.dir, gh.run, options, memory, later(60_000));
  expect(r.lines).toEqual([
    "PR_HEAD_MOVED acme/app#7 lane=fix-7 thread=- by=unknown +1 bbbbbbb..ccccccc https://github.com/acme/app/pull/7",
  ]);
});

test("untracking and tracking again between two passes starts a new baseline, not the old cursor", async () => {
  await pass();
  pr.comments.push(row(5, "maintainer", "said while untracked"));
  expect(new PrTracking(state.dir).untrack(REF, later(1000))?.lane).toBe("fix-7");
  track("fix-7b");
  expect(await pass()).toEqual(["PR_WATCH_BASELINE acme/app#7 lane=fix-7b thread=- head=aaaaaaa state=open known=1"]);
});

test("a failing commit status on a later page of a combined status is read", async () => {
  pr.statuses[pr.head] = Array.from({ length: 101 }, (_, i) => ({
    id: i + 1,
    state: "success",
    context: `ci/${i}`,
    target_url: `https://ci.example/${i}`,
  }));
  await pass();
  pr.statuses[pr.head]!.push({ id: 500, state: "failure", context: "ci/late", target_url: "https://ci.example/late" });
  expect(await pass()).toEqual([
    "PR_CI_FAIL acme/app#7 lane=fix-7 thread=- conclusion=failure head=aaaaaaa https://ci.example/late | ci/late",
  ]);
});

test("past GitHub's 250-commit list, a new head is compared with the old one: our push is quiet, theirs is not", async () => {
  pr.commits = Array.from({ length: 250 }, (_, i) => ({ sha: hex(i + 1), author: "me", committer: "me" }));
  pr.head = hex(250);
  await pass();
  pr.commits.push({ sha: hex(251), author: "me", committer: "me" });
  pr.head = hex(251);
  expect(await pass()).toEqual([]);
  pr.commits.push({ sha: hex(252), author: "maintainer", committer: "maintainer" });
  pr.head = hex(252);
  expect(await pass()).toEqual([
    `PR_HEAD_MOVED acme/app#7 lane=fix-7 thread=- by=maintainer +1 ${hex(251).slice(0, 7)}..${hex(252).slice(0, 7)} https://github.com/acme/app/pull/7`,
  ]);
  expect(gh.calls.filter((c) => c.includes("/compare/"))).toHaveLength(2);
});

test("exactly 3000 comments are read whole; one more is refused rather than read in part", async () => {
  pr.comments = Array.from({ length: 3000 }, (_, i) => row(i + 1, "me", "x"));
  expect(await pass()).toEqual(["PR_WATCH_BASELINE acme/app#7 lane=fix-7 thread=- head=aaaaaaa state=open known=3000"]);
  pr.comments.push(row(3001, "maintainer", "one too many"));
  expect(await pass()).toEqual(["PR_WATCH_WARN acme/app#7 repos/acme/app/issues/7/comments: more than 3000 rows"]);
  expect(sha("a")).toBe(pr.head);
});
