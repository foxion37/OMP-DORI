import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { RuntimeKind } from "./types.ts";

export type RuntimeSource = "default" | "env" | "config" | "detect:TERN_PANE" | "detect:path";
export type RuntimeChoice = { readonly kind: RuntimeKind; readonly source: RuntimeSource };
type Settings = { readonly runtime?: unknown; readonly sessionRuntime?: unknown };

/** No runtime could be chosen; the message is the one-line fix. */
export class RuntimeChoiceError extends Error {}
/** A runtime setting that is present but unusable (bad value, unreadable config file). */
export class ConfigError extends Error {}

export const isSessionRuntime = (value: unknown): value is RuntimeKind => value === "headless" || value === "tern";

const isExecutableFile = (path: string): boolean => {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

function configSettings(configPath: string): Settings {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return {};
    throw new ConfigError(`cannot read ${configPath}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${configPath} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new ConfigError(`${configPath} must hold a JSON object`);
  return {
    runtime: "runtime" in parsed ? parsed.runtime : undefined,
    sessionRuntime: "sessionRuntime" in parsed ? parsed.sessionRuntime : undefined,
  };
}

const ternOnPath = (pathVar: string | undefined, exists: (path: string) => boolean): boolean =>
  (pathVar ?? "").split(delimiter).some((dir) => dir !== "" && exists(join(dir, "tern")));

/**
 * Sessions run on headless OMP by default on macOS and Linux. Tern is consulted only when terminal execution was
 * requested (`terminalOnly`), named by `CATALY_RUNTIME` or `sessionRuntime`, or on Windows where the native socket host
 * is unavailable: config `runtime: "tern"`, then an enclosing Tern block (`TERN_PANE`), then `tern` on PATH.
 */
export function readRuntimeChoice(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly configPath: string;
  readonly config?: Settings;
  readonly terminalOnly?: boolean;
  readonly exists?: (path: string) => boolean;
}): RuntimeChoice {
  const { env, configPath } = options;
  const fromEnv = nonEmpty(env["CATALY_RUNTIME"]);
  if (fromEnv !== undefined && !isSessionRuntime(fromEnv))
    throw new ConfigError(`invalid CATALY_RUNTIME: ${JSON.stringify(fromEnv)}`);
  const config = options.config ?? configSettings(configPath);
  if (config.runtime !== undefined && config.runtime !== "tern")
    throw new ConfigError(`${configPath}: "runtime" must be "tern", got ${JSON.stringify(config.runtime)}`);
  const sessionRuntime = config.sessionRuntime;
  if (sessionRuntime !== undefined && !isSessionRuntime(sessionRuntime))
    throw new ConfigError(`${configPath}: invalid sessionRuntime ${JSON.stringify(sessionRuntime)}`);
  if (fromEnv !== undefined && (!options.terminalOnly || fromEnv !== "headless"))
    return { kind: fromEnv, source: "env" };
  if (sessionRuntime !== undefined && (!options.terminalOnly || sessionRuntime !== "headless"))
    return { kind: sessionRuntime, source: "config" };
  if (!options.terminalOnly && process.platform !== "win32") return { kind: "headless", source: "default" };
  if (config.runtime === "tern") return { kind: "tern", source: "config" };
  if (nonEmpty(env["TERN_PANE"]) !== undefined) return { kind: "tern", source: "detect:TERN_PANE" };
  if (ternOnPath(env["PATH"], options.exists ?? isExecutableFile)) return { kind: "tern", source: "detect:path" };
  throw new RuntimeChoiceError(
    `tern is not on PATH: install Tern, or set "runtime": "tern" in ${configPath}, or CATALY_RUNTIME`,
  );
}
