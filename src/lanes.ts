import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shq } from "./delivery.ts";
import { oneName } from "./fit.ts";
import { agentCommand, harnessLaneEnv, prompt, type Deps } from "./harness.ts";
import { settled, tellLead, type SendResult } from "./inbox.ts";
import { Refusal } from "./refusal.ts";
import { runHook } from "./hooks.ts";
import { checkPriority } from "./lock-queue.ts";
import { applyEvidence, blockerOf, waitingSinceOf, waitingTarget } from "./progress.ts";
import { refText } from "./refs.ts";
import { groupId } from "./runtime/group.ts";
import { openSession } from "./runtime/types.ts";
import { KEY_RE, reservedKey, type Lane } from "./store-types.ts";

/**
 * The lead's `evidence:` line: each reference is the lane's own input, so a line break or escape in it stays out; the
 * spaces inside one stay, so it names the file the lane gave.
 */
const evidenceLine = (evidence: readonly string[]): string => `evidence: ${evidence.map(oneName).join(" ")}`;

export async function startLane(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; group?: string; priority?: number } = {},
): Promise<Lane> {
  if (!KEY_RE.test(key)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const priority = opts.priority === undefined ? undefined : checkPriority(opts.priority);
  const reserved = reservedKey(key);
  if (reserved) throw new Refusal(reserved);
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost")
    throw new Refusal(`lane ${key} is already open in ${refText(existing.sessionRef)}`);
  const cwd = resolve(opts.cwd ?? process.cwd());
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, dori: d.doriCmd });
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);

  // The group is the caller's own when it runs in a session of the selected runtime (a lane opened from the lead's
  // workspace stays there); otherwise herdr gets a new "dori" workspace and hc this home's group label.
  const rt = d.runtimes.default;
  const self = d.runtimes.selfAny(process.env);
  const group =
    opts.group ??
    (self?.runtime === rt.kind ? self.group : undefined) ??
    (rt.kind === "herdr" ? await rt.createGroup("dori", cwd) : groupId(d.store.root));
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
  const ref = await openSession(
    rt,
    { name: key, role: "lane", container: "tab", cwd, env: harnessLaneEnv(d, key), group },
    `${agentCommand(d, "lane")} ${shq(kickoff)}`,
  );

  const now = d.now();
  const lane: Lane = {
    key,
    sessionRef: ref,
    paneId: ref.id,
    tabId: ref.container ?? "",
    brief: briefPath,
    cwd,
    status: "working",
    createdAt: now,
    lastActivityAt: now,
    progressAt: now,
    noticeId: randomUUID(),
    progressEpoch: 0,
    ...(priority !== undefined ? { priority } : {}),
    nudges: 0,
    log: [{ at: now, kind: "start", text: briefFile }],
  };
  d.store.saveLane(lane);
  await tellLead(d, `[START ${key}] lane opened in ${refText(ref)}`, key);
  const open = d.store.lanes().filter((l) => l.status === "working" || l.status === "waiting").length;
  d.usage.record({ name: "dori.lane_started", open_lanes: Math.min(open, 1000) });
  return lane;
}

function openLane(d: Deps, key: string): Lane {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}

/** Sets an open lane's priority (1 first, 9 last); the next lock it waits for queues it by that. */
export function setPriority(d: Deps, key: string, priority: number): Lane {
  const lane = openLane(d, key);
  lane.priority = checkPriority(priority);
  d.store.saveLane(lane);
  return lane;
}

/**
 * Logs a lane's report and tells the lead. Only new evidence moves the progress clock and clears the nudge count; the
 * returned lines say whether it did. `sent` is the delivery to the lead. `--status waiting` records what the lane waits
 * on (`waitingFor`; else the target it already named; else the blocker in the text) and since when; `--status working`
 * clears both.
 */
export async function report(
  d: Deps,
  key: string,
  text: string,
  opts: { status?: "working" | "waiting"; evidence?: readonly string[]; waitingFor?: string } = {},
): Promise<{ sent: SendResult | undefined; progress: string[] }> {
  if (opts.waitingFor !== undefined && opts.status !== "waiting") throw new Refusal("--for needs --status waiting");
  const lane = openLane(d, key);
  const now = d.now();
  const evidence = opts.evidence ?? [];
  // A lane already waiting keeps its start and target. Both are read before this report touches the record: a record
  // from before `waitingSince`/`--for` infers them from its progress and its last report, and new evidence or this
  // report's text would otherwise move them.
  const still = lane.status === "waiting" ? { since: waitingSinceOf(lane), target: waitingTarget(lane) } : undefined;
  // The clock is read before this report joins the log: a record from before the clock falls back to its last report,
  // and that fallback must not count the report being judged (a lane could otherwise talk its way out of a stall).
  const progress = applyEvidence(lane, evidence, now);
  lane.log.push({ at: now, kind: "report", text: evidence.length ? `${text}\nevidence: ${evidence.join(" ")}` : text });
  lane.lastActivityAt = now;
  // A report that leaves the lane waiting (--status waiting, or no --status on a waiting lane) records the start and the
  // target, so a record from before `waitingSince`/`--for` keeps what was inferred before this report moved its clock.
  if (opts.status === "waiting" || (still && opts.status === undefined)) {
    // Waiting is not progress: the lane stays on the same clock, and the target is named in its nudges and escalation.
    // --for is stored on one line with boundary whitespace trimmed; printable spaces inside are part of the name.
    lane.waitingSince = still?.since ?? now;
    lane.waitingFor = oneName(opts.waitingFor ?? "").trim() || still?.target || blockerOf(text);
  } else if (opts.status === "working") {
    delete lane.waitingFor;
    delete lane.waitingSince;
  }
  if (opts.status) lane.status = opts.status;
  d.store.saveLane(lane);
  void runHook(d, "onReport", { key, text, evidence: evidence.join(" ") });
  const head = `[REPORT ${key}${lane.status === "waiting" ? " WAITING" : ""}]`;
  const tail = evidence.length ? `\n${evidenceLine(evidence)}` : "";
  return { sent: await settled(tellLead(d, `${head} ${text}${tail}`, key)), progress };
}

export async function ready(
  d: Deps,
  key: string,
  text: string,
  evidence: readonly string[],
): Promise<SendResult | undefined> {
  if (evidence.length === 0) throw new Refusal("READY needs at least one --evidence link (a PR, a receipt, a file)");
  if (!text.trim()) throw new Refusal("READY needs the final answer text");
  const lane = openLane(d, key);
  const now = d.now();
  lane.status = "ready";
  lane.final = { text, evidence: [...evidence], at: now };
  lane.lastActivityAt = now;
  lane.progressAt = now;
  lane.progressEpoch = (lane.progressEpoch ?? 0) + 1;
  lane.nudges = 0;
  delete lane.escalatedAt;
  lane.log.push({ at: now, kind: "ready", text });
  d.store.saveLane(lane);
  const sent = await settled(tellLead(d, `[READY ${key}] ${text}\n${evidenceLine(evidence)}`, key));
  void runHook(d, "onReady", { key, text, evidence: evidence.join(" ") });
  d.usage.record({
    name: "dori.lane_ready",
    evidence_count: Math.min(evidence.length, 100),
    lane_minutes: Math.min(Math.floor((now - lane.createdAt) / 60_000), 10_080),
  });
  return sent;
}

export async function done(d: Deps, key: string): Promise<void> {
  const lane = d.store.lane(key);
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status !== "ready") throw new Refusal(`lane ${key} is ${lane.status}, not ready: no final answer recorded`);
  const rt = d.runtimes.for(lane.sessionRef);
  const { status: st } = await rt.probe(lane.sessionRef);
  if (st === "working" || st === "blocked" || st === "error")
    throw new Refusal(`lane ${key} pane is ${st}; let it finish first`);
  if (st !== "gone") await rt.close(lane.sessionRef);
  lane.status = "done";
  lane.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
  d.store.saveLane(lane);
}
