import { readFileSync } from "node:fs";
import { object, UpdateError, UpdateInterrupted } from "./config.ts";
import { saveJson } from "./state.ts";

export const REVIEW_TOOLS = ["read", "grep", "glob"] as const;
type GuardContext = { readonly sessionManager?: { getSessionId(): string } };
type GuardApi = {
  getActiveTools(): string[];
  setActiveTools(names: string[]): Promise<void>;
  on(name: string, handler: (event: unknown, ctx: GuardContext) => unknown): void;
};
export type ReviewScope = {
  readonly version: 1;
  readonly nonce: string;
  readonly job: string;
  readonly sourceHash: string;
  readonly pid: number;
  readonly active: readonly string[];
  readonly stages: readonly string[];
  readonly callBlocker: true;
  readonly blocked: readonly string[];
  readonly sessionId: string | null;
  readonly at: string;
};

/** CLI --tools is additive on some OMP builds. The runtime API must replace and read back the whole active set. */
export async function enforceReviewTools(api: Pick<GuardApi, "getActiveTools" | "setActiveTools">): Promise<string[]> {
  await api.setActiveTools([...REVIEW_TOOLS]);
  const active = api.getActiveTools();
  if (
    active.length !== REVIEW_TOOLS.length ||
    new Set(active).size !== REVIEW_TOOLS.length ||
    active.some((name) => !REVIEW_TOOLS.some((allowed) => allowed === name))
  ) {
    throw new UpdateError("native reviewer tool scope was not restricted to read,grep,glob");
  }
  return active;
}

/** Loaded explicitly by this controller only; no role/ULW/global extension discovery or SDK dependency. */
export default function installReviewerGuard(api: GuardApi): void {
  const path = process.env["DORI_UPDATE_REVIEW_SCOPE"];
  const nonce = process.env["DORI_UPDATE_REVIEW_NONCE"];
  const job = process.env["DORI_UPDATE_REVIEW_JOB"];
  const sourceHash = process.env["DORI_UPDATE_REVIEW_SOURCE"];
  if (!path || !nonce || !job || !sourceHash) process.exit(70);
  const stages = new Set<string>();
  const blocked: string[] = [];
  let sessionId: string | null = null;
  const persist = (active: readonly string[]): void => {
    const receipt: ReviewScope = {
      version: 1,
      nonce,
      job,
      sourceHash,
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
    process.stderr.write("DORI_UPDATE_REVIEW_SCOPE_FAILED\n");
    process.exit(70);
  };
  const guard =
    (stage: string) =>
    async (_event: unknown, ctx: GuardContext): Promise<void> => {
      try {
        const active = await enforceReviewTools(api);
        const id = ctx.sessionManager?.getSessionId();
        if (id !== undefined) {
          if (sessionId !== null && sessionId !== id) throw new UpdateError("native reviewer session changed");
          sessionId = id;
        }
        stages.add(stage);
        persist(active);
      } catch {
        halt();
      }
    };
  // Deferred global MCP discovery can widen the set later. This gate runs before approval/execution for EVERY call.
  api.on("tool_call", (event) => {
    const name = object(event) && typeof event["toolName"] === "string" ? event["toolName"] : "(unknown)";
    if (REVIEW_TOOLS.some((allowed) => allowed === name)) return undefined;
    blocked.push(name);
    try {
      persist(api.getActiveTools());
    } catch {
      halt();
    }
    return { block: true, reason: "Candidate reviewer permits only read,grep,glob." };
  });
  api.on("before_agent_start", guard("before_agent_start"));
  api.on("before_provider_request", guard("before_provider_request"));
}

export function readReviewScope(
  path: string,
  expected: Pick<ReviewScope, "nonce" | "job" | "sourceHash" | "pid">,
): ReviewScope {
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (
    !object(raw) ||
    raw["version"] !== 1 ||
    raw["nonce"] !== expected.nonce ||
    raw["job"] !== expected.job ||
    raw["sourceHash"] !== expected.sourceHash ||
    raw["pid"] !== expected.pid ||
    !Array.isArray(raw["active"]) ||
    raw["active"].length !== REVIEW_TOOLS.length ||
    new Set(raw["active"]).size !== REVIEW_TOOLS.length ||
    raw["active"].some((name) => !REVIEW_TOOLS.some((allowed) => allowed === name)) ||
    !Array.isArray(raw["stages"]) ||
    !raw["stages"].includes("before_agent_start") ||
    !raw["stages"].includes("before_provider_request") ||
    raw["callBlocker"] !== true ||
    !Array.isArray(raw["blocked"]) ||
    raw["blocked"].length !== 0 ||
    !(raw["sessionId"] === null || typeof raw["sessionId"] === "string") ||
    typeof raw["at"] !== "string"
  ) {
    throw new UpdateInterrupted("native reviewer has no matching, source-bound read-only runtime scope receipt");
  }
  return raw as unknown as ReviewScope;
}
