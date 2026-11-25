import { EvidenceError, type EvidenceRef } from "./evidence.ts";
import { hasCatalyCommand } from "./monitor-command.ts";
import { isCatalyEntry } from "./session-compat.ts";
import { type ContentBlock, type Details, resultFingerprint } from "./tool-fingerprint.ts";

// The native session's message shapes (omp's AgentMessage), as its session manager stores them on the branch.
type ToolCall = {
  readonly type: "toolCall";
  readonly id: string;
  readonly name: unknown;
  readonly arguments?: unknown;
};
type NativeMessage =
  | { readonly role: "assistant"; readonly content: readonly ContentBlock[] }
  | {
      readonly role: "toolResult";
      readonly toolCallId: string;
      readonly toolName: unknown;
      readonly content: unknown;
      readonly details?: Details | null;
      readonly isError: unknown;
      readonly prunedAt?: unknown;
    }
  | { readonly role: "user" | "developer" };
type ToolResult = Extract<NativeMessage, { role: "toolResult" }>;
type Branch = readonly {
  readonly type: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly message?: unknown;
}[];
// A tool_execution_update frame's partial result, as omp's agent loop coerces it.
type Frame = { readonly content?: unknown; readonly details?: Details | null; readonly isError?: unknown };

/**
 * The custom entry recording that the background job a tool call started completed successfully: the call, its job,
 * the tool, the session cwd the call started in, and the completed result's fingerprint, or why that result is not
 * evidence.
 */
export const COMPLETION_ENTRY = "omp-cataly:tool-completion";
export type Completion = {
  readonly call: string;
  readonly job: string;
  readonly tool: string;
  readonly cwd: string;
} & ({ readonly fingerprint: string } | { readonly refused: string });

/** Tools that coordinate the lane (reports, messages, goals, questions, plans) rather than do its work. */
const COORDINATION_TOOLS: Record<string, true> = {
  cataly_report: true,
  monitor: true,
  goal: true,
  ask: true,
  todo: true,
  yield: true,
  think: true,
};
const MESSAGE_PATH = /^(?:agent:\/\/|xd:\/\/ask(?:[/?#]|$))/;
const REPORT_LINE = /^\[REPORT\] /m;
const COORDINATES = "it reports, messages or coordinates rather than does work";
const UNSEEN = "this process did not see its execution directory; select file evidence";
const SHA256 = /^[a-f0-9]{64}$/;

const findCall = (branch: Branch, id: string): ToolCall | undefined => {
  for (const entry of branch) {
    const message = entry.type === "message" ? (entry.message as NativeMessage | null | undefined) : undefined;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const call = message.content.find(
      (block): block is ToolCall => block?.type === "toolCall" && "id" in block && block.id === id,
    );
    if (call) return call;
  }
  return undefined;
};
// Why a call reports, messages or coordinates rather than does work, or why that is not known; `session` is the
// session cwd it was called in, if known. A shell command is read in the directory it started in (pinned omp 18.20.0
// bash, pi-tui BashToolDetails.cwd): the call's own `cwd`, as omp resolved it into `details.cwd`; without one, the
// session cwd, which its leading `cd` (hoisted by omp into `details.cwd`, off the script it runs) then moves as the
// command itself reads. An explicit cwd prevents native leading-cd hoisting, so it is not applied twice.
const coordinates = (
  name: string,
  arguments_: unknown,
  content: readonly (ContentBlock | null)[],
  details: Details | null | undefined,
  session: string | undefined,
): string | undefined => {
  const args = typeof arguments_ === "object" && arguments_ !== null ? (arguments_ as Record<string, unknown>) : {};
  const command = name === "bash" || name === "run";
  if (
    Object.hasOwn(COORDINATION_TOOLS, name) ||
    (typeof args["path"] === "string" && MESSAGE_PATH.test(args["path"])) ||
    ((command || name === "eval") &&
      content.some((block) => block?.type === "text" && typeof block.text === "string" && REPORT_LINE.test(block.text)))
  )
    return COORDINATES;
  if (!command) return undefined;
  const own = typeof args["cwd"] === "string" && args["cwd"] !== "";
  const dir = !own ? session : typeof details?.["cwd"] === "string" ? details["cwd"] : undefined;
  if (hasCatalyCommand(args["command"], dir, true)) return COORDINATES;
  return dir === undefined ? UNSEEN : undefined;
};
// Eval can finish while a nested native job is still running. Its public cell/status metadata, not output text,
// must establish completion. Run events omit their effective cwd, including explicit overrides, so a successful
// exit code cannot establish that the operation was work rather than a relative coordination command.
const evalRefusal = (details: Details | null | undefined): string | undefined => {
  const incomplete = "eval completion does not establish successful completion of its nested operations";
  const cells = details?.["cells"];
  if (!Array.isArray(cells) || cells.length === 0) return incomplete;
  for (const value of cells) {
    if (typeof value !== "object" || value === null) return incomplete;
    const cell = value as Record<string, unknown>;
    if (cell["status"] !== "complete" || (cell["exitCode"] !== undefined && cell["exitCode"] !== 0)) return incomplete;
  }
  for (const group of [details, ...cells] as Record<string, unknown>[]) {
    if (group["statusEventsElided"] !== undefined && group["statusEventsElided"] !== 0) return incomplete;
    const events = group["statusEvents"] ?? [];
    if (!Array.isArray(events)) return incomplete;
    for (const value of events) {
      if (typeof value !== "object" || value === null) return incomplete;
      const event = value as Record<string, unknown>;
      const op = event["op"];
      if (typeof op !== "string") return incomplete;
      const args = { command: event["cmd"], path: event["path"] };
      const output = [{ type: "text", text: event["output"] ?? event["preview"] }];
      if (event["hasError"] === true || event["error"] !== undefined || (op === "run" && event["code"] !== 0))
        return incomplete;
      const refusal = coordinates(op, args, output, undefined, undefined);
      if (op === "run")
        return refusal === COORDINATES
          ? refusal
          : "eval completion omits command execution directory; select files or a direct Bash result";
      if (refusal) return refusal;
      if (!["read", "write", "edit", "grep", "glob"].includes(op)) return incomplete;
    }
  }
  return undefined;
};

/** The receipt of call `id`'s background `job` on `branch`, if one records it for tool `name`. */
const findCompletion = (branch: Branch, id: string, job: string, name: string): Completion | undefined => {
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry?.type !== "custom" || !isCatalyEntry(entry.customType, "omp-cataly:tool-completion")) continue;
    const data = entry.data as Partial<Completion> | null | undefined;
    if (data?.call !== id || data.job !== job || data.tool !== name || typeof data.cwd !== "string") continue;
    const receipt = { call: id, job, tool: name, cwd: data.cwd };
    if ("refused" in data && typeof data.refused === "string") return { ...receipt, refused: data.refused };
    if ("fingerprint" in data && typeof data.fingerprint === "string" && SHA256.test(data.fingerprint))
      return { ...receipt, fingerprint: data.fingerprint };
  }
  return undefined;
};

/**
 * The receipt of tool call `id`'s background job completing successfully, from the job's settled
 * `tool_execution_update` frame (`partialResult`): `details.async` completed, the job's result content (images ride in
 * `details.images`) and details. Eval terminal frames omit images without attesting their absence, so they are refused.
 * Undefined for any other frame, or when the session's current `branch` lacks the call. `cwd` is the session cwd the
 * call started in.
 */
export const completionReceipt = (
  branch: Branch,
  id: string,
  name: unknown,
  partialResult: unknown,
  cwd: string,
): Completion | undefined => {
  const frame = typeof partialResult === "object" && partialResult !== null ? (partialResult as Frame) : undefined;
  if (!frame || frame.isError === true || !Array.isArray(frame.content)) return undefined;
  if (typeof frame.details !== "object" || frame.details === null) return undefined;
  const { async: job, images, ...details } = frame.details;
  if (job?.state !== "completed" || typeof job.jobId !== "string" || job.jobId === "") return undefined;
  const call = findCall(branch, id);
  if (!call || typeof name !== "string" || call.name !== name) return undefined;
  const content: (ContentBlock | null)[] = [...frame.content, ...(Array.isArray(images) ? images : [])];
  const receipt = { call: id, job: job.jobId, tool: name, cwd };
  const refused =
    coordinates(name, call.arguments, content, frame.details, cwd) ??
    (name === "eval"
      ? "its native async eval completion does not contain the full result; select files or a foreground result"
      : undefined);
  return refused ? { ...receipt, refused } : { ...receipt, fingerprint: resultFingerprint(name, content, details) };
};

/**
 * A completed, successful native tool call on `branch` (the session's current branch, root to leaf) as evidence. Its
 * fingerprint covers the tool name, visible content and structured result data, excluding native run timing, async
 * bookkeeping and artifact locators. A new call id or timestamp alone is not new evidence. A call that started a
 * background job is evidence only through a receipt on the branch of that call's job completing successfully. Report,
 * message and coordination calls, failed or pruned results and background starts are refused. `cwd` is the session
 * cwd this process saw the call start in, undefined when it did not; a receipt carries its call's own. A command whose
 * start directory is not known is refused.
 */
export const toolEvidence = (
  branch: Branch,
  id: string,
  cwd: string | undefined,
): Extract<EvidenceRef, { kind: "tool" }> => {
  const call = findCall(branch, id);
  let result: ToolResult | undefined;
  for (const entry of branch) {
    const message = entry.type === "message" ? (entry.message as NativeMessage | null | undefined) : undefined;
    if (message?.role === "toolResult" && message.toolCallId === id) result = message;
  }
  const refuse = (why: string) => new EvidenceError(`tool call ${id} is not evidence: ${why}`);
  if (!call || !result) throw refuse("this session's current branch has no completed result for it");
  const name = call.name;
  if (typeof name !== "string" || result.toolName !== name) throw refuse("its result belongs to another tool");
  if (result.isError !== false) throw refuse("it failed");
  if (result.prunedAt !== undefined) throw refuse("its output was pruned");
  const background = result.details?.async;
  let completion: Completion | undefined;
  if (background?.state !== undefined && background.state !== "completed") {
    if (background.state === "running" && typeof background.jobId === "string")
      completion = findCompletion(branch, id, background.jobId, name);
    if (!completion)
      throw refuse("it was started in the background and this branch records no successful completion of its job");
  }
  if (!Array.isArray(result.content)) throw refuse("it has no content");
  const coordinating = coordinates(name, call.arguments, result.content, result.details, completion?.cwd ?? cwd);
  if (coordinating) throw refuse(coordinating);
  if (completion && "refused" in completion) throw refuse(completion.refused);
  if (!completion && name === "eval") {
    const incomplete = evalRefusal(result.details);
    if (incomplete) throw refuse(incomplete);
  }
  const fingerprint =
    completion && "fingerprint" in completion
      ? completion.fingerprint
      : resultFingerprint(name, result.content, result.details ?? {});
  return { kind: "tool", ref: id, fingerprint };
};
