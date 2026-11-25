import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HeadlessObservation } from "../../../../src/runtime/headless-protocol.ts";
import { HeadlessRuntime } from "../../../../src/runtime/headless.ts";
import type { SessionRef } from "../../../../src/runtime/types.ts";
import { bootCheck } from "../src/boot.ts";
import { doctorCheck } from "../src/doctor.ts";
import { leadAddress } from "../src/lead-ref.ts";
import { Reports } from "../src/reports.ts";
import { ChosenRuntimes } from "../src/run.ts";
import { Worklog } from "../src/worklog.ts";
import { depsFor, fakeClock, newWorld, sid, withState } from "./fakes.ts";
import { doctorCommand } from "./doctor-fixture.ts";

test.skipIf(process.platform === "win32")(
  "boot and doctor find the durable lead, prove its native role, and never scan the sessions tree for monitors",
  async () => {
    const state = withState();
    try {
      const now = Date.now();
      const at = new Date(now).toISOString();
      let harnessRole: "lead" | "duty" = "lead";
      let leadRef: SessionRef | undefined;
      class LeadRuntime extends HeadlessRuntime {
        override async list() {
          return leadRef ? [{ ref: leadRef, status: "idle" as const }] : [];
        }
        override async observe(ref: SessionRef): Promise<HeadlessObservation> {
          return {
            ref,
            cwd: state.dir,
            startedAt: at,
            updatedAt: at,
            status: "idle",
            held: false,
            dialogs: [],
            recent: [],
            role: "cataly",
            harnessRole,
            pid: process.pid,
            sessionId: "saved-lead",
            sessionFile: join(state.dir, "lead.jsonl"),
            goal: { status: "none" },
          };
        }
      }
      const rt = new LeadRuntime(state.dir);
      const ref = await rt.create({ name: "lead", role: "lead", cwd: state.dir, env: {} });
      leadRef = ref;
      writeFileSync(join(state.dir, "roles.json"), JSON.stringify({ lead: `headless:${ref.id}` }));
      // Boot and doctor read monitor metadata from the state directory only, never the sessions tree.
      const notSessions = join(state.dir, "not-sessions");
      writeFileSync(notSessions, "this is not a sessions directory");
      const world = newWorld();
      const base = depsFor(world, fakeClock(now), state.dir, {
        sessionRuntime: "headless",
        leadPane: "",
        sessionsDir: notSessions,
        agentCommand: doctorCommand(state.dir),
      });
      const deps = {
        ...base,
        env: { CATALY_HOME: state.dir },
        rts: new ChosenRuntimes(
          () => ({ kind: "headless", source: "default" }),
          () => rt,
        ),
      };
      const boot = await bootCheck({
        ...deps,
        reports: new Reports(state.dir),
        worklog: new Worklog(state.dir),
        slack: async () => null,
      });
      expect(boot.exitCode).toBe(0);
      expect(boot.lines.join("\n")).toContain(`lead=headless:${ref.id} leadState=live`);
      const doctor = await doctorCheck(deps);
      expect(doctor.exitCode).toBe(0);
      expect(doctor.findings).toContainEqual(expect.objectContaining({ check: "runtime", severity: "OK" }));
      expect(world.calls).toEqual([]);
      // An explicit lead that disagrees with the durable one is no address.
      expect(leadAddress({ ...deps.config, leadPane: `headless:${sid(9)}` }, deps.env)).toEqual({
        reason: "ambiguous",
      });
      harnessRole = "duty";
      const wrongRole = await doctorCheck(deps);
      expect(wrongRole.findings).toContainEqual(expect.objectContaining({ check: "runtime", severity: "WARN" }));
    } finally {
      state.done();
    }
  },
);
