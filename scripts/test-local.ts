/**
 * `bun run test:local [root|skill|ext|all] [bun test args...]`: run the suites the way CI does, after
 * `bun run dev:setup`. Loads target/dev-env.sh, re-executes under the pinned Bun when another Bun started it, rebuilds
 * the native headless host (`cargo build --locked --release --bin cataly`, named by dev-env's
 * CATALY_DISCORD_NATIVE_BIN), sets umask 022 and a fresh private `mktemp -d /tmp/cataly-test-XXXXXX` TMPDIR (removed
 * afterwards), then runs CI's package.json suite scripts. Extra arguments go to `bun test`; file paths are relative to
 * the suite's directory. A checkout from before the omp-ulw removal loses that former fixture (`ref/omp-ulw`) first.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { removeUlwFixture } from "../src/update/ulw-fixture.ts";
import { pinnedBunVersion, requirePosix, runUnderPinnedBun, withPrivateTmp } from "./dev-bun.ts";

// CI runs these package.json scripts: test:ci within `bun run ci`, test:skill and test:extension after it.
const SUITES = { root: "test:ci", skill: "test:skill", ext: "test:extension" } as const;
type Suite = keyof typeof SUITES;
const isSuite = (value: string | undefined): value is Suite => value !== undefined && Object.hasOwn(SUITES, value);

/** Headless lanes, leads and duty run on the native binary; rebuild it so it matches this checkout's Rust sources. */
const buildNativeHost = (root: string, env: Readonly<Record<string, string>>): void => {
  if (env["CATALY_DISCORD_NATIVE_BIN"] !== join(root, "target", "release", "cataly"))
    throw new Error("target/dev-env.sh does not name target/release/cataly; rerun `bun run dev:setup`");
  const build = Bun.spawnSync(["cargo", "build", "--locked", "--release", "--bin", "cataly"], {
    cwd: root,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (build.exitCode !== 0) throw new Error(`cargo build of the native headless host failed (exit ${build.exitCode})`);
};

const ROOT_TEST_DIR = "./test/";

/** The environment target/dev-env.sh produces when a POSIX shell sources it. */
const loadDevEnv = (root: string): Record<string, string> => {
  const file = join(root, "target", "dev-env.sh");
  if (!existsSync(file)) throw new Error("target/dev-env.sh is missing; run `bun run dev:setup` first");
  const result = Bun.spawnSync(["bash", "--noprofile", "--norc", "-c", '. "$1" && env -0', "bash", file], {
    stdout: "pipe",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`sourcing ${file} failed (exit ${result.exitCode})`);
  const env: Record<string, string> = {};
  for (const entry of result.stdout.toString().split("\0")) {
    const at = entry.indexOf("=");
    if (at > 0) env[entry.slice(0, at)] = entry.slice(at + 1);
  }
  return env;
};

/**
 * `bun run <script> args` appends the args to CI's command. The root script's `./test/` would still match every file,
 * and a bare `test/x.test.ts` is a substring filter that also matches copies under target/, so when arguments name
 * existing paths the root suite runs that script's own `bun test` flags with those paths made exact (`./test/x...`).
 */
const suiteCommand = (root: string, suite: Suite, extra: readonly string[]): string[] => {
  const script = SUITES[suite];
  const isPath = (arg: string): boolean => !arg.startsWith("-") && existsSync(resolve(root, arg));
  if (suite !== "root" || !extra.some(isPath)) return [process.execPath, "run", script, ...extra];
  const pkg: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scripts = pkg && typeof pkg === "object" && "scripts" in pkg ? pkg.scripts : undefined;
  const command =
    scripts && typeof scripts === "object" && script in scripts ? Reflect.get(scripts, script) : undefined;
  const tokens = typeof command === "string" ? command.trim().split(/\s+/) : [];
  if (tokens[0] !== "bun" || tokens[1] !== "test" || !tokens.includes(ROOT_TEST_DIR))
    throw new Error(`package.json ${script} is no longer \`bun test ... ${ROOT_TEST_DIR}\`; update test-local.ts`);
  const paths = extra.map((arg) => (isPath(arg) && !isAbsolute(arg) && !arg.startsWith("./") ? `./${arg}` : arg));
  return [process.execPath, ...tokens.slice(1).filter((token) => token !== ROOT_TEST_DIR), ...paths];
};

if (import.meta.main) {
  requirePosix("test:local");
  const root = resolve(import.meta.dir, "..");
  removeUlwFixture(root, (line) => console.log(`test:local: ${line}`));
  const args = process.argv.slice(2);
  const first = args[0];
  const suites: readonly Suite[] = isSuite(first) ? [first] : ["root", "skill", "ext"];
  const extra = isSuite(first) || first === "all" ? args.slice(1) : args;
  const version = pinnedBunVersion(root);
  const env = loadDevEnv(root);
  const bun = Bun.which("bun", { PATH: env["PATH"] ?? "" });
  if (!bun) throw new Error("target/dev-env.sh puts no bun on PATH; rerun `bun run dev:setup`");
  runUnderPinnedBun(version, bun, env);
  process.umask(0o022);
  buildNativeHost(root, env);

  let current: Subprocess | undefined;
  let interrupted: NodeJS.Signals | undefined;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      interrupted = signal;
      current?.kill(signal);
    });
  const failed: Suite[] = [];
  await withPrivateTmp("cataly-test", async (tmp) => {
    console.log(`test:local: bun ${Bun.version}, umask 022, TMPDIR=${tmp}`);
    for (const suite of suites) {
      if (interrupted) break;
      const command = suiteCommand(root, suite, extra);
      console.log(`test:local: ${suite}: ${command.slice(1).join(" ")}`);
      current = Bun.spawn(command, {
        cwd: root,
        env: { ...env, TMPDIR: tmp },
        stdio: ["inherit", "inherit", "inherit"],
      });
      const status = await current.exited;
      current = undefined;
      console.log(`TEST_LOCAL ${suite} ${status === 0 ? "PASS" : `FAIL exit=${status}`}`);
      if (status !== 0) failed.push(suite);
    }
  });
  if (interrupted) process.exit(130);
  if (failed.length) {
    console.log(`TEST_LOCAL_FAIL ${failed.join(" ")}`);
    process.exit(1);
  }
  console.log(`TEST_LOCAL_OK ${suites.join(" ")}`);
}
