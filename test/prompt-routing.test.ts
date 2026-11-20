import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fill } from "../src/harness.ts";

describe("consistent lead and skill routing", () => {
  const surfaces = {
    lead: () => fill(readFileSync(new URL("../prompts/lead.md", import.meta.url), "utf8"), { dori: "dori" }),
    skill: () => readFileSync(new URL("../skills/dori-mode/SKILL.md", import.meta.url), "utf8"),
  };
  for (const [name, render] of Object.entries(surfaces)) {
    test(`${name}: questions and explicitly main-scoped implementation stay direct`, () => {
      const text = render();
      expect(text).toContain("Answer questions, status checks and lookups directly.");
      expect(text).toContain(
        "Do small local changes directly, and honor an explicit request to work in the main session, including implementation.",
      );
      expect(text).not.toContain("Turn each request from the human into a lane");
      expect(text).not.toContain("Never do a lane's work in this pane.");
    });
    test(`${name}: independent work keeps its lane without mandatory supervisors`, () => {
      const text = render();
      expect(text).toContain(
        "Use a lane when independent work needs its own topic, repository, lifetime or parallel ownership.",
      );
      expect(text).toContain(
        "A PR or several steps alone does not require a lane, a planning ceremony or a supervisor/worker pair.",
      );
      expect(text).toContain(
        "A lane executes its task directly; native tasks are optional for bounded subtasks, not a replacement for an independent lane.",
      );
    });
  }
  test("the skill retains launch holds, idle-lane reuse and work threads", () => {
    const skill = surfaces.skill();
    expect(skill).toContain("If an idle lane already owns that repo or topic");
    expect(skill).toContain("If `dori can-launch` says HOLD");
    expect(skill).toContain("substantive messenger work gets a work thread before execution");
    expect(skill).toContain("A follow-up to existing work continues in its original thread");
  });
});
