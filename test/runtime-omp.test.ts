import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HcRuntime } from "../src/runtime/hc/index.ts";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { ompWorld } from "./omp-setup.ts";

for (const kind of ["herdr", "hc"] as const) {
  describe(`${kind}: OMP process and approval boundary`, () => {
    test("trusted identity is bound to the terminal root; approvals hold even forced delivery", async () => {
      const s = ompWorld(kind);
      expect(await s.rt.probe(s.ref)).toMatchObject({
        status: "idle",
        pid: 101,
        rootPid: 100,
        sessionId: s.record.sessionId,
        sessionFile: s.record.sessionFile,
        approvalPending: false,
      });
      s.record.approvalPending = true;
      s.save();
      expect((await s.rt.probe(s.ref)).status).toBe("blocked");
      expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({
        kind: "not-ready",
        status: "blocked",
      });
      expect(s.w.calls.some((c) => c.argv[0] === "agent" || c.argv[1] === "send")).toBe(false);
      expect(await s.rt.typeIntoShell(s.ref, "message")).toBe(false);
      s.record.approvalPending = false;
      s.save();
      expect((await s.rt.deliver(s.ref, "message")).kind).toBe("delivered");
      if (kind === "herdr") expect(s.pane.received).toEqual(["message"]);
      else expect(s.w.hc.sent).toEqual([{ id: "t1", text: "message" }]);
    });

    test("omitting stateDir ignores configured OMP state and malformed config", async () => {
      const s = ompWorld(kind);
      const config = join(s.stateDir, "config.json");
      s.record.approvalPending = true;
      s.save();
      const options = {
        env: { DORI_CONFIG: config, DORI_STATE_DIR: undefined },
        sleep: async () => {},
      };
      for (const raw of [JSON.stringify({ stateDir: s.stateDir }), "{"]) {
        writeFileSync(config, raw);
        const rt = kind === "hc" ? new HcRuntime(s.w.exec, options) : new HerdrRuntime(s.w.exec, "", options);
        const snapshot = await rt.probe(s.ref);
        expect(snapshot.status).toBe("idle");
        expect(snapshot.sessionId).toBeUndefined();
        expect(snapshot.approvalPending).toBeUndefined();
        expect((await rt.deliver(s.ref, "message")).kind).toBe("delivered");
      }
      if (kind === "herdr") expect(s.pane.received).toEqual(["message", "message"]);
      else
        expect(s.w.hc.sent).toEqual([
          { id: "t1", text: "message" },
          { id: "t1", text: "message" },
        ]);
    });

    test.each([
      ["exited writer", "100 1 /bin/bash\n"],
      ["writer outside this terminal", "100 1 /bin/bash\n101 200 bun /synthetic/omp\n"],
      ["pid reused by another program", "100 1 /bin/bash\n101 100 vim\n"],
      ["shell command mentioning OMP", "100 1 /bin/bash\n101 100 bash -c omp\n"],
    ])("%s is unknown and receives no text", async (_, table) => {
      const s = ompWorld(kind);
      s.control.table = table;
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({
        kind: "not-ready",
        status: "unknown",
      });
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
    });

    test("a newer OMP process reusing the writer pid does not inherit its state", async () => {
      const s = ompWorld(kind);
      s.control.started = "2026-11-11T00:01:00Z";
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect((await s.rt.deliver(s.ref, "message")).kind).toBe("not-ready");
    });

    test("an old but still live OMP session stays trusted without an age expiry", async () => {
      const s = ompWorld(kind);
      s.record.startedAt = "2025-01-01T00:00:05Z";
      s.record.updatedAt = s.record.startedAt;
      s.control.started = "2025-01-01T00:00:00Z";
      s.save();
      expect((await s.rt.probe(s.ref)).sessionId).toBe(s.record.sessionId);
    });

    test("an unreadable process table holds delivery instead of trusting a state file", async () => {
      const s = ompWorld(kind);
      s.control.psCode = 1;
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect((await s.rt.deliver(s.ref, "message")).kind).toBe("not-ready");
    });

    test("malformed state and a record for another terminal are never trusted", async () => {
      const s = ompWorld(kind);
      for (const raw of ["{", "{}", JSON.stringify({ ...s.record, paneId: "other" })]) {
        writeFileSync(s.path, raw);
        expect((await s.rt.probe(s.ref)).status).toBe("unknown");
        expect((await s.rt.deliver(s.ref, "message")).kind).toBe("not-ready");
      }
    });

    test("an OMP process without an extension record receives no input", async () => {
      const s = ompWorld(kind, false, false);
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect((await s.rt.deliver(s.ref, "message", { when: "any", force: true })).kind).toBe("not-ready");
    });

    test("an unrelated foreground process cannot inherit a live writer's input", async () => {
      const s = ompWorld(kind);
      s.record.pid = 201;
      s.save();
      s.control.table = "100 1 /bin/bash\n201 100 bun /synthetic/omp\n101 100 vim\n";
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect((await s.rt.deliver(s.ref, "message")).kind).toBe("not-ready");
    });

    test("native unknown status stays unknown even with valid extension identity", async () => {
      const s = ompWorld(kind);
      s.pane.status = "unknown";
      s.w.hc.terminals.get("t1")!.status = { state: "unknown", app: "omp" };
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect((await s.rt.deliver(s.ref, "message", { when: "any", force: true })).kind).toBe("not-ready");
    });

    test("sidecar status refines known status without replacing a missing native report", async () => {
      const s = ompWorld(kind);
      s.record.agentStatus = "working";
      s.save();
      expect((await s.rt.probe(s.ref)).status).toBe("working");
      s.record.agentStatus = "idle";
      s.pane.status = "working";
      s.w.hc.terminals.get("t1")!.status = { state: "working", app: "omp" };
      s.save();
      expect((await s.rt.probe(s.ref)).status).toBe("idle");
      s.pane.status = "unknown";
      s.w.hc.terminals.get("t1")!.status = null;
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
      expect((await s.rt.deliver(s.ref, "message", { when: "any", force: true })).kind).toBe("not-ready");
    });

    test("a shell in front receives nothing despite stale idle agent status", async () => {
      const s = ompWorld(kind);
      s.pane.foreground = "-bash";
      s.w.hc.terminals.get("t1")!.foreground = { name: "bash", argv: ["-bash"], pid: 100 };
      expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({ kind: "no-agent" });
      expect(await s.rt.probe(s.ref)).toMatchObject({ pid: 101, sessionId: s.record.sessionId, shellInFront: true });
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
    });

    test("approval opening during process attestation is read before returning the snapshot", async () => {
      const s = ompWorld(kind);
      s.control.onPs = (argv) => {
        if (argv[0] !== "-o") return;
        s.record.approvalPending = true;
        s.save();
      };
      expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({
        kind: "not-ready",
        status: "blocked",
      });
      expect(s.pane.received).toEqual([]);
      expect(s.w.hc.sent).toEqual([]);
    });

    test("a session switch during attestation is doubt rather than a mixed snapshot", async () => {
      const s = ompWorld(kind);
      s.control.onPs = () => {
        s.record.sessionId += "-switched";
        s.save();
      };
      expect((await s.rt.probe(s.ref)).status).toBe("unknown");
    });
  });
}

test("hc accepts extension state written by the direct-program terminal root", async () => {
  const s = ompWorld("hc", true);
  expect(await s.rt.probe(s.ref)).toMatchObject({ rootPid: 101, pid: 101, sessionId: s.record.sessionId });
  s.record.approvalPending = true;
  s.save();
  expect(await s.rt.deliver(s.ref, "message", { force: true })).toEqual({ kind: "not-ready", status: "blocked" });
});

test("hc keeps its native compare-and-send gate when the live OMP record proves idle", async () => {
  const s = ompWorld("hc");
  s.record.agentStatus = "idle";
  s.w.hc.terminals.get("t1")!.status = { state: "working", app: "omp" };
  s.save();
  expect((await s.rt.deliver(s.ref, "message")).kind).toBe("delivered");
  expect(s.w.hc.calls.filter((c) => c[0] === "send")).toEqual([["send", "t1", "--if", "working", "--", "message"]]);
});

test("hc delivers a completed OMP turn while preserving its approval hold", async () => {
  const s = ompWorld("hc");
  s.record.agentStatus = "idle";
  s.w.hc.terminals.get("t1")!.status = { state: "done", app: "omp" };
  s.save();
  expect(await s.rt.probe(s.ref)).toMatchObject({
    status: "done",
    pid: 101,
    sessionId: s.record.sessionId,
    approvalPending: false,
  });
  s.record.approvalPending = true;
  s.save();
  expect(await s.rt.deliver(s.ref, "message")).toEqual({ kind: "not-ready", status: "blocked" });
  expect(await s.rt.deliver(s.ref, "message", { when: "any", force: true })).toEqual({
    kind: "not-ready",
    status: "blocked",
  });
  expect(s.w.hc.sent).toEqual([]);
  s.record.approvalPending = false;
  s.save();
  expect((await s.rt.deliver(s.ref, "message")).kind).toBe("delivered");
  expect(s.w.hc.sent).toEqual([{ id: "t1", text: "message" }]);
});
