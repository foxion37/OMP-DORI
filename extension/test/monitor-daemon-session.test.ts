import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { readMonitorManifests } from "../../skills/cataly-mode/scripts/src/boot-monitors.ts";
import { readMonitorSet } from "../../src/update/deployment-monitors.ts";
import { recordedMonitorStates } from "../monitor-state.ts";
import { type FakePi, type FakeSession, load, until, useConfig } from "./fake-pi.ts";

const run = (pi: FakePi, params: Record<string, unknown>) =>
  pi.tools.get("monitor")!.execute("call", params, undefined, undefined, pi.ctx());
const text = async (pi: FakePi) => (await run(pi, { op: "list" })).content[0]!.text;
const record = (pi: FakePi) => recordedMonitorStates(pi.session.entries).get("daemon");

async function fixture() {
  const stateDir = useConfig();
  const root = dirname(stateDir);
  const marker = join(root, "runs");
  const session: FakeSession = { id: "daemon-owner", entries: [] };
  const pi = await load({ session, flags: { "cataly-role": "cataly" } });
  await pi.emit("session_start");
  return {
    pi,
    root,
    stateDir,
    session,
    marker,
    params: {
      op: "start",
      name: "daemon",
      mode: "daemon",
      filter: ".",
      argv: [
        process.execPath,
        "-e",
        `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'run'); process.exit(7)`,
      ],
    },
    manifest: () => JSON.parse(readFileSync(join(stateDir, "monitors", "daemon-owner.json"), "utf8")),
  };
}

test("daemon exhaustion is durable across resume and new sessions, but explicit start gets a fresh budget", async () => {
  const f = await fixture();
  let resumed: FakePi | undefined;
  try {
    await run(f.pi, { ...f.params, restart: { max: 1, backoffSec: 0.03 } });
    await until(() => record(f.pi)?.completed === true);
    expect(readFileSync(f.marker, "utf8")).toBe("runrun");
    expect(await text(f.pi)).toContain("mode=daemon status=exhausted");
    expect(await text(f.pi)).toContain("retries=1/1");
    expect(await text(f.pi)).not.toContain("pid ");
    expect(f.manifest()).toMatchObject({ version: 1, monitors: [] });
    await f.pi.emit("session_shutdown");
    resumed = await load({ session: f.session });
    await resumed.emit("session_start");
    expect(resumed.messages.some((message) => message.content.includes("restored"))).toBe(false);
    expect(record(resumed)?.completed).toBe(true);
    await run(resumed, { ...f.params, restart: { max: 1, backoffSec: 0.03 } });
    await until(() => record(resumed!)?.completed === true);
    expect(readFileSync(f.marker, "utf8")).toBe("runrunrunrun");
    resumed.session = { id: "after-daemon", entries: [] };
    await resumed.emit("session_switch", { type: "session_switch", reason: "new" });
    expect(await text(resumed)).toBe("no monitors running or recorded");
    expect(readFileSync(f.marker, "utf8")).toBe("runrunrunrun");
  } finally {
    await resumed?.emit("session_shutdown");
    await f.pi.emit("session_shutdown");
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("branch replay keeps one pending retry and resume retains its spent budget", async () => {
  const f = await fixture();
  let resumed: FakePi | undefined;
  try {
    await run(f.pi, { ...f.params, restart: { max: 3, backoffSec: 10 } });
    await until(() => record(f.pi)?.exit?.restartAttempt === 1);
    expect(await text(f.pi)).toContain("status=backoff");
    expect(await text(f.pi)).toContain("retries=1/3 next=");
    expect(await text(f.pi)).not.toContain("pid ");
    await f.pi.emit("session_tree");
    await Bun.sleep(60);
    expect(readFileSync(f.marker, "utf8")).toBe("run");
    expect(f.pi.messages.some((message) => message.content.includes("could not restore"))).toBe(false);
    await f.pi.emit("session_shutdown");
    resumed = await load({ session: f.session });
    await resumed.emit("session_start");
    await until(() => record(resumed!)?.exit?.restartAttempt === 2);
    expect(readFileSync(f.marker, "utf8")).toBe("runrun");
    expect(await text(resumed)).toContain("retries=2/3");
    await run(resumed, { op: "stop", name: "daemon" });
    expect(await text(resumed)).toBe("no monitors running or recorded");
    expect(f.manifest().monitors).toEqual([]);
  } finally {
    await resumed?.emit("session_shutdown");
    await f.pi.emit("session_shutdown");
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("version three preserves daemon and silence policy through boot and managed handoff", async () => {
  const f = await fixture();
  try {
    f.pi.api.appendEntry("omp-cataly:intake", {
      path: join(f.stateDir, "heartbeat"),
      monitor: "daemon",
      maxAgeMs: 1000,
    });
    await run(f.pi, { ...f.params, argv: ["sleep", "10"], silentAfterMin: 1 });
    expect(f.manifest()).toMatchObject({
      version: 3,
      monitors: [{ mode: "daemon", restart: { max: 5, backoffSec: 10 }, silentAfterMin: 1 }],
    });
    const boot = readMonitorManifests(join(f.stateDir, "monitors"));
    expect(boot.errors).toEqual([]);
    expect(boot.manifests[0]?.data.monitors[0]).toMatchObject({ mode: "daemon", silentAfterMin: 1 });
    const readManaged = () => readMonitorSet(join(f.stateDir, "monitors", "daemon-owner.json"), "daemon-owner", true);
    if (process.platform === "win32") {
      expect(readManaged).toThrow(/monitor metadata ownership differs|must be private/);
      return;
    }
    const managed = readManaged();
    expect(managed.version).toBe(3);
    expect(managed.monitors).toEqual(f.manifest().monitors);
  } finally {
    await f.pi.emit("session_shutdown");
    rmSync(f.root, { recursive: true, force: true });
  }
});
