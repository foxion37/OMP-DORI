import type { ProbedNativeObservation } from "../native-observation.ts";

export type TerminalRuntimeKind = "tern";
export type RuntimeKind = TerminalRuntimeKind | "headless";
/**
 * One session as its runtime addresses it. `group`: the headless group label or the Tern session id. `container`: the
 * Tern tab id.
 */
export type SessionRef = {
  readonly runtime: RuntimeKind;
  readonly id: string;
  readonly group?: string;
  readonly container?: string;
};
export type AgentStatus = "idle" | "working" | "blocked" | "error" | "done" | "unknown" | "shell" | "gone";
export type AgentIdentity = {
  readonly agent?: string;
  readonly pgid?: number;
  /** OMP's live writer and session, so a switched session never receives an old input's Enter. */
  readonly pid?: number;
  readonly sessionId?: string;
};
export type ForegroundProcess = {
  readonly name: string;
  readonly argv: readonly string[];
  readonly pid?: number;
  /** True when Tern reported only a name or a partial argv, not a complete observation. */
  readonly argvIncomplete?: boolean;
};
/** One snapshot: status, identity, foreground and discovery data together (submitTyped compares all of them; deliver re-reads them). `rootPid`: the session's root process (the Tern block's child pid, the headless OMP pid). */
export type Probe = {
  readonly status: AgentStatus;
  readonly agent?: string;
  readonly pgid?: number;
  readonly rootPid?: number;
  readonly turn?: number;
  readonly title?: string;
  readonly cwd?: string;
  readonly pid?: number;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly approvalPending?: boolean;
  readonly native?: ProbedNativeObservation;
  readonly shellInFront: boolean;
  readonly foreground?: readonly ForegroundProcess[];
};
export type SessionInfo = {
  readonly ref: SessionRef;
  readonly name?: string;
  readonly title?: string;
  readonly cwd?: string;
  readonly status?: AgentStatus;
  readonly agent?: string;
};
export type SessionRole = "lead" | "duty" | "duty-loop" | "hourly-loop" | "lane";
/**
 * Where the session is created. tern: "workspace-root" = `new session`, "tab" (also when absent) = `new tab` in the
 * `group` session (else the caller's own), "split-below" = `split <near> down`. headless ignores the container kind and
 * records `group`.
 */
export type CreateSpec = {
  readonly name: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly role: SessionRole;
  readonly container?: "workspace-root" | "tab" | "split-below";
  readonly group?: string;
  readonly near?: SessionRef;
};
export type DeliverWhen = "idle" | "working" | "any";
/** `when`: the status the session must show; unknown and shell never receive agent delivery.
 * `force`: kept for callers that allow a blocked agent; Tern reports no blocked state and OMP tool approvals always hold delivery. */
export type DeliverOptions = {
  readonly when?: DeliverWhen;
  readonly force?: boolean;
  /** Require idle at the runtime's last delivery check, overriding `when`. */
  readonly strictIdle?: boolean;
  /** Require this process-bound native session in the probe immediately before delivery. */
  readonly expectedSessionId?: string;
};
export type DeliverOutcome =
  | { readonly kind: "delivered"; readonly turn?: number; readonly started?: boolean }
  | { readonly kind: "no-agent" }
  | { readonly kind: "not-ready"; readonly status: AgentStatus }
  | { readonly kind: "typed"; readonly into: AgentIdentity; readonly failure: unknown }
  | { readonly kind: "ambiguous"; readonly detail: string; readonly failure: unknown };
export type SubmitResult = "submitted" | "wait" | "changed";
export type Key = "enter" | "escape";
export type CloseScope = "session" | "container";
/** `unwrapped`: a line the terminal wrapped over several rows comes back as one line, not one line per row. */
export type ReadOptions = { readonly unwrapped?: boolean };
/** `foregroundOnly`: skip any observational screen check; Tern and headless never make one, so they ignore it. */
export type ProbeOptions = { readonly foregroundOnly?: boolean };
interface SessionOperations {
  readonly kind: RuntimeKind;
  /** The caller's own session from the runtime's env (CATALY_HEADLESS_ID / TERN_PANE), or undefined. */
  self(): SessionRef | undefined;
  /** Allocates a session address before its agent starts: an idle shell for a terminal or a native lane reservation. */
  create(spec: CreateSpec): Promise<SessionRef>;
  list(filter?: { readonly group?: string }): Promise<readonly SessionInfo[]>;
  probe(ref: SessionRef, opts?: ProbeOptions): Promise<Probe>;
  /** Reads recent terminal output or native conversation observations. */
  read(ref: SessionRef, lines: number, opts?: ReadOptions): Promise<string>;
  /** Agent delivery never types into a shell. Default `when` = "idle". */
  deliver(ref: SessionRef, text: string, opts?: DeliverOptions): Promise<DeliverOutcome>;
  /** Closes the session by default; terminal runtimes may also close its container. tern: `close <id>` for both scopes. */
  close(ref: SessionRef, scope?: CloseScope, expectedSessionId?: string): Promise<void>;
}

export interface TerminalRuntime extends SessionOperations {
  readonly kind: TerminalRuntimeKind;
  /** Tern: the caller's own Tern session, else one named `label` (nothing is created until a block opens in it). */
  createGroup(label: string, cwd: string): Promise<string>;
  /** Tern: types `command` into the new block's shell and submits it. */
  start(ref: SessionRef, command: string): Promise<void>;
  submitTyped(ref: SessionRef, into: AgentIdentity): Promise<SubmitResult>;
  typeIntoShell(ref: SessionRef, text: string): Promise<boolean>;
  keys(ref: SessionRef, keys: readonly Key[]): Promise<void>;
}

export interface NativeSessionRuntime extends SessionOperations {
  readonly kind: "headless";
}

export type SessionRuntime = TerminalRuntime | NativeSessionRuntime;

/** Id shape after each prefix. Another machine's `<machine>/<address>` is not a ref: the id names its inbox file. */
export const HEADLESS_ADDRESS = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const TERN_BLOCK = /^[0-9]+$/;
const ID_SHAPES: Readonly<Record<RuntimeKind, RegExp>> = { tern: TERN_BLOCK, headless: HEADLESS_ADDRESS };
const KINDS = Object.keys(ID_SHAPES) as RuntimeKind[];

/** "headless:<uuid>" or "tern:42". A bare "42" is NOT a ref (it is a legal lane key); undefined otherwise. */
export const parseRef: (text: string) => SessionRef | undefined = (text) => {
  for (const runtime of KINDS) {
    if (!text.startsWith(`${runtime}:`)) continue;
    const id = text.slice(runtime.length + 1);
    return ID_SHAPES[runtime].test(id) ? { runtime, id } : undefined;
  }
  return undefined;
};
export const formatRef: (ref: SessionRef) => string = (ref) => `${ref.runtime}:${ref.id}`;
/**
 * create + start in one call (the root harness path). A start that fails closes the session create just made (scope
 * "session"), so no idle shell is left behind, and rethrows the start error; a close that fails too is one stderr line.
 */
export const openSession: (rt: TerminalRuntime, spec: CreateSpec, command: string) => Promise<SessionRef> = async (
  rt,
  spec,
  command,
) => {
  const ref = await rt.create(spec);
  try {
    await rt.start(ref, command);
  } catch (e) {
    await rt.close(ref, "session").catch((closeError: unknown) => {
      const why = closeError instanceof Error ? closeError.message : String(closeError);
      process.stderr.write(`cataly: could not close ${formatRef(ref)} after its start failed (${why})\n`);
    });
    throw e;
  }
  return ref;
};
