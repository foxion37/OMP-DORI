import type { AgentIdentity, DeliverOutcome, Key, Probe, SubmitResult } from "../types.ts";
import { type HerdrCli, reasonOf, ToolError } from "./exec.ts";
import { probe } from "./probe.ts";

/** The terminal needs a moment to finish a bracketed paste before an Enter is read as a submit. */
export const PASTE_SETTLE_MS = 400;
/** How often the Enter that submits typed fallback text is tried before the delivery is reported as failed. */
export const ENTER_ATTEMPTS = 3;

export type Sleep = (ms: number) => Promise<void>;

const NO_AGENT: DeliverOutcome = { kind: "no-agent" };
/** How a failed lookup ends its stderr line on the delivery path: the message stays queued. */
const HOLDING = "holding delivery";
const ambiguous = (step: string, failure: unknown): DeliverOutcome => ({
  kind: "ambiguous",
  detail: `herdr ${step} failed: ${reasonOf(failure)}`,
  failure,
});
const identity = (seen: Probe): AgentIdentity => ({
  ...(seen.agent !== undefined ? { agent: seen.agent } : {}),
  ...(seen.pgid !== undefined ? { pgid: seen.pgid } : {}),
  ...(seen.pid !== undefined ? { pid: seen.pid } : {}),
  ...(seen.sessionId !== undefined ? { sessionId: seen.sessionId } : {}),
});
const sameAgent = (into: AgentIdentity, seen: Probe): boolean =>
  (into.agent === undefined || into.agent === seen.agent) &&
  (into.pgid === undefined || into.pgid === seen.pgid) &&
  (into.pid === undefined || into.pid === seen.pid) &&
  (into.sessionId === undefined || into.sessionId === seen.sessionId);

/**
 * Delivers one message to the agent in a pane as a single argv element: nothing in it is ever expanded by a shell.
 * `no-agent`, having typed nothing: the pane has no running agent, and text typed into a bare shell runs as a command
 * (#66). `ambiguous`: the message may already be in the pane (#89) and must not be sent again as is. `typed`: the text
 * is in the agent's input and only the Enter that submits it is missing (#108 identity in `into`).
 */
export async function deliver(
  cli: HerdrCli,
  paneId: string,
  text: string,
  sleep: Sleep,
  stateDir?: string,
): Promise<DeliverOutcome> {
  // Probe first (#66): a gone pane or a shell in front gets nothing, whatever herdr's status word says. herdr types
  // whatever the status is (the caller decided), so the #62 screen read is skipped here.
  // A pane get that fails for any reason but not-found (a server that is down, a timeout) types nothing: the status is
  // unknown, so the caller keeps the message queued instead of seeing herdr's raw error.
  let first: Awaited<ReturnType<typeof probe>>;
  try {
    first = await probe(cli, paneId, false, HOLDING, stateDir);
  } catch (e) {
    process.stderr.write(`dori: herdr pane get failed for ${paneId} (${reasonOf(e)}); ${HOLDING}\n`);
    return { kind: "not-ready", status: "unknown" };
  }
  if (first.status === "gone" || first.status === "shell" || first.shellInFront) return NO_AGENT;
  if (first.status === "unknown" || first.approvalPending)
    return { kind: "not-ready", status: first.approvalPending ? "blocked" : "unknown" };
  try {
    await cli.call(["agent", "prompt", paneId, text]);
    return { kind: "delivered" };
  } catch (e) {
    // herdr only accepts `agent prompt` for agents it started itself (`herdr agent start`); an omo launched
    // with `pane run` is detected but refused. Fall back to typing the text and pressing Enter.
    // Match herdr's own output, never e.message: that carries argv, which includes the delivered text.
    // Any other failure (a timeout, say) may come after herdr handed the prompt over: it is ambiguous.
    if (!(e instanceof ToolError) || !/agent_not_ready/.test(e.result.stderr || e.result.stdout))
      return ambiguous("agent prompt", e);
    // agent_not_ready also covers an agent that exited and left a shell in front: typing would run the text there.
    // Re-read right before typing (#66): only a pane that still has an agent gets keystrokes.
    const ready = await probe(cli, paneId, false, HOLDING, stateDir);
    if (ready.status === "shell" || ready.status === "gone" || ready.shellInFront) return NO_AGENT;
    if (ready.status === "unknown" || ready.approvalPending)
      return { kind: "not-ready", status: ready.approvalPending ? "blocked" : "unknown" };
    // A multi-line paste swallows the Enter that follows it, so type the message as one line.
    // A failed send-text may still have typed some or all of it: ambiguous as well.
    try {
      await cli.call(["pane", "send-text", paneId, text.trim().replace(/\s*\n\s*/g, " / ")]);
    } catch (err) {
      return ambiguous("pane send-text", err);
    }
    await sleep(PASTE_SETTLE_MS);
    const into = identity(ready);
    const missed = await pressEnter(cli, paneId, into, stateDir);
    return missed ? { kind: "typed", into, failure: missed.failure } : { kind: "delivered" };
  }
}

/**
 * Submits text that an earlier deliver typed into `typedInto` but could not submit: presses only Enter, never types
 * the text again. `changed`, pressing nothing: herdr sees no agent in the pane, or a different one (another name or
 * foreground process group), so the typed text is not in this input (#108). `wait`, pressing nothing: the agent is
 * still reported but a shell is in front (suspended with Ctrl+Z, #66/#69), or the lookup failed. Throws herdr's
 * error when every Enter failed.
 */
export async function submitTyped(
  cli: HerdrCli,
  paneId: string,
  typedInto: AgentIdentity,
  stateDir?: string,
): Promise<SubmitResult> {
  const seen = await probe(cli, paneId, false, HOLDING, stateDir);
  if (seen.status === "gone") return "wait";
  if (seen.status === "shell") return "changed";
  if (seen.shellInFront || seen.status === "unknown" || seen.approvalPending) return "wait";
  if (seen.pid !== undefined && (typedInto.pid === undefined || typedInto.sessionId === undefined)) return "changed";
  if (!sameAgent(typedInto, seen)) return "changed";
  const missed = await pressEnter(cli, paneId, identity(seen), stateDir);
  if (missed) throw missed.failure;
  return "submitted";
}

/** The text is already in the pane: retry only the Enter, so a flaky key press never re-types the message. */
async function pressEnter(
  cli: HerdrCli,
  paneId: string,
  into: AgentIdentity,
  stateDir?: string,
): Promise<{ readonly failure: unknown } | undefined> {
  for (let attempt = 1; ; attempt++) {
    try {
      if (into.pid !== undefined || into.sessionId !== undefined) {
        const seen = await probe(cli, paneId, false, HOLDING, stateDir);
        if (
          seen.shellInFront ||
          seen.status === "gone" ||
          seen.status === "shell" ||
          seen.status === "unknown" ||
          seen.approvalPending ||
          !sameAgent(into, seen)
        ) {
          return {
            failure: new Error("OMP input changed or is awaiting approval; typed text kept for reconciliation"),
          };
        }
      }
      await cli.call(["pane", "send-keys", paneId, "enter"]);
      return undefined;
    } catch (failure) {
      if (attempt >= ENTER_ATTEMPTS) return { failure };
    }
  }
}

/**
 * The operator's explicit `dori send --to-shell`: types text + Enter into a pane that has no agent. The status is
 * re-read right before typing; if an agent is there now, nothing is typed and false is returned.
 */
export async function typeIntoShell(cli: HerdrCli, paneId: string, text: string, stateDir?: string): Promise<boolean> {
  const before = await probe(cli, paneId, false, HOLDING, stateDir);
  if (before.status !== "shell" || !before.shellInFront || before.pid !== undefined) return false;
  await cli.call(["pane", "send-text", paneId, text]);
  await cli.call(["pane", "send-keys", paneId, "enter"]);
  return true;
}

export async function keys(cli: HerdrCli, paneId: string, pressed: readonly Key[]): Promise<void> {
  for (const key of pressed) await cli.call(["pane", "send-keys", paneId, key]);
}
