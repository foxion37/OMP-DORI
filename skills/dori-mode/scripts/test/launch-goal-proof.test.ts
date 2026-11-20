import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import * as goals from "../src/goal-record.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

test("a working agent quoting a failure checks its recorded goal once before rejection", async () => {
  const state = withState();
  const world = newWorld();
  world.screen = "Error: Cannot find module '/repo/dist/cli.js'";
  const brief = join(state.dir, "brief.md");
  writeFileSync(brief, "# private brief\n");
  const goal = spyOn(goals, "laneGoalActive").mockResolvedValue(false);
  try {
    const base = depsFor(world, fakeClock(Date.parse("2026-01-01T12:00:00.000Z")), state.dir, {
      agentCommand: ["omo", "--model", "{model}", "{prompt}"],
      goalMarker: "Pursuing goal",
    });
    const deps = {
      ...base,
      run: async (argv: readonly string[]) => {
        if (argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create")
          return {
            code: 0,
            out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }),
            err: "",
          };
        if (argv[0] === "herdr" && argv[1] === "pane" && argv[2] === "list")
          return {
            code: 0,
            out: JSON.stringify({
              result: { panes: [{ pane_id: "w:p9", workspace_id: "w", agent: "pi", agent_status: "working" }] },
            }),
            err: "",
          };
        return base.run(argv);
      },
    };
    const result = await launchLane(deps, {
      key: "goal-proof-once",
      title: "private regression",
      brief,
      done: "closed acme/app#3",
    });
    expect(result.startup).toBe("STARTUP_ERROR goal-proof-once w:p9: Cannot find module");
    expect(goal).toHaveBeenCalledTimes(1);
  } finally {
    goal.mockRestore();
    state.done();
  }
});
