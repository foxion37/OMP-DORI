import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { platform } from "../../../../src/platform/index.ts";
import { processIdentity } from "../../../../src/update/deployment-process.ts";
import type { MonitorSpec } from "../../../../src/update/deployment-types.ts";
import type { Manifest } from "../src/boot-monitors.ts";
import { monitorRuntimeFindings } from "../src/doctor-monitors.ts";
import { doctorCheck } from "../src/doctor.ts";
import type { PaneState } from "../src/lane-state.ts";
import { doctorCommand } from "./doctor-fixture.ts";
import { depsFor, fakeClock, nativeLead, newWorld, sid, withState } from "./fakes.ts";

const liveSeverity = platform.supportsProcessReaders ? "OK" : "WARN";

test("only a fresh matching receipt and an owned live child establish monitor liveness", async () => {
  const state = withState();
  const child = Bun.spawn([process.execPath, "-e", "await Bun.stdin.text()"], {
    stdin: "pipe",
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    // The fake supervisor reports every session as started at the epoch; receipts must name that same start.
    const startedAt = new Date(0).toISOString();
    const updatedAt = new Date().toISOString();
    const lead: PaneState = {
      paneId: sid(1),
      role: "cataly",
      sessionId: "owner",
      cwd: state.dir,
      pid: process.pid,
      startedAt,
      updatedAt,
      goal: { status: "none" },
      approvalPending: false,
    };
    const spec = { name: "watch", argv: ["cataly", "watch"], filter: "^LANE_", cwd: state.dir };
    const manifest: Manifest = {
      path: "/unused",
      data: { version: 1, sessionId: "owner", monitors: [spec] },
    };
    const identity = processIdentity(child.pid);
    if (platform.supportsProcessReaders) expect(identity).toBeDefined();
    mkdirSync(join(state.dir, "runtime"));
    const health = {
      version: 1,
      paneId: lead.paneId,
      role: "cataly",
      sessionId: "owner",
      pid: process.pid,
      startedAt,
      updatedAt,
      configLoaded: true,
      monitors: [{ ...spec, pid: child.pid, startTicks: identity?.startTicks ?? "unavailable" }],
    };
    const path = join(state.dir, "runtime", `${encodeURIComponent(lead.paneId)}.json`);
    const check = () => monitorRuntimeFindings(state.dir, [manifest], lead, Date.now());
    const save = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
    save(health);
    if (platform.supportsProcessReaders) {
      expect(check()).toEqual([
        { check: "monitor-runtime", severity: "OK", detail: '"watch" live with recorded spec' },
      ]);
    } else {
      expect(check()).toMatchObject([{ check: "monitor-runtime", severity: "WARN" }]);
    }
    save({ ...health, monitors: [] });
    expect(check()[0]?.severity).toBe("WARN");
    if (platform.supportsProcessReaders) expect(check()[0]?.detail).toContain("no matching live child");
    save({ ...health, monitors: [{ ...health.monitors[0], startTicks: "wrong-incarnation" }] });
    expect(check()[0]?.severity).toBe("WARN");
    save({ ...health, monitors: [{ ...health.monitors[0], cwd: "/different" }] });
    expect(check()[0]?.severity).toBe("WARN");
    save({ ...health, monitors: [{ ...health.monitors[0], pid: process.pid }] });
    expect(check()[0]?.severity).toBe("WARN");
    save({
      ...health,
      updatedAt: new Date(Date.now() - 60_000).toISOString(),
      startedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    expect(check()[0]?.detail).toContain("liveness unverified");
    save({ ...health, pid: child.pid });
    expect(check()[0]?.detail).toContain("liveness unverified");
    save(health);
    expect(monitorRuntimeFindings(state.dir, [manifest], null, Date.now())[0]?.severity).toBe("INFO");
    expect(
      monitorRuntimeFindings(state.dir, [manifest], { ...lead, sessionId: "another-session" }, Date.now())[0]?.severity,
    ).toBe("INFO");
    const multiple = { ...manifest, data: { ...manifest.data, monitors: [{ ...spec, name: "broken" }, spec] } };
    save({ ...health, monitors: [{ ...health.monitors[0], name: "broken", filter: "[" }, health.monitors[0]] });
    const independent = monitorRuntimeFindings(state.dir, [multiple], lead, Date.now());
    if (platform.supportsProcessReaders) {
      expect(independent.map((finding) => finding.severity)).toEqual(["WARN", "OK"]);
      expect(independent[0]?.detail).toContain("invalid or unreadable process receipt");
    } else {
      expect(independent[0]?.severity).toBe("WARN");
    }
    const restartingSpec: MonitorSpec = { ...spec, restart: "on-failure" };
    const restartingManifest = { ...manifest, data: { ...manifest.data, monitors: [restartingSpec] } };
    const restartFindings = [undefined, "always", "on-failure"].map((restart) => {
      save({
        ...health,
        monitors: [{ ...health.monitors[0], ...(restart === undefined ? {} : { restart }) }],
      });
      const receipt = readFileSync(path, "utf8");
      const findings = monitorRuntimeFindings(state.dir, [restartingManifest], lead, Date.now());
      expect(readFileSync(path, "utf8")).toBe(receipt);
      expect(processIdentity(child.pid)).toEqual(identity);
      expect(child.exitCode).toBeNull();
      return { restart, severities: findings.map((finding) => finding.severity) };
    });

    const world = newWorld();
    const deps = depsFor(world, fakeClock(Date.parse(updatedAt)), state.dir, {
      leadPane: nativeLead(world, 1, { pid: lead.pid, cwd: state.dir }),
      sessionsDir: join(state.dir, "sessions"),
      agentCommand: doctorCommand(state.dir),
    });
    const dir = join(state.dir, "monitors");
    mkdirSync(dir);
    writeFileSync(join(dir, "owner.json"), JSON.stringify({ ...manifest.data, monitors: [{ ...spec, filter: "" }] }));
    const { filter: _filter, ...running } = health.monitors[0]!;
    const filters = [{}, { filter: [] }, { filter: null }, { filter: "." }, { filter: "" }, { filter: "(?:)" }];
    const filterFindings = [];
    for (const receiptFields of filters) {
      save({ ...health, monitors: [{ ...running, ...receiptFields }] });
      const result = await doctorCheck(deps);
      filterFindings.push({
        exitCode: result.exitCode,
        severities: result.findings.filter((finding) => finding.check === "monitor-runtime").map((f) => f.severity),
      });
    }
    save(health);
    child.kill();
    await child.exited;
    expect(check()[0]?.severity).toBe("WARN");
    expect(restartFindings).toEqual([
      { restart: undefined, severities: ["WARN"] },
      { restart: "always", severities: ["WARN"] },
      { restart: "on-failure", severities: [liveSeverity] },
    ]);
    expect(filterFindings).toEqual([
      { exitCode: 1, severities: ["WARN"] },
      { exitCode: 1, severities: ["WARN"] },
      { exitCode: 1, severities: ["WARN"] },
      { exitCode: 1, severities: ["WARN"] },
      { exitCode: platform.supportsProcessReaders ? 0 : 1, severities: [liveSeverity] },
      { exitCode: platform.supportsProcessReaders ? 0 : 1, severities: [liveSeverity] },
    ]);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
    state.done();
  }
});
