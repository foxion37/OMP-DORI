import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prompt } from "../src/harness.ts";

const skill = readFileSync(new URL("../skills/dori-mode/SKILL.md", import.meta.url), "utf8");
const sessions = readFileSync(new URL("../skills/dori-mode/references/sessions.md", import.meta.url), "utf8");
let promptOverride: string | undefined;
beforeEach(() => {
  promptOverride = process.env["DORI_PROMPTS_DIR"];
  delete process.env["DORI_PROMPTS_DIR"];
});
afterEach(() => {
  if (promptOverride === undefined) delete process.env["DORI_PROMPTS_DIR"];
  else process.env["DORI_PROMPTS_DIR"] = promptOverride;
});

for (const [name, render] of Object.entries({
  "lane footer": () => prompt("lane-footer.md", { key: "goal-owner", dori: "dori" }),
  "Dori skill": () => skill,
})) {
  test(`${name} reuses native or durable workflow ownership`, () => {
    const text = render();
    expect(text).toContain("Inspect the current native goal and any selected durable workflow");
    expect(text).toContain("Reuse the owner for this task");
    expect(text).toContain("Active, paused or budget-limited ownership is not an empty slot");
    expect(text).toContain("Do not add a native goal beside a durable workflow");
    expect(text).toContain("a worklog entry or lane registry record alone is not that owner");
    expect(text).toContain("Follow the host's goal and workflow rules");
  });

  test(`${name} keeps paused work paused without a user resume request`, () => {
    const text = render();
    expect(text).toContain("Leave paused work paused unless the user explicitly asks to resume it");
    expect(text).toContain("never replace another objective just to create a new one");
    expect(text).toContain("A nudge or wait event is not a resume request");
  });

  test(`${name} only creates an unowned executable objective`, () => {
    const text = render();
    expect(text).toContain("Only when no owner exists and the request calls for executable work");
    expect(text).toContain("observable `Done =` condition");
    expect(text).toContain("A question, status reply or waiting-only monitor is not a reason to create a goal");
  });
}

test("an external wait preserves ownership instead of creating an availability loop", () => {
  expect(skill).toContain("Waiting for CI, review or a monitor does not create a fresh objective");
  expect(skill).toContain("Keep the existing owner intact and use its event/wait protocol");
  expect(skill).toContain("idle without a standing availability goal");
  expect(skill).toContain("watch`, `freshness`, `dead-panes`, `guard`");
  expect(skill).toContain(
    "restore a stopped session within the scope of the owner's still-open request for that lane's work, but they do not unpause its goal or authorize a new objective by themselves",
  );
  expect(skill).toContain(
    "If recovery restores a paused goal, report the held work and wait for the user's explicit resume instruction",
  );
});

test("hand-back guidance distinguishes reopening a session from reactivating a paused goal", () => {
  expect(sessions).toContain("A reply in the original work thread is not a hand-back while main owns that work");
  expect(sessions).toContain(
    "A routine question or status-only message does not hand work back or authorize resumption",
  );
  expect(sessions).toContain(
    "While main owns the work, an explicit instruction to hand it back must reach the lead conversation or main session",
  );
  expect(skill).toContain(
    "While main owns the work, an explicit hand-back must go through the lead conversation or main session",
  );
  expect(skill).toContain("A reply in the original work thread or a monitor recovery is not a hand-back");
  expect(sessions).toContain("When work is assigned back to a closed lane, use `dori reopen <key> [--note TEXT]`");
  expect(sessions).toContain("If the native goal is paused, it confirms `/goal resume` through extension state");
  expect(sessions).toContain("The session can also reopen with no goal or with a completed or dropped goal");
  for (const doc of [sessions, skill]) {
    expect(doc.toLowerCase()).toContain("a successful reopen alone does not prove a native goal is active");
  }
  expect(sessions).toContain(
    "This is process recovery, not `dori reopen` for a closed lane. If recovery restores a paused goal, report the held work and wait for the user's explicit resume instruction.",
  );
});

test("the lane stop condition does not grant authority for external effects", () => {
  const footer = prompt("lane-footer.md", { key: "goal-owner", dori: "dori" });
  expect(footer).toContain(
    "For authorized, unpaused work, continue until the assigned deliverable meets its observable stop condition.",
  );
  expect(footer).toContain(
    "Analysis-only and review-only requests stay read-only. Merge, deployment, posting, spending and destructive actions still require the applicable explicit authorization under host and project rules. READY is evidence of work, not authorization for external effects. Hold actions lacking authorization and continue independent authorized work.",
  );
});
