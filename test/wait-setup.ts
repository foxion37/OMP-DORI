import { startLane } from "../src/lanes.ts";
import type { Probe } from "../src/runtime/types.ts";
import { setup } from "./harness-setup.ts";

/** Real root report/duty/store code, with the native probe observation supplied at its existing boundary. */
export async function waitLane() {
  const s = setup();
  const lane = await startLane(s.d, "waiting-job", s.brief, { group: "w1" });
  const pane = s.w.panes.get(lane.sessionRef.id)!;
  pane.status = "idle";
  const control: {
    native: NonNullable<Probe["native"]> | undefined;
    duringProbe?: () => void | Promise<void>;
  } = {
    native: {
      sessionId: "native-main",
      sessionStartedAt: new Date(lane.createdAt).toISOString(),
      observedAt: lane.createdAt,
      jobs: { running: [{ id: "bg_1", startTime: lane.createdAt }], recent: [] },
      approvals: [{ sessionId: "native-main", toolCallId: "call-1", toolName: "bash" }],
    },
  };
  const runtime = s.d.runtimes.for(lane.sessionRef);
  const original = runtime.probe.bind(runtime);
  runtime.probe = async (ref) => {
    const result = await original(ref);
    if (ref.id !== lane.sessionRef.id) return result;
    const native = control.native && structuredClone({ ...control.native, observedAt: s.w.clock });
    const during = control.duringProbe;
    delete control.duringProbe;
    await during?.();
    return { ...result, ...(native ? { native } : {}) };
  };
  return { ...s, lane, pane, control };
}
