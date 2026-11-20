import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUpdateConfig, ompPart } from "../src/update/load.ts";
import { nativePromptOptions } from "../src/update/native-prompts.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// Native OMP admission applies to argv that starts OMP, including the Linux source launcher's Bun command; an
// external wrapper that only runs OMP later keeps its own contract.
const load = (argv: readonly string[], engine?: "omp" | "external") => {
  const directory = mkdtempSync(join(tmpdir(), "dori-native-source-"));
  directories.push(directory);
  for (const name of ["candidate", "remote", "model-client"]) mkdirSync(join(directory, name), { mode: 0o700 });
  const agent = (name: string) => ({
    name,
    argv: ["omp", "--model", "anthropic/claude-opus-5-5", "-p", "{prompt}"],
    timeoutMs: 1000,
  });
  const path = join(directory, "update.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      target: "dori",
      runtime: "herdr",
      root: join(directory, "updates"),
      remote: join(directory, "remote"),
      ref: "refs/heads/main",
      baseUpstream: "a".repeat(40),
      localSource: join(directory, "candidate"),
      worker: { ...agent("port"), argv, ...(engine === undefined ? {} : { engine }) },
      reviewer: agent("review"),
      provision: [],
      checks: [{ name: "check", argv: ["true"], timeoutMs: 1000 }],
      modelAgentDir: join(directory, "model-client"),
    }),
  );
  return loadUpdateConfig(path);
};

test("the Linux source launcher argv is admitted as native OMP, not as an external wrapper", () => {
  const pkg = "/opt/agent tools/packages/coding-agent/";
  const source = ["bun", "--preload", `${pkg}scripts/omp.ts`, `${pkg}scripts/../src/cli.ts`];
  expect(() => load([...source, "--resume", "session", "{prompt}"])).toThrow();
  // A shell script that names OMP cannot be read: it must opt out explicitly instead of silently losing the guard.
  const shell = ["sh", "-c", 'exec "$0" "$@"', "omp", "--resume", "session", "{prompt}"];
  expect(() => load(shell)).toThrow("cannot read");
  expect(() => load(shell, "external")).not.toThrow();
});

test.each([
  ["env -u NAME", ["env", "-u", "FOO", "omp"]],
  ["env -uNAME", ["/usr/bin/env", "-uFOO", "omp"]],
  ["env --unset NAME", ["env", "--unset", "FOO", "A=1", "omp"]],
  ["env --unset=NAME -i -", ["env", "--unset=FOO", "-i", "-", "A=1", "omp"]],
  ["env -iv -C DIR --", ["A=1", "env", "-iv", "-C", "/tmp", "--", "B=2", "omp"]],
  ["env with a non-shell NAME=VALUE", ["env", "a-b=1", "./x=2", "omp"]],
  ["an abbreviated env --un=NAME", ["env", "--un=FOO", "omp"]],
  ["env -a NAME", ["env", "-a", "omp", "omp"]],
  ["env running env", ["env", "-i", "/usr/bin/env", "-u", "FOO", "A=1", "omp"]],
  ["an assignment between two env", ["env", "A=1", "env", "omp"]],
])("an OMP argv behind %s keeps the native resume guard", (_, command) => {
  expect(() => load([...command, "--resume", "session", "{prompt}"])).toThrow("without session resume");
});

test("native argument checks read the OMP argv, not the env options before it", () => {
  const model = ["--model", "anthropic/claude-opus-5-5"];
  expect(() => load(["env", "-i", "--", "omp", ...model, "{prompt}"])).not.toThrow();
  expect(() => load(["env", "--", "omp", ...model, "--", "{prompt}"])).not.toThrow();
  // The launch-time prompt guard (process.ts nativeLaunch) reads the same part.
  const runtime = mkdtempSync(join(tmpdir(), "dori-native-runtime-"));
  const candidate = mkdtempSync(join(tmpdir(), "dori-native-candidate-"));
  directories.push(runtime, candidate);
  for (const argv of [
    ["env", "-i", "--", "omp", ...model, "{prompt}"],
    ["env", "--", "A=1", "omp", ...model, "--", "{prompt}"],
  ]) {
    expect(() => nativePromptOptions(runtime, candidate, "worker", argv)).toThrow("only immediately before");
    expect(nativePromptOptions(runtime, candidate, "worker", ompPart(argv))).toHaveLength(4);
  }
  // An explicit engine:"omp" CLI behind env is checked after the prefix too.
  const custom = ["env", "-i", "--", "/opt/custom/cli", ...model, "{prompt}"];
  expect(ompPart(custom)).toEqual(custom.slice(3));
});

test.each([
  [
    "env -S with a resume inside the string",
    ["env", "-S", "omp --resume session", "--model", "anthropic/x", "{prompt}"],
  ],
  ["env -S with a quoted command", ["env", "-S", '"omp"', "--resume", "session", "{prompt}"]],
  ["an env option Dori does not know", ["env", "--frobnicate", "omp", "--resume", "session", "{prompt}"]],
])("%s is refused unless the agent is declared an external wrapper", (_, argv) => {
  const refused = 'drop -S and unknown env options, or set worker.engine to "external"';
  expect(() => load(argv)).toThrow(refused);
  expect(() => load(argv, "omp")).toThrow(refused);
  expect(() => load(argv, "external")).not.toThrow();
});

test.each([
  ["Bun preload", ["bun", "--preload", "/hook.ts", "/opt/bin/omp"]],
  ["Bun cwd", ["bun", "--cwd", "/repo", "/opt/bin/omp"]],
  ["Node require", ["node", "--require", "/otel.js", "/opt/@oh-my-pi/pi-coding-agent/dist/cli.js"]],
])("%s cannot silently downgrade native update guards", (_, argv) => {
  const command = [...argv, "--model", "anthropic/claude-opus-5-5", "--resume", "session", "{prompt}"];
  expect(() => load(command)).toThrow("command prefix");
  expect(() => load(command, "omp")).toThrow("command prefix");
  expect(() => load(command, "external")).not.toThrow();
});

test("a directly executed published OMP CLI retains its native session guard", () => {
  expect(() =>
    load([
      "/opt/@oh-my-pi/pi-coding-agent/dist/cli.js",
      "--model",
      "anthropic/claude-opus-5-5",
      "--resume",
      "session",
      "{prompt}",
    ]),
  ).toThrow("without session resume");
});
