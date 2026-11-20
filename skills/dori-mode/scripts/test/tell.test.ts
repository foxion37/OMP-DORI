import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Lane, Registry } from "../src/registry.ts";
import { run } from "../src/run.ts";
import { tellLane } from "../src/tell.ts";
import { depsFor, fakeClock, hcSent, newWorld, sent, withState, type World } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
let state: ReturnType<typeof withState>;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

const lane: Lane = {
  key: "tell-lane",
  title: "tell",
  thread: "none",
  pane: "w:p7",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
};
const deps = () => depsFor(world, fakeClock(T0), state.dir);
const pane = (patch: Partial<World["panes"][number]>) => {
  world.panes = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", ...patch }];
};
const typed = () => world.calls.filter((c) => c[2] === "send-text" || c[2] === "send-keys");
/** tell reads the lane again from the registry, so each case stores the lane it passes. */
const told = async (target: Lane, text: string) => {
  await deps().registry.write(target);
  return await tellLane(deps(), target, text);
};

test("an idle lane that starts working on the message is confirmed, with the text sent once", async () => {
  pane({ agent_status: "idle" });
  world.onEnterStatus = "working";
  expect(await told(lane, "owner chose option 2")).toEqual({
    line: "TOLD tell-lane delivery=confirmed",
    code: 0,
  });
  expect(sent(world)).toEqual(["owner chose option 2"]);
  // herdr's typed fallback submits one line: the documented line-break flattening, still one send.
  pane({ agent_status: "idle" });
  expect((await told(lane, "first\n  second")).code).toBe(0);
  expect(sent(world).at(-1)).toBe("first / second");
});

test("a working lane gets the text as queued input: unconfirmed, exit 3, never sent again", async () => {
  pane({ agent_status: "working" });
  const r = await told(lane, "owner chose option 2");
  expect(r.code).toBe(3);
  expect(r.line).toStartWith("TELL_UNCONFIRMED tell-lane delivery=unconfirmed:");
  expect(r.line).toEndWith("do not resend");
  expect(sent(world)).toEqual(["owner chose option 2"]);
});

test("a shell, a suspended agent or a missing pane gets nothing: failed, exit 2", async () => {
  const shell = [{ pane_id: "w:p7", workspace_id: "w" }];
  const suspended = [{ pane_id: "w:p7", workspace_id: "w", agent: "omo", agent_status: "idle", foreground: "-zsh" }];
  for (const [panes, seen] of [
    [shell, "no agent"],
    [suspended, "idle"],
    [[], "no agent"],
  ] as const) {
    world.panes = [...panes];
    expect(await told(lane, "owner chose option 2")).toEqual({
      line: `TELL_FAILED tell-lane delivery=failed: no agent ready for input (status now: ${seen}); nothing was sent`,
      code: 2,
    });
  }
  expect(typed()).toEqual([]);
  expect(world.calls.filter((c) => c[1] === "agent")).toEqual([]);
});

test("a paused lane, a lane without a session and unsafe text are refused before anything is typed", async () => {
  pane({ agent_status: "idle" });
  world.onEnterStatus = "working";
  expect(await told({ ...lane, status: "paused" }, "go on")).toEqual({
    line: "TELL_FAILED tell-lane delivery=failed: the lane is paused; resume it first; nothing was sent",
    code: 2,
  });
  const { pane: _pane, ...sessionless } = lane;
  expect((await told(sessionless, "go on")).line).toBe(
    "TELL_FAILED tell-lane delivery=failed: the lane has no session; nothing was sent",
  );
  expect((await told(lane, "run $(id) now")).line).toBe(
    "TELL_FAILED tell-lane delivery=failed: the text contains a backtick or $(; nothing was sent",
  );
  expect(world.calls).toEqual([]);
});

test("an hc lane is told through its terminal, gated on the status read before the send", async () => {
  world.terminals = { t3: hcTerm() };
  world.onEnterStatus = "working";
  const hcLane: Lane = { ...lane, pane: "t3", sessionRef: { runtime: "hc", id: "t3" } };
  expect((await told(hcLane, "owner chose option 2")).code).toBe(0);
  expect(hcSent(world)).toEqual(["owner chose option 2"]);
  expect(world.calls.find((c) => c[2] === "send")).toEqual([
    "hc",
    "--json",
    "send",
    "t3",
    "--if",
    "idle",
    "--",
    "owner chose option 2",
  ]);
  // A blocked agent (a question waiting) is held on hc, and the line names its status rather than a missing agent.
  world.terminals = { t3: hcTerm({ status: { state: "blocked", app: "omo" } }) };
  expect((await told(hcLane, "answer")).line).toBe(
    "TELL_FAILED tell-lane delivery=failed: no agent ready for input (status now: blocked); nothing was sent",
  );
  expect(hcSent(world)).toEqual(["owner chose option 2"]);
});

test("the CLI prints the outcome line and exits with its code; unknown or closed lanes are refused", async () => {
  const config = join(state.dir, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: state.dir, defaultCwd: state.dir, hooks: {} }));
  const registry = new Registry(state.dir);
  await registry.write({ ...lane, status: "paused" });
  await registry.write({ ...lane, key: "closed-lane", closedAt: new Date(T0).toISOString() });
  const cli = join(import.meta.dir, "../src/cli.ts");
  const tell = (...args: string[]) =>
    run(["env", `DORI_CONFIG=${config}`, `DORI_STATE_DIR=${state.dir}`, process.execPath, cli, "tell", ...args]);

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
