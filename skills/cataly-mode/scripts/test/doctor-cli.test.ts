import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctorCommand } from "./doctor-fixture.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
test("real CLI emits JSON diagnostics and presets with isolated state and no side effects", async () => {
  const state = withState();
  try {
    // Bun owns its HOME cache; Cataly must leave the separately selected state directory untouched.
    const stateDir = join(state.dir, "state");
    mkdirSync(stateDir);
    const config = join(state.dir, "config.json");
    const agentCommand = doctorCommand(state.dir);
    writeFileSync(
      config,
      JSON.stringify({
        stateDir,
        agentCommand,
        sessionsDir: join(state.dir, "sessions"),
        leadPane: "",
        runtime: "tern",
      }),
    );
    const before = readFileSync(config, "utf8");
    const run = async (...args: string[]) => {
      const child = Bun.spawn([process.execPath, cli, ...args], {
        env: {
          HOME: state.dir,
          PATH: process.env["PATH"],
          CATALY_CONFIG: config,
          CATALY_STATE_DIR: stateDir,
          CATALY_LEAD_PANE: "",
          CATALY_RUNTIME: "tern",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { out, err, code };
    };
    const result = await run("doctor", "--json", "--repo", "acme/app");
    expect(result.code).toBe(1);
    expect(result.err).toBe("");
    const report = JSON.parse(result.out);
    expect(report.findings).toContainEqual(expect.objectContaining({ check: "repo-identities", severity: "WARN" }));
    expect(report.findings).toContainEqual(expect.objectContaining({ check: "runtime", severity: "WARN" }));
    const presets = await run("monitor-presets", "freshness", "--json");
    expect(presets.code).toBe(0);
    expect(JSON.parse(presets.out)).toEqual([
      {
        name: "freshness",
        argv: ["cataly", "freshness", "--loop", "5"],
        filter: expect.stringContaining("BLOCKED|WARNING|SUPERVISION-ERROR"),
      },
    ]);
    const invalid = await run("monitor-presets", "unknown");
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain("unknown monitor preset");
    expect((await run("doctor", "--repo", "wrong")).err).toContain("--repo must be owner/repo");
    expect(readFileSync(config, "utf8")).toBe(before);
    expect(readdirSync(stateDir)).toEqual([]);
    writeFileSync(
      config,
      JSON.stringify({
        stateDir,
        agentCommand,
        sessionsDir: join(state.dir, "sessions"),
        doctor: { ignore: ["runtime"] },
      }),
    );
    const ignored = await run("doctor", "--json");
    expect(ignored.code).toBe(0);
    expect(JSON.parse(ignored.out).ignored).toEqual(["runtime"]);
    expect(readdirSync(stateDir)).toEqual([]);
  } finally {
    state.done();
  }
});

const withHealthyCli = () => {
  const state = withState();
  const home = join(state.dir, "home");
  const stateDir = join(state.dir, "state");
  const sessionsDir = join(state.dir, "sessions");
  for (const dir of [home, stateDir, sessionsDir]) mkdirSync(dir);
  const config = join(home, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      stateDir,
      agentCommand: doctorCommand(mkdtempSync(join(tmpdir(), "cataly-doctor-cmd-"))),
      sessionsDir,
      leadPane: "",
      runtime: "tern",
      // No live lead is needed for these local diagnostics; every other check stays enabled.
      doctor: { ignore: ["runtime"] },
    }),
  );
  const run = async (args: string[], env: Record<string, string> = {}) => {
    const child = Bun.spawn([process.execPath, cli, ...args], {
      cwd: home,
      env: {
        HOME: home,
        PATH: dirname(process.execPath),
        TMPDIR: state.dir,
        CATALY_TELEMETRY: "0",
        CATALY_CONFIG: config,
        CATALY_STATE_DIR: stateDir,
        CATALY_LEAD_PANE: "",
        CATALY_RUNTIME: "tern",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { out, err, code };
  };
  return { ...state, stateDir, sessionsDir, config, run };
};

test("real CLI rejects a trailing bare --repo instead of reporting healthy diagnostics", async () => {
  const state = withHealthyCli();
  try {
    const before = readFileSync(state.config, "utf8");
    const healthy = await state.run(["doctor", "--json"]);
    expect(healthy.code).toBe(0);
    expect(healthy.err).toBe("");
    expect(JSON.parse(healthy.out)).toMatchObject({ warnings: 0, exitCode: 0, ignored: ["runtime"] });
    // Exercise the real permissive parser and option adapter, not a hand-built CLI context.
    const invalid = await state.run(["doctor", "--json", "--repo"]);
    expect(invalid.code).toBe(1);
    expect(invalid.out).toBe("");
    expect(invalid.err).toBe("--repo must be owner/repo\n");
    expect(readFileSync(state.config, "utf8")).toBe(before);
    expect(readdirSync(state.stateDir)).toEqual([]);
  } finally {
    state.done();
  }
});

test("real CLI warns about corrupt monitor metadata without exposing private data", async () => {
  const state = withHealthyCli();
  try {
    const before = readFileSync(state.config, "utf8");
    const monitors = join(state.stateDir, "monitors");
    mkdirSync(monitors);
    const sessionFile = join(state.sessionsDir, "private-session.jsonl");
    const transcript = "PRIVATE_TRANSCRIPT_MUST_NOT_BE_READ";
    writeFileSync(sessionFile, transcript);
    const metadata = join(monitors, "private-monitor-metadata.json");
    writeFileSync(metadata, JSON.stringify({ version: 1, sessionId: "private-owner", monitors: [] }));
    const empty = await state.run(["doctor", "--json"]);
    expect(empty.code).toBe(0);
    expect(empty.err).toBe("");
    expect(JSON.parse(empty.out)).toMatchObject({ warnings: 0, exitCode: 0, ignored: ["runtime"] });

    const privatePayload = "PRIVATE_MONITOR_PAYLOAD";
    const corrupt = `{"version":1,"sessionId":"${privatePayload}","monitors":[`;
    writeFileSync(metadata, corrupt);
    for (const json of [true, false]) {
      const result = await state.run(json ? ["doctor", "--json"] : ["doctor"]);
      expect(result.code).toBe(1);
      expect(result.err).toBe("");
      if (json) {
        const report = JSON.parse(result.out);
        expect(report.warnings).toBe(1);
        expect(report.exitCode).toBe(1);
        expect(report.findings).toContainEqual({
          check: "monitors",
          severity: "WARN",
          detail: "unreadable monitor metadata locations: 1",
        });
      } else {
        expect(result.out).toContain("WARN monitors: unreadable monitor metadata locations: 1");
        expect(result.out).toContain("DOCTOR warn=1 ignored=runtime read-only; nothing changed");
      }
      for (const secret of [state.dir, "private-monitor-metadata.json", privatePayload, transcript])
        expect(result.out + result.err).not.toContain(secret);
    }
    expect(readFileSync(metadata, "utf8")).toBe(corrupt);
    expect(readFileSync(sessionFile, "utf8")).toBe(transcript);
    expect(readFileSync(state.config, "utf8")).toBe(before);
    expect(readdirSync(state.stateDir)).toEqual(["monitors"]);
    expect(readdirSync(state.sessionsDir)).toEqual(["private-session.jsonl"]);
  } finally {
    state.done();
  }
});
