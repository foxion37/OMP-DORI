import { homedir } from "node:os";
import { join, sep } from "node:path";
import { resolveConsumerOmpCommand, resolveProcessOmpCommand } from "../../../../src/release/runtime.ts";
import { freshnessError, type FreshnessPolicy } from "./freshness-policy.ts";
import { isSessionRuntime } from "../../../../src/runtime/select.ts";
import type { RuntimeKind, TerminalRuntimeKind } from "../../../../src/runtime/types.ts";
import { type ArtifactRoot, parseArtifactRoots } from "./artifact-config.ts";
import { repoIdentities } from "./config-identities.ts";
import { type DoctorOptions, validDoctorOptions } from "./doctor-config.ts";
import { type LaunchConfig, launchConfig } from "./launch-selection.ts";
import type { QuotaOptions } from "./quota.ts";
import { supervisionOptionsError } from "./supervision-config.ts";
import type { SupervisionOptions } from "./supervision-observe.ts";
import { usageOptionsError } from "./usage-options.ts";
import type { CommitIdentity } from "./verify-pr-check.ts";
import type { VoiceSettings } from "./voice/settings.ts";
import { recallSettingsError, type RecallSettings } from "./messenger/recall-text.ts";
import { checkLanePolicy, type LanePolicy, PolicyError } from "./lane-policy.ts";

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

export type CatalyConfig = LaunchConfig & {
  /** Terminal preference: only "tern". */
  readonly runtime?: TerminalRuntimeKind;
  readonly sessionRuntime?: RuntimeKind;
  readonly laneRuntime?: "headless" | "terminal";
  readonly stateDir: string;
  readonly artifactRoots?: readonly ArtifactRoot[];
  readonly laneWorkspace: string;
  readonly workspaces: readonly string[];
  readonly ignorePanes: readonly string[];
  readonly leadPane: string;
  readonly defaultCwd: string;
  readonly agentCommand: ArgvTemplate;
  readonly defaultModel: string;
  readonly requireModelReadback: boolean;
  readonly goalMarker: string;
  /** How long `launch` waits for the agent's ready status and goal after it starts; a slow host is a host property. */
  readonly startupWaitSeconds: number;
  readonly sessionsDir: string;
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
  readonly quota?: QuotaOptions;
  readonly prAutoTrack: boolean; // opt-in: claim and checkpoint PR links are tracked for `cataly pr watch`
  readonly lanePolicy?: LanePolicy;
  readonly recall?: RecallSettings;
  readonly doctor?: DoctorOptions;
};

export const defaultConfig = (home = homedir()): CatalyConfig => ({
  stateDir: join(home, ".cataly", "state"),
  laneWorkspace: "",
  workspaces: [],
  ignorePanes: [],
  leadPane: "",
  defaultCwd: home,
  agentCommand: ["omp", "--cataly-role", "lane", "--model", "{model}", "{prompt}"],
  defaultModel: "anthropic/claude-opus-5-5",
  requireModelReadback: false,
  ...launchConfig(),
  goalMarker: "Pursuing goal",
  startupWaitSeconds: 180,
  sessionsDir: join(home, ".omp", "agent", "sessions"),
  nudgeAfterMin: 15,
  postAfterMin: 20,
  closeAfterMin: 5,
  heavySlots: 1,
  heavyMaxLoad: 80,
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

export const configPath = (): string => process.env["CATALY_CONFIG"] ?? join(homedir(), ".cataly", "config.json");

export const expandHome = (path: string, home = homedir()): string =>
  path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;

// Enqueue alone needs the spelling before path.join removes `..` after a possible symlink.
const queueCwds = new WeakMap<CatalyConfig, string>();
export const queueDefaultCwd = (config: CatalyConfig): string => queueCwds.get(config) ?? config.defaultCwd;

export class ConfigError extends Error {}

const checkRuntimeSettings = (raw: Readonly<Record<string, unknown>>): void => {
  const { runtime, sessionRuntime } = raw;
  if (runtime !== undefined && runtime !== "tern")
    throw new ConfigError(`invalid runtime: expected "tern", got ${JSON.stringify(runtime)}`);
  if (sessionRuntime !== undefined && !isSessionRuntime(sessionRuntime))
    throw new ConfigError(`invalid sessionRuntime: ${JSON.stringify(sessionRuntime)}`);
};

export const loadConfig = async (path = configPath(), home = homedir(), env = process.env): Promise<CatalyConfig> => {
  const selectedHome = env["CATALY_HOME"];
  const base = {
    ...defaultConfig(home),
    ...(selectedHome && path === join(selectedHome, "config.json") ? { stateDir: join(selectedHome, "state") } : {}),
  };
  const file = Bun.file(path);
  const raw = (await file.exists()) ? ((await file.json()) as Partial<CatalyConfig>) : {};
  checkRuntimeSettings(raw);
  try {
    checkLanePolicy(raw.lanePolicy);
  } catch (error) {
    throw error instanceof PolicyError ? new ConfigError(error.message) : error;
  }
  const laneRuntime = env["CATALY_LANE_RUNTIME"] ?? raw.laneRuntime;
  if (laneRuntime !== undefined && laneRuntime !== "terminal" && laneRuntime !== "headless")
    throw new ConfigError(`invalid laneRuntime: expected "terminal" or "headless", got ${JSON.stringify(laneRuntime)}`);
  const supervisionError = supervisionOptionsError(raw.supervision);
  if (supervisionError) throw new ConfigError(supervisionError);
  if (raw.doctor !== undefined && !validDoctorOptions(raw.doctor))
    throw new ConfigError("invalid doctor: expected an object with an optional ignore array of known check IDs");
  const policyError =
    freshnessError(raw.freshness) ??
    recallSettingsError(raw.recall) ??
    usageOptionsError(raw.supervision?.usage, raw.supervision?.usageArgv, raw.quota);
  if (policyError) throw new ConfigError(policyError);
  if (raw.threadDonePolicy !== undefined && !["every-lane", "last-lane"].includes(raw.threadDonePolicy))
    throw new ConfigError("invalid threadDonePolicy: expected every-lane or last-lane");
  for (const name of ["prAutoTrack", "requireModelReadback"] as const)
    if (raw[name] !== undefined && typeof raw[name] !== "boolean")
      throw new ConfigError(`invalid ${name}: expected true or false`);
  const wait = raw.startupWaitSeconds;
  const merged: CatalyConfig = {
    ...base,
    ...raw,
    ...(laneRuntime === undefined ? {} : { laneRuntime }),
    ...launchConfig(raw.launchKeywords, raw.launchKeywords === undefined ? undefined : path),
    guard: { ...base.guard, ...raw.guard },
    hooks: { ...base.hooks, ...raw.hooks },
    repoIdentities: repoIdentities(raw.repoIdentities),
    // Only a string is a marker: null or false would quietly turn the goal check off, and an object would never show.
    goalMarker: typeof raw.goalMarker === "string" ? raw.goalMarker : base.goalMarker,
    startupWaitSeconds: typeof wait === "number" && wait >= 0 && wait < Infinity ? wait : base.startupWaitSeconds,
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
  const config: CatalyConfig = {
    ...merged,
    agentCommand:
      command === merged.agentCommand || env["CATALY_AGENT_ARGV"] === undefined
        ? resolveConsumerOmpCommand(command, { home })
        : command,
    stateDir: expandHome(env["CATALY_STATE_DIR"] ?? merged.stateDir, home),
    artifactRoots: parseArtifactRoots(raw.artifactRoots, (root) => expandHome(root, home), ConfigError),
    defaultCwd: expandHome(merged.defaultCwd, home),
    sessionsDir: expandHome(merged.sessionsDir, home),
    leadPane: env["CATALY_LEAD_PANE"] ?? merged.leadPane,
  };
  if (merged.defaultCwd.startsWith("~/")) queueCwds.set(config, `${home}${sep}${merged.defaultCwd.slice(2)}`);
  return config;
};
export const fill = (template: ArgvTemplate, values: Readonly<Record<string, string>>): string[] =>
  template.map((part) => part.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole));
