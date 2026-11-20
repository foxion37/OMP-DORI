import { type Lane, statusOf } from "./registry.ts";

export const unfinishedOutcome = (lane: Lane): "parked" | "abandoned" | undefined => {
  const { receipt } = lane;
  if (!receipt || typeof receipt !== "object" || !("outcome" in receipt)) return undefined;
  return receipt.outcome === "parked" || receipt.outcome === "abandoned" ? receipt.outcome : undefined;
};

/** Read-only ledger: a resume condition describes the operator's decision, never an automatic trigger. */
export const holdLines = (lanes: readonly Lane[], thread?: string): string[] =>
  lanes
    .filter((lane) => thread === undefined || lane.thread === thread)
    .sort((a, b) => a.key.localeCompare(b.key))
    .flatMap((lane) => {
      const state =
        statusOf(lane) === "paused"
          ? "paused"
          : statusOf(lane) === "closed" && unfinishedOutcome(lane) === "parked"
            ? "parked"
            : undefined;
      if (!state) return [];
      const reason = lane.hold?.reason ?? lane.history?.at(-1)?.note ?? "not recorded";
      const recovery = state === "parked" || lane.hold?.outcome === "parked" ? "reopen" : "resume";
      return [
        `HOLD ${lane.key} state=${state} thread=${lane.thread} reason=${JSON.stringify(reason)} resumeWhen=${JSON.stringify(lane.hold?.resumeWhen ?? "explicit operator instruction")} resume=dori ${recovery} ${lane.key}`,
      ];
    });
