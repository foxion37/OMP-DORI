import type { Deps, nativeHarnessCommand } from "./harness.ts";
import { Refusal } from "./refusal.ts";
import { refText } from "./refs.ts";
import type { HeadlessRuntime } from "./runtime/headless.ts";
import { sameLaneRegistration } from "./store-lanes.ts";
import type { Lane } from "./store-types.ts";

/** Native activation was not confirmed. The reservation remains evidence, not proof of a started goal. */
export class LaneStartupHeld extends Refusal {}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function startNativeLane(
  d: Deps,
  rt: HeadlessRuntime,
  reservation: Lane,
  native: Awaited<ReturnType<typeof nativeHarnessCommand>>,
  env: Record<string, string>,
  kickoff: string,
): Promise<Lane> {
  const { key, sessionRef: ref, cwd } = reservation;
  const bindCurrent = (patch: Pick<Lane, "policyBinding" | "sessionPath">): Lane =>
    d.store.updateLane(key, (current) => {
      if (!current || !sameLaneRegistration(reservation, current))
        throw new Refusal(`lane ${key} registration changed during native startup`);
      if (current.status === "done" || current.status === "lost") throw new Refusal(`lane ${key} is ${current.status}`);
      return { ...current, ...patch };
    });
  try {
    d.store.saveLane(reservation);
    let binding = "";
    if (native.lanePolicy !== undefined) {
      const { policyBinding, prepareLanePolicy, writeLanePolicy } =
        await import("../skills/cataly-mode/scripts/src/lane-policy-store.ts");
      const policy = prepareLanePolicy(rt.stateDir, key, native.lanePolicy, ref.id);
      if (policy) {
        writeLanePolicy(policy, { key, lifecycleEpoch: ref.id });
        binding = policyBinding(policy);
        bindCurrent({ policyBinding: binding });
      }
    }
    const seen = await rt.startNative(ref, native.argv, { ...env, CATALY_LANE_POLICY: binding });
    if (seen.role !== "lane" || seen.cwd !== cwd || !seen.sessionId || !seen.sessionFile)
      throw new Refusal("native lane did not prove the requested role, cwd and session");
    const lane = bindCurrent({ sessionPath: seen.sessionFile });
    const result = await rt.begin(ref, seen.sessionId, kickoff);
    if (result.sessionId !== seen.sessionId || result.goal?.status !== "active")
      throw new Refusal("native kickoff was not confirmed; inspect before taking further action");
    return lane;
  } catch (error) {
    // A process or kickoff might still be live. Only conclusive exit frees the lane key for a new start.
    const seen = await rt.observe(ref).catch(() => undefined);
    let recordFailure = "";
    if (seen?.status === "gone") {
      try {
        d.store.updateLane(key, (current) => {
          if (!current || !sameLaneRegistration(reservation, current) || current.status !== "working") return;
          current.status = "lost";
          current.log.push({ at: d.now(), kind: "lost", text: "native host exited during startup" });
          return current;
        });
      } catch (e) {
        recordFailure = `; could not record native exit: ${errorText(e)}`;
      }
    }
    throw new LaneStartupHeld(`lane ${key} startup held at ${refText(ref)}: ${errorText(error)}${recordFailure}`, {
      cause: error,
    });
  }
}
