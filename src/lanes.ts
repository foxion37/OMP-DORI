import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { shq } from "./delivery.ts";
import { oneName } from "./fit.ts";
import { agentCommand, harnessLaneEnv, nativeHarnessCommand, prompt, type Deps } from "./harness.ts";
import { settled, tellLead, type SendResult } from "./inbox.ts";
import { startNativeLane } from "./lane-start-native.ts";
import { Refusal } from "./refusal.ts";
import { runHook } from "./hooks.ts";
import { checkPriority } from "./lock-queue.ts";
import { acquire, release } from "./loop-lock.ts";
import { applyEvidence, blockerOf, waitingSinceOf, waitingTarget } from "./progress.ts";
import { refText } from "./refs.ts";
import { headSha } from "./gate.ts";
import { bindCiWait } from "./wait-ci.ts";
import { bindNativeWait, observeWait, parseWait, renderWait, type Wait } from "./wait.ts";
import { groupId } from "./runtime/group.ts";
import { HeadlessRuntime } from "./runtime/headless.ts";
import { openSession } from "./runtime/types.ts";
import { sameLaneRegistration } from "./store-lanes.ts";
import { KEY_RE, reservedKey, type Lane } from "./store-types.ts";
const evidenceLine = (evidence: readonly string[]): string => `evidence: ${evidence.map(oneName).join(" ")}`;
export class LaneStartNoticeFailure extends Refusal {
  constructor(
    readonly lane: Lane,
    cause: unknown,
  ) {
    const why = cause instanceof Error ? cause.message : String(cause);
    super(`${lane.key} started in ${refText(lane.sessionRef)} but the lead was not told: ${why}`, { cause });
  }
}
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
  const lock = `${d.store.briefPath(key)}.start.lock`;
  const held = acquire(d, lock);
  if ("holder" in held) throw new Refusal(`another start owns lane ${key} (${held.holder})`);
  try {
    return await startAdmitted(d, key, briefFile, opts, priority);
  } finally {
    release(d, held.nonce, lock);
  }
}
async function startAdmitted(
  d: Deps,
  key: string,
  briefFile: string,
  opts: { cwd?: string; group?: string },
  priority?: number,
): Promise<Lane> {
  const existing = d.store.lane(key);
  if (existing && existing.status !== "done" && existing.status !== "lost")
    throw new Refusal(`lane ${key} is already open in ${refText(existing.sessionRef)}`);
  const rt = d.runtimes.default;
  if (rt.kind === "headless" && !(rt instanceof HeadlessRuntime))
    throw new Refusal("native lane runtime is unavailable");
  const cwd = rt.kind === "headless" ? realpathSync(opts.cwd ?? process.cwd()) : resolve(opts.cwd ?? process.cwd());
  const native = rt instanceof HeadlessRuntime ? await nativeHarnessCommand(d) : undefined;
  const briefPath = d.store.briefPath(key);
  const footer = prompt("lane-footer.md", { key, cataly: d.catalyCmd });
  await Bun.write(briefPath, `${readFileSync(briefFile, "utf8").trimEnd()}\n\n${footer}`);
  // The group is the caller's own when it runs in a session of the selected runtime (a lane opened from the lead's
  // Tern session stays there); otherwise Tern gets a "cataly" session and headless this home's group label.
  const self = d.runtimes.selfAny(process.env);
  const group =
    opts.group ??
    (self?.runtime === rt.kind ? self.group : undefined) ??
    (rt.kind === "tern" ? await rt.createGroup("cataly", cwd) : groupId(d.store.root));
  const kickoff = `Read your brief at ${briefPath} and execute it. Your lane key is ${key}.`;
  const env = harnessLaneEnv(d, key);
  const spec = { name: key, role: "lane", container: "tab", cwd, env, group } as const;
  const ref =
    rt.kind === "headless"
      ? await rt.create(spec)
      : await openSession(rt, spec, `${agentCommand(d, "lane")} ${shq(kickoff)}`);
  const now = d.now();
  const reservation: Lane = {
    key,
    sessionRef: ref,
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
  const lane =
    rt instanceof HeadlessRuntime && native
      ? await startNativeLane(d, rt, reservation, native, env, kickoff)
      : d.store.updateLane(key, () => reservation);
  try {
    await tellLead(d, `[START ${key}] lane opened in ${refText(ref)}`, key);
  } catch (error) {
    throw new LaneStartNoticeFailure(lane, error);
  }
  const open = d.store.lanes().filter((l) => l.status === "working" || l.status === "waiting").length;
  d.usage.record({ name: "cataly.lane_started", open_lanes: Math.min(open, 1000) });
  return lane;
}
function openLane(lane: Lane | undefined, key: string): Lane {
  if (!lane) throw new Refusal(`no lane ${key}`);
  if (lane.status === "done" || lane.status === "lost") throw new Refusal(`lane ${key} is ${lane.status}`);
  return lane;
}
export function setPriority(d: Deps, key: string, priority: number): Lane {
  return d.store.updateLane(key, (current) => {
    const lane = openLane(current, key);
    lane.priority = checkPriority(priority);
    return lane;
  });
}
export async function report(
  d: Deps,
  key: string,
  text: string,
  opts: { status?: "working" | "waiting"; evidence?: readonly string[]; waitingFor?: string } = {},
): Promise<{ sent: SendResult | undefined; progress: string[] }> {
  if (opts.waitingFor !== undefined && opts.status !== "waiting") throw new Refusal("--for needs --status waiting");
  const listed = openLane(d.store.lane(key), key);
  const request = opts.waitingFor === undefined ? undefined : parseWait(opts.waitingFor);
  const previous = listed.status === "waiting" ? listed.wait : undefined;
  let wait: Wait | undefined;
  if (request?.kind === "ci") {
    wait = await bindCiWait(
      request,
      () => headSha(d, { repo: request.repo, number: request.number, id: `${request.repo}#${request.number}` }),
      async (endpoint) => {
        const result = await d.exec("gh", ["api", "--method", "GET", endpoint]);
        if (result.code !== 0) throw new Refusal(`CI observation failed: ${(result.stderr || result.stdout).trim()}`);
        return JSON.parse(result.stdout);
      },
      d.now,
      previous,
    );
  } else if (request) {
    const probe =
      request.kind === "label" ? undefined : await d.runtimes.for(listed.sessionRef).probe(listed.sessionRef);
    wait = bindNativeWait(request, probe, d.now(), previous);
  } else if (previous && opts.status !== "working") {
    wait =
      previous.target.kind === "job" || previous.target.kind === "approval"
        ? observeWait(previous, await d.runtimes.for(listed.sessionRef).probe(listed.sessionRef))
        : previous;
  }
  const now = d.now();
  const evidence = opts.evidence ?? [];
  let progress: string[] = [];
  const updated = d.store.updateLane(key, (current) => {
    const lane = openLane(current, key);
    if (
      !sameLaneRegistration(listed, lane) ||
      lane.status !== listed.status ||
      lane.log.length !== listed.log.length ||
      lane.progressEpoch !== listed.progressEpoch ||
      JSON.stringify(lane.wait) !== JSON.stringify(listed.wait)
    )
      throw new Refusal("lane changed while observing its wait; report again");
    const still = lane.status === "waiting" ? { since: waitingSinceOf(lane), target: waitingTarget(lane) } : undefined;
    progress = applyEvidence(lane, evidence, now);
    lane.log.push({
      at: now,
      kind: "report",
      text: evidence.length ? `${text}\nevidence: ${evidence.join(" ")}` : text,
    });
    lane.lastActivityAt = now;
    if (opts.status === "waiting" || (still && opts.status === undefined)) {
      lane.waitingSince = still?.since ?? now;
      lane.waitingFor = oneName(opts.waitingFor ?? "").trim() || still?.target || blockerOf(text);
      lane.wait =
        wait ?? bindNativeWait({ kind: "label", text: lane.waitingFor }, undefined, now, still ? lane.wait : undefined);
      if (lane.wait.target.kind !== "label") progress.push(`WAIT ${renderWait(lane.wait)}`);
    } else if (opts.status === "working") {
      delete lane.wait;
      delete lane.waitingFor;
      delete lane.waitingSince;
    }
    if (opts.status) lane.status = opts.status;
    return lane;
  });
  void runHook(d, "onReport", { key, text, evidence: evidence.join(" ") });
  const head = `[REPORT ${key}${updated.status === "waiting" ? " WAITING" : ""}]`;
  const tail =
    (evidence.length ? `\n${evidenceLine(evidence)}` : "") +
    (updated.status === "waiting" && updated.wait && updated.wait.target.kind !== "label"
      ? `\nWAIT ${renderWait(updated.wait)}`
      : "");
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
  const now = d.now();
  const lane = d.store.updateLane(key, (current) => {
    const lane = openLane(current, key);
    lane.status = "ready";
    lane.final = { text, evidence: [...evidence], at: now };
    lane.lastActivityAt = now;
    lane.progressAt = now;
    lane.progressEpoch += 1;
    lane.nudges = 0;
    delete lane.escalatedAt;
    lane.log.push({ at: now, kind: "ready", text });
    return lane;
  });
  const sent = await settled(tellLead(d, `[READY ${key}] ${text}\n${evidenceLine(evidence)}`, key));
  void runHook(d, "onReady", { key, text, evidence: evidence.join(" ") });
  d.usage.record({
    name: "cataly.lane_ready",
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
  d.store.updateLane(key, (current) => {
    if (!current || !sameLaneRegistration(lane, current) || current.status !== "ready")
      throw new Refusal(`lane ${key} registration changed while closing`);
    current.status = "done";
    current.log.push({ at: d.now(), kind: "done", text: "closed by lead" });
    return current;
  });
}
