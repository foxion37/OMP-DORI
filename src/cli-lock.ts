import { need, one, USAGE, type Args } from "./cli-args.ts";
import type { Deps } from "./harness.ts";
import { setPriority } from "./lanes.ts";
import { lockEnv, type RunEnv, runLocked } from "./lock.ts";
import { lockLine } from "./lock-list.ts";
import { checkName, checkPriority } from "./lock-queue.ts";
import { Refusal } from "./refusal.ts";
import { KEY_RE, reservedKey } from "./store-types.ts";

/**
 * `lock <name> --lane K [--priority N] -- CMD ...` and `lock <name> --list`. The turn's priority is --priority, else
 * the lane record's, else 5. Log lines go to stderr, so CMD's own output stays as it is.
 */
export async function runLock(
  d: Deps,
  a: Args,
  env: RunEnv = { ...lockEnv(d.store.root), now: d.now },
): Promise<number> {
  const name = checkName(need(a.pos[1], "lock name"));
  if (one(a, "list") === "true") {
    console.log(lockLine(env, name));
    return 0;
  }
  const lane = need(one(a, "lane"), "--lane");
  if (!KEY_RE.test(lane)) throw new Refusal(`lane key must match ${KEY_RE}`);
  const reserved = reservedKey(lane);
  if (reserved) throw new Refusal(reserved);
  const given = one(a, "priority");
  const priority = checkPriority(given === undefined ? d.store.lane(lane)?.priority : Number(given));
  if (a.rest.length === 0) throw new Refusal(`lock needs a command after --\n\n${USAGE}`);
  return runLocked(env, name, lane, priority, a.rest, (line) => console.error(line));
}

/** `priority <key> <1-9>`. */
export function runPriority(d: Deps, a: Args): number {
  const key = need(a.pos[1], "lane key");
  const lane = setPriority(d, key, Number(need(a.pos[2], "priority 1-9")));
  console.log(`PRIORITY ${lane.key} p${lane.priority}`);
  return 0;
}
