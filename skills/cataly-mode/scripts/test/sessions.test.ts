import { afterEach, beforeEach, expect, test } from "bun:test";

import { ENTER_ATTEMPTS } from "../../../../src/runtime/terminal/deliver.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { block, ZSH } from "../../../../test/fake-tern.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import type { PaneState } from "../src/lane-state.ts";
import { type Ran, runtimesOf } from "../src/run.ts";
import { listSessions, sendVerified, shellInFront, UnsafeTextError } from "../src/sessions.ts";
import { agentIn, laneState, ternDeps, ternOf, ternRef, ternSent } from "./fake-tern-world.ts";
import { fakeClock, newWorld, withState, type TestState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const ID = "5001";
const B1 = ternRef(ID);

let state: TestState;
let world: World;
let deps: FlowDeps;

/** A live OMP agent in block ID with the extension's record beside it; `working` is Tern's busy flag. */
const agent = (opts: { readonly working?: boolean } = {}, record: Partial<PaneState> = {}): SessionRef => {
  agentIn(world, ID, opts);
  laneState(state.dir, ID, record);
  return B1;
};
const blockOf = () => {
  const b = ternOf(world).blocks.get(ID);
  if (b === undefined) throw new Error(`no block ${ID}`);
  return b;
};
/** Deps whose runner first offers each argv to `over`; an undefined answer falls through to the fake world. */
const wrapped = (over: (argv: readonly string[]) => Promise<Ran> | undefined): FlowDeps => {
  const base = ternDeps(world, fakeClock(T0), state.dir);
  return { ...base, run: (argv) => over(argv) ?? base.run(argv) };
};
const send = (text: string, ref: SessionRef = B1, d: FlowDeps = deps) =>
  sendVerified(runtimesOf(d), d.clock, ref, text);
const entered = () => ternOf(world).entered;

beforeEach(() => {
  state = withState();
  world = newWorld();
  deps = ternDeps(world, fakeClock(T0), state.dir);
});
afterEach(() => state.done());

test("delivery is confirmed by the block's agent turning working, with exactly one paste and one Enter", async () => {
  agent();
  expect(await send("[LEAD] please report")).toBe("delivered");
  expect(entered()).toEqual([ID]);
  expect(ternSent(world)).toEqual(["[LEAD] please report"]);
  expect(ternOf(world).submitted).toEqual([{ id: ID, text: "[LEAD] please report" }]);
});

test("an Enter the agent takes without turning working is unconfirmed and never pressed again", async () => {
  agent();
  const d = wrapped((argv) => {
    if (argv[1] !== "send" || argv[3] !== "keys") return undefined;
    return deps.run(argv).then((r) => {
      blockOf().working = false;
      return r;
    });
  });
  expect(await send("[LEAD] no status change", B1, d)).toBe("unconfirmed");
  expect(entered()).toEqual([ID]);
  expect(ternSent(world)).toEqual(["[LEAD] no status change"]);
});

test("text left in the input is pasted once; sendVerified adds no Enter past the runtime's bounded submit", async () => {
  agent();
  ternOf(world).knobs.enterSwallowed = 99;
  expect(await send("[LEAD] stuck text still here")).toBe("unconfirmed");
  expect(ternSent(world)).toEqual(["[LEAD] stuck text still here"]);
  expect(entered()).toHaveLength(ENTER_ATTEMPTS);
  expect(ternOf(world).submitted).toEqual([]);
});

test("a block that was already working cannot show a change, so the send is unconfirmed, not delivered", async () => {
  agent({ working: true });
  expect(await send("[LEAD] queued while busy")).toBe("unconfirmed");
  expect(entered()).toEqual([ID]);
  expect(ternSent(world)).toEqual(["[LEAD] queued while busy"]);
});

test("the send is gated on the status read before it: an agent that turned working in between gets nothing", async () => {
  agent({}, { agentStatus: "working" });
  expect(await send("[LEAD] please report")).toBe("failed");
  expect(ternSent(world)).toEqual([]);
  expect(entered()).toEqual([]);
});

test("a block with no running agent is a bare shell: nothing is typed, the send fails", async () => {
  ternOf(world).blocks.set(ID, block({ foreground: ZSH, group: ZSH.pid, draft: undefined, body: "$ " }));
  expect(await send("[LEAD] please report")).toBe("failed");
  ternOf(world).blocks.delete(ID);
  expect(await send("[LEAD] please report")).toBe("failed");
  expect(ternSent(world)).toEqual([]);
  expect(entered()).toEqual([]);
});

test("an agent suspended with Ctrl+Z still has an idle record, but the shell is in front: nothing is typed", async () => {
  agent({}, { agentStatus: "idle" });
  const shell = blockOf().child;
  Object.assign(blockOf(), { foreground: { ...shell, argv: ["-zsh"] }, group: shell.pid });
  expect(await shellInFront(runtimesOf(deps), B1)).toBe(true);
  expect(await send("[LEAD] please report")).toBe("failed");
  expect(ternSent(world)).toEqual([]);
  expect(entered()).toEqual([]);
});

test("a non-interactive sh -c in front is no shell but no agent Tern can read; an empty foreground is doubt", async () => {
  agent();
  blockOf().foreground = { pid: 4300, name: "sh", argv: ["sh", "-c", "true"] };
  expect(await shellInFront(runtimesOf(deps), B1)).toBe(false);
  expect(await send("[LEAD] one")).toBe("failed");
  blockOf().foreground = null;
  expect(await shellInFront(runtimesOf(deps), B1)).toBe(true);
  expect(await send("[LEAD] two")).toBe("failed");
  expect(ternSent(world)).toEqual([]);
  expect(entered()).toEqual([]);
  // The agent back in front is delivered to again.
  agent();
  expect(await shellInFront(runtimesOf(deps), B1)).toBe(false);
  expect(await send("[LEAD] three")).toBe("delivered");
});

test("a failed probe is doubt: shellInFront holds the send and nothing is typed", async () => {
  agent();
  ternOf(world).knobs.processError = "tern down";
  expect(await shellInFront(runtimesOf(deps), B1)).toBe(true);
  expect(await send("[LEAD] please report")).toBe("failed");
  expect(ternSent(world)).toEqual([]);
  expect(entered()).toEqual([]);
});

test("a failed block lookup is doubt: nothing is typed, the send fails", async () => {
  agent();
  const typed: (readonly string[])[] = [];
  const d = wrapped((argv) => {
    if (argv[0] !== "tern") return undefined;
    if (argv[1] === "inspect") return Promise.resolve({ code: 1, out: "", err: "tern inspect: not running" });
    if (argv[1] === "send") typed.push(argv);
    return undefined;
  });
  expect(await shellInFront(runtimesOf(d), B1)).toBe(true);
  expect(await send("[LEAD] please report", B1, d)).toBe("failed");
  expect(typed).toEqual([]);
});

test("an agent awaiting an approval gets nothing", async () => {
  agent({}, { approvalPending: true });
  expect(await send("[LEAD] please report")).toBe("failed");
  expect(ternSent(world)).toEqual([]);
  expect(entered()).toEqual([]);
});

test("text with a backtick or $( never reaches a block", async () => {
  agent();
  world.calls = [];
  for (const text of ["run `rm -rf`", "run $(rm -rf)"])
    await expect(send(text)).rejects.toBeInstanceOf(UnsafeTextError);
  expect(world.calls).toHaveLength(0);
  expect(ternSent(world)).toEqual([]);
});

test("listing names each live block's status", async () => {
  agent({}, { agentStatus: "idle" });
  ternOf(world).blocks.set("5002", block({ foreground: ZSH, group: ZSH.pid, draft: undefined, body: "$ " }));
  ternOf(world).blocks.set("5003", block({ live: false }));
  const lanes = [{ sessionRef: B1 }, {}];
  const listed = await listSessions(runtimesOf(deps), { lanes });
  expect(listed.map((s) => `${s.ref.runtime}:${s.ref.id}:${s.status}`).sort()).toEqual([
    "tern:5001:idle",
    "tern:5002:shell",
  ]);
  expect(listed.find((s) => s.ref.id === ID)?.agent).toBe("omp");
  expect(await listSessions(runtimesOf(deps), { group: "elsewhere" })).toEqual([]);
});

test("a failed runtime choice still lists a stored Tern lane; with no lane the failure is thrown", async () => {
  agent();
  for (const choice of ["tmux", "screen"]) {
    const failing = (): FlowDeps => ({ ...ternDeps(world, fakeClock(T0), state.dir), env: { CATALY_RUNTIME: choice } });
    const listed = await listSessions(runtimesOf(failing()), { lanes: [{ sessionRef: B1 }] });
    expect(listed.map((s) => `${s.ref.runtime}:${s.ref.id}`)).toEqual(["tern:5001"]);
    await expect(listSessions(runtimesOf(failing()))).rejects.toThrow();
  }
});
