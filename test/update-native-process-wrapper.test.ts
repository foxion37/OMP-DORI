import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOmpAgentCommand } from "../src/harness.ts";
import { classifyOmpArgv, mayRunOmpArgv } from "../src/runtime/omp-argv.ts";
import { nativeAgent } from "../src/update/load.ts";
import { runCommand } from "../src/update/process.ts";
import type { UpdateConfig, UpdateJob } from "../src/update/types.ts";

const MODEL = "--model=fixture/no-provider";
const PACKAGE = "@oh-my-pi/pi-coding-agent";
// POSIX-only: the refused launches spawn through the updater's private 0o700 runtime and POSIX wrappers.
const it = test.skipIf(process.platform === "win32");
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    const ownership = join(directory, "job", "runtime", "000", "runtime-paths.json");
    if (existsSync(ownership)) unlinkSync(JSON.parse(readFileSync(ownership, "utf8")).alias);
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "dori-native-process-wrapper-"));
  directories.push(directory);
  for (const name of ["candidate", "remote", "job"]) mkdirSync(join(directory, name), { mode: 0o700 });
  const agent = { argv: ["omp", MODEL, "{prompt}"], timeoutMs: 1000 };
  const config: UpdateConfig = {
    version: 1,
    target: "dori",
    runtime: "herdr",
    root: join(directory, "updates"),
    remote: join(directory, "remote"),
    ref: "refs/heads/main",
    baseUpstream: "a".repeat(40),
    localSource: join(directory, "candidate"),
    intervalSeconds: 1,
    worker: { ...agent, name: "worker" },
    reviewer: { ...agent, name: "reviewer" },
    provision: [],
    checks: [{ name: "check", argv: ["true"], timeoutMs: 1000 }],
    modelEnv: [],
    reporterEnv: [],
  };
  const at = new Date().toISOString();
  const job: UpdateJob = {
    version: 1,
    id: "a".repeat(64),
    upstream: config.baseUpstream,
    baseUpstream: config.baseUpstream,
    configHash: "b".repeat(64),
    createdAt: at,
    updatedAt: at,
    phase: "verifying",
    candidate: config.localSource,
    directory: join(directory, "job"),
    sourceHash: "c".repeat(64),
    commands: [],
    history: [],
  };
  return { directory, config, job };
}

test.each([["exec"], ["x"]])(
  "npm %s needs -- immediately before the command for exact OMP classification",
  (subcommand) => {
    for (const prefix of [
      ["npm", subcommand, "omp"],
      ["npm", subcommand, PACKAGE],
      ["npm", subcommand, "--package", PACKAGE, "omp"],
      ["npm", subcommand, "omp", "--"],
    ]) {
      const argv = [...prefix, MODEL, "{prompt}"];
      expect(classifyOmpArgv(argv)).toEqual({ kind: "unparsed" });
      expect(mayRunOmpArgv(argv)).toBe(true);
      expect(isOmpAgentCommand(argv.join(" "))).toBe(false);
      expect(nativeAgent({ name: "external", argv, timeoutMs: 1000, engine: "external" })).toBe(false);
    }
  },
);

// These remain readable OMP launches for the harness and lanes, independently of updater PID admission.
test.each([
  ["timeout", ["timeout", "600", "omp"]],
  ["caffeinate", ["caffeinate", "-it600", "omp"]],
  ["setsid", ["setsid", "omp"]],
  ["npx", ["npx", "--yes", "omp"]],
  ["npx package", ["npx", PACKAGE]],
  ["bunx", ["bunx", "--package", PACKAGE, "omp"]],
  ["bun x", ["bun", "x", "omp"]],
  ["npm exec", ["npm", "exec", "--", "omp"]],
  ["npm x", ["npm", "x", "--", PACKAGE]],
])("%s retains exact general OMP classification despite native updater refusal", (_, prefix) => {
  const argv = [...prefix, MODEL, "{prompt}"];
  expect(classifyOmpArgv(argv)).toEqual({ kind: "omp", command: [prefix.at(-1)!, MODEL, "{prompt}"] });
  expect(mayRunOmpArgv(argv)).toBe(true);
  expect(isOmpAgentCommand(argv.join(" "))).toBe(true);
});

test.each([
  ["bun script", ["bun", "/private/custom-native.ts", "x"]],
  ["bun script with flags", ["bun", "--no-env-file", "/private/custom-native.ts", "x"]],
  ["node script", ["node", "/private/custom-native.js", "x"]],
])("%s keeps an explicit native script's x argument as application data", (_, prefix) => {
  for (const name of ["worker", "reviewer"]) {
    expect(nativeAgent({ name, engine: "omp", argv: [...prefix, MODEL, "{prompt}"], timeoutMs: 1000 })).toBe(true);
  }
});

it.each([
  ["timeout", ["timeout", "600", "omp"]],
  ["timeout foreground", ["timeout", "--foreground", "600", "omp"]],
  ["caffeinate", ["caffeinate", "-i", "omp"]],
  ["setsid conditional fork", ["setsid", "omp"]],
  ["setsid forced fork", ["setsid", "--fork", "omp"]],
  ["npx", ["npx", "--yes", "omp"]],
  ["bunx", ["bunx", "--package", PACKAGE, "omp"]],
  ["bun x", ["bun", "x", "omp"]],
  ["npm exec", ["npm", "exec", "--", PACKAGE]],
  ["npm x without --", ["npm", "x", "omp"]],
  ["unreadable npx", ["npx", "--unknown", "setting", PACKAGE]],
  ["npm global options", ["npm", "--silent", "exec", "--", PACKAGE]],
  ["pnpm", ["pnpm", "dlx", PACKAGE]],
  ["pnpx", ["pnpx", PACKAGE]],
  ["yarn", ["yarn", "dlx", PACKAGE]],
  ["bun global options", ["bun", "--no-env-file", "x", PACKAGE]],
  ["nested env", ["env", "A=1", "timeout", "600", "omp"]],
])("%s is refused again at model launch before any process receipt for either role", async (_, prefix) => {
  const f = fixture();
  for (const role of ["worker", "reviewer"] as const) {
    for (const engine of [undefined, "omp"] as const) {
      // A regression may attempt a spawn, but must never reach a real package runner or provider.
      const argv = [join(f.directory, "unavailable", prefix[0]!), ...prefix.slice(1), MODEL, "{prompt}"];
      const command = { ...f.config[role], argv, ...(engine === undefined ? {} : { engine }) };
      const config = { ...f.config, [role]: command };
      await expect(
        runCommand(
          { config, configHash: f.job.configHash, emit: () => {} },
          f.job,
          command,
          { prompt: "probe" },
          "model",
        ),
      ).rejects.toThrow("PID-preserving");
      expect(f.job.commands).toEqual([]);
      expect(existsSync(join(f.job.directory, "logs"))).toBe(false);
      expect(nativeAgent({ ...command, engine: "external" })).toBe(false);
    }
  }
});
