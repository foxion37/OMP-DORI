#!/usr/bin/env bun
import { resolve } from "node:path";
import { bindCliEnvironment } from "./cli-environment.ts";
import { runLock, runPriority } from "./cli-lock.ts";
import { runBacklog, runDuty, runLoop } from "./cli-loops.ts";
import { status, up } from "./cli-up.ts";
import { done, ready, report, startLane } from "./lanes.ts";
import { mergeGate, review } from "./gate.ts";
import { need, one, parse, textOf, USAGE } from "./cli-args.ts";
import { defaultDeps, ROLES, type Deps } from "./harness.ts";
import { stopNativeHarness } from "./harness-native-stop.ts";
import { nativeDialogTarget, nativeInventory, withHarnessLock } from "./harness-native.ts";
import { ConfigError, hooksSettled } from "./hooks.ts";
import { send, type SendResult } from "./inbox.ts";
import { inboxList, releaseHeld, sendToShell } from "./inbox-held.ts";
import { Refusal } from "./refusal.ts";
import { runOwner } from "./cli-owner.ts";
import { refText } from "./refs.ts";
import { HeadlessRuntime } from "./runtime/headless.ts";
import { HeadlessError } from "./runtime/headless-record.ts";
import { ConfigError as RuntimeConfigError, RuntimeChoiceError } from "./runtime/select.ts";
import { parseRef } from "./runtime/types.ts";
import type { Role } from "./store-types.ts";
import { resolveTarget } from "./target.ts";

const COMMANDS = new Set([
  "up",
  "stop",
  "observe",
  "answer",
  "role",
  "start",
  "report",
  "ready",
  "send",
  "inbox",
  "duty",
  "review",
  "merge",
  "done",
  "status",
  "loop",
  "backlog",
  "lock",
  "priority",
  "owner",
]);

/** Prints the line for a delivery that did not land now and returns the exit code: HELD 3, everything else 0. */
function deliveryOutcome(result: SendResult | undefined, target: string): number {
  if (result === "HELD") {
    console.log(`HELD ${target}: delivery may or may not have reached the pane; do not resend`);
    return 3;
  }
  if (result === "QUEUED") console.log(`QUEUED ${target}`);
  return 0;
}

export async function main(argv: readonly string[], d: Deps = defaultDeps()): Promise<number> {
  const a = parse(argv);
  // --help is a boolean flag, so the word after it is the command: print the usage instead of running it.
  if (a.flags.has("help")) {
    console.log(USAGE);
    return 0;
  }
  const [cmd, x] = a.pos;
  if (cmd !== undefined && COMMANDS.has(cmd)) d.usage.touch();
  switch (cmd) {
    case "up":
      await up(d, resolve(one(a, "cwd") ?? process.cwd()), a.flags.has("fresh"));
      return 0;
    case "stop":
      if (x !== undefined || a.flags.size || a.rest.length) throw new Refusal("usage: cataly harness stop (no force)");
      await stopNativeHarness(d);
      return 0;
    case "observe":
    case "answer": {
      const ref = resolveTarget(d, need(x, "native role, lane or ref"));
      if (ref.runtime !== "headless") throw new Refusal(`${cmd} requires a native headless session`);
      const binding = await nativeDialogTarget(d, ref);
      const native = binding?.runtime ?? d.runtimes.for(ref);
      if (!(native instanceof HeadlessRuntime)) throw new Refusal("native runtime is unavailable");
      if (cmd === "observe") {
        const seen = await native.observe(ref);
        if (
          binding &&
          ((seen.harnessRole !== undefined && seen.harnessRole !== binding.role) ||
            (seen.sessionId !== undefined && seen.sessionId !== binding.sessionId))
        )
          throw new Refusal(`${binding.role} native session identity has changed`);
        console.log(JSON.stringify(seen));
      } else {
        const session = need(one(a, "session"), "--session from observe");
        if (binding && binding.sessionId !== session)
          throw new Refusal(`${binding.role} answer session does not match the owned native session`);
        const request = need(one(a, "request"), "--request from observe");
        let answer;
        try {
          answer = JSON.parse(await textOf(a));
        } catch {
          throw new Refusal("provide a JSON answer with --text or stdin");
        }
        // The broker validates both native identities and the answer shape, never granting future approval.
        await native.answer(ref, request, answer, session);
        console.log("ANSWER SUBMITTED (inspect observe; OMP does not acknowledge a dialog reply)");
      }
      return 0;
    }
    case "role": {
      const role = need(x, "role") as Role;
      if (!ROLES.includes(role)) throw new Refusal(`role must be one of ${ROLES.join(", ")}`);
      const given = a.pos[2];
      const ref = given === undefined ? d.runtimes.selfAny(process.env) : parseRef(given);
      if (given !== undefined && ref === undefined) throw new Refusal(`${given} is not a session ref (tern:42)`);
      if (ref === undefined) throw new Refusal(`missing session ref (not inside tern?)\n\n${USAGE}`);
      await withHarnessLock(d, () => {
        if (ref.runtime === "headless" || nativeInventory(d))
          throw new Refusal("native lead and duty roles are registered by cataly harness up, not by hand");
        d.store.setRole(role, ref);
      });
      console.log(`ROLE ${role}=${refText(ref)}`);
      return 0;
    }
    case "start": {
      const cwd = one(a, "cwd");
      const workspace = one(a, "workspace");
      const priority = one(a, "priority");
      const lane = await startLane(d, need(x, "lane key"), need(one(a, "brief"), "--brief"), {
        ...(cwd !== undefined ? { cwd } : {}),
        ...(workspace !== undefined ? { group: workspace } : {}),
        ...(priority !== undefined ? { priority: Number(priority) } : {}),
      });
      console.log(`STARTED ${lane.key} pane=${refText(lane.sessionRef)} brief=${lane.brief}`);
      return 0;
    }
    case "report": {
      const st = one(a, "status");
      if (st && st !== "working" && st !== "waiting") throw new Refusal("--status must be working or waiting");
      const waitingFor = one(a, "for");
      const { sent, progress } = await report(d, need(x, "lane key"), await textOf(a), {
        ...(st ? { status: st as "working" | "waiting" } : {}),
        evidence: a.flags.get("evidence") ?? [],
        ...(waitingFor !== undefined ? { waitingFor } : {}),
      });
      console.log(`REPORTED ${x}`);
      for (const line of progress) console.log(line);
      return deliveryOutcome(sent, "lead");
    }
    case "ready": {
      const sent = await ready(d, need(x, "lane key"), await textOf(a), a.flags.get("evidence") ?? []);
      console.log(`READY ${x}`);
      return deliveryOutcome(sent, "lead");
    }
    case "send": {
      const target = need(x, "target");
      const deliver = one(a, "to-shell") === "true" ? sendToShell : send;
      const sent = await deliver(d, target, await textOf(a), one(a, "from") ?? process.env["CATALY_LANE"] ?? "cli");
      if (sent === "DELIVERED") console.log(`DELIVERED ${target}`);
      return deliveryOutcome(sent, target);
    }
    case "inbox": {
      const target = need(a.pos[2], "target");
      if (x === "list") {
        const { paneId, entries } = inboxList(d, target);
        if (entries.length === 0) console.log(`EMPTY ${paneId}`);
        for (const e of entries)
          console.log(`${e.index} ${e.state} from ${e.from} queued ${new Date(e.at).toISOString()} ${e.preview}`);
        return 0;
      }
      if (x === "ack" || x === "resend") {
        const index = Number(need(a.pos[3], "entry index (see cataly harness inbox list)"));
        const paneId = releaseHeld(d, target, index, x);
        console.log(
          x === "ack" ? `ACKED ${paneId} ${index}` : `RELEASED ${paneId} ${index}: the next flush delivers it`,
        );
        return 0;
      }
      throw new Refusal(`unknown inbox command ${x}\n\n${USAGE}`);
    }
    case "duty":
      return runDuty(d, a, x);
    case "loop":
      return runLoop(d, a, x);
    case "backlog":
      return runBacklog(d, a, x);
    case "review": {
      const r = await review(d, need(x, "PR"), one(a, "model"));
      console.log(`REVIEW ${x} head=${r.sha} verdict=${r.verdict}`);
      return r.verdict === "CLEAR" ? 0 : 1;
    }
    case "merge":
      console.log(await mergeGate(d, need(x, "PR"), { dryRun: one(a, "dry-run") === "true" }));
      return 0;
    case "done":
      await done(d, need(x, "lane key"));
      console.log(`DONE ${x}`);
      return 0;
    case "lock":
      return runLock(d, a);
    case "priority":
      return runPriority(d, a);
    case "owner":
      return runOwner(d, a, x);
    case "status":
      await status(d);
      return 0;
    default:
      console.log(USAGE);
      return cmd === undefined || cmd === "help" ? 0 : 64;
  }
}

if (import.meta.main) {
  bindCliEnvironment();
  const deps = defaultDeps();
  let code = 0;
  try {
    code = await main(process.argv.slice(2), deps);
  } catch (e) {
    if (!(
      e instanceof Refusal ||
      e instanceof HeadlessError ||
      e instanceof ConfigError ||
      e instanceof RuntimeConfigError ||
      e instanceof RuntimeChoiceError
    ))
      throw e;
    console.error(e.message);
    code = 2;
  } finally {
    await hooksSettled();
    await deps.usage.flush(2000);
  }
  process.exit(code);
}
