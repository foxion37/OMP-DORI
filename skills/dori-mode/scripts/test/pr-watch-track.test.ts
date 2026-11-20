import { afterEach, beforeEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig } from "../src/config.ts";
import { autoTrack } from "../src/cli-pr.ts";
import { parsePrRef, PrTracking, prLinks } from "../src/pr-watch.ts";
import { type Lane, Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { type TestState, withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const T0 = Date.parse("2026-11-17T00:00:00Z");
let state: TestState;

beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());

const dori = (config: Record<string, unknown> = {}) => {
  const path = join(state.dir, "config.json");
  writeFileSync(path, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {}, ...config }));
  return (...args: string[]) =>
    run(["env", `DORI_CONFIG=${path}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, ...args]);
};

const lane = (key: string, thread: string): Lane => ({
  key,
  title: key,
  thread,
  brief: "/dev/null",
  done: "file /dev/null",
  openedAt: new Date(T0).toISOString(),
  status: "working",
});

test("a PR is named as owner/repo#N or a pull link; anything else is refused", () => {
  for (const text of [
    "acme/app#7",
    " acme/app#7 ",
    "https://github.com/acme/app/pull/7",
    "https://github.com/acme/app/pull/7/files",
    "https://github.com/acme/app/pull/7#discussion_r1",
  ])
    expect(parsePrRef(text)).toEqual({ repo: "acme/app", number: 7 });
  for (const text of [
    "acme/app#0",
    "acme/app#07",
    "acme#7",
    "acme/app/x#7",
    "../app#7",
    "acme/..#7",
    "acme/app#7x",
    "http://github.com/acme/app/pull/7",
    "https://github.com/acme/app/issues/7",
    "https://example.com/acme/app/pull/7",
    "acme/app#99999999999",
  ])
    expect(parsePrRef(text)).toBeUndefined();
  // Free text: pull links only, once each, whatever the case; a bare owner/repo#N may be an issue and is not taken.
  expect(
    prLinks(
      "merged https://github.com/acme/app/pull/7 and https://github.com/ACME/App/pull/7/files; closed acme/app#9; https://github.com/acme/app/pull/8x",
    ),
  ).toEqual([{ repo: "acme/app", number: 7 }]);
});

test("pr track, list and untrack; a lane gives its thread; an unknown lane or a spaced thread is refused", async () => {
  await new Registry(state.dir).write(lane("fix-7", "discord:123"));
  const run = dori();
  const tracked = await run("pr", "track", "https://github.com/acme/app/pull/7", "--lane", "fix-7");
  expect(tracked.out).toBe("PR_TRACKED acme/app#7 lane=fix-7 thread=discord:123");
  expect((await run("pr", "track", "acme/app#8", "--lane", "nope")).err).toBe('no registered lane "nope"');
  expect((await run("pr", "track", "acme/app#8", "--thread", "a b")).code).toBe(1);
  expect((await run("pr", "track", "acme/app")).err).toContain("not owner/repo#N");
  const listed = JSON.parse((await run("pr", "list")).out);
  expect(listed).toEqual([
    {
      repo: "acme/app",
      number: 7,
      source: "dori pr track",
      lane: "fix-7",
      thread: "discord:123",
      since: expect.any(String),
      trackedAt: expect.any(String),
      watch: null,
    },
  ]);
  // A cursor saved for this tracking shows in the list; after untrack and track it belongs to the old tracking.
  const tracking = new PrTracking(state.dir);
  const entry = { since: listed[0].since, head: "a".repeat(40), commits: [], seen: ["ic:1"], state: "closed" };
  tracking.saveState({ "acme/app#7": { ...entry, state: "closed", polledAt: listed[0].since } });
  expect(JSON.parse((await run("pr", "list")).out)[0].watch).toMatchObject({ state: "closed", known: 1 });
  expect((await run("pr", "untrack", "ACME/app#7")).out).toBe("PR_UNTRACKED acme/app#7");
  expect((await run("pr", "untrack", "acme/app#7")).out).toBe("PR_NOT_TRACKED acme/app#7");
  expect(JSON.parse((await run("pr", "list")).out)).toEqual([]);
  expect((await run("pr", "track", "acme/app#7", "--lane", "fix-7", "--thread", "none")).out).toBe(
    "PR_TRACKED acme/app#7 lane=fix-7 thread=-",
  );
  expect(JSON.parse((await run("pr", "list")).out)[0].watch).toBeNull();
});

test("the tracking record skips a torn last line, names other damage, and keeps one tracking across re-tracks", () => {
  const tracking = new PrTracking(state.dir);
  tracking.track({ repo: "acme/app", number: 7 }, { source: "test", lane: "a" }, T0);
  const again = tracking.track({ repo: "acme/app", number: 7 }, { source: "again", lane: "a" }, T0 + 1);
  expect(readFileSync(tracking.path, "utf8").trim().split("\n")).toHaveLength(2);
  expect([again.since, again.trackedAt]).toEqual([new Date(T0).toISOString(), new Date(T0 + 1).toISOString()]);
  // A repeated auto-tracking with the same lane writes nothing more.
  autoTrack(state.dir, { key: "a", thread: "" }, "https://github.com/acme/app/pull/7", "claim-done a", T0 + 2);
  expect(readFileSync(tracking.path, "utf8").trim().split("\n")).toHaveLength(2);
  appendFileSync(tracking.path, 'not json\n{"op":"track","repo":"x/y","number":1,"at":"2026-11-17T00:00:00.000Z"}\n');
  appendFileSync(tracking.path, '{"op":"track","repo":"acme/app","nu');
  const read = tracking.read();
  expect(read.prs.map((p) => p.number)).toEqual([7]);
  expect(read.problems).toEqual([
    `${tracking.path}:3: JSON Parse error: Unexpected identifier "not"`,
    `${tracking.path}:4: field "source" must be one line`,
  ]);
  // The next append starts on its own line, so only the torn record is lost.
  tracking.track({ repo: "acme/app", number: 8 }, { source: "test" }, T0 + 2);
  expect(tracking.read().prs.map((p) => p.number)).toEqual([7, 8]);
});

test("auto-tracking is off by default; with prAutoTrack a checkpoint's PR receipt is tracked for its lane", async () => {
  await new Registry(state.dir).write(lane("fix-7", "discord:123"));
  const receipt = "pushed https://github.com/acme/app/pull/7";
  const off = await dori()(
    "checkpoint",
    "fix-7",
    "--step",
    "s1",
    "--result",
    "ok",
    "--evidence",
    "/dev/null",
    "--remote-effect",
    receipt,
  );
  expect(off.code).toBe(0);
  expect(off.err).toBe("");
  expect(new PrTracking(state.dir).read().prs).toEqual([]);
  const on = await dori({ prAutoTrack: true })(
    "checkpoint",
    "fix-7",
    "--step",
    "s2",
    "--result",
    "ok",
    "--evidence",
    "/dev/null",
    "--remote-effect",
    "pushed abc1234 to the fork",
    "--remote-effect",
    "pr https://github.com/acme/app/pull/9",
  );
  expect(on.code).toBe(0);
  expect(on.err).toBe("PR_TRACKED acme/app#9 lane=fix-7 thread=discord:123");
  expect(new PrTracking(state.dir).read().prs.map((p) => [p.number, p.source])).toEqual([[9, "checkpoint fix-7"]]);
});

test("with prAutoTrack a recorded claim tracks each PR link in its evidence once; off, the claim tracks nothing", async () => {
  // Lanes without a session: the claim is recorded without messaging a pane.
  await new Registry(state.dir).write(lane("fix-7", ""));
  await new Registry(state.dir).write(lane("fix-8", "discord:8"));
  const evidence = "https://github.com/acme/app/pull/7 opened; CI https://github.com/acme/app/pull/7/checks";
  const off = await dori()("claim-done", "fix-8", "--evidence", "https://github.com/acme/app/pull/8");
  expect(off.out).toStartWith("LANE_DONE_CLAIMED fix-8");
  expect(off.err).toBe("");
  const on = await dori({ prAutoTrack: true })("claim-done", "fix-7", "--evidence", evidence);
  expect(on.out).toStartWith("LANE_DONE_CLAIMED fix-7");
  expect(on.err).toBe("PR_TRACKED acme/app#7 lane=fix-7 thread=-");
  expect(new PrTracking(state.dir).read().prs.map((p) => [p.number, p.source])).toEqual([[7, "claim-done fix-7"]]);
  // The library entry point takes the lane's thread when it is one token.
  expect(autoTrack(state.dir, { key: "fix-8", thread: "discord:8" }, evidence, "test", T0)).toEqual([
    "PR_TRACKED acme/app#7 lane=fix-8 thread=discord:8",
  ]);
});

test("prAutoTrack is true, false or absent; any other value stops the load", async () => {
  const path = join(state.dir, "config.json");
  for (const value of [true, false]) {
    await Bun.write(path, JSON.stringify({ prAutoTrack: value }));
    expect((await loadConfig(path, "/home/ana")).prAutoTrack).toBe(value);
  }
  await Bun.write(path, "{}");
  expect((await loadConfig(path, "/home/ana")).prAutoTrack).toBe(false);
  for (const value of ["true", "false", 1, null]) {
    await Bun.write(path, JSON.stringify({ prAutoTrack: value }));
    await expect(loadConfig(path, "/home/ana")).rejects.toBeInstanceOf(ConfigError);
  }
});
