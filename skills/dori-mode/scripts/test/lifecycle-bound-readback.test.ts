import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeLane } from "../src/done-flow.ts";
import { readPaneState, writePaneState } from "../src/lane-state.ts";
import { parkLane } from "../src/park.ts";
import { sessionFields, statusOf } from "../src/registry.ts";
import { reopenLane } from "../src/reopen.ts";
import { laneState } from "./fakes.ts";
import { hcTerm } from "./hc-runner.ts";
import { lifecycleFixture, type LifecycleFixture } from "./lifecycle-fixture.ts";

let f: LifecycleFixture;
beforeEach(async () => {
  f = await lifecycleFixture();
});
afterEach(() => f.state.done());

test("reopened hc close does not kill a shell script that took over during the working screen read", async () => {
  const ref = { runtime: "hc", id: "t7" } as const;
  const pid = 4242;
  const rootPid = 4241;
  const cwd = f.deps.config.defaultCwd;
  const { tab: _tab, ...base } = f.lane;
  const lane = { ...base, ...sessionFields(ref), status: "working" as const, lifecycleEpoch: "hc-reopened" };
  await f.deps.registry.write(lane);
  const terminal = hcTerm({
    cwd,
    pid: rootPid,
    status: { state: "working", app: "omp" },
    foreground: { name: "omp", argv: ["omp"], pid },
    screen: "──────────\n❯\n──────────",
  });
  f.world.terminals[ref.id] = terminal;
  // OSC working may describe background work; this fixture closes a main that the native extension attests idle.
  laneState(f.state.dir, ref.id, { cwd, pid, sessionId: f.session, sessionFile: f.file, agentStatus: "idle" });
  const nativeBefore = readPaneState(f.state.dir, ref.id);
  expect(nativeBefore).toMatchObject({ pid, sessionId: f.session });
  const shell = { name: "bash", argv: ["bash", "owner-script.sh"], pid: 4251 };
  f.world.procs?.push({ pid: shell.pid, ppid: rootPid, cmd: shell.argv.join(" ") });
  const result = await closeLane(
    {
      ...f.deps,
      config: { ...f.deps.config, runtime: "hc" },
      run: async (argv, options) => {
        const response = await f.deps.run(argv, options);
        // The read returns the old idle-looking screen, but its caller resumes with a different foreground.
        if (argv[0] === "hc" && argv[2] === "read" && argv[3] === ref.id && response.code === 0)
          terminal.foreground = shell;
        return response;
      },
    },
    lane,
    "verified Done",
  );

  const trace = f.world.calls.filter(([cmd, , , id]) => cmd === "hc" && id === ref.id).map(([, , verb]) => verb);
  const read = trace.indexOf("read");
  expect(trace).toContain("get");
  expect(result.lines.join("\n")).toContain("SIGNAL OK");
  expect(readPaneState(f.state.dir, ref.id)).toEqual(nativeBefore);
  const registered = await f.deps.registry.read(lane.key);
  expect(registered).toBeDefined();
  if (read === -1) {
    // A foreground-only probe never opens the race window; closing the still-owned terminal is valid.
    expect(terminal.foreground).toMatchObject({ name: "omp", pid });
    expect(result.closed).toBe(true);
    expect(trace.filter((verb) => verb === "kill")).toHaveLength(1);
  } else {
    expect(terminal.foreground).toEqual(shell);
    expect({
      refreshed: trace.slice(read + 1).includes("get"),
      closed: result.closed,
      effects: trace.filter((verb) => verb === "kill" || verb === "rm"),
    }).toEqual({
      refreshed: true,
      closed: false,
      effects: [],
    });
    expect(terminal.state).toBe("live");
    expect(statusOf(registered!)).toBe("working");
    expect(registered?.receipt).toBeUndefined();
  }
});

test.each(["after paste", "after Enter"] as const)("reopen note stays unconfirmed on switch %s", async (switchAt) => {
  const parked = await parkLane(f.deps, f.lane, "owner asked to stop");
  expect(parked.code).toBe(0);
  f.world.calls.length = 0;
  const pane = "w1:p8";
  const note = "Continue with the updated scope";
  const text = `[LEAD] ${note}`;
  const replacement = "01a11440-ee81-7f90-b2ed-dcc7d51a0ade";
  const file = join(dirname(f.file), `2026-01-01T12-01-00-000Z_${replacement}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: replacement, cwd: f.deps.config.defaultCwd })}\n`);
  let promptCode: number | undefined;
  let pasted = false;
  const noteEffects: string[] = [];

  const reopened = await reopenLane(
    {
      ...f.deps,
      run: async (argv, options) => {
        const response = await f.deps.run(argv, options);
        const [cmd, scope, action, id, value] = argv;
        if (cmd !== "herdr" || id !== pane) return response;
        if (scope === "agent" && action === "prompt" && value === text) {
          promptCode = response.code;
          noteEffects.push("prompt");
        }
        const paste = scope === "pane" && action === "send-text" && value === text;
        const enter = scope === "pane" && action === "send-keys" && value === "enter" && pasted;
        if (paste) {
          pasted = true;
          noteEffects.push("paste");
        }
        if (enter) noteEffects.push("enter");
        if ((switchAt === "after paste" && paste) || (switchAt === "after Enter" && enter)) {
          const current = readPaneState(f.state.dir, pane);
          const foreground = f.world.panes.find((entry) => entry.pane_id === pane);
          if (!current || !foreground) throw new Error("missing live reopened OMP fixture");
          expect(current).toMatchObject({ pid: 4250, sessionId: f.session });
          writePaneState(f.state.dir, {
            ...current,
            sessionId: replacement,
            sessionFile: file,
            agentStatus: "working",
          });
          foreground.agent_status = "working";
        }
        return response;
      },
    },
    parked.lane,
    note,
  );

  expect(promptCode).toBe(1);
  expect(noteEffects).toEqual(switchAt === "after paste" ? ["prompt", "paste"] : ["prompt", "paste", "enter"]);
  expect(readPaneState(f.state.dir, pane)).toMatchObject({ pid: 4250, sessionId: replacement });
  expect(reopened.lane).toMatchObject({ pane, status: "working", session: f.session });
  expect(reopened.code).toBe(3);
  expect(reopened.lines.join("\n")).toContain("note=unconfirmed");
});
