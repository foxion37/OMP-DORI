import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchLane } from "../skills/cataly-mode/scripts/src/launch.ts";
import { RemoteRecords } from "../skills/cataly-mode/scripts/src/remote-records.ts";
import { remoteOperation } from "../skills/cataly-mode/scripts/src/remote-worker.ts";
import { liveSessions, type Request, selectSession } from "../src/remote/client.ts";
import { remotePolicy, setRemotePolicy } from "../src/remote/policy.ts";
import { remoteSocketPath } from "../src/remote/socket-path.ts";
import { type HeadlessObservation, HeadlessRuntime } from "../src/runtime/headless.ts";
import { formatRef, parseRef, type SessionRef } from "../src/runtime/types.ts";
import { startTestEndpoint } from "./fixtures/remote-endpoint.ts";
import { headlessFixture } from "./fixtures/runtime-headless.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

function fixture() {
  const f = headlessFixture();
  cleanup.push(() => rmSync(f.home, { force: true, recursive: true }));
  return f;
}

test.skipIf(process.platform === "win32")(
  "same-host remote operations check wake policy per request and send each request once",
  async () => {
    const f = fixture();
    const session = await startTestEndpoint(f.stateDir, cleanup);
    const call = (request: Request) => remoteOperation(f.deps, request);
    const text = "'\" $HOME $(echo no)\nsecond line";
    expect(await call({ op: "sessions" })).toEqual([{ ...session.target, lane: null }]);
    expect(await call({ op: "read", session: "native" })).toMatchObject({
      messages: [{ role: "assistant", text: "status" }],
    });
    await expect(call({ op: "send", session: "native-001", generation: "stale", text })).rejects.toThrow(
      "generation changed",
    );
    expect(await call({ op: "send", session: "native-001", generation: "original", id: "once", text })).toMatchObject({
      status: "admitted",
      text,
    });
    expect(session.inputs()).toBe(1);
    expect(remotePolicy(f.stateDir)).toEqual({ wake: false });
    await expect(call({ op: "wake", session: "native-001" })).rejects.toThrow("wake is disabled");
    setRemotePolicy(f.stateDir, true);
    await expect(call({ op: "close", session: "native-001" })).rejects.toThrow("close held by approval");
    expect(await call({ op: "wake", session: "native-001" })).toMatchObject(session.target);
    session.loseCloseReply();
    await expect(call({ op: "close", session: "native-001" })).rejects.toThrow("receipt");
    await expect(call({ op: "wake", session: "native-001" })).rejects.toThrow("close outcome is unconfirmed");
  },
);

test.skipIf(process.platform === "win32")(
  "remote open reserves and starts a standalone headless session through the native supervisor",
  async () => {
    const f = fixture();
    const runtime = new HeadlessRuntime(f.stateDir, f.env);
    const [omp = ""] = f.deps.config.agentCommand;
    const deps = {
      ...f.deps,
      config: { ...f.deps.config, agentCommand: [omp, "--cataly-role", "lane", "--model", "{model}", "{prompt}"] },
    };
    const records = new RemoteRecords(f.stateDir);
    const receipt = records.path("open", "open-1");
    let ref: SessionRef | undefined;
    try {
      const opened = remoteOperation(deps, { op: "open", id: "open-1", name: "remote-work" });
      // The pending receipt names the reservation; the supervisor then reports the started OMP process. Both come from a
      // real native host subprocess, so the test polls them instead of driving a fake clock.
      let seen: HeadlessObservation | undefined;
      for (const expires = Date.now() + 15_000; !seen && Date.now() < expires; await Bun.sleep(100)) {
        const reserved = records.read(receipt)?.["ref"];
        ref = typeof reserved === "string" ? parseRef(reserved) : undefined;
        if (!ref) continue;
        const observed = await runtime.observe(ref).catch(() => undefined);
        if (observed?.sessionId && observed.pid !== undefined) seen = observed;
      }
      if (!seen?.sessionId || seen.pid === undefined) throw new Error("remote open never started a native session");
      expect(seen).toMatchObject({ role: "lane", ref: { runtime: "headless", id: ref?.id } });
      // The Cataly extension inside OMP publishes this endpoint; the fake native host has no extension.
      await startTestEndpoint(f.stateDir, cleanup, {
        session: seen.sessionId,
        pane: formatRef(seen.ref),
        cwd: seen.cwd,
        pid: seen.pid,
      });
      expect(await opened).toMatchObject({
        status: "opened",
        id: "open-1",
        session: seen.sessionId,
        pane: formatRef(seen.ref),
        worktree: null,
      });
      expect(records.read(receipt)).toMatchObject({ status: "opened", session: seen.sessionId });
      expect(records.read(records.path("session", seen.sessionId))).toMatchObject({ cwd: f.deps.config.defaultCwd });
      // A standalone remote session is never registered as a lane.
      expect(await f.deps.registry.list()).toEqual([]);
    } finally {
      if (ref) await runtime.close(ref);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "standalone remote close leaves a registered headless lane and its close receipt unchanged",
  async () => {
    const f = fixture();
    const runtime = new HeadlessRuntime(f.stateDir, f.env);
    let ref: SessionRef | undefined;
    try {
      const { lane, startup } = await launchLane(f.deps, f.input);
      ref = lane.sessionRef;
      const session = lane.session;
      expect(startup).toStartWith("STARTUP_OK");
      if (!ref || !session) throw new Error("native fixture did not supply a lane identity");
      const { target } = await startTestEndpoint(f.stateDir, cleanup, { session, pane: formatRef(ref) });
      const receipt = new RemoteRecords(f.stateDir).path("session", session);
      const request = { op: "close", session, generation: target.generation, force: true };
      await expect(remoteOperation(f.deps, request)).rejects.toThrow("use cataly close or cataly park");
      expect(await runtime.observe(ref)).toMatchObject({
        sessionId: session,
        status: "idle",
        goal: { status: "active" },
      });
      expect(await f.deps.registry.read(lane.key)).toEqual(lane);
      expect(existsSync(receipt)).toBe(false);

      // A failed membership read must not be treated as an empty registry.
      writeFileSync(f.deps.registry.path("fixture-unreadable"), "{");
      await expect(remoteOperation(f.deps, request)).rejects.toThrow("lane ownership is unconfirmed");
      expect(await runtime.observe(ref)).toMatchObject({ sessionId: session, status: "idle" });
      expect(existsSync(receipt)).toBe(false);
    } finally {
      if (ref) await runtime.close(ref);
    }
  },
);

test.skipIf(process.platform === "win32")(
  "live discovery rejects unsafe sockets and selection rejects ambiguous IDs",
  async () => {
    const { stateDir } = fixture();
    const { target } = await startTestEndpoint(stateDir, cleanup, { role: "cataly" });
    expect(await liveSessions(stateDir)).toEqual([target]);
    expect(() => selectSession([target, { ...target, session: "native-002" }], "native")).toThrow("Ambiguous");
    chmodSync(remoteSocketPath(stateDir, target.session), 0o666);
    expect(await liveSessions(stateDir)).toEqual([]);
  },
);

test.skipIf(process.platform === "win32")("untrusted policy mode never silently enables access", () => {
  const { stateDir } = fixture();
  mkdirSync(stateDir, { recursive: true });
  const path = join(stateDir, "remote-policy.json");
  // A policy file written while cross-machine control existed keeps its `control` key; it is read and ignored.
  writeFileSync(path, '{"control":true,"wake":true}', { mode: 0o600 });
  expect(remotePolicy(stateDir)).toEqual({ wake: true });
  chmodSync(path, 0o644);
  expect(statSync(path).mode & 0o777).toBe(0o644);
  expect(() => remotePolicy(stateDir)).toThrow("owner-only");
});
