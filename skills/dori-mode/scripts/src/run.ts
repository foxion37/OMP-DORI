import type { Exec } from "../../../../src/runtime/exec.ts";
import { HcRuntime } from "../../../../src/runtime/hc/index.ts";
import { HerdrRuntime } from "../../../../src/runtime/herdr/index.ts";
import { Runtimes } from "../../../../src/runtime/registry.ts";
import { type RuntimeChoice, readRuntimeChoice } from "../../../../src/runtime/select.ts";
import type { RuntimeKind, SessionRuntime } from "../../../../src/runtime/types.ts";
import { configPath, type DoriConfig } from "./config.ts";

export type Ran = { readonly code: number; readonly out: string; readonly err: string; readonly spawnFailed?: true };
export type RunOptions = {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly preserveOutput?: boolean;
  readonly env?: Env;
};
export type Runner = (argv: readonly string[], opts?: RunOptions) => Promise<Ran>;

export const run: Runner = async (argv, opts = {}) => {
  let p: ReturnType<typeof Bun.spawn>;
  try {
    p = Bun.spawn([...argv], {
      stdout: "pipe",
      stderr: "pipe",
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.timeoutMs ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" } : {}),
    });
  } catch (e) {
    return { code: 127, out: "", err: e instanceof Error ? e.message : String(e), spawnFailed: true as const };
  }
  const [out, err, code] = await Promise.all([
    new Response(p.stdout as ReadableStream).text(),
    new Response(p.stderr as ReadableStream).text(),
    p.exited,
  ]);
  return {
    code: p.signalCode ? 124 : code,
    out: opts.preserveOutput ? out : out.trim(),
    err: (p.signalCode ? `killed by ${p.signalCode} (timeout)` : err).trim(),
  };
};

/** Repository housekeeping must not inherit another Git invocation's repository or index. */
export const repoGit = (runner: Runner, root: string, argv: readonly string[]): Promise<Ran> =>
  runner(["git", "-C", root, ...argv], {
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      LC_ALL: "C",
    },
  });

export type Clock = { readonly now: () => number; readonly sleep: (ms: number) => Promise<void> };
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) };

export const iso = (clock: Clock): string => new Date(clock.now()).toISOString();

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The runtimes of one process plus the choice that picked the default kind (printed by `dori boot`). A choice that
 * failed (no runtime detected, a bad DORI_RUNTIME) is thrown only where a new session would open, `default`: stored
 * lanes (`for`) and the caller's own session (`selfAny`) still resolve.
 */
export class ChosenRuntimes extends Runtimes {
  readonly choice: RuntimeChoice | undefined;
  readonly failure: Error | undefined;

  constructor(pick: () => RuntimeChoice, make: (kind: RuntimeKind) => SessionRuntime) {
    let choice: RuntimeChoice | undefined;
    let failure: Error | undefined;
    try {
      choice = pick();
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    }
    // Without a choice the selected kind is never read: `default` throws the failure first.
    super(choice?.kind ?? "hc", make);
    this.choice = choice;
    this.failure = failure;
  }

  override get default(): SessionRuntime {
    if (this.failure) throw this.failure;
    return super.default;
  }
}

/** Pass-local adapters, with runtime discovery shared by all calls on the original flow. */
class ScopedRuntimes extends ChosenRuntimes {
  constructor(
    private readonly original: ChosenRuntimes,
    make: (kind: RuntimeKind) => SessionRuntime,
  ) {
    super(
      () => {
        if (original.choice) return original.choice;
        throw original.failure;
      },
      (kind) => {
        original.for({ runtime: kind, id: "" });
        return make(kind);
      },
    );
  }

  override kinds(): readonly RuntimeKind[] {
    return this.original.kinds();
  }
}

/** `DORI_RUNTIME` > the config's `runtime` > the root's detection (inside hc, inside herdr, hc on PATH, else herdr). */
export const runtimeChoice = (config: Pick<DoriConfig, "runtime">, env: Env): RuntimeChoice => {
  const fromEnv = env["DORI_RUNTIME"];
  if (!fromEnv && config.runtime !== undefined) return { kind: config.runtime, source: "config" };
  return readRuntimeChoice({ env, configPath: configPath() });
};

const runtimeFactory = (
  config: Pick<DoriConfig, "runtime"> & Partial<Pick<DoriConfig, "stateDir">>,
  env: Env,
  runner: Runner,
  clock: Clock,
): ((kind: RuntimeKind) => SessionRuntime) => {
  const exec: Exec = async (cmd, argv) => {
    const r = await runner([cmd, ...argv]);
    return { code: r.code, stdout: r.out, stderr: r.err, ...(r.spawnFailed ? { spawnFailed: true as const } : {}) };
  };
  const options = { env, sleep: clock.sleep, ...(config.stateDir === undefined ? {} : { stateDir: config.stateDir }) };
  const make: Record<RuntimeKind, () => SessionRuntime> = {
    // Explicit env owns absence too; undefined would invoke the constructor's process.env default.
    herdr: () => new HerdrRuntime(exec, env["DORI_HERDR_SESSION"] ?? "", options),
    hc: () => new HcRuntime(exec, options),
  };
  return (kind) => make[kind]();
};

/** Every runtime behind the skill's Runner, so tests swap the binaries for a recorder; sleeps go through the clock. */
export const runtimesFor = (
  config: Pick<DoriConfig, "runtime"> & Partial<Pick<DoriConfig, "stateDir">>,
  env: Env,
  runner: Runner = run,
  clock: Clock = realClock,
): ChosenRuntimes => new ChosenRuntimes(() => runtimeChoice(config, env), runtimeFactory(config, env, runner, clock));

const built = new WeakMap<object, ChosenRuntimes>();

/** Injected runtimes are authoritative. A scoped Runner preserves the original choice and runtime discovery order. */
export const runtimesOf = (
  deps: {
    readonly run: Runner;
    readonly clock: Clock;
    readonly config: Pick<DoriConfig, "runtime"> & Partial<Pick<DoriConfig, "stateDir">>;
    readonly rts?: ChosenRuntimes;
    readonly env?: Env;
  },
  scopedRun?: Runner,
): ChosenRuntimes => {
  if (deps.rts) return deps.rts;
  const env = deps.env ?? process.env;
  let rts = built.get(deps);
  if (!rts) {
    rts = runtimesFor(deps.config, env, deps.run, deps.clock);
    built.set(deps, rts);
  }
  return scopedRun ? new ScopedRuntimes(rts, runtimeFactory(deps.config, env, scopedRun, deps.clock)) : rts;
};
