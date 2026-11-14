import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { hasControl } from "./config.ts";
import type { DeploymentConfig } from "./deployment-types.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const fail = (name: string): never => {
  throw new Error(`invalid promotion.deployment.${name}`);
};
const text = (value: unknown, name: string): string =>
  typeof value === "string" && value.trim() !== "" && !hasControl(value) ? value : fail(name);
const below = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Keep lexical paths stable when liveSource changes from a directory to a release symlink. */
export function parseDeploymentConfig(value: unknown, configDir: string): DeploymentConfig {
  if (!object(value)) return fail("config");
  const required = [
    "releaseRoot",
    "liveSource",
    "home",
    "doriHome",
    "doriConfig",
    "stateDir",
    "bun",
    "omp",
    "herdr",
    "pane",
    "sessionId",
    "model",
    "restartLock",
    "launcherPath",
    "healthTimeoutMs",
  ];
  const allowed = new Set([
    ...required,
    "legacyOmp",
    "stopTimeoutMs",
    "monitorBootstrapFile",
    "quiesceCheckpointFile",
    "shims",
    "herdrSession",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return fail("unknown setting");
  const rawHome = text(value["home"], "home");
  const home =
    rawHome === "~"
      ? homedir()
      : resolve(
          rawHome.startsWith("~/") ? homedir() : configDir,
          rawHome.startsWith("~/") ? rawHome.slice(2) : rawHome,
        );
  const resolvedPath = (raw: unknown, name: string): string => {
    const supplied = text(raw, name);
    return supplied === "~"
      ? home
      : resolve(supplied.startsWith("~/") ? home : configDir, supplied.startsWith("~/") ? supplied.slice(2) : supplied);
  };
  const path = (name: string): string => resolvedPath(value[name], name);
  const ms = (name: string, fallback?: number): number => {
    const n = value[name] === undefined ? fallback : value[name];
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 100 && n <= 600_000 ? n : fail(name);
  };
  const config: DeploymentConfig = {
    releaseRoot: path("releaseRoot"),
    liveSource: path("liveSource"),
    home,
    doriHome: path("doriHome"),
    doriConfig: path("doriConfig"),
    stateDir: path("stateDir"),
    bun: path("bun"),
    omp: path("omp"),
    herdr: path("herdr"),
    pane: text(value["pane"], "pane"),
    sessionId: text(value["sessionId"], "sessionId"),
    model: text(value["model"], "model"),
    restartLock: path("restartLock"),
    launcherPath: path("launcherPath"),
    healthTimeoutMs: ms("healthTimeoutMs"),
    stopTimeoutMs: ms("stopTimeoutMs", 15_000),
    ...(value["legacyOmp"] === undefined ? {} : { legacyOmp: path("legacyOmp") }),
    ...(value["herdrSession"] === undefined ? {} : { herdrSession: text(value["herdrSession"], "herdrSession") }),
    ...(value["monitorBootstrapFile"] === undefined ? {} : { monitorBootstrapFile: path("monitorBootstrapFile") }),
    ...(value["quiesceCheckpointFile"] === undefined ? {} : { quiesceCheckpointFile: path("quiesceCheckpointFile") }),
    shims: [],
  };
  if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/.test(config.pane)) return fail("pane");
  if (!/^[A-Za-z0-9_-]+$/.test(config.sessionId)) return fail("sessionId");
  if (!/^[A-Za-z0-9_.:-]+\/[A-Za-z0-9_.:/-]+$/.test(config.model)) return fail("model");
  if (
    !below(config.home, config.doriHome) ||
    !below(config.home, config.doriConfig) ||
    !below(config.home, config.stateDir)
  )
    return fail("operator paths");
  if (
    config.liveSource === "/" ||
    config.releaseRoot === "/" ||
    config.liveSource === config.releaseRoot ||
    below(config.liveSource, config.releaseRoot) ||
    below(config.releaseRoot, config.liveSource)
  )
    return fail("source paths");
  if (
    config.restartLock === config.liveSource ||
    below(config.liveSource, config.restartLock) ||
    config.launcherPath === config.liveSource ||
    below(config.liveSource, config.launcherPath)
  )
    return fail("runtime paths");
  const raw = value["shims"] ?? [];
  if (!Array.isArray(raw)) return fail("shims");
  const used = new Set([
    config.liveSource,
    config.launcherPath,
    config.restartLock,
    config.doriConfig,
    config.bun,
    config.omp,
    config.herdr,
    ...(config.legacyOmp ? [config.legacyOmp] : []),
    resolve(config.home, ".bun/bin/bun"),
    resolve(config.home, ".bun/bin/omp"),
  ]);
  const shims = raw.map((item): { path: string; source: string } => {
    if (!object(item) || Object.keys(item).some((key) => key !== "path" && key !== "source")) return fail("shims");
    const to = resolvedPath(item["path"], "shims.path");
    const source = text(item["source"], "shims.source");
    if (
      isAbsolute(source) ||
      source === "ref" ||
      source.startsWith("ref/") ||
      (source !== "." && source.split("/").some((part) => part === ".." || part === "." || !part))
    )
      return fail("shims.source");
    if (
      !below(config.home, to) ||
      [...used].some((path) => path === to || below(path, to) || below(to, path)) ||
      to === config.stateDir ||
      below(to, config.stateDir) ||
      below(config.stateDir, to)
    )
      return fail("shims.path");
    used.add(to);
    return { path: to, source };
  });
  return { ...config, shims };
}
