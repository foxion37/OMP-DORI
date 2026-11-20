import { expect, test } from "bun:test";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import type { BootLane } from "../src/boot-monitors.ts";
import { doctorCheck, doctorLocal } from "../src/doctor.ts";
import { Reports } from "../src/reports.ts";
import type { BudgetLimits } from "../src/supervision-observe.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const now = Date.parse("2026-01-01T12:00:00Z");
const unlimited = { wallMinutes: null, tokens: null, costUsd: null };
const lane = (key: string, extra: Partial<BootLane> = {}): BootLane => ({
  key,
  title: key,
  brief: "/brief",
  thread: "none",
  done: "file /done",
  reportProtocol: "jsonl-v1",
  openedAt: new Date(now).toISOString(),
  ...extra,
});
type Scenario = {
  name: string;
  defaults?: BudgetLimits;
  overrides?: Record<string, BudgetLimits>;
  lanes: BootLane[];
  missing: string[];
};
const scenarios: Scenario[] = [
  { name: "future override", overrides: { future: { tokens: 1 } }, lanes: [lane("open")], missing: ["open"] },
  {
    name: "closed override",
    overrides: { closed: { wallMinutes: 1 } },
    lanes: [lane("open"), lane("closed", { status: "closed" })],
    missing: ["open"],
  },
  {
    name: "verified-done override",
    overrides: { complete: { costUsd: 1 } },
    lanes: [lane("open"), lane("complete", { status: "verified-done" })],
    missing: ["open"],
  },
  {
    name: "done-journal override",
    overrides: { complete: { tokens: 1 } },
    lanes: [lane("open"), lane("complete", { reportState: "done" })],
    missing: ["open"],
  },
  {
    name: "lane override clears defaults",
    defaults: { tokens: 1 },
    overrides: { open: { tokens: null } },
    lanes: [lane("open")],
    missing: ["open"],
  },
  {
    name: "recorded budget clears configured limits",
    defaults: { tokens: 1 },
    overrides: { open: { tokens: 2 } },
    lanes: [lane("open", { budget: { tokens: null } })],
    missing: ["open"],
  },
  {
    name: "one protected lane cannot mask another",
    overrides: { protected: { tokens: 1 } },
    lanes: [lane("protected"), lane("open")],
    missing: ["open"],
  },
  { name: "inherited default", defaults: { wallMinutes: 1 }, lanes: [lane("open")], missing: [] },
  { name: "active override", overrides: { open: { costUsd: 1 } }, lanes: [lane("open")], missing: [] },
  { name: "recorded zero ceiling", lanes: [lane("open", { budget: { tokens: 0 } })], missing: [] },
  { name: "no active lanes", lanes: [lane("closed", { status: "closed" })], missing: [] },
];

test.each(scenarios)("doctor uses each active lane's effective budget: $name", (scenario) => {
  const state = withState();
  try {
    const deps = depsFor(newWorld(), fakeClock(now), state.dir);
    const config = {
      ...deps.config,
      supervision: {
        ...deps.config.supervision,
        defaults: { ...unlimited, ...scenario.defaults },
        lanes: scenario.overrides ?? {},
        usageArgv: ["fixture-usage-must-not-run"],
      },
    };
    const findings = doctorLocal(config, scenario.lanes, []).filter((finding) => finding.check === "supervision");
    expect(findings).toHaveLength(scenario.missing.length ? 1 : 0);
    if (scenario.missing.length)
      expect(findings[0]).toEqual({
        check: "supervision",
        severity: "WARN",
        detail: `no configured ceilings for active lanes: ${scenario.missing.join(", ")}`,
      });
  } finally {
    state.done();
  }
});

test.each([true, false])(
  "adopted lanes stay explicitly unsupervised even with a journal and configured limits=%s",
  async (configured) => {
    const state = withState();
    try {
      const deps = depsFor(newWorld(), fakeClock(now), state.dir, {
        leadPane: "",
        sessionsDir: join(state.dir, "sessions"),
        doctor: { ignore: ["runtime"] },
      });
      const config = {
        ...deps.config,
        supervision: {
          ...deps.config.supervision,
          defaults: configured ? { ...unlimited, tokens: 1 } : unlimited,
          usageArgv: configured ? ["fixture-usage-must-not-run"] : [],
        },
      };
      await deps.registry.write(lane("adopted", { reportProtocol: undefined }));
      new Reports(state.dir).report("adopted", "milestone", "a journal does not opt an adopted lane in", now);
      const result = await doctorCheck({ ...deps, config });
      expect(result.findings.filter((finding) => finding.check === "supervision")).toEqual([
        {
          check: "supervision",
          severity: "INFO",
          detail: "not supervised (adopted/legacy lanes): adopted; configured ceilings do not apply",
        },
      ]);
      expect(result.exitCode).toBe(0);
    } finally {
      state.done();
    }
  },
);

test("doctor and boot both warn when only a completed journal's lane has configured ceilings", async () => {
  const state = withState();
  try {
    const world = newWorld();
    const deps = depsFor(world, fakeClock(now), state.dir, {
      leadPane: "",
      sessionsDir: join(state.dir, "sessions"),
      doctor: { ignore: ["runtime"] },
    });
    const config = {
      ...deps.config,
      supervision: {
        ...deps.config.supervision,
        defaults: unlimited,
        lanes: { complete: { tokens: 1 } },
        usageArgv: ["fixture-usage-must-not-run"],
      },
    };
    for (const key of ["open", "complete"]) await deps.registry.write(lane(key, { reportProtocol: "jsonl-v1" }));
    const reports = new Reports(state.dir);
    reports.report("complete", "done", "complete", now);
    const result = await doctorCheck({ ...deps, config });
    expect(result.findings.filter((finding) => finding.check === "supervision")).toEqual([
      { check: "supervision", severity: "WARN", detail: "no configured ceilings for active lanes: open" },
    ]);
    expect(result.exitCode).toBe(1);
    const boot = await bootCheck({
      ...deps,
      config,
      reports,
      worklog: new Worklog(state.dir),
      slack: async () => null,
    });
    expect(boot.lines).toContain("DOCTOR warn=1 ignored=runtime (local advisory checks; run dori doctor for details)");
    expect(world.calls.some((argv) => argv[0] === "fixture-usage-must-not-run")).toBe(false);
  } finally {
    state.done();
  }
});
