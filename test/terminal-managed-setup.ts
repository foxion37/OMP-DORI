import { expect } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultDeps } from "../src/harness.ts";
import type { Exec } from "../src/runtime/exec.ts";
import type { RuntimeKind } from "../src/runtime/types.ts";
import { Store } from "../src/store.ts";
import { World } from "./fake.ts";
import { environment, managedCommand } from "./managed-command-setup.ts";
import { type ChildCapture, recorded, recordingOmp, terminalServer } from "./terminal-context-setup.ts";

export function managedTerminal(runtime: RuntimeKind, conflicting = true) {
  const f = managedCommand();
  recordingOmp(f.omp);
  const prefix = [...f.argv, "--owner-option", ""];
  const scope = join(f.root, "process scope 'quote'.json");
  environment({
    HOME: f.config.home,
    DORI_AGENT_ARGV: JSON.stringify(prefix),
    OMP_ULW_SCOPE_FILE: scope,
    DORI_HERDR_SESSION: "private-herdr-session",
    HC_SESSION: "private-hc-session",
    DORI_RUNTIME: undefined,
    HERDR_PANE_ID: "wparent:pparent",
    HERDR_WORKSPACE_ID: "wparent",
    HC_TERMINAL_ID: "tparent",
    DORI_MANAGED_STARTUP: "1",
    DORI_SLACK_TOKEN: undefined,
    DORI_SLACK_TOKEN_FILE: undefined,
    DORI_SLACK_TOKEN_FILE_OUTSIDE_HOME: undefined,
    UNRELATED_SECRET: "actor-only-secret",
  });
  writeFileSync(
    f.config.doriConfig,
    JSON.stringify({
      runtime,
      stateDir: f.config.stateDir,
      defaultCwd: f.root,
    }),
  );
  const expected = {
    HOME: f.config.home,
    DORI_CONFIG: f.config.doriConfig,
    DORI_HOME: f.config.doriHome,
    DORI_STATE_DIR: f.config.stateDir,
    DORI_AGENT_ARGV: JSON.stringify(prefix),
    DORI_OMP_ULW_PATH: f.env["DORI_OMP_ULW_PATH"]!,
    OMP_ULW_SCOPE_FILE: scope,
    DORI_HERDR_SESSION: "private-herdr-session",
    HC_SESSION: "private-hc-session",
    DORI_MANAGED_STARTUP: "",
  };
  const world = new World();
  const original = world.exec;
  const ready: Exec = async (cmd, argv, options) => {
    const result = await original(cmd, argv, options);
    if (cmd === "herdr" && argv[0] === "pane" && argv[1] === "run") {
      const pane = world.panes.get(argv[2]!)!;
      pane.status = "idle";
      pane.screen = "recording program";
    }
    if (cmd === "hc" && argv[1] === "send") {
      const terminal = world.hc.terminals.get(argv[2]!)!;
      terminal.status = { state: "idle", app: "omo" };
      terminal.reported = true;
      terminal.screen = "recording program";
    }
    return result;
  };
  const daemon = terminalServer(ready, {
    ...(conflicting ? Object.fromEntries(Object.keys(expected).map((key) => [key, `/server/default/${key}`])) : {}),
    HOME: join(f.root, "server-home"),
    PATH: "/usr/bin:/bin",
    DORI_MANAGED_STARTUP: "1",
    SERVER_ONLY: "daemon-created-child",
  });
  world.exec = daemon.exec;
  const deps = {
    ...world.deps({ runtime }),
    store: new Store(f.config.doriHome),
    agentCmd: defaultDeps().agentCmd,
    doriCmd: ":",
  };
  const brief = join(f.root, "brief 'literal'.txt");
  writeFileSync(brief, "Execute the terminal transport recording program.\n");
  mkdirSync(join(f.root, "ordinary cwd"));
  return { ...f, prefix, expected, world, daemon, deps, brief, cwd: join(f.root, "ordinary cwd") };
}

export function expectContext(capture: ChildCapture, expected: Record<string, string>) {
  expect(capture.code).toBe(0);
  expect(capture.serverPid).not.toBe(process.pid);
  expect(capture.childPid).not.toBe(capture.serverPid);
  const child = recorded(capture);
  for (const [key, value] of Object.entries(expected)) expect(child.env[key]).toBe(value);
  expect(child.env["SERVER_ONLY"]).toBe("daemon-created-child");
  expect(child.env["UNRELATED_SECRET"]).toBeUndefined();
  expect(child.env["HERDR_PANE_ID"]).not.toBe("wparent:pparent");
  expect(child.env["HERDR_WORKSPACE_ID"]).not.toBe("wparent");
  expect(child.env["HC_TERMINAL_ID"]).not.toBe("tparent");
  return child;
}
