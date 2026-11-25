import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { review } from "../src/gate.ts";
import { agentCommand, defaultDeps, harnessLaunchEnv } from "../src/harness.ts";
import { ompStateDir } from "../src/runtime/omp.ts";
import { World } from "./fake.ts";

describe("OMP harness launches", () => {
  test("explicit command and role overrides retain their arguments", () => {
    const d = new World().deps();
    expect(agentCommand({ ...d, agentCmd: "custom-agent --model other" }, "lane")).toBe("custom-agent --model other");
    expect(agentCommand({ ...d, agentCmd: "omp --cataly-role=lane --model other" }, "cataly")).toBe(
      "omp --cataly-role=lane --model other",
    );
    expect(agentCommand({ ...d, agentCmd: "omp --cataly-role lane --model other" }, "cataly")).toBe(
      "omp --cataly-role lane --model other",
    );
    expect(agentCommand({ ...d, agentCmd: "/opt/bin/omp --model other" }, "cataly")).toBe(
      "/opt/bin/omp --model other --cataly-role cataly",
    );
    expect(agentCommand({ ...d, agentCmd: "env MODEL=x '/opt/agent tools/omp'" }, "lane")).toBe(
      "env MODEL=x '/opt/agent tools/omp' --cataly-role lane",
    );
    expect(agentCommand({ ...d, agentCmd: "bun /opt/bin/omp --model other" }, "lane")).toBe(
      "bun /opt/bin/omp --model other --cataly-role lane",
    );
    const source =
      "bun --preload '/opt/agent tools/packages/coding-agent/scripts/omp.ts' '/opt/agent tools/packages/coding-agent/scripts/../src/cli.ts'";
    expect(agentCommand({ ...d, agentCmd: source }, "cataly")).toBe(`${source} --cataly-role cataly`);
    const foreign = "bun --preload '/opt/agent tools/packages/coding-agent/scripts/omp.ts' /elsewhere/src/cli.ts";
    expect(agentCommand({ ...d, agentCmd: foreign }, "cataly")).toBe(foreign);
  });

  test("fresh review preserves the configured command prefix and passes model and prompt as literal arguments", async () => {
    const w = new World();
    const d = { ...w.deps(), agentCmd: "omp --model 'configured model'" };
    w.gh = () => ({ code: 0, stdout: JSON.stringify({ headRefOid: "a".repeat(40) }) });
    await review(d, "o/r#7", "selected/model");
    const call = w.calls.find((c) => c.cmd === "env")!;
    const context = [
      ...Object.entries(harnessLaunchEnv(d)).map(([key, value]) => `${key}=${value}`),
      "CATALY_DISCORD_TOKEN=",
      "CATALY_TELEGRAM_TOKEN=",
    ];
    expect(call.argv.slice(0, context.length)).toEqual(context);
    expect(call.argv.slice(context.length, context.length + 8)).toEqual([
      "sh",
      "-c",
      "unset TERN_PANE CATALY_HEADLESS_ID CATALY_HARNESS_ROLE CATALY_MANAGED_STARTUP CATALY_LANE; omp --model 'configured model' --cataly-role lane \"$@\"",
      "cataly-review",
      "-p",
      "--no-session",
      "--model",
      "selected/model",
    ]);
    expect(call.argv[context.length + 8]).toContain("o/r#7");
    expect(d.store.receipt("o/r#7", "a".repeat(40))!.model).toBe("selected/model");
  });

  test("default dependencies select OMP and retain an explicit CATALY_AGENT_CMD", () => {
    const keys = ["CATALY_HOME", "CATALY_AGENT_CMD", "CATALY_AGENT_ARGV", "CATALY_TELEMETRY", "CATALY_CMD"];
    const before = keys.map((key) => process.env[key]);
    process.env["CATALY_HOME"] = realpathSync(mkdtempSync(join(tmpdir(), "cataly-default-")));
    process.env["CATALY_TELEMETRY"] = "0";
    delete process.env["CATALY_AGENT_CMD"];
    delete process.env["CATALY_AGENT_ARGV"];
    delete process.env["CATALY_CMD"];
    try {
      const d = defaultDeps();
      expect(d.agentCmd).toBe("omp");
      expect(agentCommand(d, "cataly")).toBe("omp --cataly-role cataly");
      expect(d.catalyCmd).toContain("bun '");
      expect(d.catalyCmd).toContain(join("src", "cli.ts"));
      writeFileSync(join(d.store.root, ".omp-cataly"), "primary\n");
      expect(defaultDeps().agentCmd).toContain(join(d.store.root, "bin/omp"));
      expect(defaultDeps().agentCmd).not.toBe("omp");
      process.env["CATALY_AGENT_CMD"] = "custom-agent --model x";
      expect(defaultDeps().agentCmd).toBe("custom-agent --model x");
    } finally {
      keys.forEach((key, i) => {
        if (before[i] === undefined) delete process.env[key];
        else process.env[key] = before[i];
      });
    }
  });
});

test("OMP state directory follows config, environment override and home expansion", () => {
  const root = mkdtempSync(join(tmpdir(), "cataly-omp-config-"));
  const config = join(root, "config.json");
  writeFileSync(config, JSON.stringify({ stateDir: "~/synthetic-omp-state" }));
  expect(ompStateDir({ CATALY_CONFIG: config })).toBe(join(homedir(), "synthetic-omp-state"));
  expect(ompStateDir({ CATALY_CONFIG: config, CATALY_STATE_DIR: join(root, "override") })).toBe(join(root, "override"));
  expect(ompStateDir({ CATALY_CONFIG: join(root, "missing.json") })).toBe(join(homedir(), ".cataly", "state"));
});
