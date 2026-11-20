import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isDiscordWakePending } from "../src/discord-lane-wake-pending.ts";
import { wakeDiscordLane } from "../src/discord-lane-wake.ts";
import type { FlowDeps } from "../src/done-flow.ts";
import { type GoalStatus, readPaneState } from "../src/lane-state.ts";
import { type Lane, sessionOf, statusOf } from "../src/registry.ts";
import {
  executable,
  nativePid,
  next,
  prior,
  replacement,
  type WakeFixture,
  wakeFixture,
} from "./discord-lane-wake-fixture.ts";
import { laneState, sent } from "./fakes.ts";

const linux = test.skipIf(process.platform !== "linux");

let fixture: WakeFixture;
let lane: Lane;
let deps: FlowDeps;

beforeEach(async () => {
  fixture = await wakeFixture();
  ({ lane, deps } = fixture);
});

afterEach(() => fixture.state.done());

test.skipIf(process.platform === "linux")("holds an eligible retired lane before runtime calls off Linux", async () => {
  const before = await deps.registry.read(lane.key);
  const run = mock(deps.run);

  const result = await wakeDiscordLane({ ...deps, run }, lane);

  expect(result).toEqual({ kind: "held", reason: "exact OMP lease ownership requires Linux" });
  expect(run).not.toHaveBeenCalled();
  expect(await deps.registry.read(lane.key)).toEqual(before);
});

linux.each(["legacy", "registered"] as const)(
  "wakes the exact %s session once without overriding the saved model",
  async (model) => {
    if (model === "registered") {
      lane = { ...lane, model: "initial/launch-model" };
      await deps.registry.write(lane);
    }

    const first = await wakeDiscordLane(deps, lane);
    const current = await deps.registry.read(lane.key);
    if (!current) throw new Error("missing lane after wake");
    const repeated = await wakeDiscordLane(deps, current);

    expect(first).toEqual({ kind: "started", ref: next });
    expect(repeated.kind).toBe("held");
    expect({ opened: fixture.control.creates, starts: fixture.control.starts, input: sent(fixture.world) }).toEqual({
      opened: 1,
      starts: 1,
      input: [],
    });
    expect(sessionOf(current)).toEqual(next);
    expect(statusOf(current)).toBe("not-done");
    expect(current).toMatchObject({
      thread: lane.thread,
      session: fixture.session,
      sessionFile: fixture.file,
      worktrees: lane.worktrees,
      cwd: lane.cwd,
      openedAt: lane.openedAt,
    });
    expect(current.model).toBe(lane.model);
    expect(readPaneState(fixture.state.dir, next.id)?.sessionId).toBe(fixture.session);
  },
);

linux.each(["paused", "closed", "goal paused", "goal blocked", "approval"] as const)(
  "holds a retired lane with %s",
  async (reason) => {
    if (reason === "paused" || reason === "closed") {
      lane = { ...lane, status: reason };
      await deps.registry.write(lane);
    } else {
      const goal: GoalStatus = reason === "goal paused" ? "paused" : reason === "goal blocked" ? "blocked" : "active";
      laneState(fixture.state.dir, prior.id, {
        cwd: deps.config.defaultCwd,
        pid: 0,
        sessionFile: fixture.file,
        discordLaneInbox: true,
        goal: { status: goal },
        approvalPending: reason === "approval",
      });
    }
    const before = await deps.registry.read(lane.key);

    expect((await wakeDiscordLane(deps, lane)).kind).toBe("held");

    expect(fixture.control.creates).toBe(0);
    expect(await deps.registry.read(lane.key)).toEqual(before);
  },
);

linux.each(["other lease owner", "unsafe template", "continuation", "departed transcript"] as const)(
  "holds before opening a pane on %s",
  async (reason) => {
    if (reason === "other lease owner") fixture.control.leaseHeld = true;
    if (reason === "unsafe template")
      deps = { ...deps, config: { ...deps.config, agentCommand: [executable, "--resume=unrelated", "{prompt}"] } };
    if (reason === "continuation") {
      const id = "01a11440-ee81-7f90-b2ed-dcc7d51a0ade";
      const sibling = join(dirname(fixture.file), `2026-01-01T12-01-00-000Z_${id}.jsonl`);
      writeFileSync(sibling, `${JSON.stringify({ type: "session", id, continuationOf: fixture.session })}\n`);
    }
    if (reason === "departed transcript")
      appendFileSync(
        fixture.file,
        `${JSON.stringify({
          type: "custom_message",
          customType: "session-transfer",
          details: { kind: "departed", to: "elsewhere" },
        })}\n`,
      );

    expect((await wakeDiscordLane(deps, lane)).kind).toBe("held");

    expect(fixture.control.creates).toBe(0);
  },
);

linux("leaves a new pane alone if it is already running a job", async () => {
  fixture.control.shellBusy = true;

  const result = await wakeDiscordLane(deps, lane);

  expect(result.kind).toBe("unconfirmed");
  expect({ opened: fixture.control.creates, starts: fixture.control.starts }).toEqual({ opened: 1, starts: 0 });
  expect(sessionOf((await deps.registry.read(lane.key)) ?? lane)).toEqual(prior);
});

linux.each(["queued input", "lost receipt"] as const)(
  "%s stays pending until a later poll attests startup",
  async (mode) => {
    fixture.control.delayStartup = true;
    fixture.control.loseStartReceipt = mode === "lost receipt";

    const first = await wakeDiscordLane(deps, lane);
    const binding = await deps.registry.read(lane.key);
    if (!binding) throw new Error("missing lane after ambiguous wake");
    expect(first.kind).toBe("unconfirmed");
    expect(isDiscordWakePending(binding.lifecycleEpoch)).toBe(true);
    expect(sessionOf(binding)).toEqual(next);
    expect((await wakeDiscordLane({ ...deps }, binding)).kind).toBe("unconfirmed");

    fixture.attachStartedPane();
    fixture.control.leaseOwner = nativePid;
    expect(await wakeDiscordLane({ ...deps }, binding)).toEqual({ kind: "started", ref: next });
    expect(isDiscordWakePending((await deps.registry.read(lane.key))?.lifecycleEpoch)).toBe(false);
    expect({ opened: fixture.control.creates, starts: fixture.control.starts }).toEqual({ opened: 1, starts: 1 });
  },
);

linux.each(["foreign session", "foreign file", "foreign cwd", "foreign lease", "free lease"] as const)(
  "keeps startup pending with %s despite a live OMP pane",
  async (mismatch) => {
    fixture.control.delayStartup = true;
    await wakeDiscordLane(deps, lane);
    const binding = await deps.registry.read(lane.key);
    if (!binding) throw new Error("missing wake binding");

    const panePatches = {
      "foreign session": { sessionId: "different-session" },
      "foreign file": { sessionFile: join(fixture.state.dir, "elsewhere.jsonl") },
      "foreign cwd": { cwd: fixture.state.dir },
      "foreign lease": {},
      "free lease": {},
    };
    fixture.attachStartedPane(panePatches[mismatch]);
    fixture.control.leaseOwner =
      mismatch === "free lease" ? undefined : mismatch === "foreign lease" ? nativePid + 1 : nativePid;

    expect((await wakeDiscordLane({ ...deps }, binding)).kind).toBe("unconfirmed");
    expect(await deps.registry.read(lane.key)).toEqual(binding);
    expect({ opened: fixture.control.creates, starts: fixture.control.starts }).toEqual({ opened: 1, starts: 1 });
  },
);

linux("wakes in a no-focus workspace root in the same Herdr session after the last tab closes", async () => {
  fixture.control.keepWorkspace = false;
  fixture.world.panes = [{ pane_id: "w3:p2", workspace_id: "w3", foreground: "bash" }];

  const result = await wakeDiscordLane(deps, lane);

  expect(result).toEqual({ kind: "started", ref: replacement });
  const current = await deps.registry.read(lane.key);
  if (!current) throw new Error("missing lane after workspace replacement");
  expect(sessionOf(current)).toEqual(replacement);
  expect({
    opened: fixture.control.creates,
    starts: fixture.control.starts,
    panes: fixture.world.panes.map((pane) => pane.pane_id),
  }).toEqual({ opened: 1, starts: 1, panes: ["w3:p2", replacement.id] });
});
