import { afterEach, expect, test } from "bun:test";
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processIdentity } from "../../src/update/deployment-process.ts";
import type { RuntimeHealth } from "../../src/update/deployment-types.ts";
import { type FakePi, load, until, useConfig } from "./fake-pi.ts";

// The kernels whose process identity deployment can bind.
const posix = test.skipIf(process.platform !== "linux" && process.platform !== "darwin");

const previousPane = process.env.HERDR_PANE_ID;
const previousTerminal = process.env.HC_TERMINAL_ID;
const previousManagedStartup = process.env.DORI_MANAGED_STARTUP;
const sessions: FakePi[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.emit("session_shutdown");
  if (previousPane === undefined) delete process.env.HERDR_PANE_ID;
  else process.env.HERDR_PANE_ID = previousPane;
  if (previousTerminal === undefined) delete process.env.HC_TERMINAL_ID;
  else process.env.HC_TERMINAL_ID = previousTerminal;
  if (previousManagedStartup === undefined) delete process.env.DORI_MANAGED_STARTUP;
  else process.env.DORI_MANAGED_STARTUP = previousManagedStartup;
});
function fixture(sessionId = "legacy-session") {
  const stateDir = useConfig(join(import.meta.dir, "fake-ulw.ts"));
  process.env.HERDR_PANE_ID = "w1:p7";
  delete process.env.HC_TERMINAL_ID;
  const bootstrap = join(stateDir, "..", "trusted-bootstrap.json");
  const intake = { path: join(stateDir, "heartbeat"), monitor: "inbound", maxAgeMs: 120_000 };
  // The real child is portable; only deployment health's kernel start-tick attestation requires Linux.
  const monitor = { name: "inbound", argv: ["sleep", "60"], filter: "^INBOUND", cwd: tmpdir() };
  writeFileSync(bootstrap, JSON.stringify({ version: 1, sessionId, monitors: [monitor], intake }), { mode: 0o600 });
  return { stateDir, bootstrap, monitor, intake, healthPath: join(stateDir, "runtime", "w1%3Ap7.json") };
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
  "trusted first handoff replaces legacy specifications, observes real monitor identities and resumes without the file",
  async () => {
    const f = fixture();
    const session = {
      id: "legacy-session",
      entries: [
        {
          type: "custom",
          customType: "omp-dori:monitor",
          data: {
            op: "start",
            name: "incompatible-legacy",
            argv: ["missing-command-fixture"],
            filter: ".",
            cwd: tmpdir(),
          },
        },
      ],
    };
    const first = await load({ session, flags: { "dori-role": "dori", "dori-monitor-bootstrap": f.bootstrap } });
    sessions.push(first);
    await first.emit("session_start");
    await until(() => JSON.parse(readFileSync(f.healthPath, "utf8")).monitors.length === 1);
    const health = JSON.parse(readFileSync(f.healthPath, "utf8")) as RuntimeHealth;
    expect(health).toMatchObject({ role: "dori", paneId: "w1:p7", pid: process.pid, sessionId: session.id });
    expect(health.presetLoaded).toBe(true);
    expect(health.monitors[0]).toMatchObject(f.monitor);
    expect(processIdentity(health.monitors[0]!.pid)?.startTicks).toBe(health.monitors[0]!.startTicks);
    expect(JSON.parse(readFileSync(join(f.stateDir, "monitors", `${session.id}.json`), "utf8"))).toMatchObject({
      intake: f.intake,
    });
    expect((await run(first, { op: "list" })).content[0]?.text).toContain("inbound");
    expect((await run(first, { op: "list" })).content[0]?.text).not.toContain("incompatible-legacy");
    const oldPid = health.monitors[0]!.pid;
    await first.emit("session_shutdown");
    await until(() => processIdentity(oldPid) === undefined);
    const resumed = await load({ session });
    sessions.push(resumed);
    await resumed.emit("session_start");
    const after = JSON.parse(readFileSync(f.healthPath, "utf8")) as RuntimeHealth;
    expect(after.monitors[0]?.pid).not.toBe(oldPid);
    expect(after.monitors[0]?.argv).toEqual(f.monitor.argv);
    expect(session.entries.filter((entry) => entry.customType === "omp-dori:monitor-bootstrap")).toHaveLength(1);
  },
);

test("ordinary bootstrap replaces legacy monitors and restores real children without the bootstrap file", async () => {
  const f = fixture();
  const session = {
    id: "legacy-session",
    entries: [
      {
        type: "custom",
        customType: "omp-dori:monitor",
        data: { op: "start", ...f.monitor, name: "incompatible-legacy", argv: ["missing-command-fixture"] },
      },
    ],
  };
  const first = await load({ session, flags: { "dori-role": "dori", "dori-monitor-bootstrap": f.bootstrap } });
  sessions.push(first);
  await first.emit("session_start");
  const listed = (await run(first, { op: "list" })).content[0]?.text ?? "";
  const oldPid = Number(/pid (\d+)/.exec(listed)?.[1]);
  expect(alive(oldPid)).toBe(true);
  expect(listed).toContain("inbound");
  expect(listed).not.toContain("incompatible-legacy");
  const metadata = join(f.stateDir, "monitors", `${session.id}.json`);
  expect(JSON.parse(readFileSync(metadata, "utf8"))).toMatchObject({ monitors: [f.monitor], intake: f.intake });
  const health = JSON.parse(readFileSync(f.healthPath, "utf8")) as RuntimeHealth;
  expect(health).toMatchObject({ role: "dori", paneId: "w1:p7", pid: process.pid, sessionId: session.id });
  expect(health.presetLoaded).toBe(true);
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
  expect(session.entries.filter((entry) => entry.customType === "omp-dori:monitor-bootstrap")).toHaveLength(1);
});

test("a consumed bootstrap never resurrects an explicitly stopped monitor", async () => {
  const f = fixture();
  const session = { id: "legacy-session", entries: [] };
  const dori = await load({ session, flags: { "dori-role": "dori", "dori-monitor-bootstrap": f.bootstrap } });
  sessions.push(dori);
  await dori.emit("session_start");
  await run(dori, { op: "stop", name: "inbound" });
  await dori.emit("session_start");
  expect((await run(dori, { op: "list" })).content[0]?.text).toBe("no monitors running");
  expect(JSON.parse(readFileSync(join(f.stateDir, "monitors", "legacy-session.json"), "utf8")).monitors).toEqual([]);
});

test("a bootstrap bound to another native session launches nothing", async () => {
  const f = fixture("different-session");
  const dori = await load({
    session: { id: "legacy-session", entries: [] },
    flags: {
      "dori-role": "dori",
      "dori-monitor-bootstrap": f.bootstrap,
    },
  });
  sessions.push(dori);
  await expect(dori.emit("session_start")).rejects.toThrow("session or version");
  expect(lstatSync(f.healthPath, { throwIfNoEntry: false })).toBeUndefined();
});

test("branch movement replaces a changed specification under the same monitor name", async () => {
  const f = fixture();
  const dori = await load({ session: { id: "legacy-session", entries: [] }, flags: { "dori-role": "dori" } });
  sessions.push(dori);
  await dori.emit("session_start");
  await run(dori, { op: "start", name: "inbound", argv: ["sleep", "60"], filter: "." });
  const before = (await run(dori, { op: "list" })).content[0]?.text ?? "";
  const oldPid = Number(/pid (\d+)/.exec(before)?.[1]);
  expect(alive(oldPid)).toBe(true);
  dori.api.appendEntry("omp-dori:monitor", {
    op: "start",
    name: "inbound",
    argv: ["sleep", "61"],
    filter: "^changed",
    cwd: tmpdir(),
  });
  await dori.emit("session_tree");
  await until(() => !alive(oldPid));
  const after = (await run(dori, { op: "list" })).content[0]?.text ?? "";
  const newPid = Number(/pid (\d+)/.exec(after)?.[1]);
  expect(alive(newPid)).toBe(true);
  expect(newPid).not.toBe(oldPid);
  expect(after).toContain("sleep 61");
  expect(after).toContain("^changed");
  expect(JSON.parse(readFileSync(join(f.stateDir, "monitors", "legacy-session.json"), "utf8"))).toMatchObject({
    monitors: [{ name: "inbound", argv: ["sleep", "61"], filter: "^changed", cwd: tmpdir() }],
  });
});

test("a managed initial restore reports failure without starting model work, then ordinary restore keeps its repair behavior", async () => {
  const f = fixture();
  process.env.DORI_MANAGED_STARTUP = "1";
  const dori = await load({
    session: {
      id: "legacy-session",
      entries: [
        {
          type: "custom",
          customType: "omp-dori:monitor",
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
    flags: { "dori-role": "dori" },
  });
  sessions.push(dori);
  await dori.emit("session_start");
  expect(dori.messages.at(-1)?.options).toMatchObject({ triggerTurn: false });
  expect((JSON.parse(readFileSync(f.healthPath, "utf8")) as RuntimeHealth).monitors).toEqual([]);
  await dori.emit("session_tree");
  expect(dori.messages.at(-1)?.options).toMatchObject({ triggerTurn: true });
});

test("role health records a failed preset load even when role and PID metadata exist", async () => {
  const f = fixture();
  writeFileSync(
    join(f.stateDir, "..", "config.json"),
    JSON.stringify({
      stateDir: f.stateDir,
      ompUlwPath: join(f.stateDir, "absent-preset.ts"),
    }),
  );
  const dori = await load({ session: { id: "legacy-session", entries: [] }, flags: { "dori-role": "dori" } });
  sessions.push(dori);
  await dori.emit("session_start");
  expect(JSON.parse(readFileSync(f.healthPath, "utf8"))).toMatchObject({
    role: "dori",
    pid: process.pid,
    presetLoaded: false,
  });
});
