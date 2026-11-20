import { describe, expect, test } from "bun:test";
import { ok } from "node:assert/strict";
import { buildDiscordAskCard } from "../discord-ask-card.ts";
import { parseAskAnswer, projectAskForm } from "../discord-ask-form.ts";

async function project(html: string) {
  const form = await projectAskForm(html);
  ok(form, "Expected a projectable form");
  return form;
}

function choiceList(count: number) {
  const options = Array.from({ length: count }, (_, index) => `<option value="v${index}">Mode ${index}</option>`);
  return `<select name="mode">${options.join("")}</select>`;
}

describe("Discord ASK choice cards", () => {
  test("renders enabled Korean choices and keeps native submit data off the wire", async () => {
    const form = await project(`<form>
      <p>배포 전략 &lt;@123&gt; @everyone &#x202e;</p>
      <input type="hidden" name="request_id" value="private-ask-default">
      <input name="disabled_native_field" disabled value="private-disabled-default">
      <label><input type="radio" name="internal_pick" value="gradual&quot;rollout" checked>점진적 *배포*</label>
      <label><input type="radio" name="internal_pick" value="all-at-once">즉시 배포</label>
      <label><input type="radio" name="internal_pick" value="retired-path" disabled>이전 방식</label>
    </form>`);

    const card = buildDiscordAskCard(form, "ask:opaque-1");

    ok(card);
    expect(form.choices?.options).toEqual([
      { label: "점진적 *배포*", value: 'gradual"rollout', recommended: true },
      { label: "즉시 배포", value: "all-at-once", recommended: false },
    ]);
    expect(card.rows.map((row) => row.type)).toEqual([1]);
    const buttons = card.rows.flatMap((row) => row.components);
    expect(buttons.map(({ type, style, label }) => ({ type, style, label }))).toEqual([
      { type: 2, style: 1, label: "점진적 *배포* (추천)" },
      { type: 2, style: 2, label: "즉시 배포" },
    ]);
    expect(buttons.every((button) => button.custom_id.startsWith("ask:opaque-1:"))).toBe(true);
    expect([...card.answers.keys()]).toEqual(buttons.map((button) => button.custom_id));
    expect(buttons.map((button) => card.answers.get(button.custom_id))).toEqual([
      {
        request_id: "private-ask-default",
        disabled_native_field: "private-disabled-default",
        internal_pick: 'gradual"rollout',
      },
      {
        request_id: "private-ask-default",
        disabled_native_field: "private-disabled-default",
        internal_pick: "all-at-once",
      },
    ]);
    expect(card.content).toContain("배포 전략");
    expect(card.instruction).toContain("이 채널");
    const wire = JSON.stringify({ content: card.content, components: card.rows });
    expect(wire).not.toMatch(
      /internal_pick|request_id|private-|disabled_native_field|gradual|all-at-once|retired-path|<@123>|@everyone|\u202e/,
    );
  });

  test("uses a numbered button and shows the complete long label in the body", async () => {
    const longLabel =
      "Keep current jobs running while the updated worker configuration reaches every deployment region worldwide";
    const form = await project(`<select name="plan">
      <option value="restart">Restart workers</option>
      <option value="rollout" selected>${longLabel}</option>
    </select>`);

    const card = buildDiscordAskCard(form, "ask:opaque-2");

    ok(card);
    expect(card.rows.flatMap((row) => row.components).map((button) => [button.label, button.style])).toEqual([
      ["Restart workers", 2],
      ["Option 2 (Recommended)", 1],
    ]);
    expect(card.content).toContain(`Option 2: ${longLabel}`);
    expect(card.instruction).toContain("Discord Reply");
    expect(parseAskAnswer(form, "Restart workers")).toEqual({ data: { plan: "restart" } });
  });

  test("does not recommend an enabled alternative when only a disabled choice is selected", async () => {
    const form = await project(`<select name="internal_mode">
      <option value="old" selected disabled>Unavailable</option><option value="new">Available</option>
    </select>`);

    const card = buildDiscordAskCard(form, "ask:opaque-3");

    expect(card?.rows.flatMap((row) => row.components).map(({ label, style }) => [label, style])).toEqual([
      ["Available", 2],
    ]);
    expect(card?.content).not.toContain("internal_mode");
  });

  test("accepts ordinary delegation text as Other rather than submitting the checked choice", async () => {
    const form = await project(`<form>
      <label><input name="plan" type="radio" value="gradual" checked>Gradual</label>
      <label><input name="plan" type="radio" value="full">Full</label>
    </form>`);

    expect(parseAskAnswer(form, "너가 원하는대로 진행해", true)).toEqual({ data: { plan: "너가 원하는대로 진행해" } });
  });

  test("treats JSON-shaped channel text as a literal textarea value", async () => {
    const form = await project('<textarea name="answer"></textarea>');
    expect(parseAskAnswer(form, '{"answer":"draft"}', true)).toEqual({ data: { answer: '{"answer":"draft"}' } });
    expect(parseAskAnswer(form, "[draft]", true)).toEqual({ data: { answer: "[draft]" } });
  });

  test.each([
    ["text", '<input name="answer">', true],
    ["textarea", '<textarea name="answer"></textarea>', true],
    ["number", '<input name="answer" type="number">', false],
    ["select", '<select name="plan"><option value="a">A</option></select>', false],
    [
      "explicit Other",
      '<input type="radio" name="plan" value="a"><label><input type="radio" name="plan" value="other">Other</label>',
      false,
    ],
    ["multiple editable fields", '<input name="answer"><textarea name="reason"></textarea>', false],
  ] as const)("sets ordinary channel-text eligibility for %s", async (_kind, html, acceptsPlainText) => {
    const form = await project(html);

    expect(form.acceptsPlainText === true).toBe(acceptsPlainText);
  });

  test.each([
    ["checkbox", '<label><input type="checkbox" name="agree">Agree</label>'],
    ["multi-select", '<select name="plan" multiple><option value="a">A</option></select>'],
    [
      "select with a second editable field",
      '<select name="plan"><option value="a">A</option></select><input name="reason">',
    ],
  ] as const)("preserves the summary fallback for %s", async (_kind, html) => {
    const form = await project(html);

    expect(buildDiscordAskCard(form, "ask:opaque-4")).toBeUndefined();
    expect(form.choices).toBeUndefined();
    expect(form.summary).toContain("JSON field map");
  });

  test("uses the fallback rather than exposing a field name for an unlabeled choice", async () => {
    const form = await project('<input type="radio" name="internal_plan" value="raw">');

    expect(buildDiscordAskCard(form, "ask:opaque-5")).toBeUndefined();
  });

  test("packs exactly 25 buttons across five native rows", async () => {
    const form = await project(choiceList(25));

    const card = buildDiscordAskCard(form, "ask:limit");

    expect(card?.rows.map((row) => row.components.length)).toEqual([5, 5, 5, 5, 5]);
    expect(card?.answers.size).toBe(25);
  });

  test("uses the fallback when more than 25 buttons would be needed", async () => {
    const form = await project(choiceList(26));

    expect(buildDiscordAskCard(form, "ask:limit")).toBeUndefined();
  });

  test("uses the fallback rather than emitting an overlong custom ID", async () => {
    const form = await project(choiceList(1));

    expect(buildDiscordAskCard(form, "x".repeat(99))).toBeUndefined();
  });
});
