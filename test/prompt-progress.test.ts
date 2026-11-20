import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { prompt } from "../src/harness.ts";

const skill = readFileSync(new URL("../skills/dori-mode/SKILL.md", import.meta.url), "utf8");
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
  "Dori skill": () => skill,
  "duty prompt": () => prompt("duty.md", { dori: "dori" }),
})) {
  test(`${name} reports observed transitions instead of unchanged CI waits`, () => {
    const text = render();
    expect(text).toContain("meaningful state changes, new evidence or a real blocker");
    expect(text).toContain("available tool/result boundaries");
    expect(text).toContain("Unchanged CI or review waits are not new progress");
    expect(text).toContain("Report a newly observed failure or completion once per transition");
    expect(text).toContain("do not repeat an unchanged update");
  });

  test(`${name} does not manufacture reporting-only model turns`, () => {
    const text = render();
    expect(text).toContain("Do not start a model goal, timer or polling turn solely to manufacture a status update");
    expect(text).not.toContain("progress reply every 15 minutes");
    expect(text).toContain("A progress report does not pause, relaunch or close work");
  });

  test(`${name} retains code watches and explicit long-silence policy`, () => {
    const text = render();
    expect(text).toContain("Keep existing code-based watches and inbound delivery running");
    expect(text).toContain("Silence is not success or acceptance");
    expect(text).toContain("explicit reporting cadence and the existing silence/escalation policy");
    expect(text).toContain("attention signals, not new work evidence");
  });
}

test("duty retains its ordinary code loop and reports through the lead", () => {
  const text = prompt("duty.md", { dori: "dori" });
  expect(text).toContain("dori duty --interval 60");
  expect(text).toContain("40 minutes without progress");
  expect(text).toContain("Never merge and never talk to the human");
  expect(text).toContain("Escalate to the lead");
  expect(text).toContain("Report only your own interventions or a change the lane or duty loop has not already sent");
  expect(text).toContain("the lead's explicit reporting cadence");
  expect(text).toContain("A requested cadence uses a code-based watch, not a model timer");
  expect(skill).toContain("An owner-requested cadence is a code-based watch you set, not a model timer");
});
