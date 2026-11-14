import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { UpdateError } from "./config.ts";
import { digest } from "./source.ts";
import { saveJson } from "./state.ts";
import type { UpdateContext } from "./types.ts";

export type Capability = "model" | "reporter" | "check";

const uid = process.getuid?.() ?? null;

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
    throw new UpdateError("automated runtime directory is not a private owned directory");
  }
}

function ownedLink(path: string, target: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) symlinkSync(target, path, "dir");
  else if (!stat.isSymbolicLink() || (uid !== null && stat.uid !== uid) || readlinkSync(path) !== target) {
    throw new UpdateError("automated runtime alias collision; retained paths require operator inspection");
  }
}

/** Short aliases preserve Unix socket budgets; all actual data and the ownership receipt remain in the job. */
function runtimeAlias(ctx: UpdateContext, target: string, cache: string): string {
  privateDirectory(cache);
  const sharedCache = realpathSync(cache);
  const alias = `/tmp/du-${digest(`${uid}\0${ctx.configHash}\0${target}`).slice(0, 16)}`;
  const ownership = { version: 1, uid, configHash: ctx.configHash, directory: target, alias, cache: sharedCache };
  const receipt = join(target, "runtime-paths.json");
  const recorded = lstatSync(receipt, { throwIfNoEntry: false });
  if (recorded === undefined) {
    if (lstatSync(alias, { throwIfNoEntry: false }) !== undefined) {
      throw new UpdateError("unrecorded automated runtime alias collision; no path was replaced");
    }
    writeFileSync(receipt, `${JSON.stringify(ownership, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  } else if (
    !recorded.isFile() ||
    (uid !== null && recorded.uid !== uid) ||
    (recorded.mode & 0o077) !== 0 ||
    JSON.stringify(JSON.parse(readFileSync(receipt, "utf8"))) !== JSON.stringify(ownership)
  ) {
    throw new UpdateError("automated runtime ownership receipt mismatch; retained paths require operator inspection");
  }
  ownedLink(alias, target);
  if (sharedCache !== join(target, "cache")) ownedLink(join(target, "cache"), sharedCache);
  return alias;
}

/**
 * Every child gets a rebuilt environment: nothing is inherited except PATH and the model/reporter variable NAMES the
 * operator listed. Paths are task-owned; this is environment/path isolation, not an OS sandbox.
 */
export function isolatedEnv(
  ctx: UpdateContext,
  directory: string,
  capability: Capability,
  cache: string = join(directory, "cache"),
): Record<string, string> {
  privateDirectory(directory);
  const target = realpathSync(directory);
  const runtime = runtimeAlias(ctx, target, cache);
  const home = join(runtime, "home");
  const state = join(runtime, "state");
  const sessions = join(runtime, "sessions");
  const agent = join(runtime, "agent");
  const tmp = join(runtime, "tmp");
  for (const name of ["home", "state", "sessions", "agent", "tmp", "config", "data", "run", "harness"]) {
    privateDirectory(join(directory, name));
  }
  const shortCache = join(runtime, "cache");
  const config = join(runtime, "dori.json");
  saveJson(config, { runtime: "herdr", stateDir: state, sessionsDir: sessions, defaultCwd: directory, hooks: {} });
  // OMP 18.18.8 filters these discovery providers before MCP startup; model auth/settings remain referenced.
  saveJson(join(runtime, "omp.json"), {
    update: { auto: false },
    disabledProviders: [
      "native",
      "mcp-json",
      "omp-plugins",
      "agent-plugins",
      "claude",
      "claude-plugins",
      "codex",
      "gemini",
      "opencode",
      "cursor",
      "windsurf",
      "vscode",
    ],
    mcp: { enableProjectConfig: false },
  });
  const env: Record<string, string> = {
    PATH: process.env["PATH"] ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
    TERM: "dumb",
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    XDG_CACHE_HOME: shortCache,
    XDG_CONFIG_HOME: join(runtime, "config"),
    XDG_STATE_HOME: state,
    XDG_DATA_HOME: join(runtime, "data"),
    XDG_RUNTIME_DIR: join(runtime, "run"),
    DORI_CONFIG: config,
    DORI_STATE_DIR: state,
    DORI_HOME: join(runtime, "harness"),
    DORI_RUNTIME: "herdr",
    DORI_TELEMETRY: "0",
    DO_NOT_TRACK: "1",
    PI_CODING_AGENT_DIR: capability === "model" ? (ctx.config.modelAgentDir ?? agent) : agent,
    BUN_INSTALL_CACHE_DIR: join(shortCache, "bun"),
    npm_config_cache: join(shortCache, "npm"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: target,
    GIT_TERMINAL_PROMPT: "0",
  };
  if (capability === "model") {
    // A headless model child must never address (or overwrite records of) the parent's herdr/hc server.
    const namespace = `dori-update-${digest(directory).slice(0, 16)}`;
    env["DORI_HERDR_SESSION"] = namespace;
    env["HC_SESSION"] = namespace;
  }
  const names = capability === "model" ? ctx.config.modelEnv : capability === "reporter" ? ctx.config.reporterEnv : [];
  for (const name of names) {
    const value = process.env[name];
    if (value === undefined || !value) {
      throw new UpdateError(`required ${capability} environment capability ${name} is missing`);
    }
    env[name] = value;
  }
  return env;
}
