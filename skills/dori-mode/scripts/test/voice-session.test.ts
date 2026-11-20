import { expect, test } from "bun:test";
import { call, count, flush } from "./voice-fixture.ts";
import { fixture, voiced } from "./voice-session-fixture.ts";

test("only the owner starts a configured Live session, idle closes after two minutes, speech wakes with preroll", async () => {
  const f = fixture();
  try {
    f.engine.pcm(voiced());
    expect(f.sessions).toHaveLength(0);
    const first = await f.start();
    expect(JSON.stringify(first.wires[0])).toContain("fixture-live");
    expect(JSON.stringify(first.wires[0])).toContain("fixture-backend");
    expect(JSON.stringify(first.wires[0])).toContain('"store":false');
    f.time(120_999);
    f.engine.tick();
    expect(count(first.wires, "session.close")).toBe(0);
    f.time(121_001);
    f.engine.tick();
    expect(count(first.wires, "session.close")).toBe(1);
    first.handlers.event({ type: "session.closed", usage: { seconds: 120 } });
    await flush();
    for (let i = 0; i < 9; i++) f.engine.pcm(voiced());
    expect(f.sessions).toHaveLength(1);
    f.engine.pcm(voiced());
    expect(f.sessions).toHaveLength(2);
    const second = f.sessions[1]!;
    second.handlers.open();
    second.handlers.event({ type: "session.started", session: { id: "second" } });
    await flush();
    f.engine.tick();
    const audio = second.wires.find((e) => e["type"] === "session.input_audio.append");
    expect(Buffer.from(String(audio?.["audio"]), "base64").length).toBe(9600);
    f.engine.ownerPresence(false);
    second.handlers.event({ type: "session.closed" });
    await flush();
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});

test("usage cap keeps audio flowing during the goodbye but cannot execute or continue tools", async () => {
  const f = fixture({ dailyMinuteCap: 0.01 });
  try {
    const current = await f.start();
    f.time(2000);
    f.engine.tick();
    expect(count(current.wires, "session.instructions.append")).toBe(1);
    f.engine.pcm(voiced());
    f.time(2040);
    f.engine.tick();
    expect(count(current.wires, "session.input_audio.append")).toBeGreaterThan(0);
    current.handlers.event({ type: "session.delegation.created", delegation: { id: "d1", response_id: "r1" } });
    current.handlers.event({
      type: "response.event",
      delegation_id: "d1",
      event: call("not-executed", "forward_to_lead", { message: "work", risky: false }),
    });
    await flush();
    expect(f.counts().tools).toBe(0);
    f.time(10_000);
    f.engine.tick();
    expect(count(current.wires, "session.close")).toBe(1);
    current.handlers.event({ type: "session.closed" });
    await flush();
    for (let i = 0; i < 15; i++) f.engine.pcm(voiced());
    await flush();
    expect(f.sessions).toHaveLength(1);
    expect(f.notices).toHaveLength(1);
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});

test("provider failure halts paid work across owner re-entry; no automatic retry", async () => {
  const f = fixture();
  try {
    const current = await f.start();
    current.handlers.event({ type: "error", error: { code: "insufficient_quota" } });
    await flush();
    expect(count(current.wires, "session.close")).toBe(1);
    current.handlers.closed();
    await flush();
    f.engine.ownerPresence(false);
    f.engine.ownerPresence(true);
    for (let i = 0; i < 20; i++) f.engine.pcm(voiced());
    expect(f.sessions).toHaveLength(1);
    expect(f.notices[0]).toContain("No automatic paid retry");
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});

test("owner departure during connection never starts a late session", async () => {
  const f = fixture();
  try {
    f.engine.ownerPresence(true);
    f.engine.ownerPresence(false);
    const current = f.sessions[0]!;
    current.handlers.open();
    current.handlers.event({ type: "session.started", session: { id: "late" } });
    await flush();
    expect(current.wires).toHaveLength(0);
    expect(f.counts().tools).toBe(0);
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});

test("a stalled backend closes its session without inventing a result or running an announced call", async () => {
  const f = fixture({ idleCloseSec: 300 });
  try {
    const current = await f.start();
    current.handlers.event({ type: "session.delegation.created", delegation: { id: "d1", response_id: "r1" } });
    const pending = call("lost");
    pending.type = "response.output_item.added";
    current.handlers.event({ type: "response.event", delegation_id: "d1", event: pending });
    await flush();
    f.time(121_001);
    f.engine.tick();
    expect(count(current.wires, "session.close")).toBe(1);
    expect(count(current.wires, "response.item.create")).toBe(0);
    expect(count(current.wires, "response.create")).toBe(0);
    expect(f.counts().tools).toBe(0);
    current.handlers.closed();
    await flush();
    await f.engine.stop();
  } finally {
    f.cleanup();
  }
});
