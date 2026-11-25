import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOmpAgentCommand } from "../src/harness.ts";
import { classifyOmpArgv, mayRunOmpArgv } from "../src/runtime/omp-argv.ts";
import { loadUpdateConfig } from "../src/update/load.ts";
import { nativeAgent } from "../src/update/native-agent.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const load = (argv: readonly string[], engine?: "omp" | "external", role: "worker" | "reviewer" = "worker") => {
  const directory = mkdtempSync(join(tmpdir(), "cataly-native-launchers-"));
  directories.push(directory);
  for (const name of ["candidate", "remote"]) mkdirSync(join(directory, name), { mode: 0o700 });
  const agent = { argv: ["omp", "--model=anthropic/claude-opus-5-5", "{prompt}"], timeoutMs: 1000 };
  const path = join(directory, "update.json");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      target: "cataly",
      root: join(directory, "updates"),
      remote: join(directory, "remote"),
      ref: "refs/heads/main",
      baseUpstream: "a".repeat(40),
      localSource: join(directory, "candidate"),
      worker: { ...agent, name: "port" },
      reviewer: { ...agent, name: "review" },
      [role]: {
        ...agent,
        name: role === "worker" ? "port" : "review",
        argv,
        ...(engine === undefined ? {} : { engine }),
      },
      checks: [{ name: "check", argv: ["true"], timeoutMs: 1000 }],
    }),
  );
  return loadUpdateConfig(path);
};
const MODEL = "--model=anthropic/claude-opus-5-5";
const PREFIX_REFUSED = 'set worker.engine to "external"';
const pkg = "/opt/native/source/packages/coding-agent/";

// Every launch form the change-before classifier (e829d3c) guarded: each must still refuse a resumed session, either
// through the native guard or as an unreadable prefix, unless the configuration explicitly opts out as external.
test.each([
  ["direct", ["omp"]],
  ["absolute", ["/opt/bin/omp"]],
  ["spaced path", ["/home/user/agent tools/omp"]],
  ["env assignment", ["env", "X=1", "omp"]],
  ["env -u", ["env", "-u", "FOO", "omp"]],
  ["env -i", ["env", "-i", "omp"]],
  ["env -S", ["env", "-S", "omp"]],
  ["env --", ["env", "--", "omp"]],
  ["env -C", ["env", "-C", "/repo", "omp"]],
  ["abbreviated env option", ["env", "--un", "FOO", "omp"]],
  ["nested env", ["env", "X=1", "env", "Y=2", "omp"]],
  ["env inside env options", ["env", "-i", "/usr/bin/env", "-u", "FOO", "A=1", "omp"]],
  ["bun run", ["bun", "run", "/x/omp"]],
  ["bun run with a separate cwd", ["bun", "run", "--cwd", "/repo", "/x/omp"]],
  ["bun run with an attached cwd", ["bun", "run", "--cwd=/repo", "/x/omp"]],
  ["bunx", ["bunx", "--no-install", "--package", "@oh-my-pi/pi-coding-agent", "omp"]],
  ["npx", ["npx", "--no-install", "--package", "@oh-my-pi/pi-coding-agent", "omp"]],
  ["bun x", ["bun", "x", "omp"]],
  ["npx running OMP's package", ["npx", "@oh-my-pi/pi-coding-agent"]],
  ["npx running a pinned OMP package", ["npx", "--yes", "@oh-my-pi/pi-coding-agent@19.0.1"]],
  ["npm exec running OMP's package", ["npm", "exec", "--", "@oh-my-pi/pi-coding-agent"]],
  ["bunx running OMP's package", ["bunx", "@oh-my-pi/pi-coding-agent"]],
  ["npx -c naming OMP", ["npx", "-c", "omp --mode json"]],
  ["the source launcher", ["bun", "--preload", `${pkg}scripts/omp.ts`, `${pkg}scripts/../src/cli.ts`]],
  ["node published CLI", ["node", "/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"]],
  ["bun published CLI", ["bun", "/opt/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"]],
  ["sh -c exec omp", ["sh", "-c", 'exec omp "$@"', "audit"]],
  ["sh -c exec /path/omp", ["sh", "-c", 'exec /opt/bin/omp "$@"', "audit"]],
  ["sh -c with OMP as $0", ["sh", "-c", 'exec "$0" "$@"', "omp"]],
  ["sh -cl exec omp", ["sh", "-cl", 'exec omp "$@"', "audit"]],
  ["sh -c with a quoted OMP path", ["sh", "-c", 'exec "$HOME/bin/omp" "$@"', "audit"]],
  ["sh -c with a quoted bare omp", ["sh", "-c", "exec 'omp' \"$@\"", "audit"]],
  ["sh -c in a loop", ["bash", "-c", 'while true; do omp "$@"; done', "audit"]],
  ["an unreadable launcher before a shell", ["timeout", "--unknown", "600", "sh", "-c", 'exec omp "$@"', "a"]],
  ["the side wrapper", ["omp-cataly", "omp"]],
  ["the side wrapper by path", ["/home/user/.omp-cataly/bin/omp-cataly", "omp"]],
  ["the installed wrapper", ["/home/user/.cataly/bin/omp"]],
  ["node --require separate", ["node", "--require", "/hook.js", "/x/omp"]],
  ["node --require attached", ["node", "--require=/hook.js", "/x/omp"]],
  ["timeout", ["timeout", "-k", "5", "600", "/opt/bin/omp"]],
  ["timeout with an abbreviated option", ["timeout", "--kill", "5", "600", "/opt/bin/omp"]],
  ["timeout with a short cluster", ["timeout", "-vk", "5", "600", "/opt/bin/omp"]],
  ["caffeinate with an attached value", ["caffeinate", "-it600", "omp"]],
  ["npx --call= naming OMP", ["npx", "--call=omp --mode json"]],
  ["nice and nohup", ["nice", "-n", "5", "nohup", "omp"]],
  ["caffeinate", ["caffeinate", "-i", "-t", "3600", "omp"]],
  ["setsid", ["setsid", "-w", "omp"]],
  ["stdbuf", ["stdbuf", "-oL", "omp"]],
])("%s keeps OMP from resuming a session", (_, prefix) => {
  const argv = [...prefix, MODEL, "--resume", "s", "{prompt}"];
  for (const engine of [undefined, "omp"] as const) {
    expect(() => load(argv, engine)).toThrow(/without session resume|cannot read|PID-preserving/);
  }
  const external = load(argv, "external").worker;
  expect(nativeAgent(external)).toBe(false);
});

test.each([
  ["direct", ["omp"]],
  ["env -u", ["env", "-u", "FOO", "omp"]],
  ["nohup", ["nohup", "omp"]],
  ["nice", ["nice", "-n", "5", "omp"]],
  ["stdbuf", ["stdbuf", "-e", "L", "omp"]],
  ["nested env", ["env", "X=1", "env", "Y=2", "omp"]],
  ["the side wrapper", ["omp-cataly", "omp"]],
])("%s is native OMP: it keeps the capability guard and its own arguments", (_, prefix) => {
  for (const engine of [undefined, "omp"] as const) {
    for (const flag of ["-e", "--profile", "--cataly-role"]) {
      expect(() => load([...prefix, MODEL, flag, "untrusted", "{prompt}"], engine)).toThrow("controller-owned");
    }
    const argv = [...prefix, MODEL, "{prompt}"];
    const command = load(argv, engine).worker;
    expect(nativeAgent(command)).toBe(true);
    expect(command.argv).toEqual(argv);
  }
});

test.each([
  ["timeout", ["timeout", "600", "omp"]],
  ["timeout foreground", ["timeout", "--foreground", "600", "omp"]],
  ["timeout with unreadable options", ["timeout", "--unknown", "600", "omp"]],
  ["caffeinate", ["caffeinate", "-i", "-t", "3600", "omp"]],
  ["caffeinate attached options", ["caffeinate", "-it600", "omp"]],
  ["setsid conditional fork", ["setsid", "omp"]],
  ["setsid waiting", ["setsid", "-w", "omp"]],
  ["setsid forced fork", ["setsid", "--fork", "omp"]],
  ["setsid with unreadable options", ["setsid", "--unknown", "omp"]],
  ["bunx", ["bunx", "--package", "@oh-my-pi/pi-coding-agent", "omp"]],
  ["npx", ["npx", "--yes", "omp"]],
  ["bun x", ["bun", "x", "omp"]],
  ["npm exec", ["npm", "exec", "--", "omp"]],
  ["npm x", ["npm", "x", "--", "@oh-my-pi/pi-coding-agent"]],
  ["npm exec without a separator", ["npm", "exec", "@oh-my-pi/pi-coding-agent"]],
  ["npm x without a separator", ["npm", "x", "omp"]],
  ["npx script", ["npx", "-c", 'exec omp "$@"']],
  ["npx unreadable options", ["npx", "--loglevel", "silent", "@oh-my-pi/pi-coding-agent"]],
  ["npm global options", ["npm", "--silent", "exec", "--", "@oh-my-pi/pi-coding-agent"]],
  ["package alias", ["bunx", "agent@npm:@oh-my-pi/pi-coding-agent"]],
  ["pnpm", ["pnpm", "dlx", "@oh-my-pi/pi-coding-agent"]],
  ["pnpx", ["pnpx", "@oh-my-pi/pi-coding-agent"]],
  ["yarn", ["yarn", "dlx", "@oh-my-pi/pi-coding-agent"]],
  ["bun global options", ["bun", "--no-env-file", "x", "@oh-my-pi/pi-coding-agent"]],
  ["nested prefixes", ["nice", "-n", "5", "env", "A=1", "setsid", "omp"]],
])("%s requires a PID-preserving native launch for either role, including explicit engine omp", (_, prefix) => {
  for (const role of ["worker", "reviewer"] as const) {
    for (const flags of [
      [],
      ["--resume", "s"],
      ["-e", "untrusted"],
      ["--profile", "untrusted"],
      ["--cataly-role", "lane"],
    ]) {
      const argv = [...prefix, MODEL, ...flags, "{prompt}"];
      expect(mayRunOmpArgv(argv)).toBe(true);
      for (const engine of [undefined, "omp"] as const) {
        expect(() => load(argv, engine, role)).toThrow("PID-preserving");
      }
      const external = load(argv, "external", role)[role];
      expect(external.argv).toEqual(argv);
      expect(nativeAgent(external)).toBe(false);
    }
  }
});

test.each([
  ["a shell script naming OMP", ["sh", "-c", 'exec omp "$@"', "audit"]],
  ["npx -c naming OMP", ["npx", "-c", "omp --mode json"]],
  ["timeout with an unknown separate option value", ["timeout", "--frobnicate", "5", "600", "omp"]],
  ["an external wrapper behind a launcher", ["nohup", "/opt/wrapper", "/x/omp"]],
  // A script is not parsed: one that mentions omp at all, even in a value or comment, must declare its engine.
  ["a shell running omp after an assignment", ["sh", "-c", 'TERM=x exec omp "$@"', "audit"]],
  ["a shell running omp after a redirection", ["sh", "-c", '2>/dev/null exec omp "$@"', "audit"]],
  ["a shell running omp through a substitution", ["sh", "-c", 'exec "$(command -v omp)" "$@"', "audit"]],
  ["a shell passing another agent a quoted omp value", ["sh", "-c", 'exec codex -c \'x="omp"\' "$@"', "sh"]],
  ["a shell with an omp comment", ["sh", "-c", 'exec codex "$@" # was omp', "audit"]],
  ["a shell given OMP's path by env", ["env", "OMP_BIN=/opt/bin/omp", "sh", "-c", 'exec "$OMP_BIN" "$@"', "a"]],
  ["a shell given OMP's path by an assignment", ["OMP_BIN=/opt/bin/omp", "sh", "-c", 'exec "$OMP_BIN" "$@"', "a"]],
  ["OMP's path given past an unreadable launcher", ["X=/x/omp", "timeout", "--unknown", "codex", "-c", "$X"]],
  ["npx with an option value before OMP's package", ["npx", "--loglevel", "silent", "@oh-my-pi/pi-coding-agent"]],
  ["npm with a global option", ["npm", "--silent", "exec", "--", "@oh-my-pi/pi-coding-agent"]],
  ["an npm: package alias", ["npx", "npm:@oh-my-pi/pi-coding-agent@19.0.1"]],
  ["a named package alias", ["bunx", "agent@npm:@oh-my-pi/pi-coding-agent"]],
  ["pnpm dlx", ["pnpm", "dlx", "@oh-my-pi/pi-coding-agent"]],
  ["yarn dlx", ["yarn", "dlx", "@oh-my-pi/pi-coding-agent"]],
  ["npm exec -c naming OMP", ["npm", "exec", "--offline", "-c", 'exec omp "$@"']],
  ["pnpm exec running omp", ["pnpm", "exec", "omp"]],
  ["yarn exec running an OMP path", ["yarn", "exec", "/x/omp"]],
  ["a bun x package alias", ["bun", "x", "omp-alias@npm:@oh-my-pi/pi-coding-agent@19.0.1"]],
  ["bun x past an option", ["bun", "--no-env-file", "x", "@oh-my-pi/pi-coding-agent"]],
])("%s is refused before launch even when it declares engine omp", (_, prefix) => {
  for (const engine of [undefined, "omp"] as const) {
    expect(() => load([...prefix, MODEL, "{prompt}"], engine)).toThrow(PREFIX_REFUSED);
  }
});

// External commands that do not run OMP keep their own contract, as do wrappers whose arguments merely mention it.
test.each([
  ["a launcher running another agent", ["timeout", "600", "codex"]],
  ["a shell running another agent", ["sh", "-c", "exec codex", "sh"]],
  ["npx -c running another agent", ["npx", "-c", "codex"]],
  ["a shell running a tool whose name contains omp", ["sh", "-c", "exec omp-tools --x", "sh"]],
  ["an agent given a setting whose value is omp", ["env", "PROFILE=omp", "codex"]],
  ["an external script", ["node", "/opt/not-omp.js", "/x/omp"]],
  ["echo", ["echo", "omp"]],
  ["the side wrapper's other commands", ["omp-cataly", "status", "--", "omp"]],
  ["bunx whose cwd value names omp", ["bunx", "--cwd", "/tmp/omp", "--no-install", "echo"]],
  ["npx whose cache value names omp", ["npx", "--offline", "--cache", "/tmp/omp", "--", "/bin/echo"]],
])("%s stays external", (_, prefix) => {
  const argv = [...prefix, MODEL, "--resume", "s", "{prompt}"];
  expect(nativeAgent(load(argv).worker)).toBe(false);
  // The harness gives the OMP role only to OMP: an option value that names omp does not make the command OMP.
  expect(isOmpAgentCommand(prefix.join(" "))).toBe(false);
});

test.each([
  ["an empty command", []],
  ["assignments without a command", ["TASK=1"]],
  ["echo naming a runner and OMP's package", ["echo", "npx", "@oh-my-pi/pi-coding-agent"]],
  ["an external wrapper naming a runner", ["/opt/wrapper", "npx", "@oh-my-pi/pi-coding-agent"]],
  ["an env option operand naming a runner", ["env", "-u", "npm", "codex", "@oh-my-pi/pi-coding-agent"]],
])("%s is not an OMP launch", (_, argv) => {
  expect(classifyOmpArgv(argv).kind).toBe("other");
  expect(mayRunOmpArgv(argv)).toBe(false);
  expect(isOmpAgentCommand(argv.join(" "))).toBe(false);
});
