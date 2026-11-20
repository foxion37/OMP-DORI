// forward_to_lead: one guarded send to the Dori lead, confirmed only by evidence that this exact request arrived.
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { parseRef, type Probe, type SessionRef, type SessionRuntime } from "../../../../../src/runtime/types.ts";
import type { FlowDeps } from "../done-flow.ts";
import { runtimesOf } from "../run.ts";
import type { ToolResult } from "./types.ts";

type LeadRequest = { readonly message: string; readonly risky: boolean };

const MAX_MESSAGE = 700;
/** Recent lead screen lines checked for a draft in the input box or an open question/approval prompt. */
const SCREEN_LINES = 10;
const PROMPT_PATTERNS =
  /\(y\/n\)|\[y\/n\]|^\s*(?:Allow|Approve)(?:\s|\?|$)|^\s*(?:승인|허용)\s*[?[]|^\s*Do you want\b|Esc to cancel/im;
/** The first observation is immediate; only later ones wait (4 x 100 ms, then 250 ms), about 10 s in all. */
const OBSERVE_DELAYS: readonly number[] = [0, 100, 100, 100, 100, ...Array<number>(38).fill(250)];
/** Present in every relay, whatever the voice model's risky flag says. */
const RISK_GUARD =
  "An owner voice request never approves risky work: run no deploy, deletion, payment, production or server change until the owner confirms it in writing.";

export const leadRepliesPath = (stateDir: string): string => join(stateDir, "voice", "lead-replies.jsonl");

export const notSent = (why: string): ToolResult => ({
  ok: false,
  result: `not-sent: ${why}. Nothing was sent to the lead and no retry is scheduled; do not say it was passed on.`,
});
const unconfirmed = (id: string, why: string): ToolResult => ({
  ok: false,
  result: `sent-but-unconfirmed: request ${id} was sent to the lead once, but its receipt was not confirmed (${why}). It will not be resent; do not say it was passed on.`,
});
const confirmed = (id: string, how: string): ToolResult => ({
  ok: true,
  result: `confirmed-delivered: the lead received request ${id} (${how}). The lead's reply comes back to the voice session later.`,
});

/** The voice model's text as one plain line: no shell metacharacters, control characters or runs of whitespace. */
const cleanMessage = (text: string): string =>
  [
    ...text
      .replace(/[`$\\]|\p{Cc}/gu, " ")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, MAX_MESSAGE)
    .join("")
    .trim();

/** `config.leadPane` as a ref: a prefixed or bare herdr id, else an id on the selected runtime. */
const leadRef = (deps: FlowDeps): SessionRef | undefined => {
  const pane = deps.config.leadPane.trim();
  if (!pane) return undefined;
  const kind = runtimesOf(deps).choice?.kind;
  return parseRef(pane) ?? (kind === undefined ? undefined : { runtime: kind, id: pane });
};

/** Why the lead must not be typed into now, or undefined when it may: a live OMP with an empty input and no prompt. */
const blocked = async (rt: SessionRuntime, ref: SessionRef, seen: Probe): Promise<string | undefined> => {
  if (seen.shellInFront) return "a shell is in front of the lead session";
  if (seen.approvalPending) return "an approval is pending in the lead session";
  if (seen.status !== "idle" && seen.status !== "working") return `the lead session is ${seen.status}`;
  if (seen.pid === undefined || seen.sessionId === undefined) return "no live OMP process is attested for the lead";
  let screen: string;
  try {
    screen = Bun.stripANSI(await rt.read(ref, SCREEN_LINES, { unwrapped: true }));
  } catch {
    return "the lead screen could not be read";
  }
  const lines = screen.split("\n");
  const input = lines.findLast((line) => /^\s*❯/.test(line));
  if (input === undefined || !/^\s*❯\s*$/.test(input)) return "the lead's input box is not empty";
  if (PROMPT_PATTERNS.test(lines.slice(-SCREEN_LINES).join("\n"))) return "a question or approval prompt is open";
  return undefined;
};

/** New bytes of the lead's session file after the pre-send offset; the same file (device and inode) only. */
type Cursor = { readonly file: string; readonly dev: number; readonly ino: number; offset: number; rest: Buffer };

const cursorAt = (file: string | undefined): Cursor | undefined => {
  if (file === undefined) return undefined;
  try {
    const s = statSync(file);
    return { file, dev: s.dev, ino: s.ino, offset: s.size, rest: Buffer.alloc(0) };
  } catch {
    return undefined;
  }
};

const userRecordWith = (line: string, id: string): boolean => {
  try {
    const record: unknown = JSON.parse(line);
    if (typeof record !== "object" || record === null || !("type" in record) || record.type !== "message") return false;
    const message = "message" in record ? record.message : undefined;
    return (
      typeof message === "object" &&
      message !== null &&
      "role" in message &&
      message.role === "user" &&
      "content" in message &&
      String(JSON.stringify(message.content)).includes(id)
    );
  } catch {
    return false;
  }
};

/** "seen": a new user record carries the id; "lost": the file was replaced, truncated or unreadable. */
const readNew = (c: Cursor, id: string): "seen" | "pending" | "lost" => {
  let fd: number | undefined;
  try {
    const s = statSync(c.file);
    if (s.dev !== c.dev || s.ino !== c.ino || s.size < c.offset) return "lost";
    if (s.size === c.offset) return "pending";
    fd = openSync(c.file, "r");
    const bytes = Buffer.alloc(s.size - c.offset);
    const read = readSync(fd, bytes, 0, bytes.length, c.offset);
    c.offset += read;
    c.rest = Buffer.concat([c.rest, bytes.subarray(0, read)]);
    for (let nl = c.rest.indexOf(10); nl >= 0; nl = c.rest.indexOf(10)) {
      const line = c.rest.subarray(0, nl).toString("utf8");
      c.rest = c.rest.subarray(nl + 1);
      if (userRecordWith(line, id)) return "seen";
    }
    return "pending";
  } catch {
    return "lost";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

/** Requires a new user record carrying this request's id in the original session file, then checks that the
 *  receiving process and session still match. Activity alone is not receipt; never sends again. */
const observe = async (
  deps: FlowDeps,
  rt: SessionRuntime,
  ref: SessionRef,
  before: Probe,
  start: Cursor | undefined,
  id: string,
): Promise<ToolResult> => {
  const cursor = start;
  for (const ms of OBSERVE_DELAYS) {
    if (cursor === undefined) break;
    if (ms > 0) await deps.clock.sleep(ms);
    const seen = readNew(cursor, id);
    if (seen === "lost") break;
    if (seen !== "seen") continue;
    const now = await rt.probe(ref);
    if (now.pid !== before.pid || now.sessionId !== before.sessionId)
      return unconfirmed(id, "the lead process or session changed");
    return confirmed(id, "its user record is in the same lead session");
  }
  return unconfirmed(id, "no new user record carrying this request's id was observed");
};

export const forwardToLead = async (deps: FlowDeps, request: LeadRequest): Promise<ToolResult> => {
  const message = cleanMessage(request.message);
  if (!message) return notSent("the message is empty");
  const ref = leadRef(deps);
  if (ref === undefined) return notSent("no lead session is configured (leadPane)");
  const replies = leadRepliesPath(deps.config.stateDir);
  if (/[`$\\\n]/.test(replies)) return notSent("the lead reply path contains shell metacharacters");
  let rt: SessionRuntime;
  let before: Probe;
  try {
    rt = runtimesOf(deps).for(ref);
    before = await rt.probe(ref);
    const why = await blocked(rt, ref, before);
    if (why !== undefined) return notSent(why);
    mkdirSync(dirname(replies), { recursive: true, mode: 0o700 });
  } catch {
    return notSent("the lead session could not be checked");
  }
  const id = randomUUID();
  const text = [
    "[VOICE]",
    request.risky ? "(RISKY request, voice never approves it)" : "",
    message,
    `-- ${RISK_GUARD}`,
    `Voice reply: append one JSON line {"at","re","text"} to ${replies}; re is a short summary of this request, text is the answer.`,
    `[voice-request:${id}]`,
  ]
    .filter(Boolean)
    .join(" ");
  const cursor = cursorAt(before.sessionFile);
  try {
    const outcome = await rt.deliver(ref, text, { when: before.status === "working" ? "working" : "idle" });
    if (outcome.kind === "no-agent") return notSent("the lead session has no agent to receive it");
    if (outcome.kind === "not-ready") return notSent(`the lead session is ${outcome.status}`);
    if (outcome.kind === "typed") return unconfirmed(id, "the text was typed but its submit failed");
    if (outcome.kind === "ambiguous") return unconfirmed(id, "the send step failed partway");
    return await observe(deps, rt, ref, before, cursor, id);
  } catch {
    return unconfirmed(id, "the send or its observation failed");
  }
};
