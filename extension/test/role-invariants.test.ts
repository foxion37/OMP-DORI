import { beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { nativeComposition, SOL_MODEL } from "../../test/fixtures/omp-native-host/compose.ts";
import { LANE_BOOKKEEPING } from "../lane-bookkeeping.ts";
import { ROLE_INVARIANTS } from "../role-invariants.ts";
import { load, useConfig } from "./fake-pi.ts";

const cataly = join(import.meta.dir, "../index.ts");
const ASTRA = { ...SOL_MODEL, id: "gpt-6-astra", name: "GPT-6 Astra" };

beforeEach(() => {
  useConfig();
});

for (const role of ["cataly", "lane"] as const) {
  for (const model of [SOL_MODEL, ASTRA]) {
    test(`${role} root on ${model.id} retains its core across an in-memory compaction entry`, async () => {
      const base = ["  Host system policy\n", "Retained downstream context  "];
      const original = [...base];
      const expected = [
        ...base,
        ROLE_INVARIANTS[role],
        ...(role === "lane" && model.id === SOL_MODEL.id ? [LANE_BOOKKEEPING] : []),
      ];
      const result = await nativeComposition([cataly], base, { role, model, compact: true });
      const [before, after] = result.compactionMessages;
      expect(JSON.stringify(before)).toContain("History-only role instruction");
      expect(JSON.stringify(after)).not.toContain("History-only role instruction");
      expect(JSON.stringify(after)).toContain("Local fixture summary");
      expect(result.entries.filter((entry) => entry.type === "compaction")).toHaveLength(1);
      expect(result.first).toEqual(expected);
      expect(result.second).toEqual(expected);
      expect(result.postCompaction?.systemPrompt).toEqual(expected);
      expect(result.afterAll).toEqual([expected, expected, expected]);
      expect(JSON.stringify(result.second)).toContain("Paused work waits for the user's explicit resume instruction");
      expect(JSON.stringify(result.second)).toContain("Use the applicable explicit authorization");
      if (role === "lane") {
        const guidance = JSON.stringify(result.postCompaction?.systemPrompt);
        expect(guidance).toContain("Use the supplied brief/footer for lead milestones and handoffs.");
        expect(guidance).toContain("For direct replies, follow the route selected by the host");
      }
      expect(base).toEqual(original);
    });
  }
}

test("plain native sessions stay unchanged before and after compaction", async () => {
  const base = ["Host system policy"];
  const result = await nativeComposition([cataly], base, { model: ASTRA, compact: true });
  expect(result.firstResult).toBeUndefined();
  expect(result.secondResult).toBeUndefined();
  expect(result.postCompaction).toBeUndefined();
  expect(result.afterAll).toEqual([base, base, base]);
  expect(JSON.stringify(result.compactionMessages[1])).not.toContain("History-only role instruction");
});

test("an inherited child role gets no root invariant block after compaction", async () => {
  const parent = { kind: "main", id: "InvariantParent", name: "Main", depth: 0 } as const;
  await nativeComposition([cataly], ["Parent policy"], { role: "lane", agent: parent });
  const base = ["Child policy"];
  const result = await nativeComposition([cataly], base, {
    agent: { kind: "sub", id: "InvariantChild", name: "Child", depth: 1, parentId: parent.id },
    compact: true,
  });
  expect(result.firstResult).toBeUndefined();
  expect(result.secondResult).toBeUndefined();
  expect(result.postCompaction).toBeUndefined();
  expect(result.afterAll).toEqual([base, base, base]);
  expect(JSON.stringify(result.compactionMessages[1])).not.toContain("History-only role instruction");
});

test("native composition does not append an existing role core or Sol bookkeeping again", async () => {
  const base = ["Host policy", ROLE_INVARIANTS.lane, LANE_BOOKKEEPING];
  const original = [...base];
  const result = await nativeComposition([cataly], base, { role: "lane", model: SOL_MODEL });
  expect(result.firstResult).toBeUndefined();
  expect(result.secondResult).toBeUndefined();
  expect(result.afterAll).toEqual([original, original]);
  expect(base).toEqual(original);
});

test("invalid host prompt payloads are not replaced with an invented prompt", async () => {
  const pi = await load({
    session: { id: "invariant-invalid", entries: [] },
    flags: { "cataly-role": "cataly" },
    model: ASTRA,
  });
  await pi.emit("session_start");
  for (const systemPrompt of [undefined, "host", ["host", 1]])
    expect(await pi.emit("before_agent_start", { systemPrompt })).toEqual([undefined]);
});
