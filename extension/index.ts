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
 * - A lane's main agent on GPT-6.1 Sol is told to carry lane bookkeeping along with real work (lane-bookkeeping.ts).
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../skills/dori-mode/scripts/src/config";
import {
  type DoriRole,
  type GoalStatus,
  type PaneState,
  paneStatePath,
  readPaneState,
  writePaneState,
} from "../skills/dori-mode/scripts/src/lane-state";
import { bootstrapMonitors, MONITOR_BOOTSTRAP_FLAG, recordedIntake } from "./bootstrap.ts";
import { RuntimeHealthWriter } from "./deployment-health.ts";
import { type PromptModel, withLaneBookkeeping } from "./lane-bookkeeping.ts";
import { MONITOR_DESCRIPTION, Monitors } from "./monitor";

interface SessionEntry {
  type: string;
  customType?: string;
  data?: unknown;
  mode?: string;
}
export interface DoriContext {
  cwd: string;
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
  on(event: "goal_updated", handler: (event: { goal: Goal | null }, ctx: DoriContext) => unknown): void;
  on(
    event: "tool_approval_requested" | "tool_approval_resolved",
    handler: (event: { toolCallId: string }, ctx: DoriContext) => unknown,
  ): void;
  on(event: string, handler: Handler): void;
  appendEntry(customType: string, data?: unknown): void;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" | "aside" },
  ): void;
  getActiveTools(): string[];
  setActiveTools(toolNames: string[]): Promise<void>;
}

const ROLE_FLAG = "dori-role";
const ROLE_ENTRY = "omp-dori:role";
const MONITOR_ENTRY = "omp-dori:monitor";
const ONLY_IN_ROLE = "works only in Dori sessions (omp --dori-role dori|lane)";
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
const recordedGoal = (branch: readonly SessionEntry[]): PaneState["goal"] => {
  let goal: PaneState["goal"] = { status: "none" };
  for (const entry of branch) {
    if (entry.type !== "mode_change") continue;
    const data =
      typeof entry.data === "object" && entry.data !== null && "goal" in entry.data ? entry.data.goal : undefined;
    goal = (entry.mode === "goal" || entry.mode === "goal_paused") && isGoal(data) ? goalOf(data) : { status: "none" };
  }
  return goal;
};

type MonitorSpec = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly filter: string;
  readonly cwd: string;
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
    const data = entry.data as { op?: unknown; name?: unknown; argv?: unknown; filter?: unknown; cwd?: unknown };
    if (typeof data.name !== "string") continue;
    if (data.op === "stop") specs.delete(data.name);
    else if (
      data.op === "start" &&
      Array.isArray(data.argv) &&
      typeof data.filter === "string" &&
      typeof data.cwd === "string"
    ) {
      specs.set(data.name, { name: data.name, argv: data.argv.map(String), filter: data.filter, cwd: data.cwd });
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

  let role: DoriRole | undefined;
  let stateDir: string | undefined;
  let loadError: string | undefined;
  let warned = false;
  let lifecycleRegistered = false;
  let session: { id: string; startedAt: string } | undefined;
  let goal: PaneState["goal"] = { status: "none" };
  let agentStatus: "idle" | "working" = "idle";
  let goalToolAdded = false;
  let paneWritten: string | undefined;
  let usageWritten = "";
  const approvals = new Set<string>();
  let managedRestorePending = process.env.DORI_MANAGED_STARTUP === "1";
  const monitors = new Monitors(
    (content) =>
      pi.sendMessage({ customType: "dori-monitor", content, display: true }, { triggerTurn: true, deliverAs: "aside" }),
    () => (role === "dori" ? session?.id : undefined),
  );
  const runtimeHealth = new RuntimeHealthWriter(monitors);

  // Only the file this process wrote: another process may have taken the pane since.
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

  /**
   * Only the process that owns the pane reports it. `HERDR_PANE_ID` and `HC_TERMINAL_ID` are inherited by every
   * child, so a nested `omp` run (a `-p` check, a subagent's own session) would otherwise take the pane record of
   * the live session above it and delete that record on its own shutdown — which reads to the watchdog as a dead
   * lead, so it restarts the lead every tick. An incumbent that is still alive keeps its record.
   */
  const paneHeldByAnother = (paneId: string): boolean => {
    if (stateDir === undefined) return false;
    const existing = readPaneState(stateDir, paneId);
    if (existing === null || !Number.isSafeInteger(existing.pid) || existing.pid <= 0 || existing.pid === process.pid)
      return false;
    try {
      process.kill(existing.pid, 0);
      return true;
    } catch (error) {
      // EPERM still identifies a live owner. Dead processes and invalid pid arguments do not own this pane.
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
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
    // The pane now runs a session without a role: a leftover file would point `dori` at the previous session.
    if (!role) {
      removePane();
      return;
    }
    if (paneHeldByAnother(paneId)) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    const usage = usageOf(ctx);
    usageWritten = JSON.stringify(usage);
    writePaneState(stateDir, {
      paneId,
      role,
      sessionId: session.id,
      ...(sessionFile ? { sessionFile } : {}),
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

  // Boot reads this desired-state mirror instead of opening private session transcripts.
  const saveMonitorSpecs = (specs: ReadonlyMap<string, MonitorSpec>, branch: readonly SessionEntry[]): void => {
    if (!session || !stateDir) return;
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
          monitors: [...specs.values()],
          intake: recordedIntake(branch),
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
    pi.on("session_shutdown", () => {
      monitors.stopAll();
      removePane();
    });
  };

  const syncMain = async (ctx: DoriContext, branch: readonly SessionEntry[], bootstrap = false): Promise<void> => {
    const sessionId = ctx.sessionManager.getSessionId();
    // Monitors belong to the Dori session that started them; their lines must not wake whatever session comes next.
    if (session?.id !== sessionId || role !== "dori") monitors.stopAll();
    if (session?.id !== sessionId) {
      session = { id: sessionId, startedAt: new Date().toISOString() };
      approvals.clear();
      agentStatus = "idle";
    }
    if (bootstrap && role === "dori" && bootstrapMonitors(pi, branch, sessionId, recordedMonitors(branch)))
      branch = ctx.sessionManager.getBranch();
    goal = recordedGoal(branch);
    if (role && !lifecycleRegistered) registerLifecycle();
    if (role && loadError && !warned) {
      warned = true;
      ctx.ui.notify(`omp-dori: ${loadError}. Running without omo presets.`, "warning");
    }
    await syncTools();
    savePane(ctx);
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
    for (const running of monitors.list()) {
      const spec = wanted.get(running.name);
      if (
        !spec ||
        JSON.stringify(spec.argv) !== JSON.stringify(running.argv) ||
        new RegExp(spec.filter).source !== running.filter ||
        spec.cwd !== running.cwd
      )
        monitors.stop(running.name);
    }
    const running = new Set(monitors.list().map((m) => m.name));
    const restored: string[] = [];
    const failed: string[] = [];
    for (const spec of wanted.values()) {
      if (running.has(spec.name)) continue;
      try {
        monitors.start(spec.name, spec.argv, spec.filter, spec.cwd, session.id);
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
    pi.on(eventName, async (_event, ctx) => {
      const branch = ctx.sessionManager.getBranch();
      if (ctx.agent.kind === "sub") {
        role = ctx.agent.parentId === undefined ? undefined : agentRoles.get(ctx.agent.parentId);
      } else {
        role = recordedRole(branch);
        const flagged = pi.getFlag(ROLE_FLAG);
        if (eventName === "session_start" && role === undefined && flagged !== undefined) {
          role = parseRole(flagged);
          if (role) pi.appendEntry(ROLE_ENTRY, role);
          else ctx.ui.notify(`omp-dori: --${ROLE_FLAG} must be "dori" or "lane", got "${String(flagged)}"`, "error");
        }
      }
      if (role) agentRoles.set(ctx.agent.id, role);
      else agentRoles.delete(ctx.agent.id);
      if (ctx.agent.kind === "main") await syncMain(ctx, branch, eventName === "session_start");
    });
  }

  pi.on("goal_updated", (event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    goal = goalOf(event.goal);
    savePane(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    agentStatus = "working";
    savePane(ctx);
  });
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.agent.kind !== "main" || !role) return;
    agentStatus = "idle";
    savePane(ctx);
  });

  // OMP chains prompt replacements in extension/handler order; append to the prompt this handler receives.
  pi.on("before_agent_start", (event, ctx) => {
    if (role !== "lane" || ctx.agent.kind !== "main" || typeof event !== "object" || event === null) return;
    const systemPrompt = "systemPrompt" in event ? withLaneBookkeeping(event.systemPrompt, ctx.model) : undefined;
    return systemPrompt && { systemPrompt };
  });

  const z = pi.zod;
  pi.registerTool<{ op: "start" | "stop" | "list"; name?: string; argv?: string[]; filter?: string }>({
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (role !== "dori" || ctx.agent.kind !== "main" || !session)
        throw new Error("monitor works only in the Dori session (omp --dori-role dori)");
      let text: string;
      if (params.op === "start") {
        if (!params.name || !params.argv || params.filter === undefined)
          throw new Error("start needs name, argv and filter");
        const started = monitors.start(params.name, params.argv, params.filter, ctx.cwd, session.id);
        pi.appendEntry(MONITOR_ENTRY, {
          op: "start",
          name: started.name,
          argv: started.argv,
          filter: started.filter,
          cwd: ctx.cwd,
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
        // The omp-ulw checkout is user-configured (`ompUlwPath`), so the specifier only exists at runtime.
        const module: unknown = await import(config.ompUlwPath);
        const ulw = module && typeof module === "object" && "default" in module ? module.default : undefined;
        if (typeof ulw !== "function") throw new Error("its default export is not a function");
        await ulw(gated);
      } catch (error) {
        loadError = `omp-ulw not loaded from ${config.ompUlwPath} (${errorText(error)})`;
      }
    }
  } catch (error) {
    loadError = `Dori config not loaded (${errorText(error)}); omp-ulw and pane state are off`;
  }
  pi.setLabel("omp-dori");
}
