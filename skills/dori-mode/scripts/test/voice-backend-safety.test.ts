import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Backend } from "../src/voice/backend.ts";
import type { Action, BackendEvent, Wire } from "../src/voice/types.ts";
import { VoiceUsage } from "../src/voice/usage.ts";
import { call, completed, count, created, flush, settings, temporaryVoice } from "./voice-fixture.ts";
import { fixture, voiced } from "./voice-session-fixture.ts";

const search = (id: string): BackendEvent => ({
  type: "response.output_item.done",
  item: { id, type: "web_search_call", status: "completed" },
});

test.each(["delegation", "search", "announced-call"])("F2 backend stall holds re-entry (%s)", async (work) => {
  const f = fixture({ idleCloseSec: 300 });
  try {
    const current = await f.start();
    current.handlers.event({ type: "session.delegation.created", delegation: { id: "d1", response_id: "r1" } });
    if (work !== "delegation") {
      const event = work === "search" ? search("search") : call("announced");
      event.type = "response.output_item.added";
      current.handlers.event({ type: "response.event", delegation_id: "d1", event });
    }
    f.time(121_001);
    f.engine.tick();
    expect(count(current.wires, "session.close")).toBe(1);
    current.handlers.closed();
    await flush();
    f.engine.ownerPresence(false);
    f.engine.ownerPresence(true);
    for (let i = 0; i < 20; i++) f.engine.pcm(voiced());
    expect(f.sessions).toHaveLength(1);
    expect(f.failedSummaries).toEqual([true]);
    expect(f.notices.join("\n")).toContain("Voice is held");
    expect(f.counts().tools).toBe(0);
    expect(count(current.wires, "response.create")).toBe(0);
  } finally {
    const stopped = f.engine.stop();
    for (const session of f.sessions) session.handlers.closed();
    await stopped;
    f.cleanup();
  }
});

test.each(["closing", "capped", "stale", "terminal", "uncorrelated"])(
  "F3 hosted search accounting survives inactive lifecycle states (%s)",
  async (state) => {
    const temp = temporaryVoice();
    try {
      let now = 1000;
      let active = true;
      let tools = 0;
      const wires: Wire[] = [];
      const actions: Action[] = [];
      const config = settings({ backendUsdCap: state === "capped" ? 0.005 : 0.015 });
      const usage = new VoiceUsage(temp.directory, config, () => now);
      const backend = new Backend({
        now: () => now,
        active: () => active && !usage.capReason(),
        send: (event) => wires.push(event),
        tool: async () => {
          tools++;
          return { ok: true, result: "unexpected" };
        },
        usage: (value) => usage.backend(value, config.backendModel),
        search: () => usage.search(),
        action: (action) => actions.push(action),
        log: () => {},
      });
      backend.created("d1", "r1");
      await backend.event(created("r1"), "d1");
      await backend.event(search("first"), "d1");
      const terminal: BackendEvent = {
        type: "response.completed",
        response: { id: "r1", usage: { input_tokens: 100 } },
      };
      if (state === "closing") active = false;
      if (state === "stale") {
        now = 121_001;
        expect(backend.expired()).toBe(true);
      }
      if (state === "terminal") await backend.event(terminal, "d1");
      if (state === "uncorrelated") backend.created("d2", "r2");
      const id = state === "uncorrelated" ? null : "d1";
      await backend.event(search("second"), id);
      await backend.event(search("second"), id);
      await backend.event(search("first"), "d1");
      await backend.event(terminal, "d1");
      await backend.event(terminal, "d1");
      await backend.event(call("late", "forward_to_lead"), "d1");
      const ledger = JSON.parse(readFileSync(join(temp.directory, "usage.json"), "utf8"));
      expect(ledger.days["1970-01-01"].backendUsd).toBeCloseTo(0.0201, 8);
      expect(usage.capReason()).toBe("Backend spending limit reached");
      expect(new VoiceUsage(temp.directory, config, () => now).capReason()).toBe(usage.capReason());
      expect(actions.map((action) => action.tool)).toEqual(["web_search", "web_search"]);
      expect(tools).toBe(0);
      expect(wires).toEqual([]);
    } finally {
      temp.cleanup();
    }
  },
);

test.each(["delegation", "response", "search", "continuation"])(
  "F4 idle excludes running backend work and the completed answer window (%s)",
  async (work) => {
    const f = fixture({ idleCloseSec: 5 });
    try {
      const current = await f.start();
      const event = (value: BackendEvent) =>
        current.handlers.event({ type: "response.event", delegation_id: "d1", event: value });
      current.handlers.event({ type: "session.delegation.created", delegation: { id: "d1", response_id: "r1" } });
      if (work !== "delegation") event(created("r1"));
      if (work === "search") event({ ...search("search"), type: "response.output_item.added" });
      if (work === "continuation") {
        event(call("read"));
        await flush();
        event(completed("r1"));
      }
      await flush();
      f.time(6001);
      f.engine.tick();
      expect(count(current.wires, "session.close")).toBe(0);
      if (work === "continuation") event(created("r2"));
      if (work === "search") event(search("search"));
      event(completed(work === "continuation" ? "r2" : "r1"));
      await flush();
      f.engine.tick();
      expect(count(current.wires, "session.close")).toBe(0);
      f.time(16_002);
      f.engine.tick();
      expect(count(current.wires, "session.close")).toBe(1);
      expect(f.logs).toContain("VOICE_SESSION_CLOSING idle");
    } finally {
      const stopped = f.engine.stop();
      for (const session of f.sessions) session.handlers.closed();
      await stopped;
      f.cleanup();
    }
  },
);
