import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../skills/dori-mode/scripts/src/config.ts";
import { defaultDeps } from "../src/harness.ts";
import { processOmpCommand, resolveProcessOmpCommand } from "../src/release/runtime.ts";
import { actorEnv, managedOmpCommand } from "../src/update/deployment-process.ts";
import { environment, managedCommand } from "./managed-command-setup.ts";

test.each(["not json", "null", "{}", "[]", '["", "arg"]', '["omp", 1]', '"omp"'])(
  "malformed selected argv %s fails both consumers without using legacy shell text",
  async (raw) => {
    const f = managedCommand();
    environment({ DORI_AGENT_ARGV: raw, DORI_AGENT_CMD: "touch fallback-ran" });
    expect(() => defaultDeps().agentCmd).toThrow();
    await expect(loadConfig(f.config.doriConfig, f.config.home)).rejects.toThrow();
    expect(existsSync(join(f.root, "fallback-ran"))).toBe(false);
  },
);

test("managed parent and descendant argv share the fence and exact prepared extension source", () => {
  const f = managedCommand();
  const source = f.toolchain.ompUlw!.source;
  environment({
    DORI_AGENT_ARGV: '["stale executable", "stale argument"]',
    DORI_AGENT_CMD: "stale shell command",
    DORI_AGENT_EXECUTABLE: "retired executable",
    DORI_OMP_ULW_PATH: "stale overlay",
    OMP_ULW_SCOPE_FILE: "process-local scope 'quote'",
  });
  const env = actorEnv(f.config, f.toolchain);
  expect(managedOmpCommand(f.toolchain, source)).toEqual(f.argv);
  expect(JSON.parse(env["DORI_AGENT_ARGV"]!)).toEqual(f.argv);
  expect(env["DORI_AGENT_EXECUTABLE"]).toBeUndefined();
  expect(env["DORI_AGENT_CMD"]).toBeUndefined();
  expect(env["DORI_OMP_ULW_PATH"]).toBe(join(f.toolchain.ompUlw!.directory, "index.ts"));
  expect(env["OMP_ULW_SCOPE_FILE"]).toBe("process-local scope 'quote'");
  expect(() => managedOmpCommand(f.toolchain, join(f.root, "different release"))).toThrow(
    "managed extension source differs",
  );
  expect(() => managedOmpCommand(f.toolchain, undefined)).toThrow("managed extension source differs");
  const legacy = { ...f.toolchain };
  delete legacy.ompUlw;
  expect(managedOmpCommand(legacy, undefined)).toEqual([f.omp, "--config", legacy.nativeConfig]);
  const plain = actorEnv(f.config);
  for (const key of ["DORI_AGENT_ARGV", "DORI_AGENT_CMD", "DORI_AGENT_EXECUTABLE", "DORI_OMP_ULW_PATH"])
    expect(plain[key]).toBeUndefined();
});

test("selected argv preserves empty argument values and every configured template suffix", () => {
  const f = managedCommand();
  const selected = [...f.argv, "--owner-option", ""];
  environment({ DORI_AGENT_ARGV: JSON.stringify(selected) });
  expect(processOmpCommand()).toEqual(selected);
  expect(resolveProcessOmpCommand(["omp", "--model", "{model}", "--", "{prompt}"], f.config.doriConfig)).toEqual([
    ...selected,
    "--model",
    "{model}",
    "--",
    "{prompt}",
  ]);
});
