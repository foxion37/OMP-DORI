import { homedir } from "node:os";
import { join, sep } from "node:path";
import {
  resolveConsumerOmpCommand,
  resolveConsumerOmpUlwPath,
  resolveProcessOmpCommand,
  resolveProcessOmpUlwPath,
} from "../../../../src/release/runtime.ts";
import { freshnessError, type FreshnessPolicy } from "./freshness-policy.ts";
import type { RuntimeKind } from "../../../../src/runtime/types.ts";
import { repoIdentities } from "./config-identities.ts";
import { type ContextConfig, contextConfig } from "./context-config.ts";
import { type DoctorOptions, validDoctorOptions } from "./doctor-config.ts";
import { type LaunchConfig, launchConfig } from "./launch-selection.ts";
import type { SupervisionOptions } from "./supervision-observe.ts";
import type { CommitIdentity } from "./verify-pr-check.ts";
import type { VoiceSettings } from "./voice/settings.ts";

export type ArgvTemplate = readonly string[];

export type Hooks = {
  readonly threadReply?: ArgvTemplate;
  readonly threadDone?: ArgvTemplate;
  readonly transcribe?: ArgvTemplate;
};

export type GuardThresholds = {
  readonly loadAlert: number;
  readonly loadOk: number;
  readonly memFreeMinPct: number;
  readonly diskFreeMinGb: number;
  readonly panesMax: number;
};

export type DoriConfig = LaunchConfig &
  ContextConfig & {
    /** Where new sessions open; absent = detected (see run.ts runtimeChoice). */
    readonly runtime?: RuntimeKind;
    readonly stateDir: string;
    readonly laneWorkspace: string;
    readonly workspaces: readonly string[];
    readonly ignorePanes: readonly string[];
    readonly leadPane: string;
    readonly defaultCwd: string;
    readonly agentCommand: ArgvTemplate;
    readonly defaultModel: string;
    readonly goalMarker: string;
    /** How long `launch` waits for the agent's ready status and goal after it starts; a slow host is a host property. */
    readonly startupWaitSeconds: number;
    readonly sessionsDir: string;
    readonly ompUlwPath: string;
    readonly freshness?: FreshnessPolicy;
    readonly nudgeAfterMin: number;
    readonly postAfterMin: number;
    readonly closeAfterMin: number;
    readonly heavySlots: number;
    readonly heavyMaxLoad: number;
    readonly deadPanePatterns: readonly string[];
    readonly guard: GuardThresholds;
    readonly hooks: Hooks;
    readonly transcribeMaxBytes: number;
    readonly threadDonePolicy?: "every-lane" | "last-lane";
    /** Disabled unless explicitly enabled; models, channels and prices belong to the operator. */
    readonly voice?: Partial<VoiceSettings>;
    /** Expected Git author and committer per lowercase `owner/repo`, for `verify-pr` and the lane footer. */
    readonly repoIdentities: Readonly<Record<string, CommitIdentity>>;
    readonly supervision: SupervisionOptions;
    readonly prAutoTrack: boolean; // opt-in: claim and checkpoint PR links are tracked for `dori pr watch`
    readonly doctor?: DoctorOptions;
  };

export const defaultConfig = (home = homedir()): DoriConfig => ({
  stateDir: join(home, ".dori", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omp", "--dori-role", "lane", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  ...launchConfig(),
  goalMarker: "Pursuing goal",
  startupWaitSeconds: 180,
  sessionsDir: join(home, ".omp", "agent", "sessions"),
  ompUlwPath: join(home, ".dori", "omp-ulw", "index.ts"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
  ...contextConfig(),
  deadPanePatterns: ["has stopped", "no suitable jobs"],
  guard: { loadAlert: 150, loadOk: 80, memFreeMinPct: 20, diskFreeMinGb: 50, panesMax: 20 },
  hooks: {},
  transcribeMaxBytes: 25 * 1024 * 1024,
  repoIdentities: {},
  supervision: {
    hungAfterMinutes: 20,
    staleAfterMinutes: 20,
    defaults: { wallMinutes: null, tokens: null, costUsd: null },
  },
  prAutoTrack: false,
});

export const configPath = (): string => process.env["DORI_CONFIG"] ?? join(homedir(), ".dori", "config.json");

export const expandHome = (path: string, home = homedir()): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

// Enqueue alone needs the spelling before path.join removes `..` after a possible symlink.
const queueCwds = new WeakMap<DoriConfig, string>();
export const queueDefaultCwd = (config: DoriConfig): string => queueCwds.get(config) ?? config.defaultCwd;

export class ConfigError extends Error {}

const RUNTIMES: Readonly<Record<RuntimeKind, true>> = { herdr: true, hc: true };
const checkRuntime = (value: unknown): void => {
  if (value !== undefined && !(typeof value === "string" && Object.hasOwn(RUNTIMES, value)))
    throw new ConfigError(
      `invalid runtime: expected ${Object.keys(RUNTIMES)
        .map((k) => JSON.stringify(k))
        .join(" or ")}, got ${JSON.stringify(value)}`,
    );
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const SUPERVISION_KEYS = new Set([
  "hungAfterMinutes",
  "staleAfterMinutes",
  "defaults",
  "lanes",
  "usageArgv",
  "recordCostArgv",
  "activityPaths",
  "gitActivity",
]);
const CEILINGS = new Set(["wallMinutes", "tokens", "costUsd"]);
const checkCeilingNames = (where: string, budget: Record<string, unknown>): void => {
  for (const name of Object.keys(budget))
    if (!CEILINGS.has(name))
      throw new ConfigError(
        `invalid supervision ${where}.${name}: unknown ceiling (expected wallMinutes, tokens or costUsd)`,
      );
};

// Refuse malformed supervision settings rather than silently disabling a ceiling.
const checkSupervision = (value: unknown): void => {
  if (value === undefined) return;
  if (!isRecord(value)) throw new ConfigError("invalid supervision: expected an object");
  for (const name of Object.keys(value))
    if (!SUPERVISION_KEYS.has(name)) throw new ConfigError(`invalid supervision ${name}: unknown setting`);
  for (const name of ["defaults", "lanes"] as const)
    if (value[name] !== undefined && !isRecord(value[name]))
      throw new ConfigError(`invalid supervision ${name}: expected an object`);
  if (isRecord(value["defaults"])) checkCeilingNames("defaults", value["defaults"]);
  for (const [key, budget] of Object.entries(isRecord(value["lanes"]) ? value["lanes"] : {})) {
    if (!isRecord(budget)) throw new ConfigError(`invalid supervision lanes.${key}: expected an object`);
    checkCeilingNames(`lanes.${key}`, budget);
  }
  for (const name of ["usageArgv", "recordCostArgv", "activityPaths"] as const) {
    const list = value[name];
    if (list !== undefined && !(Array.isArray(list) && list.every((item) => typeof item === "string"))) {
      throw new ConfigError(`invalid supervision ${name}: expected an array of strings`);
    }
  }
  if (value["gitActivity"] !== undefined && typeof value["gitActivity"] !== "boolean")
    throw new ConfigError("invalid supervision gitActivity: expected true or false");
};

export const loadConfig = async (path = configPath(), home = homedir(), env = process.env): Promise<DoriConfig> => {
  const selectedHome = env["DORI_HOME"];
  const base = {
    ...defaultConfig(home),
    ...(selectedHome && path === join(selectedHome, "config.json")
      ? { stateDir: join(selectedHome, "state"), ompUlwPath: join(selectedHome, "omp-ulw/index.ts") }
      : {}),
  };
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<DoriConfig>) : {};
  checkRuntime(raw.runtime);
  checkSupervision(raw.supervision);
  if (raw.doctor !== undefined && !validDoctorOptions(raw.doctor))
    throw new ConfigError("invalid doctor: expected an object with an optional ignore array of known check IDs");
  const policyError = freshnessError(raw.freshness);
  if (policyError) throw new ConfigError(policyError);
  if (raw.threadDonePolicy !== undefined && !["every-lane", "last-lane"].includes(raw.threadDonePolicy))
    throw new ConfigError("invalid threadDonePolicy: expected every-lane or last-lane");
  if (raw.prAutoTrack !== undefined && typeof raw.prAutoTrack !== "boolean")
    throw new ConfigError("invalid prAutoTrack: expected true or false");
  const merged: DoriConfig = {
    ...base,
    ...raw,
    ...launchConfig(raw.launchKeywords, raw.launchKeywords === undefined ? undefined : path),
    guard: { ...base.guard, ...raw.guard },
    hooks: { ...base.hooks, ...raw.hooks },
    repoIdentities: repoIdentities(raw.repoIdentities),
    // Only a string is a marker: null or false would quietly turn the goal check off, and an object would never show.
    goalMarker: typeof raw.goalMarker === "string" ? raw.goalMarker : base.goalMarker,
    startupWaitSeconds:
      typeof raw.startupWaitSeconds === "number" &&
      Number.isFinite(raw.startupWaitSeconds) &&
      raw.startupWaitSeconds >= 0
        ? raw.startupWaitSeconds
        : base.startupWaitSeconds,
    supervision: {
      ...base.supervision,
      ...raw.supervision,
      defaults: { ...base.supervision.defaults, ...raw.supervision?.defaults },
    },
  };
  for (const [name, value] of Object.entries({
    hungAfterMinutes: merged.supervision.hungAfterMinutes,
    staleAfterMinutes: merged.supervision.staleAfterMinutes,
    ...merged.supervision.defaults,
  })) {
    if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
      throw new ConfigError(`invalid supervision ${name}: expected a nonnegative number or null`);
  }
  for (const [key, budget] of Object.entries(merged.supervision.lanes ?? {})) {
    for (const [name, value] of Object.entries(budget)) {
      if (value != null && (typeof value !== "number" || !Number.isFinite(value) || value < 0))
        throw new ConfigError(`invalid supervision lanes.${key}.${name}: expected a nonnegative number or null`);
    }
  }
  const command = resolveProcessOmpCommand(merged.agentCommand, path, env);
  const config: DoriConfig = {
    ...merged,
    agentCommand:
      command === merged.agentCommand || env["DORI_AGENT_ARGV"] === undefined
        ? resolveConsumerOmpCommand(command, { home })
        : command,
    stateDir: expandHome(env["DORI_STATE_DIR"] ?? merged.stateDir, home),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    ompUlwPath: resolveConsumerOmpUlwPath(resolveProcessOmpUlwPath(expandHome(merged.ompUlwPath, home), home, env), {
      home,
      useDefault: raw.ompUlwPath === undefined,
    }),
    leadPane: env["DORI_LEAD_PANE"] ?? merged.leadPane,
  };
  if (merged.defaultCwd.startsWith("~/")) queueCwds.set(config, `${home}${sep}${merged.defaultCwd.slice(2)}`);
  return config;
};

export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
