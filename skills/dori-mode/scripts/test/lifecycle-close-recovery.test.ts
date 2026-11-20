import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { closeLane, type FlowDeps, objectDone, watchTick } from "../src/done-flow.ts";
import { parkLane } from "../src/park.ts";
import { type Lane, Registry, sessionOf, withStatus } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import type { Ran } from "../src/run.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

const evidence = "merge verified";
const note = `Done: ${evidence}`;
let f: LifecycleFixture;
let deps: FlowDeps;
let claim: Lane;
let pane: string;
let worktree: string;
let atNativeClose: Lane | null;

const isWorktreeRemoval = ([cmd, , , scope, verb]: readonly string[]) =>
  cmd === "git" && scope === "worktree" && verb === "remove";
const panePresent = () => f.world.panes.some((entry) => entry.pane_id === pane);
const paneEffects = () =>
  f.world.calls.filter(
    ([cmd, scope, verb]) =>
      cmd === "herdr" && (verb === "close" || verb === "send-text" || verb === "send-keys" || scope === "agent"),
  );
const cleanupCalls = () => f.world.calls.filter((argv) => argv[0] === "notify" || isWorktreeRemoval(argv));
const claimIdentity = () => ({
  claim: claim.claim,
  openedAt: claim.openedAt,
  lifecycleEpoch: claim.lifecycleEpoch,
  sessionRef: claim.sessionRef,
  session: claim.session,
  sessionFile: claim.sessionFile,
});
const expectPendingClose = (lane: Lane | null | undefined) => {
  expect(lane).toMatchObject({
    ...claimIdentity(),
    status: "done-claimed",
    nativeCloseIntent: {
      ref: claim.sessionRef,
      session: claim.session,
      epoch: claim.lifecycleEpoch,
      note,
      checks: [{ signal: claim.done, ok: true }],
      settlingClaim: true,
    },
  });
};

beforeEach(async () => {
  f = await lifecycleFixture();
  const parked = await parkLane(f.deps, f.lane, "wait");
  expect(parked.code).toBe(0);
  const reopened = await reopenLane(f.deps, parked.lane);
  expect(reopened.code).toBe(0);
  expect(reopened.lane.lifecycleEpoch).toBeDefined();
  pane = sessionOf(reopened.lane)!.id;
  expect(panePresent()).toBe(true);
  f.world.calls.length = 0;
  atNativeClose = null;

  worktree = join(f.state.dir, "owned-worktree");
  mkdirSync(worktree);
  const at = new Date(f.deps.clock.now()).toISOString();
  claim = withStatus(reopened.lane, "done-claimed", evidence, at, {
    claim: { at, evidence, emitted: true },
    thread: "discord:fixture-thread",
    worktrees: [worktree],
  });
  deps = {
    ...f.deps,
    clock: { ...f.deps.clock, now: () => f.deps.clock.now() + 6 * 60_000 },
    config: { ...f.deps.config, closeAfterMin: 5, hooks: { threadDone: ["notify", "{thread}", "{text}"] } },
    exists: existsSync,
    run: async (argv, options) => {
      if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "close" && argv[3] === pane)
        atNativeClose = await f.deps.registry.read(claim.key);
      const result = await f.deps.run(argv, options);
      if (result.code === 0 && isWorktreeRemoval(argv) && argv[5] === worktree) rmdirSync(worktree);
      return result;
    },
  };
  await deps.registry.write(claim);
});
afterEach(() => f.state.done());

// Inject at the first pane-list response after the fake Herdr command has actually removed the exact pane.
const withPostCloseList = (interleave: () => Promise<Ran | undefined>): FlowDeps => {
  let removed = false;
  let injected = false;
  return {
    ...deps,
    run: async (argv, options) => {
      const [cmd, scope, verb, id] = argv;
      if (removed && !injected && cmd === "herdr" && scope === "pane" && verb === "list") {
        injected = true;
        const result = await interleave();
        if (result) {
          f.world.calls.push([...argv]);
          return result;
        }
      }
      const result = await deps.run(argv, options);
      if (cmd === "herdr" && scope === "pane" && verb === "close" && id === pane && result.code === 0)
        removed = !panePresent();
      return result;
    },
  };
};

const expectClosed = async (lines: readonly string[], registry = deps.registry) => {
  const closed = await registry.read(claim.key);
  expect(lines).toEqual([`LANE_CLOSED ${claim.key} ${JSON.stringify(closed?.receipt)}`]);
  expect(closed).toMatchObject({
    ...claimIdentity(),
    status: "closed",
    closedAt: new Date(deps.clock.now()).toISOString(),
    receipt: {
      outcome: "done",
      checks: [{ signal: claim.done, ok: true }],
      note,
      cleanup: [`pane ${pane} closed`, "thread marked done", `worktree ${worktree} removed`],
    },
  });
  expect(closed?.history?.slice(claim.history?.length).map(({ status }) => status)).toEqual([
    "verified-done",
    "closed",
  ]);
  expect(closed?.objection).toBeUndefined();
  expect(paneEffects()).toEqual([["herdr", "pane", "close", pane]]);
  expect(cleanupCalls()).toEqual([
    ["notify", claim.thread, note],
    ["git", "-C", f.deps.config.defaultCwd, "worktree", "remove", worktree],
  ]);
  expect(panePresent()).toBe(false);
  expect(existsSync(worktree)).toBe(false);
};

test("an objection during post-close readback leaves the committed claim and its close receipt intact", async () => {
  let objection: { before: Lane | null; after: Lane | null; line: string } | undefined;
  const registry = new Registry(f.state.dir);
  const closing = withPostCloseList(async () => {
    const before = await registry.read(claim.key);
    const line = await objectDone({ ...deps, registry }, before!, ["late objection after pane removal"]);
    objection = { before, after: await registry.read(claim.key), line };
    return undefined;
  });

  const lines = await watchTick(closing);

  expect(objection?.line).toBe(`LANE_CHANGED ${claim.key} native close is in progress; objection not recorded`);
  expectPendingClose(atNativeClose);
  expectPendingClose(objection?.before);
  expect(objection?.after).toEqual(objection?.before);
  await expectClosed(lines);
});

test("a lost post-close list holds without cleanup, then a fresh watcher settles the same expired claim", async () => {
  const failure = "fixture lost the post-close pane list";
  const interrupted = withPostCloseList(async () => ({ code: 1, out: "", err: failure }));

  const lines = await watchTick(interrupted);

  expect(lines).toEqual([expect.stringContaining(`LANE_HELD ${claim.key}:`)]);
  expect(lines[0]).toContain(failure);
  expect(panePresent()).toBe(false);
  expect(paneEffects()).toEqual([["herdr", "pane", "close", pane]]);
  expect(cleanupCalls()).toEqual([]);
  expect(existsSync(worktree)).toBe(true);
  const registry = new Registry(f.state.dir);
  const held = await registry.read(claim.key);
  expect(held).toMatchObject({ ...claimIdentity(), status: "done-claimed", history: claim.history });
  expect(held?.closedAt).toBeUndefined();
  expect(held?.receipt).toBeUndefined();

  const retryStart = f.world.calls.length;
  await expectClosed(await watchTick({ ...deps, registry }), registry);
  const retryCalls = f.world.calls.slice(retryStart);
  const list = retryCalls.findIndex(([cmd, scope, verb]) => cmd === "herdr" && scope === "pane" && verb === "list");
  const threadDone = retryCalls.findIndex(([cmd]) => cmd === "notify");
  expect(list).toBeGreaterThanOrEqual(0);
  expect(threadDone).toBeGreaterThan(list);
  expectPendingClose(held);
});

test("a prepared reopened lane blocks sibling completion until native close recovery", async () => {
  deps = { ...deps, config: { ...deps.config, threadDonePolicy: "last-lane" } };
  const sibling: Lane = {
    key: "shared-sibling",
    title: "Sibling",
    thread: claim.thread,
    brief: claim.brief,
    cwd: f.deps.config.defaultCwd,
    done: claim.done,
    openedAt: claim.openedAt,
  };
  await deps.registry.write(sibling);
  const interrupted = withPostCloseList(async () => ({ code: 1, out: "", err: "interrupted readback" }));

  expect(await watchTick(interrupted)).toEqual([expect.stringContaining("interrupted readback")]);
  expectPendingClose(await deps.registry.read(claim.key));
  expect((await closeLane(deps, sibling, "done")).closed).toBe(true);
  expect(cleanupCalls()).toEqual([]);

  f.world.prState = "OPEN";
  f.world.dirty = " M tracked-after-prepare";
  await expectClosed(await watchTick(deps));
  expect(await watchTick(deps)).toEqual([]);
});

test("an absent reopened pane without close intent stays held rather than getting a close receipt", async () => {
  const before = await deps.registry.read(claim.key);
  // An unrelated disappearance, not a Dori-issued native close.
  f.world.panes = f.world.panes.filter((entry) => entry.pane_id !== pane);
  expect(panePresent()).toBe(false);

  expect(await watchTick(deps)).toEqual([expect.stringContaining(`LANE_HELD ${claim.key}:`)]);
  expect(await deps.registry.read(claim.key)).toEqual(before);
  expect(paneEffects()).toEqual([]);
  expect(cleanupCalls()).toEqual([]);
  expect(existsSync(worktree)).toBe(true);
});
