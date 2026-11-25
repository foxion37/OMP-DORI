import { expect, test } from "bun:test";
import { appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FlowDeps } from "../skills/cataly-mode/scripts/src/done-flow.ts";
import { checkPolicyCommand } from "../skills/cataly-mode/scripts/src/lane-policy-actions.ts";
import { currentLanePolicy, policyBinding } from "../skills/cataly-mode/scripts/src/lane-policy-store.ts";
import { launchLane } from "../skills/cataly-mode/scripts/src/launch.ts";
import { parkLane } from "../skills/cataly-mode/scripts/src/park.ts";
import { reopenLane } from "../skills/cataly-mode/scripts/src/reopen.ts";
import { HeadlessRuntime } from "../src/runtime/headless.ts";
import type { SessionRef } from "../src/runtime/types.ts";
import { headlessFixture } from "./fixtures/runtime-headless.ts";

test.skipIf(process.platform === "win32")(
  "the owner can grant once after a sourced policy lane reopens the verified protected transcript",
  async () => {
    const f = headlessFixture();
    const rt = new HeadlessRuntime(f.stateDir, f.env);
    const refs: SessionRef[] = [];
    const [omp, ...args] = f.deps.config.agentCommand;
    if (!omp) throw new Error("fixture has no native command");
    const config = {
      ...f.deps.config,
      agentCommand: [omp, "--cataly-role", "lane", ...args],
      lanePolicy: { denyBash: ["blocked-operation"] },
    };
    const deps: FlowDeps = { ...f.deps, config };
    writeFileSync(f.path, JSON.stringify(config));
    const grant = async () => {
      const p = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, "../skills/cataly-mode/scripts/src/cli.ts"),
          "policy",
          "allow-once",
          f.input.key,
          "denyBash[0]",
          "--reason",
          "owner approved a single retry",
        ],
        { env: f.env, stdout: "pipe", stderr: "pipe" },
      );
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text(), new Response(p.stdout).text()]);
      return { code, err };
    };
    try {
      const initial = (
        await launchLane(deps, { ...f.input, requestId: "discord:111111111111111111:222222222222222222" })
      ).lane;
      if (!initial.sessionRef || !initial.sessionFile) throw new Error("native transcript proof missing");
      refs.push(initial.sessionRef);
      const binding = policyBinding(currentLanePolicy(f.stateDir, initial.key));
      // The RPC fixture provides the native identity; the real extension writes this exact policy entry.
      appendFileSync(
        initial.sessionFile,
        `${JSON.stringify({
          type: "custom",
          id: "policy",
          parentId: null,
          customType: "omp-cataly:lane-policy",
          data: binding,
        })}\n`,
      );
      const parked = await parkLane(deps, initial, "stop work");
      expect(parked.code).toBe(0);
      const reopened = await reopenLane(deps, parked.lane);
      if (reopened.lane.sessionRef) refs.push(reopened.lane.sessionRef);
      expect(reopened.code).toBe(0);
      expect(reopened.lane.session).toBe(initial.session);
      expect(reopened.lane.lifecycleEpoch).not.toBe(initial.lifecycleEpoch);
      expect(reopened.lane.runId).not.toBe(initial.runId);
      expect(checkPolicyCommand(binding, "blocked-operation", Date.now())).toContain("BLOCKED");
      expect(await grant()).toEqual({ code: 0, err: "" });
      expect(checkPolicyCommand(binding, "blocked-operation", Date.now())).toBeUndefined();
      expect(checkPolicyCommand(binding, "blocked-operation", Date.now())).toContain("BLOCKED");

      appendFileSync(
        initial.sessionFile,
        `${JSON.stringify({ type: "custom", id: "wrong-branch", parentId: null, customType: "another-entry" })}\n`,
      );
      expect(await grant()).toMatchObject({
        code: 1,
        err: expect.stringContaining("does not match the registered lane generation"),
      });
    } finally {
      for (const ref of refs) await rt.close(ref);
      rmSync(f.home, { recursive: true, force: true });
    }
  },
  15_000,
);
