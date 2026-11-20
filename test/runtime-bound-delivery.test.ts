import { expect, test } from "bun:test";
import { ompWorld } from "./omp-setup.ts";

for (const kind of ["herdr", "hc"] as const) {
  test(`${kind} holds an expected session mismatch at the delivery adapter`, async () => {
    const { rt, ref, w } = ompWorld(kind);
    const expected = { when: "idle", expectedSessionId: "saved-session-not-in-pane" } as const;
    expect(await rt.deliver(ref, "old goal input", expected)).toMatchObject({ kind: "not-ready" });
    expect(w.calls.some(({ argv }) => argv.includes("old goal input"))).toBe(false);
  });
}

test("Herdr checks the expected saved session again before fallback paste", async () => {
  const s = ompWorld();
  s.w.promptFails.set(s.ref.id, "agent_not_ready");
  s.w.getHook.set(s.ref.id, (observed) => {
    if (observed !== 2) return;
    s.record.sessionId = "omp-session-2";
    s.save();
  });
  const expected = { expectedSessionId: s.record.sessionId };
  expect(await s.rt.deliver(s.ref, "old goal input", expected)).toMatchObject({ kind: "not-ready" });
  expect(s.w.calls.filter(({ argv }) => argv[0] === "agent" && argv[1] === "prompt")).toHaveLength(1);
  expect(s.pane.received).toEqual([]);
  expect(s.w.calls.some(({ argv }) => argv[1] === "send-keys")).toBe(false);
});

test.each([
  ["paste", 2],
  ["Enter", 3],
] as const)("Herdr idle-only fallback stops before %s when OMP starts working", async (phase, getAt) => {
  const { w, rt, ref, pane, record, save } = ompWorld();
  w.promptFails.set(ref.id, "agent_not_ready");
  w.getHook.set(ref.id, (observed) => {
    if (observed !== getAt) return;
    record.agentStatus = "working";
    save();
  });

  const result = await rt.deliver(ref, "nudge", { expectedSessionId: record.sessionId, strictIdle: true });

  expect(w.calls.filter(({ argv }) => argv[0] === "agent")).toEqual([
    { cmd: "herdr", argv: ["agent", "prompt", ref.id, "nudge"] },
  ]);
  if (phase === "paste") {
    expect(result).toEqual({ kind: "not-ready", status: "working" });
    expect(pane.received).toEqual([]);
  } else {
    expect(result).toMatchObject({ kind: "typed", into: { pid: record.pid, sessionId: record.sessionId } });
    expect(pane.received).toEqual(["nudge"]);
  }
  expect(w.calls.some(({ argv }) => argv[1] === "send-keys")).toBe(false);
});
