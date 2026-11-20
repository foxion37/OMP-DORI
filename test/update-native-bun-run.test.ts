import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyOmpArgv } from "../src/runtime/omp-argv.ts";
import { loadUpdateConfig, nativeAgent } from "../src/update/load.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const load = (argv: readonly string[], role: "worker" | "reviewer", engine?: "omp" | "external") => {
  const directory = mkdtempSync(join(tmpdir(), "dori-native-bun-run-"));
  directories.push(directory);
  for (const name of ["candidate", "remote"]) mkdirSync(join(directory, name), { mode: 0o700 });
  const agent = { argv: ["omp", "--model=anthropic/claude-opus-5-5", "{prompt}"], timeoutMs: 1000 };
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
      worker: { ...agent, name: "port" },
      reviewer: { ...agent, name: "review" },
      [role]: { ...agent, name: role, argv, ...(engine === undefined ? {} : { engine }) },
      checks: [{ name: "check", argv: ["true"], timeoutMs: 1000 }],
    }),
  );
  return loadUpdateConfig(path);
};

test.each([
  ["a compiled OMP command", ["bun", "run", "/x/omp"]],
  ["the published OMP entrypoint", ["/usr/bin/bun", "run", "/opt/@oh-my-pi/pi-coding-agent/dist/cli.js"]],
  ["a flag before run", ["bun", "--smol", "run", "/x/omp"]],
  ["a flag after run", ["bun", "run", "--smol", "/x/omp"]],
  ["an attached option value", ["bun", "run", "--preload=/hook.ts", "/x/omp"]],
  ["options on both sides of run", ["bun", "--preload=/hook.ts", "run", "--cwd=/repo", "/x/omp"]],
  ["attached and boolean options", ["bun", "run", "--preload=/hook.ts", "--smol", "/x/omp"]],
])("Bun run with %s retains native admission and the resume guard", (_, prefix) => {
  const argv = [...prefix, "--model=anthropic/claude-opus-5-5", "{prompt}"];
  expect(classifyOmpArgv(argv)).toEqual({ kind: "omp", command: argv });
  const resume = [...argv.slice(0, -1), "--resume", "s", "{prompt}"];
  for (const role of ["worker", "reviewer"] as const) {
    const command = load(argv, role)[role];
    expect(command.argv).toEqual(argv);
    expect(nativeAgent(command)).toBe(true);
    expect(() => load(resume, role)).toThrow("without session resume");
    expect(() => load(resume, role, "omp")).toThrow("without session resume");
  }
});

test.each(["-e", "--profile", "--dori-role"])("Bun run cannot bypass the native %s capability guard", (flag) => {
  const argv = ["bun", "run", "/x/omp", "--model=anthropic/claude-opus-5-5", flag, "untrusted", "{prompt}"];
  for (const role of ["worker", "reviewer"] as const) {
    expect(() => load(argv, role)).toThrow("controller-owned prompt/profile/alias/extension/hook/Dori-role flags");
  }
});

test.each([
  ["a preload operand", ["bun", "run", "--preload", "/hook.ts", "/x/omp"]],
  ["a cwd operand", ["bun", "run", "--cwd", "/repo", "/x/omp"]],
  ["flags before run and a separate operand after it", ["bun", "--smol", "run", "--preload", "/hook.ts", "/x/omp"]],
  ["a separate operand before run", ["bun", "--preload", "/hook.ts", "run", "/x/omp"]],
])("Bun run with %s is refused rather than downgraded to external", (_, prefix) => {
  const argv = [...prefix, "--model=anthropic/claude-opus-5-5", "--resume", "s", "{prompt}"];
  expect(classifyOmpArgv(argv)).toEqual({ kind: "unparsed" });
  for (const role of ["worker", "reviewer"] as const) {
    for (const engine of [undefined, "omp"] as const) {
      expect(() => load(argv, role, engine)).toThrow(
        `attach bun/node option values with = (such as --preload=FILE), drop -S and unknown env options, or set ${role}.engine to "external"`,
      );
    }
  }
});

test("readable env and assignment prefixes still expose Bun run to the native resume guard", () => {
  const argv = [
    "TASK=1",
    "env",
    "-u",
    "FOO",
    "bun",
    "run",
    "--preload=/hook.ts",
    "/x/omp",
    "--model=anthropic/claude-opus-5-5",
    "--resume",
    "s",
    "{prompt}",
  ];
  expect(classifyOmpArgv(argv)).toEqual({ kind: "omp", command: argv.slice(4) });
  for (const role of ["worker", "reviewer"] as const) {
    expect(() => load(argv, role)).toThrow("without session resume");
  }
});

test.each([
  ["a readable Bun run command", ["bun", "run", "/x/omp"]],
  ["an unreadable Bun run prefix", ["bun", "run", "--preload", "/hook.ts", "/x/omp"]],
])("explicit external opt-out retains the wrapper contract for %s", (_, prefix) => {
  const argv = [...prefix, "--model=anthropic/claude-opus-5-5", "--resume", "s", "-e", "/untrusted.ts", "{prompt}"];
  for (const role of ["worker", "reviewer"] as const) {
    const command = load(argv, role, "external")[role];
    expect(command.argv).toEqual(argv);
    expect(command.engine).toBe("external");
    expect(nativeAgent(command)).toBe(false);
  }
});

test.each([
  ["Node's ordinary script named run", ["node", "run", "/x/omp"]],
  ["a Node wrapper", ["node", "/opt/wrapper.js", "/x/omp"]],
  ["a Bun wrapper", ["bun", "/opt/wrapper.ts", "/x/omp"]],
  ["a Bun run wrapper", ["bun", "run", "/opt/wrapper.ts", "/x/omp"]],
  ["another Bun subcommand", ["bun", "install", "/x/omp"]],
  ["an external wrapper", ["/opt/wrapper", "bun", "run", "/x/omp"]],
])("%s is not inferred to execute OMP from its arguments", (_, prefix) => {
  const argv = [...prefix, "--model=anthropic/claude-opus-5-5", "--resume", "s", "{prompt}"];
  expect(classifyOmpArgv(argv)).toEqual({ kind: "other", command: argv });
  for (const role of ["worker", "reviewer"] as const) {
    const command = load(argv, role)[role];
    expect(nativeAgent(command)).toBe(false);
    expect(() => load(argv, role, "omp")).toThrow("without session resume");
  }
});
