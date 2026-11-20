import { expect, test } from "bun:test";
import { backendFixture, call, completed, count, created, flush } from "./voice-fixture.ts";

test("empty lifecycle output never completes a tool response; continuation is once per closed batch", async () => {
  const f = backendFixture();
  await f.backend.event(created("r1"), "d1");
  await f.backend.event(call("fast"), "d1");
  expect(count(f.wires, "response.create")).toBe(0);
  await f.backend.event(completed("r1"), "d1");
  expect(f.backend.delegations.get("d1")?.doneAt).toBeUndefined();
  expect(count(f.wires, "response.create")).toBe(1);
  await f.backend.event(completed("r1"), "d1");
  await f.backend.event(call("fast"), "d1");
  expect(count(f.wires, "response.item.create")).toBe(1);
  expect(count(f.wires, "response.create")).toBe(1);
  f.time(6000);
  await f.backend.event(created("r2"), null);
  await f.backend.event(
    { type: "response.output_text.delta", item_id: "final-message", delta: "Verified result" },
    null,
  );
  await f.backend.event(completed("r2"), null);
  expect(f.backend.delegations.get("d1")?.doneAt).toBe(6000);
  expect(f.backend.delegations.get("d1")?.finalText).toBe("Verified result");
});

test("later announced tools and overlapping delegations all settle before session-wide continuation", async () => {
  const slow = Promise.withResolvers<{ ok: boolean; result: string }>();
  const f = backendFixture(async (_name, args) =>
    JSON.stringify(args).includes("slow") ? slow.promise : { ok: true, result: "fast" },
  );
  await f.backend.event(created("r1"), "d1");
  await f.backend.event(call("fast"), "d1");
  const running = f.backend.event(call("slow", "get_status", { what: ["slow"] }), "d1");
  f.backend.created("d2", "other");
  await f.backend.event(created("other"), "d2");
  await f.backend.event(completed("r1"), "d1");
  slow.resolve({ ok: true, result: "slow" });
  await running;
  expect(count(f.wires, "response.create")).toBe(0);
  expect(f.backend.delegations.get("d1")?.doneAt).toBeUndefined();
  await f.backend.event(completed("other"), "d2");
  expect(count(f.wires, "response.create")).toBe(1);
  expect(f.backend.delegations.get("d2")?.status).toBe("completed");
});

test("independent reads run immediately while writes serialize", async () => {
  const first = Promise.withResolvers<{ ok: boolean; result: string }>();
  const order: string[] = [];
  const f = backendFixture(async (name, args) => {
    order.push(`${name}:${JSON.stringify(args)}`);
    return JSON.stringify(args).includes("first") ? first.promise : { ok: true, result: "done" };
  });
  await f.backend.event(created("r1"), "d1");
  const one = f.backend.event(call("one", "forward_to_lead", { message: "first", risky: false }), "d1");
  const two = f.backend.event(call("two", "post_note", { text: "second" }), "d1");
  await f.backend.event(call("read"), "d1");
  await flush();
  expect(order.some((s) => s.startsWith("get_status"))).toBe(true);
  expect(order.some((s) => s.startsWith("post_note"))).toBe(false);
  first.resolve({ ok: true, result: "confirmed" });
  await Promise.all([one, two]);
  expect(order.at(-1)).toContain("post_note");
});

for (const terminal of ["failed", "incomplete", "cancelled"]) {
  test(`${terminal} cancels announced and queued calls, but protects an already executing write`, async () => {
    const write = Promise.withResolvers<{ ok: boolean; result: string }>();
    let calls = 0;
    const f = backendFixture(async () => {
      calls++;
      return write.promise;
    });
    await f.backend.event(created("r1"), "d1");
    const one = f.backend.event(call("one", "forward_to_lead", {}), "d1");
    const two = f.backend.event(call("two", "forward_to_lead", {}), "d1");
    await flush();
    const pending = call("announced");
    pending.type = "response.output_item.added";
    await f.backend.event(pending, "d1");
    await f.backend.event({ type: `response.${terminal}`, response: { id: "r1" } }, "d1");
    expect(f.backend.pending.size).toBe(1);
    expect(f.backend.delegations.get("d1")?.status).toBe(terminal);
    write.resolve({ ok: true, result: "actual completed write" });
    await Promise.all([one, two]);
    await f.backend.event(call("announced"), "d1");
    expect(calls).toBe(1);
    expect(f.backend.pending.size).toBe(0);
    expect(f.wires).toHaveLength(0);
    expect(f.backend.delegations.get("d1")?.doneAt).toBeUndefined();
  });
}

test("stale server calls are retained, never fabricated or continued", async () => {
  const f = backendFixture();
  await f.backend.event(created("r1"), "d1");
  const announced = call("lost");
  announced.type = "response.output_item.added";
  await f.backend.event(announced, "d1");
  f.time(121_999);
  expect(f.backend.expired()).toBe(false);
  f.time(122_000);
  expect(f.backend.expired()).toBe(true);
  expect(f.backend.pending.size).toBe(1);
  await f.backend.event(call("lost"), "d1");
  expect(f.wires).toHaveLength(0);
  expect(f.actions).toHaveLength(0);
  expect(f.backend.delegations.get("d1")?.status).toBe("stale");
});

test("closed-session results cannot leak or start queued effects", async () => {
  const write = Promise.withResolvers<{ ok: boolean; result: string }>();
  let calls = 0;
  const f = backendFixture(async () => {
    calls++;
    return write.promise;
  });
  const one = f.backend.event(call("one", "forward_to_lead", {}), "d1");
  const two = f.backend.event(call("two", "forward_to_lead", {}), "d1");
  await flush();
  f.stop();
  write.resolve({ ok: true, result: "real result" });
  await Promise.all([one, two]);
  expect(calls).toBe(1);
  expect(f.wires).toHaveLength(0);
});

test("ambiguous untagged granular events execute no tools", async () => {
  const f = backendFixture();
  f.backend.created("d2", "r2");
  await f.backend.event(call("ambiguous"), null);
  expect(f.actions).toHaveLength(0);
  expect(f.logs).toContain("VOICE_BACKEND_UNCORRELATED response.output_item.done");
});
