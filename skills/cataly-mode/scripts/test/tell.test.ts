import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Lane, Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { tellLane } from "../src/tell.ts";
import {
  depsFor,
  type FakeSession,
  fakeClock,
  nativeLane,
  newWorld,
  sent,
  sid,
  withState,
  type World,
} from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
/** Texts the supervisor accepted, as opposed to every text offered to it (`sent`). */
let accepted: string[];
beforeEach(() => {
  state = withState();
  world = newWorld();
  accepted = [];
  world.onDeliver = (_id, text) => accepted.push(text);
});
afterEach(() => state.done());

const lane = (patch: Partial<FakeSession> = {}): Lane => ({
  key: "tell-lane",
  title: "tell",
  thread: "none",
  ...nativeLane(world, 7, patch),
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
});
const deps = () => depsFor(world, fakeClock(T0), state.dir);
/** tell reads the lane again from the registry, so each case stores the lane it passes. */
const told = async (target: Lane, text: string) => {
  await deps().registry.write(target);
  return await tellLane(deps(), target, text);
};

test("an idle lane gets the text once, verbatim, and the delivery is confirmed", async () => {
  world.onDeliverStatus = "working";
  expect(await told(lane(), "owner chose option 2")).toEqual({
    line: "TOLD tell-lane delivery=confirmed",
    code: 0,
  });
  expect(sent(world)).toEqual(["owner chose option 2"]);
  // The supervisor takes the text whole: no line flattening and no shell-character refusal on a native session.
  expect((await told(lane(), "first\n  second, run $(id) and `ls`")).code).toBe(0);
  expect(accepted).toEqual(["owner chose option 2", "first\n  second, run $(id) and `ls`"]);
});

test("a working lane's supervisor queues the text and confirms it, bound to the lane's session", async () => {
  expect(await told(lane({ status: "working" }), "owner chose option 2")).toEqual({
    line: "TOLD tell-lane delivery=confirmed",
    code: 0,
  });
  expect(accepted).toEqual(["owner chose option 2"]);
  // A replacement session under the same ref is not the lane's session: the supervisor refuses it.
  const stale = lane();
  (world.sessions[sid(7)] as FakeSession).sessionId = "session-replaced";
  expect((await told(stale, "again")).code).toBe(2);
  expect(accepted).toEqual(["owner chose option 2"]);
});

test("an ambiguous supervisor answer is unconfirmed, exit 3, never sent again, and holds later messages", async () => {
  world.deliverOutcome = () => ({ kind: "ambiguous", detail: "host response lost", failure: new Error("lost") });
  const target = lane();
  const r = await told(target, "owner chose option 2");
  expect(r.code).toBe(3);
  expect(r.line).toStartWith("TELL_UNCONFIRMED tell-lane delivery=unconfirmed:");
  expect(r.line).toEndWith("do not resend");
  expect(sent(world)).toEqual(["owner chose option 2"]);
  const next = await tellLane(deps(), target, "follow-up");
  expect(next.code).toBe(2);
  expect(next.line).toStartWith("TELL_HELD tell-lane delivery=held:");
  expect(sent(world)).toEqual(["owner chose option 2"]);
});

test("a gone session, an approval-held session or a blocked agent takes nothing: failed, exit 2", async () => {
  for (const [patch, seen] of [
    [{ status: "gone" }, "no agent"],
    [{ status: "idle", held: true }, "idle"],
    [{ status: "blocked" }, "blocked"],
  ] as const) {
    expect(await told(lane(patch), "owner chose option 2")).toEqual({
      line: `TELL_FAILED tell-lane delivery=failed: no agent ready for input (status now: ${seen}); nothing was sent`,
      code: 2,
    });
  }
  // A gone session is never offered the text; the others are offered it and refuse.
  expect(sent(world)).toEqual(["owner chose option 2", "owner chose option 2"]);
  expect(accepted).toEqual([]);
});

test("a paused, sessionless or unconfirmed lane is refused before any delivery", async () => {
  const live = lane();
  expect(await told({ ...live, status: "paused" }, "go on")).toEqual({
    line: "TELL_FAILED tell-lane delivery=failed: the lane is paused; resume it first; nothing was sent",
    code: 2,
  });
  const { sessionRef: _ref, session: _session, sessionFile: _file, ...sessionless } = live;
  expect((await told(sessionless, "go on")).line).toBe(
    "TELL_FAILED tell-lane delivery=failed: the lane has no session; nothing was sent",
  );
  const { session: _unbound, ...unconfirmed } = live;
  expect((await told(unconfirmed, "go on")).line).toBe(
    "TELL_FAILED tell-lane delivery=failed: the lane has no confirmed native session; nothing was sent",
  );
  expect(world.calls).toEqual([]);
});

test("the CLI prints the outcome line and exits with its code; unknown or closed lanes are refused", async () => {
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  const registry = new Registry(state.dir);
  await registry.write({ ...lane(), status: "paused" });
  await registry.write({ ...lane(), key: "closed-lane", closedAt: new Date(T0).toISOString() });
  const cli = join(import.meta.dir, "../src/cli.ts");
  const tell = (...args: string[]) =>
    run(["env", `CATALY_CONFIG=${config}`, `CATALY_STATE_DIR=${state.dir}`, process.execPath, cli, "tell", ...args]);

  const paused = await tell("tell-lane", "--text", "go on");
  expect(paused.code).toBe(2);
  expect(paused.out.trim()).toBe(
    "TELL_FAILED tell-lane delivery=failed: the lane is paused; resume it first; nothing was sent",
  );
  expect((await tell("tell-lane")).code).toBe(1);
  expect((await tell("no-such-lane", "--text", "hi")).err).toContain('no registered lane "no-such-lane"');
  expect((await tell("closed-lane", "--text", "hi")).err).toContain("lane closed-lane is already closed");
  expect((await tell("--text", "hi")).err).toContain("tell needs a lane key");
});
