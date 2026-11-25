import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { groupId } from "../src/runtime/group.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { TernRuntime } from "../src/runtime/tern/index.ts";
import { Refusal } from "../src/refusal.ts";
import { done, ready, startLane } from "../src/lanes.ts";
import { block, FakeTern } from "./fake-tern.ts";
import { LEAD_REF, setup } from "./harness-setup.ts";

describe("lanes", () => {
  test("start opens a native lane, begins its goal with the brief, and tells the lead", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    const pane = w.panes.get(lane.sessionRef.id)!;
    expect(lane.sessionRef).toEqual({ runtime: "headless", id: lane.sessionRef.id, group: "w1" });
    expect(pane.received[0]).toStartWith("Read your brief at ");
    expect(await Bun.file(lane.brief).text()).toContain("cataly ready fix-login --text");
    expect(lead.received).toEqual([`[START fix-login] lane opened in headless:${lane.sessionRef.id}`]);
    await expect(startLane(d, "fix-login", brief, { group: "w1" })).rejects.toThrow(Refusal);
  });

  test("start refuses the role names lead and duty as lane keys before it writes or opens anything", async () => {
    const { w, d, lead, brief } = setup();
    for (const key of ["lead", "duty"]) {
      await expect(startLane(d, key, brief, { group: "w1" })).rejects.toThrow(
        `lane key "${key}" is reserved for the ${key} role`,
      );
      expect(d.store.lane(key)).toBeUndefined();
      expect(existsSync(d.store.briefPath(key))).toBe(false);
    }
    expect(w.calls).toEqual([]);
    expect(lead.received).toEqual([]);
    expect(d.store.roles().lead).toEqual(LEAD_REF);
  });

  test("ready requires evidence, then reaches the lead; done closes only a ready lane", async () => {
    const { w, d, lead, brief } = setup();
    const lane = await startLane(d, "fix-login", brief, { group: "w1" });
    await expect(done(d, "fix-login")).rejects.toThrow("not ready");
    await expect(ready(d, "fix-login", "fixed", [])).rejects.toThrow("evidence");
    await ready(d, "fix-login", "fixed", ["https://github.com/o/r/pull/1"]);
    expect(lead.received.at(-1)).toBe("[READY fix-login] fixed\nevidence: https://github.com/o/r/pull/1");
    expect(w.usage.map((e) => e.name)).toEqual(["cataly.lane_started", "cataly.lane_ready"]);
    expect(JSON.stringify(w.usage)).not.toContain("fix-login");
    await done(d, "fix-login");
    expect(w.panes.has(lane.sessionRef.id)).toBe(false);
    expect(d.store.lane("fix-login")!.status).toBe("done");
  });
});

describe("startLane group fallback", () => {
  const withEnv = async (vars: Record<string, string | undefined>, run: () => Promise<void>) => {
    const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    for (const [k, v] of Object.entries(vars))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    try {
      await run();
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  };
  const clear = { CATALY_HEADLESS_ID: undefined };

  test("a lane with no group gets this home's group label", async () => {
    const { w, d, brief } = setup();
    await startLane(d, "no-group", brief);
    const spec = w.created.at(-1)!;
    expect(spec.group).toBe(groupId(d.store.root));
    expect(spec.group).toMatch(/^[0-9a-f]{8}$/);
    expect(spec.env["CATALY_HOME"]).toBe(d.store.root);
  });

  test("a tern lane is a named tab in the caller's own Tern session, else in the session named cataly", async () => {
    const { d: base, brief } = setup();
    const fake = new FakeTern({ "5001": block() });
    const tern = new TernRuntime(fake.exec, { env: process.env, sleep: async () => {} });
    const d = { ...base, runtimes: new Runtimes("tern", () => tern) };
    // The lead is the Tern block the first lane is opened from.
    d.store.setRole("lead", { runtime: "tern", id: "5001" });
    await withEnv({ ...clear, TERN_PANE: "5001" }, async () => {
      await startLane(d, "inside", brief);
    });
    // The lead's turn on the first START ends before the second lane opens.
    fake.blocks.get("5001")!.working = false;
    await withEnv({ ...clear, TERN_PANE: undefined }, async () => {
      await startLane(d, "outside", brief);
    });
    const opened = fake.calls.filter((c) => c[0] === "new").map((c) => c.slice(0, 3));
    expect(opened).toEqual([
      ["new", "tab", "7001"],
      ["new", "session", "cataly"],
    ]);
    expect(fake.calls.filter((c) => c[0] === "rename").map((c) => c[2])).toEqual(["inside", "outside"]);
    expect(fake.ran.map((r) => r.command.split(" ")[0])).toEqual(["omp", "omp"]);
    expect(d.store.lane("inside")).toMatchObject({
      sessionRef: { runtime: "tern", id: "8000", group: "7001", container: "8001" },
    });
    expect(fake.submitted).toEqual([
      { id: "5001", text: "[START inside] lane opened in tern:8000" },
      { id: "5001", text: "[START outside] lane opened in tern:8003" },
    ]);
  });
});
