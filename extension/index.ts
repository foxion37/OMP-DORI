/**
 * omp-dori: Dori mode on omp. Installed in the global extensions directory, so every omp session loads it, but only
 * sessions with a Dori role change behaviour; every other session runs exactly as without it.
 *
 * - Role: `--dori-role dori|lane` is recorded in the session file on session_start and re-read from the session
 *   branch on every session change, so `--resume` and herdr restores keep it without the flag. Subagents inherit
 *   their spawning agent's role.
 * - A nonempty config `ompUlwPath` applies omp-ulw through a gated API: its event, command and tool handlers run
 *   only in role sessions; load-time registrations stay visible everywhere. Source installs leave it empty for OMP loading.
 * - Pane state (`{stateDir}/sessions/<pane>.json`, read by the `dori` CLI): session id, goal status and open tool
 *   approvals of the Dori/lane session running in HERDR_PANE_ID or HC_TERMINAL_ID.
 * - Lanes without a goal get omp's `goal` tool so the agent can create its goal from the lane brief.
 * - The Dori session gets the `monitor` tool (monitor.ts).
 * - Root Dori/lane agents get compact role guidance on each turn; children do not.
 * - A lane's main agent on GPT-6.1 Sol is told to carry lane bookkeeping along with real work (lane-bookkeeping.ts).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../skills/dori-mode/scripts/src/config";
import { SourceBundleError } from "../src/release/source-bundle.ts";
import {
  type DoriRole,
  type GoalStatus,
  type PaneState,
  paneStatePath,
  readPaneState,
  writePaneState,
} from "../skills/dori-mode/scripts/src/lane-state";
import type { MonitorSpec } from "../src/update/deployment-types.ts";
import { bootstrapMonitors, MONITOR_BOOTSTRAP_FLAG, recordedIntake } from "./bootstrap.ts";
import { RuntimeHealthWriter } from "./deployment-health.ts";
import { DiscordAsk, routeFor } from "./discord-ask.ts";
import { type AskLane, automaticDiscordAskRoute, bindAskLane } from "./discord-ask-auto.ts";
import { DiscordLane } from "./discord-lane.ts";
import { type PromptModel, withLaneBookkeeping } from "./lane-bookkeeping.ts";
import { MONITOR_DESCRIPTION, Monitors } from "./monitor";
import { ROLE_INVARIANTS } from "./role-invariants.ts";
import { bumpAttempts, MAX_CONTINUATIONS, openOwes, recordOwes, reminder } from "../skills/dori-mode/scripts/src/owes";

interface SessionEntry {
  id?: string;
  type: string;
  customType?: string;
  data?: unknown;
  mode?: string;
  content?: unknown;
}
export interface DoriContext {
  cwd: string;
  mode: string;
  abort(): void;
  isIdle?(): boolean;
  hasPendingMessages?(): boolean;
  agent: { kind: "main" | "sub"; id: string; parentId?: string };
  model?: PromptModel;
  /** How full the session's context is; absent when omp cannot report it. */
  getContextUsage?(): { tokens: number; contextWindow: number; percent: number } | undefined;
  sessionManager: { getSessionId(): string; getSessionFile(): string | undefined; getBranch(): SessionEntry[] };
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
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
    ctx: DoriContext,
  ): Promise<ToolResult>;
}
export interface CommandOptions {
  description?: string;
  handler(args: string, ctx: DoriContext): Promise<void>;
}
interface Schema {
  optional(): Schema;
  describe(description: string): Schema;
}
type Handler = (event: unknown, ctx: DoriContext) => unknown;
export interface DoriApi {
  zod: {
    object(shape: Record<string, Schema>): Schema;
    string(): Schema;
    array(element: Schema): Schema;
    enum(values: readonly [string, ...string[]]): Schema;
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
    handler: (event: { goal: Goal | null; state?: { enabled?: boolean } }, ctx: DoriContext) => unknown,
  ): void;
  on(
    event: "tool_approval_requested" | "tool_approval_resolved",
    handler: (event: { toolCallId: string }, ctx: DoriContext) => unknown,
  ): void;
  on(event: string, handler: Handler): void;
  appendEntry(customType: string, data?: unknown): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean; details?: unknown },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
  ): void;
  sendUserMessage(content: string, options?: { deliverAs?: "aside" }): Promise<void>;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): Promise<void>;
  /** omp's session name, shown in the session list and stored in the session file. */
  setSessionName?(name: string): Promise<void>;
}

const ROLE_FLAG = "dori-role";
const ROLE_ENTRY = "omp-dori:role";
const MONITOR_ENTRY = "omp-dori:monitor";
const ONLY_IN_ROLE = "works only in Dori sessions (omp --dori-role dori|lane)";
// A path the managed overlay owns. A POSIX path is cut at `/` only; a backslash is an ordinary name character there,
// so only Windows reads it as a separator.
const MANAGED_OVERLAY =
  process.platform === "win32"
    ? /[\\/](?:consumer-dependencies[\\/]omp-ulw-[a-f0-9]{40}-[a-f0-9]{64}|\.cache[\\/]omp-dori[\\/]omp-ulw-[a-f0-9]{64})(?:[\\/]index\.ts)?$/
    : /\/(?:consumer-dependencies\/omp-ulw-[a-f0-9]{40}-[a-f0-9]{64}|\.cache\/omp-dori\/omp-ulw-[a-f0-9]{64})(?:\/index\.ts)?$/;
// budget-limited halts the goal until a person raises the budget; unknown statuses must never read as "none",
// which `dori pause` treats as nothing-to-pause.
const GOAL_STATUS: Record<string, GoalStatus> = {
  active: "active",
  paused: "paused",
  "budget-limited": "blocked",
  complete: "complete",
  dropped: "dropped",
};

/**
 * Role by agent registry id. omp rebinds extension factories to every subagent session in the same process without
 * re-evaluating this module, so a subagent finds its spawning agent's role here through `ctx.agent.parentId`.
 */
const agentRoles = new Map<string, DoriRole>();

const parseRole = (value: unknown): DoriRole | undefined => (value === "dori" || value === "lane" ? value : undefined);

const recordedRole = (branch: readonly SessionEntry[]): DoriRole | undefined => {
  let role: DoriRole | undefined;
  for (const entry of branch)
    if (entry.type === "custom" && entry.customType === ROLE_ENTRY) role = parseRole(entry.data) ?? role;
  return role;
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

/**
 * Monitors the Dori session wants running, replayed from its `omp-dori:monitor` entries (start / stop). Monitor
 * processes die with omp; the record is what brings the Telegram poller back after herdr or `omp --resume`
 * restores the session, which otherwise resumes idle with nothing left to wake it.
 */
const recordedMonitors = (branch: readonly SessionEntry[]): Map<string, MonitorSpec> => {
  const specs = new Map<string, MonitorSpec>();
  for (const entry of branch) {
    if (
      entry.type !== "custom" ||
      entry.customType !== MONITOR_ENTRY ||
      typeof entry.data !== "object" ||
      entry.data === null
    )
      continue;
    const data = entry.data as {
      op?: unknown;
      name?: unknown;
      argv?: unknown;
      filter?: unknown;
      cwd?: unknown;
      restart?: unknown;
    };
    if (typeof data.name !== "string") continue;
    if (data.op === "stop") specs.delete(data.name);
    else if (
      data.op === "start" &&
      Array.isArray(data.argv) &&
      typeof data.filter === "string" &&
      typeof data.cwd === "string"
    ) {
      specs.set(data.name, {
        name: data.name,
        argv: data.argv.map(String),
        filter: data.filter,
        cwd: data.cwd,
        ...(data.restart === "on-failure" ? { restart: data.restart } : {}),
      });
    }
  }
  return specs;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export default async function ompDori(pi: DoriApi): Promise<void> {
  pi.registerFlag(ROLE_FLAG, {
    description: "Run as a Dori-mode session: dori (the messenger session) or lane; kept on resume",
    type: "string",
  });
  pi.registerFlag(MONITOR_BOOTSTRAP_FLAG, {
    description: "Private session-bound monitor bootstrap for an explicit managed legacy handoff",
    type: "string",
  });
  pi.registerFlag("dori-lane-receiver", {
    description: "Take over an existing separately scoped Discord receiver for this lane",
    type: "boolean",
  });

  let role: DoriRole | undefined;
  let stateDir: string | undefined;
  let loadError: string | undefined;
  let requiredLoadError: SourceBundleError | undefined;
  let warned = false;
  let lifecycleRegistered = false;
  /** The session whose monitor bootstrap was rejected: it stays role-less until a session_start bootstraps it again. */
  let rejectedBootstrap: string | undefined;
  let session:
    | {
        id: string;
        startedAt: string;
        monitorSpecs?: readonly MonitorSpec[];
        intake?: ReturnType<typeof recordedIntake>;
      }
    | undefined;
  let goal: PaneState["goal"] = { status: "none" };
  let startupPause: StartupGoalPause | undefined;
  let agentStatus: "idle" | "working" = "idle";
  let goalToolAdded = false;
  let paneWritten: string | undefined;
  let usageWritten = "";
  let namedSession: string | undefined;
  const approvals = new Set<string>();
  const discordAsk = new DiscordAsk();
  const discordLane = new DiscordLane();
  let askLane: AskLane | undefined;
  let ownsDiscordReceiver = false;
  let managedRestorePending = process.env.DORI_MANAGED_STARTUP === "1";
  const monitors = new Monitors(
    async (content, delivery) => {
      const root = stateDir;
      if (!delivery.isCurrent()) return;
      // Monitor delivery is an admission path in its own right; its message must follow committed persistence.
      if (role === "dori" && root !== undefined) await recordOwes(root, content, Date.now(), delivery.signal);
      if (delivery.isCurrent())
        pi.sendMessage(
          { customType: "dori-monitor", content, display: true },
          { triggerTurn: true, deliverAs: "aside" },
        );
    },
    () => (role === "dori" ? session?.id : undefined),
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
      if (process.env.HC_TERMINAL_ID) process.stdout.write("\x1b]7501;state=unknown:app=omp\x1b\\");
    }
    paneWritten = undefined;
  };

  // Preserve session identity for a later resume without attesting a live pane owner.
  const retirePane = (): void => {
    runtimeHealth.stop();
    if (paneWritten === undefined || stateDir === undefined) return;
    const state = readPaneState(stateDir, paneWritten);
    if (state !== null && state.pid === process.pid) {
      writePaneState(stateDir, {
        ...state,
        pid: 0,
        agentStatus: "idle",
        approvalPending: false,
        updatedAt: new Date().toISOString(),
      });
      if (process.env.HC_TERMINAL_ID) process.stdout.write("\x1b]7501;state=unknown:app=omp\x1b\\");
    }
    paneWritten = undefined;
  };

  /**
   * Only the process that owns the pane reports it. `HERDR_PANE_ID` and `HC_TERMINAL_ID` are inherited by every
   * child, so a nested `omp` run (a `-p` check, a subagent's own session) would otherwise take the pane record of
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

  // What the lane monitor needs: the model and how full its context is. Percent is kept to one decimal.
  const usageOf = (ctx: DoriContext): Pick<PaneState, "model" | "context"> => {
    const model = ctx.model ? (ctx.model.provider ? `${ctx.model.provider}/${ctx.model.id}` : ctx.model.id) : undefined;
    const usage = ctx.getContextUsage?.();
    const valid = usage && Number.isFinite(usage.percent) && usage.contextWindow > 0;
    return {
      ...(model ? { model } : {}),
      ...(valid
        ? {
            context: {
              percent: Math.round(usage.percent * 10) / 10,
              tokens: usage.tokens,
              window: usage.contextWindow,
            },
          }
        : {}),
    };
  };

  const savePane = (ctx: DoriContext): void => {
    const paneId = process.env.HC_TERMINAL_ID || process.env.HERDR_PANE_ID;
    if (!paneId || stateDir === undefined || !session) return;
    // Only an interactive session taking over the pane clears an inactive resume pointer. Print/RPC children
    // inherit pane ids too, but do not own the terminal. A record another live process owns stays untouched.
    if (!role) {
      removePane();
      if (ctx.mode === "tui" && !paneHeldByAnother(paneId)) rmSync(paneStatePath(stateDir, paneId), { force: true });
      return;
    }
    if (paneHeldByAnother(paneId)) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const usage = usageOf(ctx);
    usageWritten = JSON.stringify(usage);
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
      ...(role === "lane" && ctx.mode === "tui" && !requiredLoadError && !ownsDiscordReceiver
        ? { discordLaneInbox: true }
        : {}),
      ...(discordReceiver ? { discordLaneReceiver: discordReceiver } : {}),
      cwd: ctx.cwd,
      pid: process.pid,
      startedAt: session.startedAt,
      updatedAt: new Date().toISOString(),
      goal,
      agentStatus,
      approvalPending: approvals.size > 0,
      ...usage,
    });
    if (role === "dori")
      runtimeHealth.update({
        stateDir,
        paneId,
        role,
        sessionId: session.id,
        startedAt: session.startedAt,
        wanted: recordedMonitors(ctx.sessionManager.getBranch()),
        presetLoaded: loadError === undefined,
      });
    else runtimeHealth.stop();
    paneWritten = paneId;
    if (process.env.HC_TERMINAL_ID) {
      const status = approvals.size > 0 ? "blocked" : agentStatus;
      process.stdout.write(`\x1b]7501;state=${status}:app=omp\x1b\\`);
    }
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
          version: 1,
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

  const syncTools = async (): Promise<void> => {
    const active = pi.getActiveTools();
    const next = new Set(active);
    if (role === "dori") next.add("monitor");
    else next.delete("monitor");
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
      approvals.add(event.toolCallId);
      savePane(ctx);
    });
    pi.on("tool_approval_resolved", (event, ctx) => {
      if (!approvals.delete(event.toolCallId) || !role) return;
      savePane(ctx);
    });
    // Context use moves per turn: rewrite the record only when the model or the usage actually changed.
    pi.on("turn_end", (_event, ctx) => {
      if (!role || ctx.agent.kind !== "main") return;
      if (JSON.stringify(usageOf(ctx)) !== usageWritten) savePane(ctx);
    });
    // The awaited preflight runs before the built-in opens its form; execution events can arrive later.
    pi.on("tool_call", (event, ctx) => {
      const id = ctx.sessionManager.getSessionId();
      const root = stateDir;
      const currentRole = role;
      if (root && currentRole && ctx.agent.kind === "main" && id === session?.id && approvals.size === 0)
        return discordAsk.arm(event, ctx.ui, root, id, async () => {
          const route = await automaticDiscordAskRoute(root, currentRole, id, askLane);
          return approvals.size === 0 ? route : undefined;
        });
    });
    pi.on("tool_execution_end", (event) => discordAsk.finish(event));
    pi.on("session_shutdown", () => {
      discordLane.stop();
      discordAsk.clear();
      monitors.stopAll();
      retirePane();
    });
  };

  // The lane label dori put on the launch command names the conversation: `DICO : <task>` / `TLGR : <task>`.
  const nameSession = async (ctx: DoriContext): Promise<void> => {
    const label = process.env["DORI_LANE_LABEL"]?.trim();
    if (!label || !session || namedSession === session.id || typeof pi.setSessionName !== "function") return;
    namedSession = session.id;
    try {
      await pi.setSessionName(label);
    } catch (error) {
      ctx.ui.notify(`omp-dori: could not name the session (${errorText(error)})`, "warning");
    }
  };

  const syncMain = async (ctx: DoriContext, branch: readonly SessionEntry[], bootstrap = false): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    const initialStart = bootstrap && session === undefined;
    startupPause = undefined;
    // Monitors belong to the Dori session that started them; their lines must not wake whatever session comes next.
    discordLane.stop();
    if (session?.id !== sessionId || !role) discordAsk.clear();
    if (session?.id !== sessionId || role !== "dori") monitors.stopAll();
    if (session?.id !== sessionId) {
      session = { id: sessionId, startedAt: new Date().toISOString() };
      approvals.clear();
      agentStatus = "idle";
    }
    if (role && !lifecycleRegistered) registerLifecycle();
    if (bootstrap && role === "dori") {
      try {
        if (bootstrapMonitors(pi, branch, sessionId, recordedMonitors(branch))) branch = ctx.sessionManager.getBranch();
        rejectedBootstrap = undefined;
      } catch (error) {
        // A rejected bootstrap leaves no role session behind: no handler may publish ready or approval-free state, and
        // a later branch or tree move in this session does not restore the role from its record.
        rejectedBootstrap = sessionId;
        role = undefined;
        agentRoles.delete(ctx.agent.id);
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
      process.env.DORI_DISCORD_WAKE_SESSION === sessionId &&
      goal.status === "active"
    ) {
      // A cold TUI emits session_start before it reconciles the goal and appends its own PAUSE.
      startupPause = {
        session: sessionId,
        activeEntry: process.env.DORI_DISCORD_WAKE_GOAL === "active" ? mode?.id : undefined,
      };
    }
    if (role && loadError && !warned) {
      warned = true;
      ctx.ui.notify(
        `omp-dori: ${loadError}. ${requiredLoadError ? "Required bound source failed; role requests are blocked." : "Running without omo presets."}`,
        "warning",
      );
    }
    await syncTools();
    savePane(ctx);
    if (role === "lane" && ctx.agent.kind === "main") await nameSession(ctx);
    if (role === "lane" && stateDir && !requiredLoadError)
      discordLane.start(pi, stateDir, ctx, askLane, ownsDiscordReceiver, {
        idle: () => agentStatus === "idle" && approvals.size === 0,
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
      });
    if (role === "dori") {
      restoreMonitors(ctx, branch, managedRestorePending);
      managedRestorePending = false;
    }
  };

  // Bring the running set in line with what this branch recorded: restart what a resumed session lost, stop what a
  // tree move or branch took back. Restored monitors are announced without starting a turn.
  const restoreMonitors = (ctx: DoriContext, branch: readonly SessionEntry[], managedStartup = false): void => {
    if (!session) return;
    const wanted = recordedMonitors(branch);
    for (const running of monitors.specs()) {
      const spec = wanted.get(running.name);
      if (
        !spec ||
        JSON.stringify(spec.argv) !== JSON.stringify(running.argv) ||
        new RegExp(spec.filter).source !== running.filter ||
        spec.cwd !== running.cwd ||
        spec.restart !== running.restart
      )
        monitors.stop(running.name);
    }
    const running = new Set(monitors.specs().map((m) => m.name));
    const restored: string[] = [];
    const failed: string[] = [];
    for (const spec of wanted.values()) {
      if (running.has(spec.name)) continue;
      try {
        monitors.start(spec.name, spec.argv, spec.filter, spec.cwd, session.id, spec.restart);
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
      { customType: "dori-monitor", content: lines.join("\n"), display: true },
      { triggerTurn: failed.length > 0 && !managedStartup },
    );
    if (failed.length) ctx.ui.notify(`omp-dori: ${lines.at(-1)}`, "warning");
  };

  // Registered before omp-ulw so its restore handlers see this event's role.
  for (const eventName of ["session_start", "session_switch", "session_branch", "session_tree"] as const) {
    pi.on(eventName, async (event, ctx) => {
      if (eventName !== "session_start" && ctx.agent.kind === "main") discordAsk.clear();
      const branch = ctx.sessionManager.getBranch();
      let flaggedRole = false;
      if (ctx.agent.kind === "sub") {
        role = ctx.agent.parentId === undefined ? undefined : agentRoles.get(ctx.agent.parentId);
      } else {
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
        role = recorded ?? (carried ? role : undefined);
        const flagged = pi.getFlag(ROLE_FLAG);
        if (role === undefined && eventName === "session_start" && flagged !== undefined) {
          role = parseRole(flagged);
          if (role) flaggedRole = true;
          else ctx.ui.notify(`omp-dori: --${ROLE_FLAG} must be "dori" or "lane", got "${String(flagged)}"`, "error");
        }
        if (eventName !== "session_start" && rejectedBootstrap === ctx.sessionManager.getSessionId()) role = undefined;
        // Re-record the role and desired monitor starts: an exited child is not a recorded stop, and the fresh
        // branch otherwise loses the intent that `syncMain` uses to restore it.
        if (carried && role && recorded === undefined) pi.appendEntry(ROLE_ENTRY, role);
        askLane =
          role === "lane"
            ? bindAskLane(
                branch,
                ctx.sessionManager.getSessionId(),
                flaggedRole ? process.env["CATALY_ASK_LAUNCHED_LANE"] : undefined,
                (kind, binding) => pi.appendEntry(kind, binding),
              )
            : undefined;
        const id = ctx.sessionManager.getSessionId();
        ownsDiscordReceiver =
          role === "lane" &&
          branch.some(
            (entry) =>
              entry.type === "custom" && entry.customType === "omp-dori:discord-lane-receiver" && entry.data === id,
          );
        if (
          role === "lane" &&
          !ownsDiscordReceiver &&
          eventName === "session_start" &&
          pi.getFlag("dori-lane-receiver") === true
        ) {
          pi.appendEntry("omp-dori:discord-lane-receiver", id);
          ownsDiscordReceiver = true;
        }
        if (carried && role === "dori" && recorded === undefined) {
          for (const spec of session?.monitorSpecs ?? [])
            pi.appendEntry(MONITOR_ENTRY, {
              op: "start",
              name: spec.name,
              argv: spec.argv,
              filter: spec.filter,
              cwd: spec.cwd,
              ...(spec.restart ? { restart: spec.restart } : {}),
            });
          if (session?.intake) pi.appendEntry("omp-dori:intake", session.intake);
        }
      }
      if (role) agentRoles.set(ctx.agent.id, role);
      else agentRoles.delete(ctx.agent.id);
      try {
        // Opening an OMP transcript is read-only. This appends before publishing the pane so the resumed
        // foreground must actually take the native session lease; a conflicting writer will force a sibling.
        if (
          eventName === "session_start" &&
          ctx.agent.kind === "main" &&
          ctx.mode === "tui" &&
          role === "lane" &&
          !requiredLoadError &&
          process.env["DORI_DISCORD_WAKE_SESSION"] === ctx.sessionManager.getSessionId()
        )
          pi.appendEntry(ROLE_ENTRY, role);
        if (ctx.agent.kind === "main")
          await syncMain(ctx, ctx.sessionManager.getBranch(), eventName === "session_start");
        else {
          // Explicit native tool selection can activate a defaultInactive manager tool.
          const active = pi.getActiveTools();
          if (active.includes("monitor")) await pi.setActiveTools(active.filter((name) => name !== "monitor"));
        }
      } finally {
        // A rejected bootstrap has cleared the role, so it is not recorded; any other failure keeps the role this
        // process runs with, and its record, as a later resume without the flag must restore it.
        if (flaggedRole && role) pi.appendEntry(ROLE_ENTRY, role);
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
    if (role === "lane") {
      if (startupPause && !startupPause.used) startupPause = undefined;
      discordLane.agentStart?.(ctx.sessionManager.getSessionId());
    }
    agentStatus = "working";
    savePane(ctx);
  });
  pi.on("agent_end", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    agentStatus = "idle";
    savePane(ctx);
    if (role === "lane") discordLane.agentEnd?.(ctx.sessionManager.getSessionId(), event);
  });

  /**
   * Recent Discord obligations request bounded continuations until both send and exact-message mark exist.
   * MAX_CONTINUATIONS limits the reminder loop; lanes and subagents never receive this gate.
   */
  pi.on("session_stop", (_event, ctx) => {
    if (role !== "dori" || ctx.agent.kind !== "main" || stateDir === undefined) return;
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
    if (role && requiredLoadError) {
      ctx.abort();
      throw requiredLoadError;
    }
    if (!role || ctx.agent.kind !== "main" || typeof event !== "object" || event === null) return;
    if (role === "lane") await discordLane.beforeAgentStart?.(event, ctx);
    const original = "systemPrompt" in event ? event.systemPrompt : undefined;
    if (!Array.isArray(original) || !original.every((block) => typeof block === "string")) return;
    const invariant = ROLE_INVARIANTS[role];
    const withRole = original.includes(invariant) ? original : [...original, invariant];
    const systemPrompt = role === "lane" ? (withLaneBookkeeping(withRole, ctx.model) ?? withRole) : withRole;
    if (systemPrompt !== original) return { systemPrompt };
  });

  pi.on("before_provider_request", (_event, ctx) => {
    if (role && requiredLoadError) {
      ctx.abort();
      throw requiredLoadError;
    }
    if (role === "lane" && ctx.agent.kind === "main") discordLane.beforeProviderRequest?.(ctx);
  });

  const z = pi.zod;
  pi.registerTool<{
    op: "start" | "stop" | "list";
    name?: string;
    argv?: string[];
    filter?: string;
    restart?: "on-failure";
  }>({
    name: "monitor",
    label: "Monitor",
    description: MONITOR_DESCRIPTION,
    defaultInactive: true,
    loadMode: "essential",
    parameters: z.object({
      op: z.enum(["start", "stop", "list"]).describe("start a monitor, stop one, or list running monitors"),
      name: z.string().optional().describe("monitor name (start, stop)"),
      argv: z.array(z.string()).optional().describe("command and arguments, run without a shell (start)"),
      filter: z.string().optional().describe("regular expression; matching output lines wake the session (start)"),
      restart: z.enum(["on-failure"]).optional().describe("retry unexpected exits for this monitor only (start)"),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (role !== "dori" || ctx.agent.kind !== "main" || !session)
        throw new Error("monitor works only in the Dori session (omp --dori-role dori)");
      let text: string;
      if (params.op === "start") {
        if (!params.name || !params.argv || params.filter === undefined)
          throw new Error("start needs name, argv and filter");
        const started = monitors.start(params.name, params.argv, params.filter, ctx.cwd, session.id, params.restart);
        pi.appendEntry(MONITOR_ENTRY, {
          op: "start",
          name: started.name,
          argv: started.argv,
          filter: started.filter,
          cwd: ctx.cwd,
          ...(params.restart ? { restart: params.restart } : {}),
        });
        saveMonitorSpecs(recordedMonitors(ctx.sessionManager.getBranch()), ctx.sessionManager.getBranch());
        savePane(ctx);
        text = `started monitor "${started.name}" (pid ${started.pid}): ${started.argv.join(" ")}`;
      } else if (params.op === "stop") {
        if (!params.name) throw new Error("stop needs name");
        const wasRunning = monitors.stop(params.name);
        // A monitor that exited on its own is still recorded; stopping it by name drops it from future restores.
        const recorded = recordedMonitors(ctx.sessionManager.getBranch()).has(params.name);
        if (!wasRunning && !recorded) throw new Error(`no monitor "${params.name}"`);
        if (recorded) pi.appendEntry(MONITOR_ENTRY, { op: "stop", name: params.name });
        saveMonitorSpecs(recordedMonitors(ctx.sessionManager.getBranch()), ctx.sessionManager.getBranch());
        savePane(ctx);
        text = `stopped monitor "${params.name}"`;
      } else {
        const running = monitors.list();
        text =
          running.length === 0
            ? "no monitors running"
            : running.map((m) => `${m.name} (pid ${m.pid}) /${m.filter}/: ${m.argv.join(" ")}`).join("\n");
      }
      return { content: [{ type: "text", text }] };
    },
  });

  // omp-ulw sees this API: every runtime entry point is a no-op outside role sessions.
  const gated = new Proxy(pi, {
    get(target, prop) {
      if (prop === "on")
        return (event: string, handler: Handler) =>
          target.on(event, (payload, ctx) => (role ? handler(payload, ctx) : undefined));
      if (prop === "registerCommand") {
        return (name: string, options: CommandOptions) =>
          target.registerCommand(name, {
            ...options,
            handler: async (args, ctx) => {
              if (role) return options.handler(args, ctx);
              ctx.ui.notify(`/${name} ${ONLY_IN_ROLE}.`, "warning");
            },
          });
      }
      if (prop === "registerTool") {
        return (tool: ToolDefinition) =>
          target.registerTool<Record<string, unknown>>({
            ...tool,
            execute: async (toolCallId, params, signal, onUpdate, ctx) => {
              if (role) return tool.execute(toolCallId, params, signal, onUpdate, ctx);
              ctx.ui.notify(`${tool.name} ${ONLY_IN_ROLE}.`, "warning");
              return { content: [{ type: "text", text: `${tool.name} ${ONLY_IN_ROLE}.` }] };
            },
          });
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  try {
    const config = await loadConfig();
    stateDir = config.stateDir;
    // An empty ompUlwPath means a standalone omp-ulw extension already serves every session; importing it again
    // would register its commands and handlers twice.
    if (config.ompUlwPath) {
      try {
        // Prepare the runtime-selected dependency through this host's canonical graph before binding the role gate.
        // The host loader is optional when no embedded dependency is configured.
        const { importExtensionModule } = await import("@oh-my-pi/pi-coding-agent/extensibility/extensions/loader");
        const prepared = await importExtensionModule(config.ompUlwPath, import.meta.dir);
        if (prepared.error) throw new Error(prepared.error);
        const ulw: unknown = prepared.factory;
        if (typeof ulw !== "function") throw new Error("its default export is not a function");
        await ulw(gated);
      } catch (error) {
        loadError = `omp-ulw not loaded from ${config.ompUlwPath} (${errorText(error)})`;
        if (MANAGED_OVERLAY.test(config.ompUlwPath)) requiredLoadError = new SourceBundleError(loadError);
      }
    }
  } catch (error) {
    if (error instanceof SourceBundleError) requiredLoadError = error;
    loadError = `Dori config not loaded (${errorText(error)}); omp-ulw and pane state are off`;
  }
  pi.setLabel("omp-dori");
}
