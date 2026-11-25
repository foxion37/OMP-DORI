import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { nativeDirectory } from "../../../../src/release/native.ts";
import { readSourceBundleDiagnostic } from "../../../../src/release/source-bundle-diagnostic.ts";
import { doctorCheck } from "../src/doctor.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState } from "./fakes.ts";

let state: TestState;
beforeEach(() => {
  state = withState();
});
afterEach(() => state.done());
const source = resolve(import.meta.dir, "../../../..");
const lock = readSourceBundleDiagnostic(source).lock;
const { nativeVersion } = lock;
if (nativeVersion === undefined) throw new Error("The native fixture lock must declare its version");
const help = "--config <path> --extension <path> --no-extensions --model <id>";
// Windows cannot exec a shebang script directly: run the fake CLI through the same runtime there.
const cli = (path: string, args: readonly string[] = []): readonly string[] =>
  process.platform === "win32" ? [process.execPath, path, ...args] : [path, ...args];
// Bare-name PATH lookups and direct script execution are POSIX-shaped: those scenarios run there only.
const posixExec = test.skipIf(process.platform === "win32");
const executable = (name: string, options: { version?: string; help?: string; failHelp?: boolean } = {}) => {
  const dir = join(state.dir, name);
  mkdirSync(dir);
  const path = join(dir, "omp");
  const calls = join(dir, "calls.jsonl");
  writeFileSync(
    path,
    `#!${process.execPath}
import { appendFileSync } from "node:fs";
const flag = process.argv.at(-1);
appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  argv: process.argv.slice(2), home: process.env.HOME, tmpdir: process.env.TMPDIR,
  token: process.env.CATALY_DISCORD_TOKEN, apiKey: process.env.OPENAI_API_KEY
}) + "\\n");
if (flag === "--version") console.log(${JSON.stringify(options.version ?? nativeVersion)});
else if (flag === "--help") {
  if (${Boolean(options.failHelp)}) process.exit(69);
  console.log(${JSON.stringify(options.help ?? help)});
} else process.exit(70);
`,
    { mode: 0o700 },
  );
  return { dir, path, calls };
};
const inspect = async (agentCommand: readonly string[], path: string) => {
  const deps = depsFor(newWorld(), fakeClock(Date.now()), state.dir, {
    leadPane: "",
    defaultCwd: state.dir,
    sessionsDir: join(state.dir, "sessions"),
    agentCommand,
  });
  const result = await doctorCheck({
    ...deps,
    env: {
      PATH: path,
      HOME: state.dir,
      CATALY_DISCORD_TOKEN: "f68-do-not-forward",
      OPENAI_API_KEY: "f68-do-not-forward",
    },
  });
  const finding = result.findings.find((item) => item.provenance?.startsWith("native-cli "));
  expect(finding).toBeDefined();
  if (!finding) throw new Error("native CLI finding missing");
  return { result, finding };
};

test.each([nativeVersion, `omp/${nativeVersion}`])(
  "doctor names the actual executable and public CLI probe without promoting version %s to live evidence",
  async (version) => {
    const native = executable("native", { version });
    const argv: readonly string[] =
      process.platform === "win32"
        ? cli(native.path, ["--model", "{model}", "{prompt}"])
        : ["omp", "--model", "{model}", "{prompt}"];
    const { finding } = await inspect(argv, native.dir);
    expect(finding.severity).not.toBe("WARN");
    expect(finding.detail).toContain(JSON.stringify(native.path));
    expect(finding.detail).toContain(`nativeVersion=${nativeVersion}`);
    expect(finding.detail).toContain(`expectedRevision=${lock.commit}`);
    expect(finding.detail).toContain("observedRevision=unknown");
    expect(finding.detail).toContain("publicCLI=PASS");
    expect(finding.detail).toContain("not live messenger compatibility");
    const calls = readFileSync(native.calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map((call) => call.argv)).toEqual([["--version"], ["--help"]]);
    for (const call of calls) {
      expect(call.home).not.toBe(state.dir);
      expect(call.tmpdir).toBe(call.home);
      expect(existsSync(call.home)).toBe(false);
      expect(call.token).toBeUndefined();
      expect(call.apiKey).toBeUndefined();
    }
  },
);

test.each([`unrelated/${nativeVersion}`, `${nativeVersion} fallback`, `${nativeVersion}\n1.4.4`])(
  "non-native version output %j does not pass by substring",
  async (version) => {
    const native = executable("non-native-version", { version });
    const { finding } = await inspect(cli(native.path), native.dir);
    expect(finding.severity).toBe("WARN");
    expect(finding.detail).toContain("--version did not return an exact native version");
  },
);

posixExec("a different OMP first on PATH fails at that path instead of falling back", async () => {
  const first = executable("first", { version: "18.19.9" });
  const fallback = executable("fallback");
  const { finding, result } = await inspect(["omp"], `${first.dir}:${fallback.dir}`);
  expect(result.exitCode).toBe(1);
  expect(finding.severity).toBe("WARN");
  expect(finding.detail).toContain(JSON.stringify(first.path));
  expect(finding.detail).toContain("18.19.9");
  expect(finding.detail).toContain("version differs");
  expect(existsSync(fallback.calls)).toBe(false);
});

posixExec("a version-matching SDK shim with no CLI fails its public help probe without fallback", async () => {
  const shim = executable("shim", { failHelp: true });
  const fallback = executable("fallback");
  const { finding } = await inspect(["omp"], `${shim.dir}:${fallback.dir}`);
  expect(finding.severity).toBe("WARN");
  expect(finding.detail).toContain(JSON.stringify(shim.path));
  expect(finding.detail).toContain("--help");
  expect(finding.detail).toContain(`nativeVersion=${nativeVersion}`);
  expect(existsSync(fallback.calls)).toBe(false);
});

test("similar flag spellings do not stand in for a required public feature", async () => {
  const native = executable("missing-feature", { help: help.replace("--config ", "--configuration ") });
  const { finding } = await inspect(cli(native.path), native.dir);
  expect(finding.severity).toBe("WARN");
  expect(finding.detail).toContain(JSON.stringify(native.path));
  expect(finding.detail).toContain("missing public CLI feature: --config");
});

test("an explicit executable is inspected instead of an unrelated PATH entry", async () => {
  const first = executable("first", { version: "18.19.9" });
  const selected = executable("selected");
  const { finding } = await inspect(cli(selected.path), first.dir);
  expect(finding.severity).not.toBe("WARN");
  expect(finding.detail).toContain(JSON.stringify(selected.path));
  expect(existsSync(first.calls)).toBe(false);
});

posixExec("an opaque shell command remains unavailable and is never executed as a probe", async () => {
  const native = executable("opaque");
  const { finding } = await inspect(["sh", "-c", `exec ${JSON.stringify(native.path)}`], "/usr/bin:/bin");
  expect(finding.severity).toBe("WARN");
  expect(finding.detail).toContain("opaque");
  expect(finding.detail).toContain("observedRevision=unknown");
  expect(existsSync(native.calls)).toBe(false);
});

for (const [kind, linked] of [
  ["missing receipt", false],
  ["different pin", false],
  ["missing receipt", true],
  ["different pin", true],
] as const) {
  posixExec(
    `a managed native cache with ${kind} and symlink=${linked} cannot pass through matching CLI metadata`,
    async () => {
      const fake = executable("managed-shim");
      if (linked) {
        const relocated = join(state.dir, "relocated-cache");
        mkdirSync(relocated);
        mkdirSync(join(state.dir, ".cache"));
        symlinkSync(relocated, join(state.dir, ".cache/omp-cataly"), "dir");
      }
      const directory =
        kind === "missing receipt"
          ? nativeDirectory(source, state.dir)
          : join(state.dir, ".cache/omp-cataly", `native-${process.platform}-${process.arch}-${"0".repeat(64)}`);
      mkdirSync(join(directory, "bin"), { recursive: true });
      const selected = join(directory, "bin/omp");
      copyFileSync(fake.path, selected);
      const { finding } = await inspect([selected], fake.dir);
      expect(finding.severity).toBe("WARN");
      expect(finding.detail).toContain(JSON.stringify(selected));
      expect(finding.detail).toContain("managed native source");
      expect(finding.detail).toContain("observedRevision=unknown");
      expect(existsSync(fake.calls)).toBe(false);
    },
  );
}

posixExec("an env prefix cannot be silently resolved using the doctor's different PATH", async () => {
  const scoped = executable("scoped");
  const ambient = executable("ambient");
  const { finding } = await inspect(["env", `PATH=${scoped.dir}`, "omp"], `/usr/bin:/bin:${ambient.dir}`);
  expect(finding.severity).toBe("WARN");
  expect(finding.detail).toContain("environment prefix");
  expect(existsSync(scoped.calls)).toBe(false);
  expect(existsSync(ambient.calls)).toBe(false);
});

test("an absent configured executable is not resolved through the doctor's ambient PATH", async () => {
  const { finding } = await inspect(["omp"], "");
  expect(finding.severity).toBe("WARN");
  expect(finding.detail).toContain("not found");
});
