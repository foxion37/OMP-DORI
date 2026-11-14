import { readFileSync } from "node:fs";
import { object, UpdateError, UpdateInterrupted } from "./config.ts";
import { saveJson } from "./state.ts";

/** Built-in tools a port worker needs. MCP, subagent, web, GitHub, memory and skill-management tools are excluded. */
export const WORKER_TOOLS = [
  "read",
  "grep",
  "glob",
  "find",
  "ast_grep",
  "ast_edit",
  "edit",
  "write",
  "bash",
  "lsp",
  "todo",
  "wait",
  "eval",
] as const;
const REQUIRED_TOOLS = ["read", "edit", "write", "bash"] as const;
const allowed = (name: string): boolean => WORKER_TOOLS.some((tool) => tool === name);

type GuardContext = { readonly sessionManager?: { getSessionId(): string } };
type GuardApi = {
  getActiveTools(): string[];
  getAllTools?(): Array<{ name: string }>;
  setActiveTools(names: string[]): Promise<void>;
  on(name: string, handler: (event: unknown, ctx: GuardContext) => unknown): void;
};
export type WorkerScope = {
  readonly version: 1;
  readonly nonce: string;
  readonly job: string;
  readonly pid: number;
  readonly active: readonly string[];
  readonly stages: readonly string[];
  readonly callBlocker: true;
  /** Informational: tools the worker tried and was denied. A denied attempt does not invalidate a port. */
  readonly blocked: readonly string[];
  readonly sessionId: string | null;
  readonly at: string;
};

/** Replace the active set with the built-in editing tools and read back that nothing else is active. */
export async function enforceWorkerTools(
  api: Pick<GuardApi, "getActiveTools" | "getAllTools" | "setActiveTools">,
): Promise<string[]> {
  const available = api.getAllTools === undefined ? undefined : new Set(api.getAllTools().map((tool) => tool.name));
  const wanted = WORKER_TOOLS.filter((name) => available === undefined || available.has(name));
  if (REQUIRED_TOOLS.some((name) => !wanted.includes(name))) {
    throw new UpdateError("native worker lacks its required built-in editing tools");
  }
  await api.setActiveTools([...wanted]);
  const active = api.getActiveTools();
  if (active.some((name) => !allowed(name)) || REQUIRED_TOOLS.some((name) => !active.includes(name))) {
    throw new UpdateError("native worker tool scope was not restricted to built-in editing tools");
  }
  return active;
}

/** Loaded explicitly by this controller only. Late MCP discovery cannot widen the worker: every call is gated. */
export default function installWorkerGuard(api: GuardApi): void {
  const path = process.env["DORI_UPDATE_WORKER_SCOPE"];
  const nonce = process.env["DORI_UPDATE_WORKER_NONCE"];
  const job = process.env["DORI_UPDATE_WORKER_JOB"];
  if (!path || !nonce || !job) process.exit(70);
  const stages = new Set<string>();
  const blocked = new Set<string>();
  let sessionId: string | null = null;
  const persist = (active: readonly string[]): void => {
    const receipt: WorkerScope = {
      version: 1,
      nonce,
      job,
      pid: process.pid,
      active,
      stages: [...stages],
      callBlocker: true,
      blocked: [...blocked],
      sessionId,
      at: new Date().toISOString(),
    };
    saveJson(path, receipt);
  };
  const halt = (): never => {
    // Hook exceptions may be caught by the host. End our own child before any unproven request proceeds.
    process.stderr.write("DORI_UPDATE_WORKER_SCOPE_FAILED\n");
    process.exit(70);
  };
  const guard = (stage: string) => async (_event: unknown, ctx: GuardContext) => {
    try {
      const active = await enforceWorkerTools(api);
      const id = ctx.sessionManager?.getSessionId();
      if (id !== undefined) {
        if (sessionId !== null && sessionId !== id) throw new UpdateError("native worker session changed");
        sessionId = id;
      }
      stages.add(stage);
      persist(active);
    } catch {
      halt();
    }
  };
  api.on("tool_call", (event) => {
    const name = object(event) && typeof event["toolName"] === "string" ? event["toolName"] : "(unknown)";
    if (allowed(name)) return undefined;
    blocked.add(name);
    try {
      persist(api.getActiveTools());
    } catch {
      halt();
    }
    return { block: true, reason: "Port workers may use only built-in search, edit and shell tools." };
  });
  api.on("before_agent_start", guard("before_agent_start"));
  api.on("before_provider_request", guard("before_provider_request"));
}

export function readWorkerScope(path: string, expected: Pick<WorkerScope, "nonce" | "job" | "pid">): WorkerScope {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    raw = undefined;
  }
  if (
    !object(raw) ||
    raw["version"] !== 1 ||
    raw["nonce"] !== expected.nonce ||
    raw["job"] !== expected.job ||
    raw["pid"] !== expected.pid ||
    !Array.isArray(raw["active"]) ||
    raw["active"].some((name) => typeof name !== "string" || !allowed(name)) ||
    REQUIRED_TOOLS.some((name) => !(raw["active"] as unknown[]).includes(name)) ||
    !Array.isArray(raw["stages"]) ||
    !raw["stages"].includes("before_agent_start") ||
    !raw["stages"].includes("before_provider_request") ||
    raw["callBlocker"] !== true ||
    !Array.isArray(raw["blocked"]) ||
    !(raw["sessionId"] === null || typeof raw["sessionId"] === "string") ||
    typeof raw["at"] !== "string"
  ) {
    throw new UpdateInterrupted("native worker has no matching runtime tool-scope receipt");
  }
  return raw as unknown as WorkerScope;
}
