import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DoriConfig } from "../src/config.ts";
import { adoptLane } from "../src/adopt.ts";
import { LaunchError, prepareLaunch } from "../src/launch.ts";
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
  pane: "w:p7",
  brief: "/b.md",
  done: "merged acme/app#1",
  openedAt: new Date(T0).toISOString(),
  lastReplyAt: T0,
};

test("adopting a lane refuses a Done line the watcher could never check", async () => {
  const deps = depsFor(world, fakeClock(T0), state.dir);
  await expect(
    adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "two clean QA passes", pane: "w:p2" }),
  ).rejects.toBeInstanceOf(LaunchError);
  const ok = await adoptLane(deps, {
    key: "x-lane",
    title: "x",
    brief: "/b.md",
    done: "closed acme/app#3",
    pane: "w:p2",
  });
  expect(ok.thread).toBe("none");
  await expect(
    adoptLane(deps, { key: "x-lane", title: "x", brief: "/b.md", done: "closed acme/app#3", pane: "w:p2" }),
  ).rejects.toThrow("already registered");
});

test("the footer CLI command survives a skill path with a space or a quote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dori skill's dir "));
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
  const dir = mkdtempSync(join(tmpdir(), "dori footer send "));
  const priorConfig = process.env["DORI_CONFIG"];
  try {
    const configFile = join(dir, "config.json");
    process.env["DORI_CONFIG"] = configFile;
    const brief = join(dir, "brief.md");
    writeFileSync(brief, "Perform the fixture work.");
    for (const bin of ["herdr", "hc"])
      writeFileSync(
        join(dir, bin),
        `#!/usr/bin/env bun\nawait Bun.write(process.env.ARGV_LOG, JSON.stringify([${JSON.stringify(bin)}, ...process.argv.slice(2)]));\n`,
        { mode: 0o755 },
      );
    const marker = join(dir, "must not execute");
    const text = `it's "done"; $(touch ${shellQuote(marker)}) \`touch ${shellQuote(marker)}\` \\ $HOME | 100%
next line`;
    const cases: Array<{
      configured?: DoriConfig["runtime"];
      env: Record<string, string>;
      selected?: DoriConfig["runtime"];
      lead?: string;
    }> = [
      { configured: "herdr", env: {}, selected: "herdr" },
      { configured: "hc", env: {}, selected: "hc" },
      { configured: "herdr", env: { DORI_RUNTIME: "hc" }, selected: "hc" },
      { env: { HC_TERMINAL_ID: "t1" }, selected: "hc" },
      { env: { HERDR_PANE_ID: "w:p1" }, selected: "herdr" },
      { env: { PATH: dir }, selected: "hc" },
      { configured: "herdr", env: {}, lead: "" },
      { env: {} },
    ];
    for (const [index, fixture] of cases.entries()) {
      const deps = depsFor(world, fakeClock(T0), state.dir);
      const config = { ...deps.config, leadPane: fixture.lead ?? "lead's pane" };
      delete config.runtime;
      if (fixture.configured) config.runtime = fixture.configured;
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
        DORI_CONFIG: configFile,
        DORI_STATE_DIR: state.dir,
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
        const sent =
          fixture.selected === "herdr"
            ? ["pane", "run", config.leadPane, report]
            : ["send", config.leadPane, "--", report];
        expect(await Bun.file(argvLog).json()).toEqual([fixture.selected, ...sent]);
      } else expect(forward).toBeUndefined();
      expect(await Bun.file(journal.path(key)).text()).toBe(beforeForward);
      expect(existsSync(marker)).toBe(false);
    }
  } finally {
    if (priorConfig === undefined) delete process.env["DORI_CONFIG"];
    else process.env["DORI_CONFIG"] = priorConfig;
    rmSync(dir, { recursive: true, force: true });
  }
}
