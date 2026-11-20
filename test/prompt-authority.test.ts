import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prompt } from "../src/harness.ts";

describe("task scope and external-effect authority in delivered prompts", () => {
  test("the skill keeps investigation and review requests read-only", () => {
    const skill = readFileSync(new URL("../skills/dori-mode/SKILL.md", import.meta.url), "utf8");
    expect(skill).toContain(
      "Analysis-only and review-only requests authorize reading and a report, not implementation or publication.",
    );
    expect(skill).toContain(
      "Merge, deployment, posting, spending and destructive actions require the applicable explicit authorization",
    );
    expect(skill).toContain("A completed task or passing review does not grant that authorization.");
    expect(skill).not.toContain("Everything else is yours through review, merge and release.");
    expect(skill).toContain("Delete a merged PR's worktree only when cleanup is authorized");
    expect(skill).toContain("covers that cleanup without per-merge reapproval");
    expect(skill).toContain("A merge readback alone is not cleanup permission");
  });

  test("the lead requires authorization as well as exact-head review and green checks", () => {
    const lead = prompt("lead.md", { dori: "dori" });
    expect(lead).toContain("Analysis-only and review-only requests stay read-only.");
    expect(lead).toContain("If merging is explicitly authorized");
    expect(lead).toContain("`dori merge <owner/repo#N>` (CLEAR review at the exact head + green checks)");
    expect(lead).toContain("If merge authorization is absent, report the ready PR without merging it.");
    expect(lead).toContain("deployment, posting, spending or destructive actions");
    expect(lead).toContain("missing merge authorization alone does not hold lane closure");
  });

  test("lane and reviewer prompts do not turn readiness into authority", () => {
    const lane = prompt("lane-footer.md", { key: "example", dori: "dori" });
    expect(lane).toContain("Analysis-only and review-only requests stay read-only.");
    expect(lane).toContain("READY is evidence of work, not authorization for external effects.");
    expect(lane).toContain("Do not merge yourself");
    const reviewer = prompt("review.md", {
      pr: "example/repo#1",
      sha: "a".repeat(40),
      number: "1",
      repo: "example/repo",
    });
    expect(reviewer).toContain("Do not modify any files.");
    expect(reviewer).toContain(
      "A CLEAR verdict is review evidence, not permission to merge, publish, deploy or spend.",
    );
  });
});
