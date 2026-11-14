import { beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { isSol, LANE_BOOKKEEPING, withLaneBookkeeping } from "../lane-bookkeeping";
import { load, useConfig } from "./fake-pi";

const SOL = { id: "gpt-6.1-sol", name: "GPT-6.1 Sol" };
const base = { type: "before_agent_start", prompt: "fix it", systemPrompt: ["base prompt"] };

beforeEach(() => {
  useConfig(join(import.meta.dir, "fake-ulw.ts"));
});

type Agent = { kind: "main" | "sub"; id: string; parentId?: string };

const roleSession = async (role: string | undefined, model = SOL, agent?: Agent) => {
  const pi = await load({
    session: { id: `s-${role}-${model.id}`, entries: [] },
    flags: role ? { "dori-role": role } : {},
    model,
    ...(agent ? { agent } : {}),
  });
  await pi.emit("session_start");
  return pi;
};

describe("lane bookkeeping", () => {
  test("a lane's main agent on Sol gets the bookkeeping block after the base prompt", async () => {
    const [own] = await (await roleSession("lane")).emit("before_agent_start", base);
    expect(own).toEqual({ systemPrompt: ["base prompt", LANE_BOOKKEEPING] });
  });

  test("the Dori session, plain sessions, subagents and other models keep their prompt", async () => {
    for (const pi of [
      await roleSession("dori"),
      await roleSession(undefined),
      await roleSession("lane", { id: "claude-opus-5-5", name: "Claude Opus 5.5" }),
      await roleSession("lane", { id: "gpt-6.1-terra", name: "GPT-6.1 Terra" }),
    ])
      expect((await pi.emit("before_agent_start", base))[0]).toBeUndefined();
  });

  test("a subagent of a Sol lane inherits the lane role but not the block", async () => {
    await roleSession("lane", SOL, { kind: "main", id: "LaneMain" });
    const sub = await roleSession(undefined, SOL, { kind: "sub", id: "LaneSub", parentId: "LaneMain" });
    const [own, ulw] = await sub.emit("before_agent_start", base);
    expect(own).toBeUndefined();
    expect(ulw).toEqual({ systemPrompt: ["base prompt", "<fake-ulw-policy>"] });
  });

  test("Sol is recognised across provider prefixes, separators and display names only", () => {
    for (const id of ["gpt-6.1-sol", "openai-codex/gpt-6.1-sol", "gpt-61-sol", "gpt_6_1_sol-fast", "GPT-6-1-SOL"])
      expect(isSol({ id })).toBe(true);
    expect(isSol({ id: "custom-alias", name: "GPT-6.1 Sol" })).toBe(true);
    for (const id of ["gpt-6-sol", "gpt-6.1-solar", "gpt-6.1-terra", "gpt-16.1-sol", "consol-gpt-6.1"])
      expect(isSol({ id })).toBe(false);
    expect(isSol(undefined)).toBe(false);
  });

  test("a prompt that already carries the block, or is not a block list, is left alone", () => {
    expect(withLaneBookkeeping(["base", LANE_BOOKKEEPING], SOL)).toBeUndefined();
    expect(withLaneBookkeeping("base", SOL)).toBeUndefined();
    expect(withLaneBookkeeping(["base", 1], SOL)).toBeUndefined();
  });
});
