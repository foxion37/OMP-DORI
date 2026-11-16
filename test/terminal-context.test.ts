import { expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { up } from "../src/cli-up.ts";
import { shq } from "../src/delivery.ts";
import { review } from "../src/gate.ts";
import { startLane } from "../src/lanes.ts";
import { doriLaunchEnv } from "../src/release/runtime.ts";
import { captureIo } from "./inbox-setup.ts";
import { recorded, recordingOmp } from "./terminal-context-setup.ts";
import { expectContext, managedTerminal } from "./terminal-managed-setup.ts";

for (const runtime of ["herdr", "hc"] as const) {
  for (const conflicting of [false, true]) {
    test(`${runtime}: harness agents and controllers cross a daemon with conflicting=${conflicting} defaults`, async () => {
      const f = managedTerminal(runtime, conflicting);
      try {
        await captureIo(async () => {
          await up(f.deps, f.cwd);
          return 0;
        });
        await startLane(f.deps, "transport-lane", f.brief, { cwd: f.cwd, group: "w1" });
        expect(f.daemon.captures).toHaveLength(5);
        const agents = f.daemon.captures.filter((capture) => capture.stdout.includes("\nENV\n"));
        expect(agents).toHaveLength(3);
        for (const capture of agents) {
          const child = expectContext(capture, f.expected);
          expect(child.argv.slice(0, f.prefix.length)).toEqual(f.prefix);
        }
        for (const session of f.daemon.sessions.values()) {
          for (const [key, value] of Object.entries(f.expected)) expect(session.env[key]).toBe(value);
          expect(session.env["UNRELATED_SECRET"]).toBeUndefined();
        }
        expect(recorded(agents[2]!).argv.slice(f.prefix.length, f.prefix.length + 2)).toEqual(["--dori-role", "lane"]);
      } finally {
        await f.daemon.close();
      }
    });
  }

  test(`${runtime}: explicit harness shell commands keep literal assignments and argument semantics`, async () => {
    const f = managedTerminal(runtime);
    const external = join(f.root, "owner tools", "custom-agent");
    mkdirSync(dirname(external), { recursive: true });
    recordingOmp(external);
    const value = "owner value 'quote' ; $(touch assignment-ran)";
    const command = `env OWNER_VALUE=${shq(value)} ${shq(external)} --literal ''`;
    try {
      await startLane({ ...f.deps, agentCmd: command }, "external-lane", f.brief, { cwd: f.cwd, group: "w1" });
      const child = expectContext(f.daemon.captures[0]!, f.expected);
      expect(child.argv.slice(0, 3)).toEqual([external, "--literal", ""]);
      expect(child.argv).not.toContain("--dori-role");
      expect(child.env["OWNER_VALUE"]).toBe(value);
      expect(existsSync(join(f.cwd, "assignment-ran"))).toBe(false);
    } finally {
      await f.daemon.close();
    }
  });
}

test("fresh reviewer receives the selected context and drops parent pane and managed-startup identities", async () => {
  const f = managedTerminal("herdr");
  let child: { argv: string[]; env: Record<string, string> } | undefined;
  f.world.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: "a".repeat(40) }) });
  const deps = {
    ...f.deps,
    exec: async (cmd: string, argv: readonly string[]) => {
      if (cmd === "gh") return f.world.exec(cmd, argv);
      expect(cmd).toBe("env");
      expect(argv.some((part) => part.startsWith("UNRELATED_SECRET="))).toBe(false);
      const result = Bun.spawnSync([cmd, ...argv], { cwd: f.cwd });
      child = recorded({
        serverPid: process.pid,
        childPid: result.pid,
        code: result.exitCode,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      });
      return { code: result.exitCode, stdout: "VERDICT: CLEAR", stderr: result.stderr.toString() };
    },
  };
  try {
    expect((await review(deps, "fixture/repo#7", "fixture/model")).verdict).toBe("CLEAR");
    for (const [key, value] of Object.entries(f.expected)) {
      if (key !== "DORI_MANAGED_STARTUP") expect(child!.env[key]).toBe(value);
    }
    for (const key of ["HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "HC_TERMINAL_ID", "DORI_MANAGED_STARTUP", "DORI_LANE"])
      expect(child!.env[key]).toBeUndefined();
    expect(child!.argv.slice(0, f.prefix.length)).toEqual(f.prefix);
    expect(child!.argv.slice(f.prefix.length, f.prefix.length + 6)).toEqual([
      "--dori-role",
      "lane",
      "-p",
      "--no-session",
      "--model",
      "fixture/model",
    ]);
  } finally {
    await f.daemon.close();
  }
});

test("launch context makes relative paths absolute without collapsing OS links or explicit empty scope", () => {
  const raw = `relative${sep}link${sep}..${sep}config.json`;
  const context = doriLaunchEnv(
    {
      DORI_AGENT_ARGV: '["/selected omp", "--literal", ""]',
      DORI_HOME: "relative home",
      DORI_STATE_DIR: "relative state",
      DORI_OMP_ULW_PATH: "relative ulw/index.ts",
      OMP_ULW_SCOPE_FILE: "",
      HERDR_PANE_ID: "wparent:pparent",
      DORI_MANAGED_STARTUP: "1",
      SECRET: "private",
    },
    raw,
  );
  expect(context).toEqual({
    DORI_MANAGED_STARTUP: "",
    DORI_CONFIG: `${process.cwd()}${sep}${raw}`,
    DORI_HOME: `${process.cwd()}${sep}relative home`,
    DORI_STATE_DIR: `${process.cwd()}${sep}relative state`,
    DORI_OMP_ULW_PATH: `${process.cwd()}${sep}relative ulw/index.ts`,
    OMP_ULW_SCOPE_FILE: "",
    DORI_AGENT_ARGV: '["/selected omp", "--literal", ""]',
  });
});
