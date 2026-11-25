import { readFileSync } from "node:fs";
import { Refusal } from "../../../../src/refusal.ts";
import { resolveShortRef } from "../../../../src/refs.ts";
import { parseRef } from "../../../../src/runtime/types.ts";
import { readRootLane, rootStoreHome } from "../../../../src/store-lanes.ts";
import type { Lane as RootLane } from "../../../../src/store-types.ts";
import { Store } from "../../../../src/store.ts";
import { knownRefs } from "../../../../src/target.ts";
import { type Command, die } from "./cli-context.ts";
import { allowPolicyOnce } from "./lane-policy-actions.ts";
import { verifiedPolicyContinuation } from "./lane-policy-continuity.ts";
import { currentLanePolicy, policyBinding, readLanePolicy } from "./lane-policy-store.ts";
import { PolicyError } from "./lane-policy.ts";
import { type Lane, LANE_KEY, sameLaneGeneration, sessionOf, statusOf } from "./registry.ts";
import { isCatalyEntry } from "./session-compat.ts";

const protectedCaller = (env: NodeJS.ProcessEnv): boolean => {
  if (env["CATALY_LANE_POLICY"]) return true;
  const file = env["PI_SESSION_FILE"];
  if (!file) return false;
  try {
    let header = false;
    // Approval must originate outside the protected transcript, including branches that precede the binding.
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { type?: unknown; id?: unknown; customType?: unknown } | null;
      if (typeof entry !== "object" || entry === null) throw new PolicyError("invalid session record");
      if (entry.type === "session" && typeof entry.id === "string" && entry.id) header = true;
      if (entry.type === "custom" && isCatalyEntry(entry.customType, "omp-cataly:lane-policy")) return true;
    }
    if (!header) throw new PolicyError("missing native session header");
    return false;
  } catch (error) {
    throw new PolicyError(`cannot inspect caller session: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const rootOpen = (lane: RootLane | undefined, key: string): lane is RootLane =>
  lane?.key === key && (lane.status === "working" || lane.status === "waiting" || lane.status === "ready");

export const policyCommand: Command = async ({ positionals, strings, values, deps }) => {
  if (protectedCaller(process.env))
    return die("policy grants must be issued from the owner or lead session, not a policy-bound lane");
  const [action, key, rule, ...extra] = positionals;
  if (action !== "allow-once" || !key || !LANE_KEY.test(key) || !rule || extra.length)
    return die(
      "usage: cataly policy allow-once <key> <denyBash[index]> [--root <headless:UUID|prefix> | --skill] --reason TEXT",
    );
  const [reason, ...otherReasons] = strings("reason");
  if (!reason?.trim() || otherReasons.length) return die("allow-once requires exactly one nonempty --reason");
  const rootRefs = strings("root");
  const root = rootRefs[0];
  const skill = values["skill"] === true;
  if (values["skill"] !== undefined && !skill) return die("--skill does not take a value");
  if (values["root"] !== undefined && (rootRefs.length !== 1 || skill))
    return die("choose exactly one --root <headless:UUID> or --skill");
  const home = rootStoreHome();
  let grant: ReturnType<typeof allowPolicyOnce>;
  if (root !== undefined) {
    try {
      const store = new Store(home);
      const ref = parseRef(root) ?? resolveShortRef(root, knownRefs(store));
      if (ref?.runtime !== "headless")
        throw new PolicyError(
          "--root needs a headless ref: headless:<UUID> or the unique prefix cataly harness status shows",
        );
      grant = store.withCurrentLane(key, (target) => {
        if (!rootOpen(target, key) || target.sessionRef.runtime !== ref.runtime || target.sessionRef.id !== ref.id)
          throw new PolicyError(`no matching open root registration for ${key} at ${root}`);
        if (!target.policyBinding) throw new PolicyError(`root lane ${key} has no bound policy snapshot`);
        const policy = readLanePolicy(target.policyBinding);
        if (policy.rootRef !== ref.id || policy.snapshot.key !== key || policy.snapshot.provenance !== undefined)
          throw new PolicyError("root lane policy snapshot does not match the registered lane");
        return allowPolicyOnce(target.policyBinding, rule, reason, deps.clock.now());
      });
    } catch (error) {
      if (error instanceof Refusal) throw new PolicyError(error.message);
      throw error;
    }
  } else {
    const lookup = (target: Lane | null) => {
      if (!skill && rootOpen(readRootLane(home, key), key)) {
        if (target && statusOf(target) !== "closed")
          throw new PolicyError(`lane ${key} exists in both registries; choose --root <headless:UUID> or --skill`);
        throw new PolicyError(`root lane ${key} requires --root <headless:UUID> from its harness registration`);
      }
      if (!target || target.key !== key) throw new PolicyError(`no registered lane "${key}"`);
      if (statusOf(target) === "closed") throw new PolicyError(`lane ${target.key} is already closed`);
      return target;
    };
    const selected = await deps.registry.withCurrent(key, (lane) => {
      const target = lookup(lane);
      const policy = currentLanePolicy(deps.config.stateDir, target.key);
      if (
        policy.snapshot.generation === target.lifecycleEpoch &&
        policy.snapshot.provenance?.requestId === target.requestId &&
        (target.requestId === undefined || policy.snapshot.provenance?.runId === target.runId)
      )
        return { grant: allowPolicyOnce(policyBinding(policy), rule, reason, deps.clock.now()) };
      return { target, policy };
    });
    if (selected.grant) {
      grant = selected.grant;
    } else {
      const { target, policy } = selected;
      if (!(await verifiedPolicyContinuation(deps, target, policy)))
        throw new PolicyError("lane policy snapshot does not match the registered lane generation");
      grant = await deps.registry.withCurrent(key, (lane) => {
        const current = lookup(lane);
        const before = sessionOf(target);
        const after = sessionOf(current);
        const binding = policyBinding(currentLanePolicy(deps.config.stateDir, key));
        if (
          !sameLaneGeneration(target, current) ||
          current.nativeCloseIntent ||
          current.session !== target.session ||
          current.sessionFile !== target.sessionFile ||
          current.cwd !== target.cwd ||
          current.runId !== target.runId ||
          current.requestId !== target.requestId ||
          before?.runtime !== after?.runtime ||
          before?.id !== after?.id ||
          binding !== policyBinding(policy)
        )
          throw new PolicyError("registered lane policy changed during verification; no grant issued");
        return allowPolicyOnce(binding, rule, reason, deps.clock.now());
      });
    }
  }
  console.log(
    `POLICY_ALLOW_ONCE ${key}${root === undefined ? "" : ` root=${root}`} rule=${grant.rule} command-sha256=${grant.hash}; retry explicitly; native approvals still apply`,
  );
};
