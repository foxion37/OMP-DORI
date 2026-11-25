import { expect, test } from "bun:test";
import { doctorProvenance } from "../src/doctor-provenance.ts";
import type { ModelReadback } from "../src/lane-state.ts";
import { sessionFields } from "../src/registry.ts";
import { agentIn, laneState, ternDeps, ternRef } from "./fake-tern-world.ts";
import { fakeClock, newWorld, withState } from "./fakes.ts";

const now = Date.parse("2026-01-01T12:00:00Z");
const model = { provider: "openai-codex", id: "fixture-model" };
const readback = {
  requested: model,
  observed: model,
  status: "matched",
  billing: "subscription",
  checkedAt: new Date(now).toISOString(),
  source: "native-extension",
};
const cases = [
  {
    name: "lane without a readback",
    value: undefined,
    request: "openai-codex/fixture-model",
    severity: "INFO",
    detail: "status=unknown",
  },
  {
    name: "custom-agent alias is not an exact comparison",
    value: readback,
    request: "fixture-model",
    severity: "INFO",
    detail: "request comparison=unknown",
  },
  {
    name: "same-write observation clock ordering",
    value: { ...readback, checkedAt: new Date(now + 1).toISOString() },
    request: "openai-codex/fixture-model",
    severity: "OK",
    detail: "status=matched",
  },
  {
    name: "changed exact request",
    value: readback,
    request: "other/model",
    severity: "WARN",
    detail: "recorded request differs",
  },
  {
    name: "case-insensitive catalog identity preserves colon tags",
    value: {
      ...readback,
      requested: { provider: "OPENAI-CODEX", id: "Fixture-Model:Fast" },
      observed: { ...model, id: "fixture-model:fast" },
    },
    request: "OpenAI-Codex/Fixture-Model:FAST",
    severity: "OK",
    detail: "observed=openai-codex/fixture-model:fast",
  },
  {
    name: "recorded request comparison ignores case only",
    value: readback,
    request: "OPENAI-CODEX/FIXTURE-MODEL",
    severity: "OK",
    detail: "status=matched",
  },
  {
    name: "raw exact catalog collisions may differ only by case",
    value: { ...readback, status: "mismatch", requested: { provider: "OPENAI-CODEX", id: "FIXTURE-MODEL" } },
    request: "OPENAI-CODEX/FIXTURE-MODEL",
    severity: "WARN",
    detail: "status=mismatch",
  },
  {
    name: "different catalog tags are not the same model",
    value: {
      ...readback,
      requested: { ...model, id: "fixture-model:fast" },
      observed: { ...model, id: "fixture-model:slow" },
    },
    request: "openai-codex/fixture-model:fast",
    severity: "INFO",
    detail: "status=unknown",
  },
  {
    name: "another native session cannot attest the original lane request",
    value: { ...readback, status: "unrequested", requested: null },
    observedSession: "01a11440-ee81-7f90-b2ed-dcc7d51a0ae0",
    request: "openai-codex/fixture-model",
    severity: "INFO",
    detail: "status=unknown",
  },
  ...[
    { ...readback, status: "mismatch" },
    { ...readback, status: "mismatch", observed: null },
    { ...readback, status: "unrequested" },
    { ...readback, status: "unrequested", requested: null, observed: null },
    { ...readback, status: "unavailable", requested: null },
    { ...readback, status: "matched", requested: null },
  ].map((value, index) => ({
    name: `contradictory readback ${index}`,
    value,
    request: "openai-codex/fixture-model",
    severity: "INFO" as const,
    detail: "status=unknown",
  })),
] as const;

for (const scenario of cases) {
  test(scenario.name, async () => {
    const state = withState();
    try {
      const world = newWorld();
      const pane = "5002";
      agentIn(world, pane);
      laneState(state.dir, pane, {
        ...{ modelReadback: scenario.value as ModelReadback },
        ...("observedSession" in scenario ? { sessionId: scenario.observedSession } : {}),
      });
      const findings = await doctorProvenance(
        ternDeps(world, fakeClock(now), state.dir),
        [
          {
            key: "fixture-lane",
            title: "Fixture",
            thread: "none",
            brief: "/brief",
            done: "file /done",
            openedAt: new Date(now).toISOString(),
            ...sessionFields(ternRef(pane)),
            session: "01a11440-ee81-7f90-b2ed-dcc7d51a0adf",
            model: scenario.request,
          },
        ],
        null,
      );
      const finding = findings.find((entry) => entry.detail.startsWith('lane="fixture-lane"'));
      expect(finding?.severity).toBe(scenario.severity);
      expect(finding?.detail).toContain(scenario.detail);
      if (scenario.name === "case-insensitive catalog identity preserves colon tags")
        expect(finding?.detail).toContain("requested=OPENAI-CODEX/Fixture-Model:Fast");
      if (scenario.detail === "status=unknown") expect(finding?.provenance).not.toStartWith("native-extension");
    } finally {
      state.done();
    }
  });
}
