import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../skills/cataly-mode/scripts/src/config.ts";
import { defaultDeps } from "../src/harness.ts";
import { processOmpCommand, resolveProcessOmpCommand } from "../src/release/runtime.ts";
import { actorEnv, managedOmpCommand } from "../src/update/deployment-process.ts";
import { environment, managedCommand } from "./managed-command-setup.ts";

test.each(["not json", "null", "{}", "[]", '["", "arg"]', '["omp", 1]', '"omp"'])(
  "malformed selected argv %s fails both consumers without using legacy shell text",
  async (raw) => {
    const f = managedCommand();
    environment({ CATALY_AGENT_ARGV: raw, CATALY_AGENT_CMD: "touch fallback-ran" });
    expect(() => defaultDeps().agentCmd).toThrow();
    await expect(loadConfig(f.config.catalyConfig, f.config.home)).rejects.toThrow();
    expect(existsSync(join(f.root, "fallback-ran"))).toBe(false);
  },
);

test("managed parent and descendant argv share the fence and exact prepared extension source", () => {
  const f = managedCommand();
  const source = f.toolchain.extensionSource;
  environment({
    CATALY_AGENT_ARGV: '["stale executable", "stale argument"]',
    CATALY_AGENT_CMD: "stale shell command",
    CATALY_AGENT_EXECUTABLE: "retired executable",
  });
  const env = actorEnv(f.config, f.toolchain);
  expect(managedOmpCommand(f.toolchain, source)).toEqual(f.argv);
  expect(JSON.parse(env["CATALY_AGENT_ARGV"]!)).toEqual(f.argv);
  expect(env["CATALY_AGENT_EXECUTABLE"]).toBeUndefined();
  expect(env["CATALY_AGENT_CMD"]).toBeUndefined();
  expect(() => managedOmpCommand(f.toolchain, join(f.root, "different release"))).toThrow(
    "managed extension source differs",
  );
  expect(() => managedOmpCommand(f.toolchain, undefined)).toThrow("managed extension source differs");
  const plain = actorEnv(f.config);
  for (const key of ["CATALY_AGENT_ARGV", "CATALY_AGENT_CMD", "CATALY_AGENT_EXECUTABLE"])
    expect(plain[key]).toBeUndefined();
});

test("selected argv preserves empty argument values and every configured template suffix", () => {
  const f = managedCommand();
  const selected = [...f.argv, "--owner-option", ""];
  environment({ CATALY_AGENT_ARGV: JSON.stringify(selected) });
  expect(processOmpCommand()).toEqual(selected);
  expect(resolveProcessOmpCommand(["omp", "--model", "{model}", "--", "{prompt}"], f.config.catalyConfig)).toEqual([
    ...selected,
    "--model",
    "{model}",
    "--",
    "{prompt}",
  ]);
});
