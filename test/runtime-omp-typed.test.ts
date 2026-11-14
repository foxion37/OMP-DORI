import { describe, expect, test } from "bun:test";
import { flushInbox, send } from "../src/inbox.ts";
import { Runtimes } from "../src/runtime/registry.ts";
import { ompWorld } from "./omp-setup.ts";

const NOT_READY = "agent_not_ready";

describe("herdr: OMP typed input reconciliation", () => {
  test("an approval that opens during paste holds Enter and preserves the typed identity", async () => {
    const s = ompWorld();
    s.w.promptFails.set(s.ref.id, NOT_READY);
    s.control.onSleep = () => {
      s.record.approvalPending = true;
      s.save();
    };
    const out = await s.rt.deliver(s.ref, "one\ntwo");
    expect(out).toMatchObject({
      kind: "typed",
      into: { agent: "omp", pgid: 101, pid: 101, sessionId: "omp-session-1" },
    });
    expect(s.pane.received).toEqual(["one / two"]);
    expect(s.w.calls.some((c) => c.argv[1] === "send-keys")).toBe(false);
    if (out.kind !== "typed") throw new Error(`expected typed, got ${out.kind}`);
    expect(await s.rt.submitTyped(s.ref, out.into)).toBe("wait");
    s.record.approvalPending = false;
    s.save();
    expect(await s.rt.submitTyped(s.ref, out.into)).toBe("submitted");
    expect(s.w.calls.filter((c) => c.argv[1] === "send-keys")).toHaveLength(1);
    expect(s.pane.received).toEqual(["one / two"]);
  });

  test("a session switch on the same live pid never submits the previous session's input", async () => {
    const s = ompWorld();
    s.w.promptFails.set(s.ref.id, NOT_READY);
    s.w.keyFails = 3;
    const out = await s.rt.deliver(s.ref, "one message");
    if (out.kind !== "typed") throw new Error(`expected typed, got ${out.kind}`);
    s.record.sessionId = "omp-session-2";
    s.save();
    expect(await s.rt.submitTyped(s.ref, out.into)).toBe("changed");
    expect(s.w.calls.filter((c) => c.argv[1] === "send-keys")).toHaveLength(3);
    expect(s.pane.received).toEqual(["one message"]);
  });

  test("a legacy typed marker without OMP identity is held for reconciliation", async () => {
    const s = ompWorld();
    expect(await s.rt.submitTyped(s.ref, { agent: "omp", pgid: 101 })).toBe("changed");
    expect(s.w.calls.some((c) => c.argv[1] === "send-keys")).toBe(false);
  });

  test("inbox persistence retains OMP identity across approval waits and holds a switched session's typed batch", async () => {
    const s = ompWorld();
    const d = { ...s.w.deps(), runtimes: new Runtimes("herdr", () => s.rt) };
    s.w.promptFails.set(s.ref.id, NOT_READY);
    s.w.keyFails = 3;
    expect(await send(d, s.ref.id, "one message", "cli")).toBe("QUEUED");
    expect(d.store.queued(s.ref)[0]?.attempt).toMatchObject({
      state: "typed",
      pid: 101,
      sessionId: "omp-session-1",
    });
    s.record.approvalPending = true;
    s.save();
    expect(await flushInbox(d, s.ref)).toBe("queued");
    s.record.approvalPending = false;
    s.record.sessionId = "omp-session-2";
    s.save();
    expect(await flushInbox(d, s.ref)).toBe("held");
    expect(d.store.queued(s.ref)[0]?.attempt?.state).toBe("ambiguous");
    expect(await flushInbox(d, s.ref)).toBe("held");
    expect(s.pane.received).toEqual(["one message"]);
    expect(s.w.calls.filter((c) => c.argv[1] === "send-keys")).toHaveLength(3);
  });
});
