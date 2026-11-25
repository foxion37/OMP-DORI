/**
 * omp-cataly: Cataly mode on omp. Installed in the global extensions directory, so every omp session loads it, but only
 * sessions with a Cataly role change behaviour; every other session runs exactly as without it.
 *
 * - Role: `--cataly-role cataly|lane` is recorded in the session file on session_start and re-read from the session
 *   branch on every session change, so `--resume` keeps it without the flag. Subagents inherit their spawning agent's
 *   role.
 * - Pane state (`{stateDir}/sessions/<pane>.json`, read by the `cataly` CLI): session id, goal status and open tool
 *   approvals of the Cataly/lane session running in a Tern block (TERN_PANE).
 *   Native jobs and approval observations use the existing process-bound record.
 * - Lanes without a goal get omp's `goal` tool so the agent can create its goal from the lane brief.
 * - The Cataly session gets the `monitor` tool (monitor.ts).
 * - Root Cataly/lane agents get compact role guidance on each turn; children do not.
 * - A lane's main agent gets the `cataly_report` tool: `cataly report` for the lane registered to its pane, with evidence
 *   it selects fingerprinted here, including completed tool results on its current branch, which the CLI cannot read.
 * - A lane's main agent on GPT-6.1 Sol is told to carry lane bookkeeping along with real work (lane-bookkeeping.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Checkpoints } from "../skills/cataly-mode/scripts/src/checkpoints.ts";
import { loadConfig } from "../skills/cataly-mode/scripts/src/config";
import { EvidenceError, fileEvidence, novelEvidence } from "../skills/cataly-mode/scripts/src/evidence.ts";
import { runContext } from "../skills/cataly-mode/scripts/src/lane-run.ts";
import type {
  AsyncJobSnapshot,
  ToolApprovalRequestedEvent,
  ToolApprovalResolvedEvent,
} from "@oh-my-pi/pi-coding-agent";
import type { NativeApproval, NativeObservation } from "../src/native-observation.ts";
import {
  type CatalyRole,
  type GoalStatus,
  type ModelReadback,
  type PaneState,
  exactModelIdentity,
  thinkingSuffix,
  paneStatePath,
  readPaneState,
  writePaneState,
} from "../skills/cataly-mode/scripts/src/lane-state";
import { Registry, sameLaneGeneration, sessionOf } from "../skills/cataly-mode/scripts/src/registry.ts";
import { ReportError } from "../skills/cataly-mode/scripts/src/report-events.ts";
import { type ReportKind, Reports, reportLine, reportScope } from "../skills/cataly-mode/scripts/src/reports.ts";
import {
  isCatalyEntry,
  MONITOR_MESSAGE,
  parseCatalyRole,
  recordedRole,
  SESSION_WIRE,
} from "../skills/cataly-mode/scripts/src/session-compat.ts";
import {
  COMPLETION_ENTRY,
  type Completion,
  completionReceipt,
  toolEvidence,
} from "../skills/cataly-mode/scripts/src/tool-evidence.ts";
import { HEADLESS_LAUNCH_MODEL_ENTRY, LAUNCH_MODEL_FLAG } from "../src/runtime/headless-launch-model.ts";
import { laneEntry as headlessEntry } from "../src/runtime/headless-record.ts";
import { selfSession } from "../src/runtime/registry.ts";
import type { MonitorSpec } from "../src/update/deployment-types.ts";
import { bootstrapMonitors, MONITOR_BOOTSTRAP_FLAG, recordedIntake } from "./bootstrap.ts";
import { RuntimeHealthWriter } from "./deployment-health.ts";
import { DiscordAsk, routeFor } from "./discord-ask.ts";
import { type AskLane, automaticDiscordAskRoute, bindAskLane } from "./discord-ask-auto.ts";
import { DiscordLane } from "./discord-lane.ts";
import { HeadAdmissions } from "./head-admission.ts";
import { extensionInstallation } from "./installation.ts";
import { type PromptModel, withLaneBookkeeping } from "./lane-bookkeeping.ts";
import { lanePolicyHook } from "./lane-policy.ts";
import { BATCH_MS, MONITOR_DESCRIPTION, Monitors } from "./monitor";
import { MONITOR_ENTRY, recordedMonitors, recordedMonitorStates, type RecordedMonitor } from "./monitor-state.ts";
import { sameMonitorSpecs } from "../src/update/deployment-monitors.ts";
import { NativeRemote } from "./native-remote.ts";
import { DUTY_INVARIANTS, ROLE_INVARIANTS } from "./role-invariants.ts";
import { bridgePreviousMain } from "./session-bridge.ts";
import {
  bumpAttempts,
  MAX_CONTINUATIONS,
  openOwes,
  recordOwes,
  reminder,
} from "../skills/cataly-mode/scripts/src/owes";
import { monitorPolicy } from "../src/update/monitor-policy.ts";

interface SessionEntry {
  id?: string;
  type: string;
  customType?: string;
  data?: unknown;
  mode?: string;
  /** A `message` entry's native message (toolResult, assistant tool calls); read only by cataly_report evidence. */
  message?: unknown;
  content?: unknown;
}
export interface CatalyContext {
  cwd: string;
  mode: string;
  hasUI?: boolean;
  abort(): void | Promise<void>;
  isIdle?(): boolean;
  hasPendingMessages?(): boolean;
  shutdown?(): void;
  getPendingPlanReview?(): unknown;
  agent: { kind: "main" | "sub"; id: string; parentId?: string };
  model?: PromptModel;
  models?: { resolve(selector: string): PromptModel | undefined; current(): PromptModel | undefined };
  modelRegistry?: {
    getAvailableForProviders(providers: ReadonlySet<string>): PromptModel[];
    isUsingSubscription(model: PromptModel): boolean;
  };
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getBranch(): SessionEntry[];
    getEntries?(): readonly SessionEntry[];
    ensureOnDisk?(): Promise<void>;
    getHeader?(): { parentSession?: string } | null;
  };
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus?(key: string, text: string | undefined): void;
  };
  getAsyncJobSnapshot?(): AsyncJobSnapshot | null;
}
interface Goal {
  objective: string;
  status: string;
}
interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
}
export interface ToolDefinition<Params = Record<string, unknown>> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  defaultInactive?: boolean;
  loadMode?: "essential" | "discoverable";
  execute(
    toolCallId: string,
    params: Params,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: CatalyContext,
  ): Promise<ToolResult>;
}
export interface CommandOptions {
  description?: string;
  handler(args: string, ctx: CatalyContext): Promise<void>;
}
interface Schema {
  optional(): Schema;
  describe(description: string): Schema;
}
type Handler = (event: unknown, ctx: CatalyContext) => unknown;
/** OMP's tool_execution_start/update/end events, read only for the start cwd and background job completions. */
type ToolEvent = {
  toolCallId?: unknown;
  toolName?: unknown;
  partialResult?: unknown;
  result?: unknown;
  isError?: unknown;
};
type ToolFrame = { details?: { async?: { state?: unknown; jobId?: unknown } } } | null | undefined;
export interface CatalyApi {
  zod: {
    object(shape: Record<string, Schema>): Schema;
    string(): Schema;
    number(): Schema;
    array(element: Schema): Schema;
    enum(values: readonly [string, ...string[]]): Schema;
    union(options: readonly Schema[]): Schema;
  };
  setLabel(label: string): void;
  registerFlag(
    name: string,
    options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
  ): void;
  getFlag(name: string): boolean | string | undefined;
  registerCommand(name: string, options: CommandOptions): void;
  registerTool<Params>(tool: ToolDefinition<Params>): void;
  on(
    event: "goal_updated",
    handler: (event: { goal: Goal | null; state?: { enabled?: boolean } }, ctx: CatalyContext) => unknown,
  ): void;
  on(
    event: "tool_approval_requested",
    handler: (event: ToolApprovalRequestedEvent, ctx: CatalyContext) => unknown,
  ): void;
  on(event: "tool_approval_resolved", handler: (event: ToolApprovalResolvedEvent, ctx: CatalyContext) => unknown): void;
  on(event: string, handler: Handler): void;
  appendEntry(customType: string, data?: unknown): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
  ): void;
  sendUserMessage(content: string, options?: { deliverAs?: "aside" | "steer" }): Promise<void>;
  setModel?(model: PromptModel): Promise<boolean>;
  getThinkingLevel?(): string | undefined;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): Promise<void>;
}

const ROLE_FLAG = "cataly-role";
const HARNESS_ROLE_ENTRY = "omp-cataly:harness-role";
const NATIVE_REF_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const RECEIVER_FLAG = "cataly-lane-receiver";
const RECEIVER_ENTRY = "omp-cataly:discord-lane-receiver";
// budget-limited halts the goal until a person raises the budget; unknown statuses must never read as "none",
// which `cataly pause` treats as nothing-to-pause.
const GOAL_STATUS: Record<string, GoalStatus> = {
  active: "active",
  paused: "paused",
  "budget-limited": "blocked",
  complete: "complete",
  dropped: "dropped",
};

const nativeHarnessRole = (): "lead" | "duty" | undefined => {
  const role = process.env.CATALY_HARNESS_ROLE;
  return role === "lead" || role === "duty" ? role : undefined;
};

const nativeHeadlessId = (ctx: CatalyContext): string | undefined => {
  const id = process.env.CATALY_HEADLESS_ID;
  return ctx.mode === "rpc" && ctx.hasUI === true && id && NATIVE_REF_ID.test(id) ? id : undefined;
};

const restrictArchivedLead = (branch: readonly SessionEntry[]): boolean => {
  const entry = branch.findLast((row) => row.type === "custom" && row.customType === HARNESS_ROLE_ENTRY);
  if (!entry) return false;
  const proof = entry.data as { refId?: unknown; role?: unknown } | null | undefined;
  // The newest valid duty receipt restricts a resume; an invalid receipt cannot turn a duty into a lead.
  // Even a valid lead receipt is not evidence of a live native owner.
  return proof?.role !== "lead" || typeof proof.refId !== "string" || !NATIVE_REF_ID.test(proof.refId);
};

const headlessRemoteId = (ctx: CatalyContext, role: CatalyRole | undefined): string | undefined => {
  const id = nativeHeadlessId(ctx);
  if (role === "lane" && id) return `headless:${id}`;
};

const goalOf = (goal: Goal | null | undefined): PaneState["goal"] =>
  goal ? { status: GOAL_STATUS[goal.status] ?? "blocked", objective: goal.objective } : { status: "none" };

const isGoal = (value: unknown): value is Goal =>
  typeof value === "object" &&
  value !== null &&
  "status" in value &&
  typeof value.status === "string" &&
  "objective" in value &&
  typeof value.objective === "string";

/** omp persists goals in `mode_change.data.goal` ("goal" / "goal_paused" carry the goal; any other mode ends it). */
const modeGoal = (entry: SessionEntry | undefined): PaneState["goal"] => {
  if (entry?.mode !== "goal" && entry?.mode !== "goal_paused") return { status: "none" };
  const data =
    typeof entry.data === "object" && entry.data !== null && "goal" in entry.data ? entry.data.goal : undefined;
  return isGoal(data) ? goalOf(data) : { status: "none" };
};

type StartupGoalPause = {
  readonly session: string;
  readonly activeEntry: string | undefined;
  readonly pausedEntry?: string;
  used?: boolean;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const CATALY_REPORT_DESCRIPTION = [
  "Record a lane report in its journal, as `cataly report` does, and return the [REPORT] line to forward to the lead.",
  "Attach the evidence the report rests on: `files` whose current bytes it describes, and `toolCalls`, the ids of",
  "completed, successful tool calls on this session whose results show it (a call that started a background job, once",
  "that job completed successfully). Only evidence not recorded before moves",
  "the lane's evidence clock: rewording a report, repeating it, touching a file or rerunning a call with the same",
  "result does not. Reports, messages and other coordination calls are not evidence. A command needs its recorded",
  "start directory or the host-resolved explicit cwd; select file evidence if that information is unavailable.",
  "For a launched request, tool evidence must come from calls observed in that execution.",
  "Native eval run events omit their execution directory, and async eval frames omit image bytes. Select files",
  "or a direct Bash result for those calls rather than repeating an already completed effect.",
].join(" ");

export default async function ompCataly(pi: CatalyApi): Promise<void> {
  pi.registerFlag(ROLE_FLAG, {
    description: "Run as a Cataly-mode session: cataly (the messenger session) or lane; kept on resume",
    type: "string",
  });
  pi.registerFlag(MONITOR_BOOTSTRAP_FLAG, {
    description: "Private session-bound monitor bootstrap for an explicit managed handoff",
    type: "string",
  });
  pi.registerFlag(RECEIVER_FLAG, {
    description: "Take over an existing separately scoped Discord receiver for this lane",
    type: "boolean",
  });
  pi.registerFlag(LAUNCH_MODEL_FLAG, {
    description: "Require this exact provider/model before accepting a lane launch brief",
    type: "string",
  });
  const installation = extensionInstallation();
  const launchEnv = process.env;

  const launchModelFlag = () => pi.getFlag(LAUNCH_MODEL_FLAG);

  const policy = lanePolicyHook(pi, recordedRole, launchEnv["CATALY_LANE_POLICY"]);
  let archivedLeadRestricted = false;
  const restrictedLead = () => nativeHarnessRole() === "duty" || archivedLeadRestricted;
  const appendRole = (role: CatalyRole): void => pi.appendEntry(SESSION_WIRE.role, role);
  let role: CatalyRole | undefined;
  const isLead = (): boolean => role === "cataly" && !restrictedLead();
  let stateDir: string | undefined;
  let loadError: string | undefined;
  let warned = false;
  let lifecycleRegistered = false;
  /** The session whose monitor bootstrap was rejected: it stays role-less until a session_start bootstraps it again. */
  let rejectedBootstrap: string | undefined;
  let session:
    | {
        id: string;
        agentId: string;
        startedAt: string;
        monitorSpecs?: readonly MonitorSpec[];
        intake?: ReturnType<typeof recordedIntake>;
      }
    | undefined;
  const launchSessionIds = new Set<string>();
  let headlessKickoff: { readonly sessionId: string; providerChecked: boolean; complete: boolean } | undefined;
  const modelReadback = (ctx: CatalyContext): ModelReadback => {
    const selector = launchSessionIds.has(ctx.sessionManager.getSessionId()) ? launchModelFlag() : undefined;
    const requested = typeof selector === "string" ? exactModelIdentity(selector) : null;
    const model = ctx.model;
    const observed = model?.provider ? { provider: model.provider, id: model.id } : null;
    const base = { requested, observed, checkedAt: new Date().toISOString(), source: "native-extension" as const };
    if (!model || !observed || (selector !== undefined && !requested))
      return { ...base, status: "unknown", billing: "unknown" };
    if (!requested) return { ...base, status: "unrequested", billing: "unknown" };
    if (!ctx.modelRegistry) return { ...base, status: "unknown", billing: "unknown" };
    try {
      const billing = ctx.modelRegistry.isUsingSubscription(model) ? "subscription" : "non-subscription";
      const available = ctx.modelRegistry.getAvailableForProviders(new Set([requested.provider.toLowerCase()]));
      const find = (id: string) =>
        available.filter(
          (candidate) =>
            `${candidate.provider}/${candidate.id}`.toLowerCase() === `${requested.provider}/${id}`.toLowerCase(),
        );
      // As in OMP's selector parser, a literal catalog id wins; otherwise a trailing level selects the base model.
      let matches = find(requested.id);
      const suffix = matches.length ? null : thinkingSuffix(requested.id);
      const id = suffix?.base ?? requested.id;
      if (suffix) matches = find(id);
      const thinking = suffix ? { requested: suffix.level, observed: pi.getThinkingLevel?.() ?? null } : undefined;
      const proof = thinking ? { ...base, thinking } : base;
      const selected =
        matches.find((candidate) => candidate.id === id) ?? (matches.length === 1 ? matches[0] : undefined);
      if (!selected) return { ...proof, status: matches.length ? "unknown" : "unavailable", billing };
      const level = thinking?.observed === thinking?.requested;
      return {
        ...proof,
        status:
          observed.provider === selected.provider && observed.id === selected.id && level ? "matched" : "mismatch",
        billing,
      };
    } catch {
      return { ...base, status: "unknown", billing: "unknown" };
    }
  };
  const assertLaunchModel = (ctx: CatalyContext): void => {
    if (ctx.agent.kind !== "main" || launchModelFlag() === undefined) return;
    const id = ctx.sessionManager.getSessionId();
    if (launchSessionIds.size > 0 && !launchSessionIds.has(id)) return;
    if (headlessKickoff?.sessionId === id && headlessKickoff.complete) return;
    const readback = modelReadback(ctx);
    if (role === "lane" && readback.status === "matched") return;
    ctx.abort();
    throw new Error(`STARTUP_MODEL_HOLD: exact launch model ${readback.status}; no automatic substitution`);
  };
  const reportRun = launchEnv["CATALY_LANE_RUN"];
  // These observations belong to the active root session, not to all events running in the same process.
  const callDirs = new Map<string, string | null>();
  const backgroundCalls = new Map<
    string,
    {
      name: string;
      cwd: string;
      job?: string;
      pending: Map<string, { receipt: Completion; leaf: SessionEntry } | null>;
    }
  >();
  let goal: PaneState["goal"] = { status: "none" };
  let startupPause: StartupGoalPause | undefined;
  let agentStatus: "idle" | "working" = "idle";
  let goalToolAdded = false;
  let paneWritten: string | undefined;
  /**
   * Open tool approvals of this process (the session and its subagents), each under its event's session and tool call,
   * so an event of one session never resolves another's approval that reuses the call id.
   */
  const approvals = new Map<string, NativeApproval>();
  const approvalKey = (event: { sessionId: string; toolCallId: string }): string =>
    JSON.stringify([event.sessionId, event.toolCallId]);
  /**
   * The main session's last async job snapshot and when it was read. `jobs` stays null, with the time it was cleared,
   * until the current session's main context is read; a subagent's context reports only its own jobs.
   */
  let observed: Pick<NativeObservation, "jobs" | "observedAt"> = { jobs: null, observedAt: Date.now() };
  const discordApiOverride = installation.env["CATALY_DISCORD_API_BASE"] ?? "";
  const discordAsk = new DiscordAsk(undefined, discordApiOverride);
  const discordLane = new DiscordLane(undefined, discordApiOverride);
  const nativeRemote = new NativeRemote(pi);
  let remoteActivation = 0;
  let evidenceActivation: number | undefined;
  const isCurrentLane = (ctx: CatalyContext): boolean =>
    role === "lane" &&
    evidenceActivation === remoteActivation &&
    ctx.agent.kind === "main" &&
    session?.agentId === ctx.agent.id &&
    session.id === ctx.sessionManager.getSessionId();
  let askLane: AskLane | undefined;
  let ownsDiscordReceiver = false;
  let managedRestorePending = launchEnv.CATALY_MANAGED_STARTUP === "1";
  let headContext: CatalyContext | undefined;
  const admissions = new HeadAdmissions(
    () => {
      const ctx = headContext;
      if (!isLead() || !ctx || !stateDir || typeof process.getuid !== "function") return;
      const manager = ctx.sessionManager;
      const id = manager.getSessionId();
      const file = manager.getSessionFile();
      const { getEntries, ensureOnDisk } = manager;
      if (id !== session?.id || !file || !getEntries || !ensureOnDisk) return;
      return {
        id,
        file,
        entries: () => getEntries.call(manager),
        async ensureOnDisk() {
          await ensureOnDisk.call(manager);
          if (headContext !== ctx || manager.getSessionId() !== id || manager.getSessionFile() !== file)
            throw new Error("native admission head changed during persistence");
        },
      };
    },
    (details) => pi.appendEntry(SESSION_WIRE.admissionRejected, details),
    (pending, unresolved) => {
      headContext?.ui.setStatus?.(
        "cataly-head-admission",
        pending ? `${pending} inbound item(s) awaiting native receipt` : undefined,
      );
      if (unresolved)
        headContext?.ui.notify(
          `Native admission for ${unresolved} is unconfirmed. Intake state was retained; inspect the original receipt before recovery.`,
          "warning",
        );
    },
  );
  const monitors = new Monitors(
    async (content, delivery) => {
      const root = stateDir;
      if (!delivery.isCurrent()) return;
      // Commit the obligation before admission; a native receipt is only proof of the aside, not authority.
      if (isLead() && root !== undefined) await recordOwes(root, content, Date.now(), delivery.signal);
      if (delivery.isCurrent())
        pi.sendMessage(
          {
            customType: MONITOR_MESSAGE,
            content,
            display: true,
            ...(delivery.details === undefined ? {} : { details: delivery.details }),
          },
          { triggerTurn: delivery.wake, deliverAs: delivery.wake ? "aside" : "nextTurn" },
        );
    },
    () => (isLead() ? session?.id : undefined),
    BATCH_MS,
    typeof process.getuid === "function" ? admissions : undefined,
    installation.env,
    () => stateDir,
  );
  const runtimeHealth = new RuntimeHealthWriter(monitors);

  // Only remove a live record this process wrote. Inactive pointers are handled separately on plain TUI takeover.
  const removePane = (): void => {
    runtimeHealth.stop();
    if (
      paneWritten !== undefined &&
      stateDir !== undefined &&
      readPaneState(stateDir, paneWritten)?.pid === process.pid
    ) {
      rmSync(paneStatePath(stateDir, paneWritten), { force: true });
    }
    paneWritten = undefined;
  };

  // Preserve session identity for a later resume without attesting a live pane owner or its last native observation.
  const retirePane = (): void => {
    runtimeHealth.stop();
    if (paneWritten === undefined || stateDir === undefined) return;
    const state = readPaneState(stateDir, paneWritten);
    if (state !== null && state.pid === process.pid) {
      const { native: _native, ...kept } = state;
      writePaneState(stateDir, {
        ...kept,
        pid: 0,
        agentStatus: "idle",
        approvalPending: false,
        updatedAt: new Date().toISOString(),
      });
    }
    paneWritten = undefined;
  };

  /**
   * Only the process that owns the pane reports it. `TERN_PANE` is inherited by every child, so a nested `omp` run (a
   * `-p` check, a subagent's own session) would otherwise take the pane record of
   * the live session above it and delete that record on its own shutdown — which reads to the watchdog as a dead
   * lead, so it restarts the lead every tick. An incumbent that is still alive, and not a newer process reusing its
   * pid, keeps its record.
   */
  const paneHeldByAnother = (paneId: string): boolean => {
    if (stateDir === undefined) return false;
    const existing = readPaneState(stateDir, paneId);
    if (existing === null || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || existing.pid === process.pid)
      return false;
    try {
      process.kill(existing.pid, 0);
    } catch (error) {
      // EPERM still identifies a live owner. Dead processes and invalid pid arguments do not own this pane.
      if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    }
    // A start observed later than the session cannot own it. lstart resolves seconds, not same-second PID reuse.
    // An unreadable start time keeps the incumbent's protection.
    const ps = spawnSync("ps", ["-o", "lstart=", "-p", String(existing.pid)], {
      encoding: "utf8",
      // lstart has no offset; its ps producer and Date.parse observer must use the same zone.
      env: { ...process.env, LC_ALL: "C", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone },
      timeout: 1_000,
    });
    const started = Date.parse(ps.stdout?.trim() ?? "");
    return !(ps.status === 0 && Number.isFinite(started) && started > Date.parse(existing.startedAt));
  };

  /**
   * Reads the current session's job snapshot through its main context; returns whether its jobs differ from the last
   * read. Any other context (a subagent, a session that is not the current one) is not read: its snapshot is not the
   * main session's jobs.
   */
  const observeJobs = (ctx: CatalyContext): boolean => {
    if (ctx.agent.kind !== "main" || session === undefined || ctx.sessionManager.getSessionId() !== session.id)
      return false;
    const snapshot = ctx.getAsyncJobSnapshot?.() ?? null;
    const jobs = snapshot && {
      running: snapshot.running.map((job) => ({ id: job.id, startTime: job.startTime })),
      recent: snapshot.recent.map((job) => ({
        id: job.id,
        startTime: job.startTime,
        status: job.status,
        ...(job.endTime === undefined ? {} : { endTime: job.endTime }),
      })),
    };
    const changed = JSON.stringify(jobs) !== JSON.stringify(observed.jobs);
    observed = { jobs, observedAt: Date.now() };
    return changed;
  };

  const savePane = (ctx: CatalyContext, read = true): void => {
    // Do not advertise a retired duty TUI to consumers of the lead/lane pane ABI.
    if (role === "cataly" && !isLead()) {
      removePane();
      return;
    }
    const nativeId = nativeHeadlessId(ctx);
    if (nativeId && stateDir !== undefined && session) {
      if (role === "cataly" && nativeHarnessRole() === "lead" && ctx.sessionManager.getSessionId() === session.id) {
        const entry = headlessEntry(stateDir, { runtime: "headless", id: nativeId });
        if (entry?.reservation.role === "lead")
          runtimeHealth.update({
            stateDir,
            paneId: nativeId,
            role,
            sessionId: session.id,
            startedAt: entry.reservation.startedAt,
            wanted: recordedMonitors(ctx.sessionManager.getBranch()),
            configLoaded: loadError === undefined,
          });
        else runtimeHealth.stop();
      } else runtimeHealth.stop();
      return;
    }
    const paneId = process.env.TERN_PANE;
    if (!paneId || stateDir === undefined || !session) return;
    // Only an interactive session taking over the pane clears an inactive resume pointer. Print/RPC children
    // inherit pane ids too, but do not own the terminal. A record another live process owns stays untouched.
    if (!role) {
      removePane();
      // A globally discovered extension must not clear another installation's resume pointer before a role is known.
      if (installation.ordinaryPaneRoot && ctx.mode === "tui" && !paneHeldByAnother(paneId))
        rmSync(paneStatePath(stateDir, paneId), { force: true });
      return;
    }
    if (paneHeldByAnother(paneId)) return;
    if (read) observeJobs(ctx);
    const sessionFile = ctx.sessionManager.getSessionFile();
    let discordReceiver: PaneState["discordLaneReceiver"];
    if (role === "lane" && ownsDiscordReceiver) {
      try {
        const route = routeFor(stateDir, session.id);
        if (route && route.receiverStateDir !== stateDir)
          discordReceiver = { channel: route.channel, stateDir: route.receiverStateDir };
      } catch {
        // Invalid explicit routes do not advertise ownership or start intake.
      }
    }
    writePaneState(stateDir, {
      paneId,
      role,
      sessionId: session.id,
      ...(sessionFile ? { sessionFile } : {}),
      ...(role === "lane" && askLane ? { discordLaneKey: askLane.key } : {}),
      ...(role === "lane" && ctx.mode === "tui" && !ownsDiscordReceiver ? { discordLaneInbox: true } : {}),
      ...(discordReceiver ? { discordLaneReceiver: discordReceiver } : {}),
      cwd: ctx.cwd,
      pid: process.pid,
      startedAt: session.startedAt,
      updatedAt: new Date().toISOString(),
      goal,
      agentStatus,
      approvalPending: approvals.size > 0,
      modelReadback: modelReadback(ctx),
      native: { observedAt: observed.observedAt, jobs: observed.jobs, approvals: [...approvals.values()] },
    });
    if (role === "cataly")
      runtimeHealth.update({
        stateDir,
        paneId,
        role,
        sessionId: session.id,
        startedAt: session.startedAt,
        wanted: recordedMonitors(ctx.sessionManager.getBranch()),
        configLoaded: loadError === undefined,
      });
    else runtimeHealth.stop();
    paneWritten = paneId;
  };

  // Cache desired intent for /new; boot reads the same mirror without opening private session transcripts.
  const saveMonitorSpecs = (specs: ReadonlyMap<string, MonitorSpec>, branch: readonly SessionEntry[]): void => {
    if (!session) return;
    session.monitorSpecs = [...specs.values()];
    session.intake = recordedIntake(branch);
    if (!stateDir) return;
    const dir = join(stateDir, "monitors");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `${encodeURIComponent(session.id)}.json`);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(
      tmp,
      JSON.stringify(
        {
          version: session.monitorSpecs.some((spec) => spec.mode === "daemon" || spec.silentAfterMin !== undefined)
            ? 3
            : session.monitorSpecs.some((spec) => spec.mode === "once")
              ? 2
              : 1,
          sessionId: session.id,
          monitors: session.monitorSpecs,
          intake: session.intake,
        },
        null,
        2,
      ),
      {
        mode: 0o600,
      },
    );
    renameSync(tmp, path);
  };

  const startMonitor = (record: RecordedMonitor, ctx: CatalyContext) => {
    const { spec, id } = record;
    const owner = ctx.sessionManager.getSessionId();
    return monitors.start(spec.name, spec.argv, spec.filter, spec.cwd, owner, {
      ...monitorPolicy(spec),
      ...(spec.mode === "daemon" ? { restartAttempt: record.exit?.restartAttempt ?? 0 } : {}),
      ...(id ? { recordId: id } : {}),
      async onExit(exit) {
        const owns = () => isLead() && session?.id === owner && ctx.sessionManager.getSessionId() === owner;
        if (!owns()) return false;
        const state = () => recordedMonitorStates(ctx.sessionManager.getBranch()).get(spec.name);
        const current = state();
        if (!current || current.id !== id || current.completed || !sameMonitorSpecs([current.spec], [spec]))
          return false;
        const completed =
          (spec.mode === "once" && exit.code === 0 && exit.signal === null && exit.error === undefined) ||
          (spec.mode === "daemon" && exit.exhausted === true);
        if (completed && ctx.sessionManager.getSessionFile() && !ctx.sessionManager.ensureOnDisk)
          throw new Error("native monitor journal persistence is unavailable");
        pi.appendEntry(MONITOR_ENTRY, { op: completed ? "stop" : "exit", name: spec.name, id, exit });
        await ctx.sessionManager.ensureOnDisk?.();
        if (!owns()) return false;
        const persisted = state();
        if (
          !persisted ||
          persisted.id !== id ||
          persisted.exit?.at !== exit.at ||
          !sameMonitorSpecs([persisted.spec], [spec])
        )
          return false;
        const branch = ctx.sessionManager.getBranch();
        saveMonitorSpecs(recordedMonitors(branch), branch);
        savePane(ctx);
      },
    });
  };

  const syncTools = async (): Promise<void> => {
    const active = pi.getActiveTools();
    const next = new Set(active);
    if (isLead()) next.add("monitor");
    else next.delete("monitor");
    if (role === "lane") next.add("cataly_report");
    else next.delete("cataly_report");
    // A session with its own goal keeps whatever omp decided. omp does not take the tool back when the session
    // changes, so ours is removed from any later goal-less session that is not a lane.
    if (goal.status === "none" && role === "lane") {
      if (!next.has("goal")) goalToolAdded = true;
      next.add("goal");
    } else if (goal.status === "none" && goalToolAdded) {
      next.delete("goal");
      goalToolAdded = false;
    }
    if (next.size !== active.length || active.some((name) => !next.has(name))) await pi.setActiveTools([...next]);
  };

  // Registered only once a role session appears: approval handlers make omp emit approval events and disable read
  // speculation for the whole process, which ordinary sessions must not pay for.
  const registerLifecycle = (): void => {
    lifecycleRegistered = true;
    pi.on("tool_approval_requested", (event, ctx) => {
      if (!role) return;
      const id = ctx.sessionManager.getSessionId();
      const receipt = { ...event, sessionId: event.sessionId ?? id };
      approvals.set(approvalKey(receipt), {
        sessionId: receipt.sessionId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
      });
      if (ctx.agent.kind === "main" && id === session?.id && receipt.sessionId === id)
        nativeRemote.event("tool_approval_requested", event, ctx);
      savePane(ctx);
    });
    pi.on("tool_approval_resolved", (event, ctx) => {
      if (!role) return;
      const id = ctx.sessionManager.getSessionId();
      const receipt = { ...event, sessionId: event.sessionId ?? id };
      if (!approvals.delete(approvalKey(receipt))) return;
      if (ctx.agent.kind === "main" && id === session?.id && receipt.sessionId === id)
        nativeRemote.event("tool_approval_resolved", event, ctx);
      savePane(ctx);
    });
    for (const event of ["session_before_switch", "session_before_branch", "session_before_tree"] as const)
      pi.on(event, (_event, ctx) => nativeRemote.beforeTransition(ctx));
    for (const event of [
      "message_end",
      "turn_start",
      "turn_end",
      "tool_execution_start",
      "tool_execution_end",
      "plan_review_requested",
      "plan_review_resolved",
    ] as const)
      pi.on(event, (payload, ctx) => nativeRemote.event(event, payload, ctx));
    pi.on("message_end", (event, ctx) => {
      if (
        isLead() &&
        headContext &&
        ctx.agent.kind === "main" &&
        ctx.agent.id === headContext.agent.id &&
        ctx.sessionManager.getSessionId() === session?.id
      )
        return admissions.messageEnded(event);
    });
    // The awaited preflight runs before the built-in opens its form; execution events can arrive later.
    pi.on("tool_call", (event, ctx) => {
      // A changed job set is recorded before the call runs, so a command it starts reads the jobs as of this call.
      if (role && observeJobs(ctx)) savePane(ctx, false);
      const id = ctx.sessionManager.getSessionId();
      const root = stateDir;
      const currentRole = role;
      if (
        root &&
        currentRole &&
        (currentRole === "lane" || isLead()) &&
        ctx.agent.kind === "main" &&
        id === session?.id &&
        approvals.size === 0 &&
        !headlessRemoteId(ctx, currentRole)
      )
        return discordAsk.arm(event, ctx.ui, root, id, async () => {
          const route = await automaticDiscordAskRoute(root, currentRole, id, askLane, installation.env);
          return approvals.size === 0 ? route : undefined;
        });
    });
    pi.on("tool_execution_end", (event) => discordAsk.finish(event));
    pi.on("session_shutdown", (_event, ctx) => {
      if (ctx.agent.kind === "main") {
        if (role === "lane") discordLane.retire?.(goal.status);
        remoteActivation++;
        backgroundCalls.clear();
        callDirs.clear();
        nativeRemote.stop();
        headContext?.ui.setStatus?.("cataly-head-admission", undefined);
        headContext = undefined;
      }
      discordLane.stop();
      discordAsk.clear();
      monitors.stopAll();
      retirePane();
    });
    // A terminal frame can precede the returned job ID. Keep only its fingerprint/refusal pending that binding.
    pi.on("tool_execution_update", (event, ctx) => {
      const { toolCallId, toolName, partialResult } = event as ToolEvent;
      if (!isCurrentLane(ctx) || typeof toolCallId !== "string") return;
      const started = backgroundCalls.get(toolCallId);
      const job = (partialResult as ToolFrame)?.details?.async;
      if (!started || started.name !== toolName || typeof job?.jobId !== "string" || job.jobId === "") return;
      if (job.state !== "completed" && job.state !== "failed" && job.state !== "cancelled") return;
      if (started.job !== undefined && started.job !== job.jobId) return;
      const branch = ctx.sessionManager.getBranch();
      const receipt = completionReceipt(branch, toolCallId, toolName, partialResult, started.cwd);
      if (started.job === undefined) {
        const leaf = branch.at(-1);
        if (!started.pending.has(job.jobId)) started.pending.set(job.jobId, receipt && leaf ? { receipt, leaf } : null);
        return;
      }
      backgroundCalls.delete(toolCallId);
      if (receipt) pi.appendEntry(COMPLETION_ENTRY, receipt);
    });
    pi.on("tool_execution_start", (event, ctx) => {
      const { toolCallId, toolName } = event as ToolEvent;
      if (!isCurrentLane(ctx) || typeof toolCallId !== "string" || typeof toolName !== "string") return;
      if (callDirs.has(toolCallId)) {
        // The native branch cannot disambiguate repeated IDs within the same session.
        callDirs.set(toolCallId, null);
        backgroundCalls.delete(toolCallId);
        return;
      }
      callDirs.set(toolCallId, ctx.cwd);
      backgroundCalls.set(toolCallId, { name: toolName, cwd: ctx.cwd, pending: new Map() });
    });
    pi.on("tool_execution_end", (event, ctx) => {
      const { toolCallId, toolName, result, isError } = event as ToolEvent;
      if (!isCurrentLane(ctx) || typeof toolCallId !== "string") return;
      const started = backgroundCalls.get(toolCallId);
      if (!started || started.name !== toolName || started.job !== undefined) return;
      const job = (result as ToolFrame)?.details?.async;
      if (isError === true || job?.state !== "running" || typeof job.jobId !== "string" || job.jobId === "") {
        backgroundCalls.delete(toolCallId);
        return;
      }
      if (started.pending.has(job.jobId)) {
        const pending = started.pending.get(job.jobId);
        backgroundCalls.delete(toolCallId);
        if (pending && ctx.sessionManager.getBranch().includes(pending.leaf))
          pi.appendEntry(COMPLETION_ENTRY, pending.receipt);
        return;
      }
      started.job = job.jobId;
      started.pending.clear();
    });
  };

  const syncRemote = async (ctx: CatalyContext, activation: number): Promise<void> => {
    if (activation !== remoteActivation) return;
    const root = stateDir;
    const owner = session;
    const ownerRole = role;
    const paneId = process.env.TERN_PANE;
    const headless = headlessRemoteId(ctx, ownerRole);
    if (
      !root ||
      !owner ||
      !ownerRole ||
      (ownerRole === "cataly" && !isLead()) ||
      ctx.sessionManager.getSessionId() !== owner.id ||
      typeof process.getuid !== "function" ||
      (ctx.mode !== "tui" && !headless)
    ) {
      nativeRemote.stop();
      return;
    }
    const owns = () => {
      if (remoteActivation !== activation || session !== owner || role !== ownerRole) return false;
      if (headless || !paneId) return true;
      const pane = readPaneState(root, paneId);
      return (
        pane?.pid === process.pid &&
        pane.sessionId === owner.id &&
        pane.role === ownerRole &&
        pane.startedAt === owner.startedAt
      );
    };
    if (!owns()) {
      nativeRemote.stop();
      return;
    }
    await nativeRemote.activate({
      stateDir: root,
      ctx,
      role: ownerRole,
      pane: headless ?? paneId,
      owns,
      approvalPending: () => approvals.size > 0,
      busy: () => agentStatus === "working",
      goal: () => goal.status,
    });
  };

  const syncMain = async (ctx: CatalyContext, branch: readonly SessionEntry[], bootstrap = false): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const initialStart = bootstrap && session === undefined;
    startupPause = undefined;
    // Monitors belong to the Cataly session that started them; their lines must not wake whatever session comes next.
    discordLane.stop();
    if (session?.id !== sessionId || !role) discordAsk.clear();
    if (session?.id !== sessionId || !isLead()) monitors.stopAll();
    if (session?.id !== sessionId || session.agentId !== ctx.agent.id) {
      session = { id: sessionId, agentId: ctx.agent.id, startedAt: new Date().toISOString() };
      approvals.clear();
      backgroundCalls.clear();
      callDirs.clear();
      observed = { jobs: null, observedAt: Date.now() };
      agentStatus = "idle";
    }
    if (role && !lifecycleRegistered) registerLifecycle();
    if (bootstrap && isLead()) {
      try {
        if (bootstrapMonitors(pi, branch, sessionId, recordedMonitors(branch))) branch = ctx.sessionManager.getBranch();
        rejectedBootstrap = undefined;
      } catch (error) {
        // A rejected bootstrap leaves no role session behind: no handler may publish ready or approval-free state, and
        // a later branch or tree move in this session does not restore the role from its record.
        rejectedBootstrap = sessionId;
        role = undefined;
        monitors.stopAll();
        removePane();
        throw error;
      }
    }
    const mode = branch.findLast((entry) => entry.type === "mode_change");
    goal = modeGoal(mode);
    if (
      initialStart &&
      role === "lane" &&
      ctx.mode === "tui" &&
      launchEnv.CATALY_DISCORD_WAKE_SESSION === sessionId &&
      goal.status === "active"
    ) {
      // A cold TUI emits session_start before it reconciles the goal and appends its own PAUSE.
      startupPause = {
        session: sessionId,
        activeEntry: launchEnv.CATALY_DISCORD_WAKE_GOAL === "active" ? mode?.id : undefined,
      };
    }
    if (role && loadError && !warned) {
      warned = true;
      ctx.ui.notify(`omp-cataly: ${loadError}. Running without the Cataly config.`, "warning");
    }
    await syncTools();
    savePane(ctx);
    if (role === "lane" && stateDir) {
      const nativeId = nativeHeadlessId(ctx);
      const native = nativeId ? ({ runtime: "headless", id: nativeId } as const) : undefined;
      discordLane.start(
        pi,
        stateDir,
        ctx,
        askLane,
        ownsDiscordReceiver,
        {
          idle: () => agentStatus === "idle" && approvals.size === 0,
          approvalFree: () => approvals.size === 0,
          goalAllows: (optedIn, claimed) => {
            if (startupPause && startupPause.pausedEntry === undefined) return false;
            if (goal.status === "blocked") return false;
            if (goal.status !== "paused") return true;
            if (!optedIn || !startupPause || (startupPause.used && !claimed)) return false;
            const mode = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "mode_change");
            return mode?.id === startupPause.pausedEntry;
          },
          consumePause: () => {
            if (startupPause) startupPause.used = true;
          },
        },
        native,
        launchEnv,
      );
    }
    if (isLead()) {
      headContext = ctx;
      restoreMonitors(ctx, branch, managedRestorePending);
      managedRestorePending = false;
    }
  };

  // Bring the running set in line with what this branch recorded: restart what a resumed session lost, stop what a
  // tree move or branch took back. Restored monitors are announced without starting a turn.
  const restoreMonitors = (ctx: CatalyContext, branch: readonly SessionEntry[], managedStartup = false): void => {
    if (!session) return;
    const wanted = recordedMonitors(branch);
    const records = recordedMonitorStates(branch);
    for (const running of monitors.specs()) {
      const spec = wanted.get(running.name);
      if (!spec || records.get(running.name)?.id !== running.recordId || !sameMonitorSpecs([spec], [running]))
        monitors.stop(running.name);
    }
    const running = new Set(monitors.specs().map((m) => m.name));
    const restored: string[] = [];
    const failed: string[] = [];
    for (const record of records.values()) {
      const { spec } = record;
      if (record.completed || running.has(spec.name)) continue;
      try {
        startMonitor(record, ctx);
        restored.push(spec.name);
      } catch (error) {
        failed.push(`${spec.name} (${errorText(error)})`);
      }
    }
    saveMonitorSpecs(wanted, branch);
    savePane(ctx);
    if (restored.length === 0 && failed.length === 0) return;
    const lines = [
      ...(restored.length ? [`[monitor] restored for this resumed session: ${restored.join(", ")}`] : []),
      ...(failed.length ? [`[monitor] could not restore: ${failed.join("; ")}`] : []),
    ];
    pi.sendMessage(
      { customType: MONITOR_MESSAGE, content: lines.join("\n"), display: true },
      { triggerTurn: failed.length > 0 && !managedStartup },
    );
    if (failed.length) ctx.ui.notify(`omp-cataly: ${lines.at(-1)}`, "warning");
  };

  for (const eventName of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
    pi.on(eventName, async (event, ctx) => {
      const activation = ctx.agent.kind === "main" ? ++remoteActivation : undefined;
      let remoteJournalReady = true;
      if (activation !== undefined) {
        nativeRemote.revoke();
        backgroundCalls.clear();
      }
      if (eventName !== "session_start" && ctx.agent.kind === "main") {
        discordAsk.clear();
        headContext?.ui.setStatus?.("cataly-head-admission", undefined);
        headContext = undefined;
        monitors.invalidateAdmissions();
      }
      let branch = ctx.sessionManager.getBranch();
      // The previous main's session entries are appended under the current names before anything reads this branch.
      if (bridgePreviousMain((type, data) => pi.appendEntry(type, data), branch)) {
        branch = ctx.sessionManager.getBranch();
        try {
          await ctx.sessionManager.ensureOnDisk?.();
        } catch (error) {
          ctx.ui.notify(`Cataly session state could not be persisted (${errorText(error)}).`, "warning");
        }
      }
      const inherited = ctx.agent.kind === "sub" ? await policy.inherit(ctx) : undefined;
      let flaggedRole = false;
      if (ctx.agent.kind === "sub") {
        role = inherited?.role;
        archivedLeadRestricted = false;
      } else {
        if (eventName === "session_start" && launchSessionIds.size === 0 && launchModelFlag() !== undefined)
          launchSessionIds.add(ctx.sessionManager.getSessionId());
        const recorded = recordedRole(branch);
        // `/new` emits `session_switch` with `reason: "new"`; its empty branch has no role entry to read. Adopting
        // that emptiness would strip `monitor`, stop the monitors that answer the messenger, and drop the pane record
        // for the rest of the process lifetime, so the process's own role carries over instead.
        const carried =
          eventName === "session_switch" &&
          typeof event === "object" &&
          event !== null &&
          "reason" in event &&
          event.reason === "new";
        // A new branch cannot borrow the archived duty's runtime proof. Leave it roleless rather than upgrade it.
        const carryRole = carried && (role !== "cataly" || isLead()) ? role : undefined;
        archivedLeadRestricted = restrictArchivedLead(branch);
        role = recorded ?? carryRole;
        const flagged = pi.getFlag(ROLE_FLAG);
        if (role === undefined && eventName === "session_start" && flagged !== undefined) {
          role = parseCatalyRole(flagged);
          if (role) flaggedRole = true;
          else
            ctx.ui.notify(`omp-cataly: --${ROLE_FLAG} must be "cataly" or "lane", got "${String(flagged)}"`, "error");
        }
        if (eventName !== "session_start" && rejectedBootstrap === ctx.sessionManager.getSessionId()) role = undefined;
        if (carried && role === "lane" && session && launchSessionIds.has(session.id))
          launchSessionIds.add(ctx.sessionManager.getSessionId());
        // Re-record the role and desired monitor starts: an exited child is not a recorded stop, and the fresh
        // branch otherwise loses the intent that `syncMain` uses to restore it.
        if (carried && role && recorded === undefined) appendRole(role);
        askLane =
          role === "lane"
            ? bindAskLane(
                branch,
                ctx.sessionManager.getSessionId(),
                flaggedRole ? launchEnv["CATALY_ASK_LAUNCHED_LANE"] : undefined,
                (kind, binding) => pi.appendEntry(kind, binding),
              )
            : undefined;
        const id = ctx.sessionManager.getSessionId();
        ownsDiscordReceiver =
          role === "lane" &&
          branch.some(
            (entry) => entry.type === "custom" && isCatalyEntry(entry.customType, RECEIVER_ENTRY) && entry.data === id,
          );
        if (
          role === "lane" &&
          !ownsDiscordReceiver &&
          eventName === "session_start" &&
          pi.getFlag(RECEIVER_FLAG) === true
        ) {
          pi.appendEntry(SESSION_WIRE.laneReceiver, id);
          ownsDiscordReceiver = true;
        }
        if (carried && role === "cataly" && isLead() && recorded === undefined) {
          for (const spec of session?.monitorSpecs ?? [])
            pi.appendEntry(MONITOR_ENTRY, {
              op: "start",
              ...spec,
              id: crypto.randomUUID(),
            });
          if (session?.intake) pi.appendEntry(SESSION_WIRE.intake, session.intake);
        }
      }
      try {
        // Opening an OMP transcript is read-only. This appends before publishing the pane so the resumed
        // foreground must actually take the native session lease; a conflicting writer will force a sibling.
        if (
          eventName === "session_start" &&
          ctx.agent.kind === "main" &&
          ctx.mode === "tui" &&
          role === "lane" &&
          launchEnv["CATALY_DISCORD_WAKE_SESSION"] === ctx.sessionManager.getSessionId()
        )
          appendRole(role);
        if (ctx.agent.kind === "main") {
          const pane = process.env.TERN_PANE;
          const nativeId = nativeHeadlessId(ctx);
          const nativeRole = role === "cataly" && nativeId ? nativeHarnessRole() : undefined;
          const harness = nativeRole === "lead" && !isLead() ? undefined : nativeRole;
          if (
            (eventName === "session_start" || eventName === "session_switch") &&
            stateDir &&
            role &&
            (harness ||
              headlessRemoteId(ctx, role) ||
              (ctx.mode === "tui" && (role === "lane" || isLead()) && (!pane || !paneHeldByAnother(pane)))) &&
            ctx.sessionManager.ensureOnDisk
          ) {
            // Native resume is read-only until an append: take the OMP transcript lease before publishing the
            // exact session ID. A conflicting native owner causes OMP to use a distinct sibling ID.
            try {
              pi.appendEntry(SESSION_WIRE.remoteOwner, { pid: process.pid });
              await ctx.sessionManager.ensureOnDisk();
            } catch (error) {
              remoteJournalReady = false;
              ctx.ui.notify(`Native remote journal could not be prepared (${errorText(error)}).`, "warning");
            }
          }
          await syncMain(ctx, ctx.sessionManager.getBranch(), eventName === "session_start");
          if (
            harness &&
            nativeId &&
            remoteJournalReady &&
            role === "cataly" &&
            eventName === "session_start" &&
            ctx.sessionManager.ensureOnDisk
          ) {
            pi.appendEntry(HARNESS_ROLE_ENTRY, { role: harness, refId: nativeId });
            await ctx.sessionManager.ensureOnDisk();
          }
          if (remoteJournalReady && activation === remoteActivation) evidenceActivation = activation;
        } else {
          // Explicit native tool selection can activate a defaultInactive manager tool.
          const active = pi.getActiveTools();
          const next = active.filter((name) => name !== "monitor" && name !== "cataly_report");
          if (next.length !== active.length) await pi.setActiveTools(next);
        }
      } catch (error) {
        if (activation !== undefined && remoteActivation === activation) nativeRemote.stop();
        throw error;
      } finally {
        // Preserve the ordinary child's runtime-only role; only a protected child needs a recoverable record.
        const persistRole = flaggedRole || (ctx.agent.kind === "sub" && inherited?.binding !== undefined);
        if (persistRole && role && !recordedRole(ctx.sessionManager.getBranch())) appendRole(role);
        policy.sync(role, ctx, eventName, event, flaggedRole, inherited);
      }
      if (eventName === "session_start" && ctx.agent.kind === "main" && headlessRemoteId(ctx, role)) {
        const sessionId = ctx.sessionManager.getSessionId();
        const refId = process.env["CATALY_HEADLESS_ID"];
        if (launchSessionIds.has(sessionId) && refId) {
          headlessKickoff = { sessionId, providerChecked: false, complete: false };
          pi.appendEntry(HEADLESS_LAUNCH_MODEL_ENTRY, { refId, sessionId, proof: modelReadback(ctx) });
        }
      }
      if (activation !== undefined && activation === remoteActivation) {
        if (remoteJournalReady) await syncRemote(ctx, activation);
        else nativeRemote.stop();
      }
    });
  }

  pi.on("goal_updated", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    const next = goalOf(event.goal);
    const startup = startupPause;
    startupPause = undefined;
    if (
      startup?.activeEntry !== undefined &&
      startup.pausedEntry === undefined &&
      startup.session === ctx.sessionManager.getSessionId() &&
      goal.status === "active" &&
      next.status === "paused" &&
      event.state?.enabled === false &&
      next.objective === goal.objective
    ) {
      const modes = ctx.sessionManager.getBranch().filter((entry) => entry.type === "mode_change");
      const pause = modes.at(-1);
      if (
        pause?.id !== undefined &&
        pause.mode === "goal_paused" &&
        modeGoal(pause).status === "paused" &&
        modeGoal(pause).objective === goal.objective &&
        modes.at(-2)?.id === startup.activeEntry
      ) {
        startupPause = { ...startup, pausedEntry: pause.id };
      }
    }
    goal = next;
    savePane(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    nativeRemote.event("agent_start", _event, ctx);
    if (role === "lane") {
      if (startupPause && !startupPause.used) startupPause = undefined;
      discordLane.agentStart?.(ctx.sessionManager.getSessionId());
    }
    agentStatus = "working";
    savePane(ctx);
  });
  pi.on("agent_end", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    nativeRemote.event("agent_end", event, ctx);
    if (headlessKickoff?.sessionId === ctx.sessionManager.getSessionId() && headlessKickoff.providerChecked)
      headlessKickoff.complete = true;
    agentStatus = "idle";
    savePane(ctx);
    if (role === "lane") discordLane.agentEnd?.(ctx.sessionManager.getSessionId(), event);
  });

  /**
   * Recent Discord obligations request bounded continuations until both send and exact-message mark exist.
   * MAX_CONTINUATIONS limits the reminder loop; lanes and subagents never receive this gate.
   */
  pi.on("session_stop", (_event, ctx) => {
    if (!isLead() || ctx.agent.kind !== "main" || stateDir === undefined) return;
    const owes = openOwes(stateDir, Date.now());
    if (owes.length === 0) return;
    const attempts = bumpAttempts(
      stateDir,
      owes.map((owe) => owe.id),
    );
    const live = owes.filter((owe) => (attempts[owe.id] ?? 0) <= MAX_CONTINUATIONS);
    if (live.length === 0) return;
    return { continue: true, additionalContext: reminder(live) };
  });

  // OMP chains prompt replacements in extension/handler order; append to the prompt this handler receives.
  pi.on("before_agent_start", async (event, ctx) => {
    assertLaunchModel(ctx);
    if (
      ctx.agent.kind === "main" &&
      headlessKickoff?.sessionId === ctx.sessionManager.getSessionId() &&
      !headlessKickoff.complete
    )
      headlessKickoff.providerChecked = false;
    if (!role || ctx.agent.kind !== "main" || typeof event !== "object" || event === null) return;
    nativeRemote.event("before_agent_start", event, ctx);
    if (role === "lane") await discordLane.beforeAgentStart?.(event, ctx);
    const original = "systemPrompt" in event ? event.systemPrompt : undefined;
    if (!Array.isArray(original) || !original.every((block) => typeof block === "string")) return;
    const invariant = role === "cataly" && !isLead() ? DUTY_INVARIANTS : ROLE_INVARIANTS[role];
    const withRole = original.includes(invariant) ? original : [...original, invariant];
    const systemPrompt = role === "lane" ? (withLaneBookkeeping(withRole, ctx.model) ?? withRole) : withRole;
    if (systemPrompt !== original) return { systemPrompt };
  });

  pi.on("before_provider_request", (_event, ctx) => {
    assertLaunchModel(ctx);
    if (
      ctx.agent.kind === "main" &&
      headlessKickoff?.sessionId === ctx.sessionManager.getSessionId() &&
      goal.status === "active"
    )
      headlessKickoff.providerChecked = true;
    if (role === "lane" && ctx.agent.kind === "main") discordLane.beforeProviderRequest?.(ctx);
  });

  const z = pi.zod;
  pi.registerTool<{
    op: "start" | "stop" | "list";
    name?: string;
    argv?: string[];
    filter?: string;
    mode?: "once" | "persistent" | "daemon";
    restart?: "on-failure" | { max: number; backoffSec: number };
    silentAfterMin?: number;
  }>({
    name: "monitor",
    label: "Monitor",
    description: MONITOR_DESCRIPTION,
    defaultInactive: true,
    loadMode: "essential",
    parameters: z.object({
      op: z
        .enum(["start", "stop", "list"])
        .describe("start a monitor, stop and forget one, or list running and recorded monitors"),
      mode: z
        .enum(["persistent", "once", "daemon"])
        .optional()
        .describe("persistent (default), once (successful completion), or daemon (bounded automatic restart)"),
      restart: z
        .union([z.enum(["on-failure"]), z.object({ max: z.number(), backoffSec: z.number() })])
        .optional()
        .describe(
          "on-failure retries an unexpected exit; daemon only: {max 0..100, backoffSec>0} bounded retries, default {max:5,backoffSec:10} (start)",
        ),
      silentAfterMin: z
        .number()
        .optional()
        .describe("positive quiet interval in minutes; any raw stdout/stderr bytes rearm the one-shot alert"),
      name: z.string().optional().describe("monitor name (start, stop)"),
      argv: z.array(z.string()).optional().describe("command and arguments, run without a shell (start)"),
      filter: z.string().optional().describe("regular expression selecting delivered output lines (start)"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isLead() || ctx.agent.kind !== "main" || !session)
        throw new Error("monitor works only in the Cataly session (omp --cataly-role cataly)");
      let text: string;
      if (params.op === "start") {
        if (!params.name || !params.argv || params.filter === undefined)
          throw new Error("start needs name, argv and filter");
        const record: RecordedMonitor = {
          spec: {
            name: params.name,
            argv: params.argv,
            filter: params.filter,
            cwd: ctx.cwd,
            ...monitorPolicy(params),
          },
          id: crypto.randomUUID(),
          completed: false,
        };
        const started = startMonitor(record, ctx);
        pi.appendEntry(MONITOR_ENTRY, { op: "start", ...record.spec, id: record.id });
        saveMonitorSpecs(recordedMonitors(ctx.sessionManager.getBranch()), ctx.sessionManager.getBranch());
        savePane(ctx);
        if (params.mode === "once") await ctx.sessionManager.ensureOnDisk?.();
        text = `started monitor "${started.name}" (pid ${started.pid}): ${started.argv.join(" ")}`;
      } else if (params.op === "stop") {
        if (!params.name) throw new Error("stop needs name");
        const wasRunning = monitors.stop(params.name);
        // A monitor that exited on its own is still recorded; stopping it by name drops it from future restores.
        const recorded = recordedMonitorStates(ctx.sessionManager.getBranch()).has(params.name);
        if (!wasRunning && !recorded) throw new Error(`no monitor "${params.name}"`);
        if (recorded) pi.appendEntry(MONITOR_ENTRY, { op: "stop", name: params.name });
        saveMonitorSpecs(recordedMonitors(ctx.sessionManager.getBranch()), ctx.sessionManager.getBranch());
        savePane(ctx);
        text = `stopped monitor "${params.name}"`;
      } else {
        const running = new Map(monitors.list(true).map((monitor) => [monitor.name, monitor]));
        const records = recordedMonitorStates(ctx.sessionManager.getBranch());
        for (const monitor of running.values())
          if (!records.has(monitor.name)) records.set(monitor.name, { spec: monitor, completed: false });
        text =
          [...records]
            .map(([name, { spec, exit }]) => {
              const active = running.get(name);
              const status = active?.waiting
                ? active.backoffUntil
                  ? "backoff"
                  : "recording"
                : active
                  ? "running"
                  : exit?.exhausted
                    ? "exhausted"
                    : exit
                      ? exit.error === undefined
                        ? "exited"
                        : "failed"
                      : "recorded";
              const policy = `${typeof spec.restart === "object" ? ` retries=${active?.restartAttempt ?? exit?.restartAttempt ?? 0}/${spec.restart.max}` : ""}${active?.backoffUntil ? ` next=${active.backoffUntil}` : ""}${spec.silentAfterMin ? ` silentAfterMin=${spec.silentAfterMin}` : ""}`;
              const outcome = exit
                ? ` ${active ? "lastExit " : ""}code=${exit.code} signal=${exit.signal ?? "none"} at=${exit.at}${exit.error === undefined ? "" : ` error=${JSON.stringify(exit.error)}`}`
                : "";
              return `${name}${active && !active.waiting ? ` (pid ${active.pid})` : ""} [mode=${spec.mode ?? "persistent"} status=${status}${outcome}${policy}] /${spec.filter}/: ${spec.argv.join(" ")}`;
            })
            .join("\n") || "no monitors running or recorded";
      }
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool<{ kind: ReportKind; text: string; files?: string[]; toolCalls?: string[] }>({
    name: "cataly_report",
    label: "Cataly report",
    description: CATALY_REPORT_DESCRIPTION,
    defaultInactive: true,
    loadMode: "essential",
    parameters: z.object({
      kind: z.enum(["milestone", "blocker", "question", "halted", "done"]).describe("the report's kind"),
      text: z.string().describe("the report for the lead: what was done, what is next"),
      files: z
        .array(z.string())
        .optional()
        .describe("files whose current bytes are this report's evidence (relative to the session's cwd)"),
      toolCalls: z
        .array(z.string())
        .optional()
        .describe("ids of completed, successful tool calls on this session whose results are this report's evidence"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!isCurrentLane(ctx))
        throw new ReportError("cataly_report works only in a lane's main session (omp --cataly-role lane)");
      if (stateDir === undefined)
        throw new ReportError(`cataly_report needs the Cataly config: ${loadError ?? "not loaded"}`);
      const activation = evidenceActivation;
      const source = ctx.sessionManager.getSessionId();
      const ownRef = selfSession(process.env);
      const registry = new Registry(stateDir);
      if (!ownRef) throw new ReportError("no open lane is registered for this pane");
      const matching = (await registry.open()).filter((candidate) => {
        const ref = sessionOf(candidate);
        return ref?.runtime === ownRef.runtime && ref.id === ownRef.id;
      });
      const lane = matching[0];
      if (!lane || matching.length !== 1)
        throw new ReportError("no open lane is registered unambiguously for this pane");
      const requireCurrentSession = () => {
        if (activation !== evidenceActivation || !isCurrentLane(ctx) || source !== ctx.sessionManager.getSessionId())
          throw new ReportError("cataly_report lane session changed before acceptance");
      };
      requireCurrentSession();
      // Capture evidence before contending for the writer lock. Refused files or calls record no report.
      const branch = ctx.sessionManager.getBranch();
      const toolCalls = params.toolCalls ?? [];
      const toolEvidenceTip = toolCalls.length > 0 ? branch.at(-1) : undefined;
      const evidence = [
        ...(params.files ?? []).map((path) => fileEvidence(path, ctx.cwd)),
        ...toolCalls.map((id) => {
          const cwd = callDirs.get(id);
          if (cwd === null)
            throw new EvidenceError(
              `tool call ${id} is not evidence: this process did not see an unambiguous execution`,
            );
          const ref = toolEvidence(branch, id, cwd);
          if (lane.requestId !== undefined && cwd === undefined)
            throw new EvidenceError(`tool call ${id} is not evidence: this execution did not observe its start`);
          return ref;
        }),
      ];
      const reports = new Reports(stateDir);
      const checkpoints = new Checkpoints(stateDir);
      const { entry, novel } = await registry.withCurrent(lane.key, (current) => {
        requireCurrentSession();
        if (
          (toolEvidenceTip && !ctx.sessionManager.getBranch().includes(toolEvidenceTip)) ||
          toolCalls.some((id) => callDirs.get(id) === null)
        )
          throw new ReportError("cataly_report tool evidence changed before acceptance");
        const ref = current && sessionOf(current);
        if (
          !current ||
          current.key !== lane.key ||
          !sameLaneGeneration(lane, current) ||
          current.requestId !== lane.requestId ||
          current.runId !== lane.runId ||
          !ref ||
          ref.runtime !== ownRef.runtime ||
          ref.id !== ownRef.id
        )
          throw new ReportError("cataly_report lane registration changed before acceptance");
        if (ref.runtime === "headless") {
          if (headlessRemoteId(ctx, role) !== `headless:${ref.id}`)
            throw new ReportError("cataly_report lane session does not own the registered headless runtime");
        } else {
          const pane = readPaneState(reports.stateDir, ref.id);
          if (
            pane?.pid !== process.pid ||
            pane.role !== "lane" ||
            pane.sessionId !== source ||
            pane.startedAt !== session?.startedAt
          )
            throw new ReportError("cataly_report lane session does not own the registered terminal");
        }
        if (
          (current.session !== undefined && current.session !== source) ||
          (askLane?.sessionId === source && askLane.key !== current.key)
        )
          throw new ReportError("cataly_report lane registration belongs to another native session");
        const execution = runContext(reports, current, reportRun);
        if (!execution || execution.generation !== current.lifecycleEpoch)
          throw new ReportError("cataly_report has no matching registered execution");
        const provenance = execution.provenance;
        if (current.requestId !== undefined || reportRun) {
          const native = provenance?.nativeRef;
          if (
            current.runId !== reportRun ||
            !provenance ||
            provenance.requestId !== current.requestId ||
            provenance.runId !== current.runId ||
            !native ||
            native.sessionId !== source ||
            native.ref.runtime !== ref.runtime ||
            native.ref.id !== ref.id
          )
            throw new ReportError("cataly_report requires the registered execution's verified native session");
        }
        const scope = reportScope(current);
        const novel = novelEvidence(
          [
            ...(reports.read(current.key, scope)?.evidenced ?? []),
            ...checkpoints
              .read(current.key)
              .filter(
                (checkpoint) =>
                  checkpoint.provenance?.requestId === scope.requestId && checkpoint.provenance?.runId === scope.runId,
              ),
          ],
          evidence,
        ).length;
        const entry = reports.report(
          current.key,
          params.kind,
          params.text,
          Date.now(),
          execution.generation,
          undefined,
          provenance,
          evidence,
        );
        return { entry, novel };
      });
      const clock =
        evidence.length === 0
          ? "no evidence attached; the evidence clock did not move"
          : novel === 0
            ? "the same evidence was recorded before; the evidence clock did not move"
            : `${novel} of ${evidence.length} evidence items are new; the evidence clock moved`;
      return { content: [{ type: "text", text: `${reportLine(entry)}\n${clock}` }] };
    },
  });

  try {
    const config = await loadConfig(installation.configFile, undefined, installation.env);
    stateDir = config.stateDir;
  } catch (error) {
    loadError = `Cataly config not loaded (${errorText(error)}); pane state is off`;
  }
  pi.setLabel("omp-cataly");
}
