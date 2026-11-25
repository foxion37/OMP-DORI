import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CatalyConfig } from "../src/config.ts";
import { adoptLane, LaunchError, prepareLaunch } from "../src/launch.ts";
import { cliCommand, shellQuote } from "../src/launch-footer.ts";
import type { Lane } from "../src/registry.ts";
import { Reports, reportId, reportLine } from "../src/reports.ts";
import { depsFor, fakeClock, newWorld, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");

let state: ReturnType<typeof withState>;

let world: World;

beforeEach(() => {
  state = withState();
  world = newWorld();
});

afterEach(() => state.done());

const working: Lane = {
  key: "quiet-lane",
  title: "quiet",
  thread: "chat:team/9",
  sessionRef: { runtime: "tern", id: "7" },
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
  lastReplyAt: T0,
};

test("adopting a Tern block refuses a Done line the watcher could never check, and non-Tern panes", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(
    adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "two clean QA passes", pane: "tern:2" }),
  ).rejects.toBeInstanceOf(LaunchError);
  for (const pane of ["w:p2", "tmux:2"])
    await expect(
      adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane }),
    ).rejects.toBeInstanceOf(LaunchError);
  const ok = await adoptLane(deps, {
    key: "x-lane",
    title: "x",
    brief: "/b.md",
    done: "closed acme/app#3",
    pane: "2",
  });
  expect(ok.thread).toBe("none");
  expect(ok.sessionRef).toEqual({ runtime: "tern", id: "2" });
  await expect(
    adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "tern:2" }),
  ).rejects.toThrow("already registered");
});

test("the footer CLI command survives a skill path with a space or a quote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cataly skill's dir "));
  try {
    const cli = join(dir, "cli.ts");
    writeFileSync(cli, 'console.log("CLI_OK " + process.argv.slice(2).join(" "));\n');
    const command = cliCommand(cli);
    const proc = Bun.spawn(["bash", "-c", `${command} report path-lane --kind milestone`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect((await new Response(proc.stdout).text()).trim()).toBe("CLI_OK report path-lane --kind milestone");
    expect(await proc.exited).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The launcher stubs are extensionless POSIX executables invoked by the generated shell footer.
const posix = test.skipIf(process.platform === "win32");
posix(
  "the selected footer runtime receives one data argument and missing destinations still journal reports",
  verifyFooterRuntime,
  15_000,
);

async function verifyFooterRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "cataly footer send "));
  const priorConfig = process.env["CATALY_CONFIG"];
  try {
    const configFile = join(dir, "config.json");
    process.env["CATALY_CONFIG"] = configFile;
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "Perform the fixture work.");
    writeFileSync(
      join(dir, "tern"),
      `#!/usr/bin/env bun\nawait Bun.write(process.env.ARGV_LOG, JSON.stringify(["tern", ...process.argv.slice(2)]));\n`,
      { mode: 0o755 },
    );
    const marker = join(dir, "must not execute");
    const text = `it's "done"; $(touch ${shellQuote(marker)}) \`touch ${shellQuote(marker)}\` \\ $HOME | 100%
next line`;
    const cases: Array<{
      configured?: CatalyConfig["sessionRuntime"];
      env: Record<string, string>;
      selected?: CatalyConfig["sessionRuntime"];
      lead?: string;
    }> = [
      { configured: "tern", env: {}, selected: "tern" },
      { env: { CATALY_RUNTIME: "tern" }, selected: "tern" },
      { env: { TERN_PANE: "7" } },
      { env: { PATH: dir } },
      { configured: "tern", env: {}, lead: "" },
      { env: {} },
    ];
    for (const [index, fixture] of cases.entries()) {
      // The footer names the runtime chosen from config and env, so these deps build their own runtimes.
      const { rts: _rts, ...deps } = depsFor(world, fakeClock(T0), state.dir);
      const config = { ...deps.config, leadPane: fixture.lead ?? "lead's pane" };
      delete config.sessionRuntime;
      if (fixture.configured) config.sessionRuntime = fixture.configured;
      writeFileSync(configFile, JSON.stringify(config));
      const key = `send-lane-${index}`;
      const prepared = await prepareLaunch(
        { ...deps, config, env: { PATH: "", ...fixture.env } },
        { key, title: "argv", brief, done: working.done },
      );
      expect(world.calls).toEqual([]);
      expect(await Bun.file(brief).text()).toBe("Perform the fixture work.");
      expect(await deps.registry.read(key)).toBeNull();
      await deps.registry.write(prepared.lane);
      const lines = prepared.preamble.split("\n");
      const record = lines.find((line) => line.startsWith("receipt=$("));
      const forward = lines.find((line) => line.startsWith("line=$("));
      if (!record) throw new Error("launch footer has no report command");
      const argvLog = join(dir, `${index}.argv.json`);
      const env = {
        ...process.env,
        PATH: `${dir}:${process.env["PATH"]}`,
        CATALY_CONFIG: configFile,
        CATALY_STATE_DIR: state.dir,
        ARGV_LOG: argvLog,
        kind: "milestone",
        text,
      };
      const proc = Bun.spawn(["bash", "-c", record], { stdout: "pipe", stderr: "pipe", env });
      const receipt = (await new Response(proc.stdout).text()).trimEnd();
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(await proc.exited).toBe(0);
      const journal = new Reports(state.dir);
      const saved = journal.read(key)?.lastReport;
      expect(saved?.text).toBe(text);
      if (!saved) throw new Error("report was not saved");
      expect(JSON.parse(receipt)).toEqual({ ...saved, id: reportId(saved) });
      expect(existsSync(argvLog)).toBe(false);
      const beforeForward = await Bun.file(journal.path(key)).text();
      expect(beforeForward.trimEnd().split("\n")).toHaveLength(1);
      if (fixture.selected) {
        if (!forward) throw new Error("launch footer has no forwarding command");
        const sender = Bun.spawn(["bash", "-c", forward], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...env, receipt },
        });
        expect(await new Response(sender.stderr).text()).toBe("");
        expect(await sender.exited).toBe(0);
        const report = reportLine(saved);
        const sent = ["run", config.leadPane, "--", report];
        expect(await Bun.file(argvLog).json()).toEqual([fixture.selected, ...sent]);
      } else expect(forward).toBeUndefined();
      expect(await Bun.file(journal.path(key)).text()).toBe(beforeForward);
      expect(existsSync(marker)).toBe(false);
    }
  } finally {
    if (priorConfig === undefined) delete process.env["CATALY_CONFIG"];
    else process.env["CATALY_CONFIG"] = priorConfig;
    rmSync(dir, { recursive: true, force: true });
  }
}
