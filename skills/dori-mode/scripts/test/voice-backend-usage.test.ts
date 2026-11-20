import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLiveEvent } from "../src/voice/provider.ts";
import type { BackendEvent } from "../src/voice/types.ts";
import { backendFixture, call, count, created, flush } from "./voice-fixture.ts";
import { fixture } from "./voice-session-fixture.ts";

const terminals = ["completed", "failed", "incomplete", "cancelled"] as const;
const terminal = (type: (typeof terminals)[number], id: string): BackendEvent => ({
  type: `response.${type}`,
  response: {
    id,
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
    },
  },
});

test.each(["capped", "closing"])("terminal usage survives an unadmitted delegation after %s", async (state) => {
  const finalized: { delegations: number; pending: number }[] = [];
  const f = fixture({ backendUsdCap: 0.005 }, async (session) => {
    finalized.push({ delegations: session.backend.delegations.size, pending: session.backend.pending.size });
  });
  try {
    const current = await f.start();
    const deliver = (value: unknown) => current.handlers.event(parseLiveEvent(value));
    if (state === "capped") {
      f.usage.search();
      f.engine.tick();
      expect(count(current.wires, "session.instructions.append")).toBe(1);
    } else {
      f.engine.ownerPresence(false);
      expect(count(current.wires, "session.close")).toBe(1);
    }
    deliver({ type: "session.delegation.created", delegation: { id: "late", response_id: "late-response" } });
    deliver({ type: "response.event", delegation_id: "late", event: call("late-call", "forward_to_lead") });
    const response = terminal("completed", "late-response");
    deliver({ type: "response.event", delegation_id: "late", event: response });
    deliver({ type: "response.event", delegation_id: null, event: response });
    await flush();
    const ledger = JSON.parse(readFileSync(join(f.directory, "usage.json"), "utf8"));
    expect(ledger.days["1970-01-01"].backendUsd).toBeCloseTo((state === "capped" ? 0.01 : 0) + 0.001345, 8);
    expect(f.logs).toContain("VOICE_BACKEND_UNCORRELATED response.completed");
    expect(f.logs).not.toContain("VOICE_EVENT_FAILED");
    expect(f.counts().tools).toBe(0);
    expect(count(current.wires, "response.item.create")).toBe(0);
    expect(count(current.wires, "response.create")).toBe(0);
  } finally {
    const stopped = f.engine.stop();
    for (const session of f.sessions) session.handlers.closed();
    await stopped;
    await flush();
    f.cleanup();
  }
  expect(finalized).toEqual([{ delegations: 0, pending: 0 }]);
});

test.each(terminals)("unresolved %s usage stays deduplicated when its owner becomes known", async (type) => {
  const f = backendFixture();
  const response = terminal(type, "orphan");
  await f.backend.event(response, "unadmitted");
  await f.backend.event(response, null);
  expect(f.counts().usages).toBe(1);
  expect(f.backend.delegations.size).toBe(1);
  expect(f.backend.delegations.get("d1")?.responses.size).toBe(0);
  expect(f.logs).toContain(`VOICE_BACKEND_UNCORRELATED response.${type}`);
  f.backend.created("d2", "orphan");
  await f.backend.event(response, "d2");
  await f.backend.event(response, null);
  expect(f.counts().usages).toBe(1);
  expect(f.backend.delegations.get("d2")?.responses.get("orphan")?.terminal).toBe(type);
  await f.backend.event(terminal(type, "another-orphan"), null);
  expect(f.counts().usages).toBe(2);
  expect(f.backend.delegations.size).toBe(2);
  expect(f.backend.pending.size).toBe(0);
  expect(f.actions).toEqual([]);
  expect(f.wires).toEqual([]);
});

test.each(terminals)("known %s responses record usage once and retain continuation routing", async (type) => {
  const f = backendFixture();
  await f.backend.event(created("r1"), "d1");
  await f.backend.event(call("read"), "d1");
  const response = terminal(type, "r1");
  await f.backend.event(response, null);
  await f.backend.event(response, "d1");
  await f.backend.event({ ...response, type: "response.cancelled" }, null);
  expect(f.counts().usages).toBe(1);
  expect(f.backend.delegations.get("d1")?.responses.get("r1")?.terminal).toBe(type);
  expect(f.backend.pending.size).toBe(0);
  expect(count(f.wires, "response.item.create")).toBe(1);
  expect(count(f.wires, "response.create")).toBe(type === "completed" ? 1 : 0);
  f.backend.created("d2", "r2");
  await f.backend.event(terminal(type, "r2"), null);
  await f.backend.event(terminal(type, "r2"), "d2");
  expect(f.counts().usages).toBe(2);
  expect(f.logs).toEqual([]);
});

test("a terminal notification without usage does not mask a later billable receipt", async () => {
  const f = fixture();
  try {
    const current = await f.start();
    current.handlers.event({ type: "session.delegation.created", delegation: { id: "d1", response_id: "r1" } });
    for (const event of [
      { type: "response.completed", response: { id: "r1" } },
      terminal("completed", "r1"),
      terminal("completed", "r1"),
    ])
      current.handlers.event({ type: "response.event", delegation_id: "d1", event });
    await flush();
    const ledger = JSON.parse(readFileSync(join(f.directory, "usage.json"), "utf8"));
    expect(ledger.days["1970-01-01"].backendUsd).toBeCloseTo(0.001345, 8);
    expect(count(current.wires, "response.create")).toBe(0);
  } finally {
    const stopped = f.engine.stop();
    for (const session of f.sessions) session.handlers.closed();
    await stopped;
    f.cleanup();
  }
});
