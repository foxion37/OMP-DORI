import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity } from "../../src/update/deployment-process.ts";
import type { RuntimeHealth } from "../../src/update/deployment-types.ts";
import { type FakeOptions, type FakePi, load as loadPi, until, useConfig } from "./fake-pi.ts";

// The kernels whose process identity deployment can bind, and where the headless lead (a Unix socket) runs.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

/** The native harness lead's headless reservation: only it publishes runtime health. */
const HEADLESS = "00000000-0000-4000-8000-000000000007";
const ENV = ["CATALY_HEADLESS_ID", "CATALY_HARNESS_ROLE", "CATALY_MANAGED_STARTUP"] as const;
const previous = new Map(ENV.map((name) => [name, process.env[name]]));
const sessions: FakePi[] = [];
const load = (options: FakeOptions) => loadPi({ mode: "rpc", hasUI: true, ...options });
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.emit("session_shutdown");
  for (const [name, value] of previous) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});
function fixture(sessionId = "lead-session", lead = true) {
  const stateDir = useConfig();
  const reservation = join(stateDir, "headless", HEADLESS);
  if (lead) {
    process.env.CATALY_HEADLESS_ID = HEADLESS;
    process.env.CATALY_HARNESS_ROLE = "lead";
    mkdirSync(reservation, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(reservation, "reservation.json"),
      JSON.stringify({
        ref: { runtime: "headless", id: HEADLESS },
        name: "lead",
        cwd: tmpdir(),
        startedAt: new Date().toISOString(),
        role: "lead",
      }),
      { mode: 0o600 },
    );
  }
  const bootstrap = join(stateDir, "..", "trusted-bootstrap.json");
  const intake = { path: join(stateDir, "heartbeat"), monitor: "inbound", maxAgeMs: 120_000 };
  // The real child is portable; only deployment health's kernel start-tick attestation requires Linux.
  const monitor = { name: "inbound", argv: ["sleep", "60"], filter: "^INBOUND", cwd: tmpdir() };
  writeFileSync(bootstrap, JSON.stringify({ version: 1, sessionId, monitors: [monitor], intake }), { mode: 0o600 });
  return { stateDir, bootstrap, monitor, intake, healthPath: join(stateDir, "runtime", `${HEADLESS}.json`) };
}

const run = (pi: FakePi, params: Record<string, unknown>) =>
  pi.tools.get("monitor")!.execute("call", params, undefined, undefined, pi.ctx());

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

posix(
  "trusted first handoff replaces recorded specifications, observes real monitor identities and resumes without the file",
  async () => {
    const f = fixture();
    const session = {
      id: "lead-session",
      entries: [
        {
          type: "custom",
          customType: "omp-cataly:monitor",
          data: {
            op: "start",
            name: "incompatible-spec",
            argv: ["missing-command-fixture"],
            filter: ".",
            cwd: tmpdir(),
          },
        },
      ],
    };
    const first = await load({ session, flags: { "cataly-role": "cataly", "cataly-monitor-bootstrap": f.bootstrap } });
    sessions.push(first);
    await first.emit("session_start");
    await until(() => JSON.parse(readFileSync(f.healthPath, "utf8")).monitors.length === 1);
    const health = JSON.parse(readFileSync(f.healthPath, "utf8")) as RuntimeHealth;
    expect(health).toMatchObject({ role: "cataly", paneId: HEADLESS, pid: process.pid, sessionId: session.id });
    expect(health.configLoaded).toBe(true);
    expect(health.monitors[0]).toMatchObject(f.monitor);
    expect(processIdentity(health.monitors[0]!.pid)?.startTicks).toBe(health.monitors[0]!.startTicks);
    expect(JSON.parse(readFileSync(join(f.stateDir, "monitors", `${session.id}.json`), "utf8"))).toMatchObject({
      intake: f.intake,
    });
    expect((await run(first, { op: "list" })).content[0]?.text).toContain("inbound");
    expect((await run(first, { op: "list" })).content[0]?.text).not.toContain("incompatible-spec");
    const oldPid = health.monitors[0]!.pid;
    await first.emit("session_shutdown");
    await until(() => processIdentity(oldPid) === undefined);
    const resumed = await load({ session });
    sessions.push(resumed);
    await resumed.emit("session_start");
    const after = JSON.parse(readFileSync(f.healthPath, "utf8")) as RuntimeHealth;
    expect(after.monitors[0]?.pid).not.toBe(oldPid);
    expect(after.monitors[0]?.argv).toEqual(f.monitor.argv);
    expect(session.entries.filter((entry) => entry.customType === "omp-cataly:monitor-bootstrap")).toHaveLength(1);
  },
);

// POSIX-only: the bootstrap file's 0o600 mode and owner uid are verified, and the monitor runs `sleep`.
posix(
  "ordinary bootstrap replaces recorded monitors and restores real children without the bootstrap file",
  async () => {
    const f = fixture();
    const session = {
      id: "lead-session",
      entries: [
        {
          type: "custom",
          customType: "omp-cataly:monitor",
          data: { op: "start", ...f.monitor, name: "incompatible-spec", argv: ["missing-command-fixture"] },
        },
      ],
    };
    const first = await load({ session, flags: { "cataly-role": "cataly", "cataly-monitor-bootstrap": f.bootstrap } });
    sessions.push(first);
    await first.emit("session_start");
    const listed = (await run(first, { op: "list" })).content[0]?.text ?? "";
    const oldPid = Number(/pid (\d+)/.exec(listed)?.[1]);
    expect(alive(oldPid)).toBe(true);
    expect(listed).toContain("inbound");
    expect(listed).not.toContain("incompatible-spec");
    const metadata = join(f.stateDir, "monitors", `${session.id}.json`);
    expect(JSON.parse(readFileSync(metadata, "utf8"))).toMatchObject({ monitors: [f.monitor], intake: f.intake });
    const health = JSON.parse(readFileSync(f.healthPath, "utf8")) as RuntimeHealth;
    expect(health).toMatchObject({ role: "cataly", paneId: HEADLESS, pid: process.pid, sessionId: session.id });
    expect(health.configLoaded).toBe(true);
    expect(health.monitors.map(({ name, pid }) => [name, pid])).toEqual([[f.monitor.name, oldPid]]);
    await first.emit("session_shutdown");
    await until(() => !alive(oldPid));
    unlinkSync(f.bootstrap);
    const resumed = await load({ session });
    sessions.push(resumed);
    await resumed.emit("session_start");
    const restored = (await run(resumed, { op: "list" })).content[0]?.text ?? "";
    const newPid = Number(/pid (\d+)/.exec(restored)?.[1]);
    expect(alive(newPid)).toBe(true);
    expect(newPid).not.toBe(oldPid);
    expect(restored).toContain(f.monitor.argv.join(" "));
    expect(JSON.parse(readFileSync(metadata, "utf8"))).toMatchObject({ monitors: [f.monitor], intake: f.intake });
    expect(session.entries.filter((entry) => entry.customType === "omp-cataly:monitor-bootstrap")).toHaveLength(1);
  },
);

// POSIX-only: the product only accepts monitor metadata that is not group/world writable and is owned by the uid.
posix("a consumed bootstrap never resurrects an explicitly stopped monitor", async () => {
  const f = fixture();
  const session = { id: "lead-session", entries: [] };
  const cataly = await load({ session, flags: { "cataly-role": "cataly", "cataly-monitor-bootstrap": f.bootstrap } });
  sessions.push(cataly);
  await cataly.emit("session_start");
  await run(cataly, { op: "stop", name: "inbound" });
  await cataly.emit("session_start");
  expect((await run(cataly, { op: "list" })).content[0]?.text).toBe("no monitors running or recorded");
  expect(JSON.parse(readFileSync(join(f.stateDir, "monitors", "lead-session.json"), "utf8")).monitors).toEqual([]);
});

// POSIX-only: the rejected bootstrap is read through the product's mode and owner-uid check.
posix("a bootstrap bound to another native session launches nothing", async () => {
  const f = fixture("different-session");
  const cataly = await load({
    session: { id: "lead-session", entries: [] },
    flags: {
      "cataly-role": "cataly",
      "cataly-monitor-bootstrap": f.bootstrap,
    },
  });
  sessions.push(cataly);
  await expect(cataly.emit("session_start")).rejects.toThrow("session or version");
  expect(lstatSync(f.healthPath, { throwIfNoEntry: false })).toBeUndefined();
});

// POSIX-only: the rejected bootstrap is read through the product's mode and owner-uid check.
posix("a rejected bootstrap leaves no half-initialized role session publishing runtime health", async () => {
  const f = fixture("different-session");
  const cataly = await load({
    session: { id: "lead-session", entries: [] },
    flags: { "cataly-role": "cataly", "cataly-monitor-bootstrap": f.bootstrap },
  });
  sessions.push(cataly);
  await expect(cataly.emit("session_start")).rejects.toThrow("session or version");
  await cataly.emit("agent_start");
  await cataly.emit("tool_approval_requested", {
    type: "tool_approval_requested",
    sessionId: cataly.session.id,
    toolName: "bash",
    approvalMode: "always-ask",
    toolCallId: "pending",
  });
  await cataly.emit("goal_updated", { goal: { objective: "work", status: "active" } });
  expect(lstatSync(f.healthPath, { throwIfNoEntry: false })).toBeUndefined();
  // A tree or branch move in the rejected session finds no recorded role to restore.
  await cataly.emit("session_tree");
  await cataly.emit("session_branch");
  await cataly.emit("agent_start");
  expect(lstatSync(f.healthPath, { throwIfNoEntry: false })).toBeUndefined();
  expect(cataly.session.entries).toEqual([]);
  expect(cataly.handlers.get("session_shutdown")?.length ?? 0).toBeGreaterThan(0);
  await cataly.emit("session_shutdown");
  expect(lstatSync(f.healthPath, { throwIfNoEntry: false })).toBeUndefined();
});

// POSIX-only: the rejected bootstrap is read through the product's mode and owner-uid check.
posix(
  "a resumed Cataly session whose bootstrap is rejected does not get its recorded role back on a tree move",
  async () => {
    const f = fixture("different-session");
    const cataly = await load({
      session: { id: "lead-session", entries: [{ type: "custom", customType: "omp-cataly:role", data: "cataly" }] },
      flags: { "cataly-monitor-bootstrap": f.bootstrap },
    });
    sessions.push(cataly);
    await expect(cataly.emit("session_start")).rejects.toThrow("session or version");
    await cataly.emit("session_tree");
    await cataly.emit("session_branch");
    await cataly.emit("agent_start");
    await cataly.emit("tool_approval_requested", {
      type: "tool_approval_requested",
      toolCallId: "pending",
      sessionId: cataly.session.id,
      toolName: "bash",
      approvalMode: "always-ask",
    });
    expect(lstatSync(f.healthPath, { throwIfNoEntry: false })).toBeUndefined();
  },
);

// Portable: monitor replacement needs no headless lead, so no runtime health is published.
test("branch movement replaces a changed specification under the same monitor name", async () => {
  const f = fixture("lead-session", false);
  const cataly = await load({ session: { id: "lead-session", entries: [] }, flags: { "cataly-role": "cataly" } });
  sessions.push(cataly);
  await cataly.emit("session_start");
  const sleeping = (milliseconds: number) => [process.execPath, "-e", `await Bun.sleep(${milliseconds})`];
  const replacement = sleeping(61_000);
  await run(cataly, { op: "start", name: "inbound", argv: sleeping(60_000), filter: "." });
  const before = (await run(cataly, { op: "list" })).content[0]?.text ?? "";
  const oldPid = Number(/pid (\d+)/.exec(before)?.[1]);
  expect(alive(oldPid)).toBe(true);
  cataly.api.appendEntry("omp-cataly:monitor", {
    op: "start",
    name: "inbound",
    argv: replacement,
    filter: "^changed",
    cwd: tmpdir(),
  });
  await cataly.emit("session_tree");
  await until(() => !alive(oldPid));
  const after = (await run(cataly, { op: "list" })).content[0]?.text ?? "";
  const newPid = Number(/pid (\d+)/.exec(after)?.[1]);
  expect(alive(newPid)).toBe(true);
  expect(newPid).not.toBe(oldPid);
  expect(after).toContain("Bun.sleep(61000)");
  expect(after).toContain("^changed");
  expect(JSON.parse(readFileSync(join(f.stateDir, "monitors", "lead-session.json"), "utf8"))).toMatchObject({
    monitors: [{ name: "inbound", argv: replacement, filter: "^changed", cwd: tmpdir() }],
  });
}, 20_000);

// POSIX-only: runtime health is published only for the headless lead.
posix(
  "a managed initial restore reports failure without starting model work, then ordinary restore keeps its repair behavior",
  async () => {
    const f = fixture();
    process.env.CATALY_MANAGED_STARTUP = "1";
    const cataly = await load({
      session: {
        id: "lead-session",
        entries: [
          {
            type: "custom",
            customType: "omp-cataly:monitor",
            data: {
              op: "start",
              name: "failed-intake",
              argv: [join(f.stateDir, "absent-command")],
              filter: ".",
              cwd: tmpdir(),
            },
          },
        ],
      },
      flags: { "cataly-role": "cataly" },
    });
    sessions.push(cataly);
    await cataly.emit("session_start");
    expect(cataly.messages.at(-1)?.options).toMatchObject({ triggerTurn: false });
    expect((JSON.parse(readFileSync(f.healthPath, "utf8")) as RuntimeHealth).monitors).toEqual([]);
    await cataly.emit("session_tree");
    expect(cataly.messages.at(-1)?.options).toMatchObject({ triggerTurn: true });
  },
);
