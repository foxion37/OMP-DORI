import { describe, expect, test } from "bun:test";
import { parseAskAnswer, projectAskForm } from "../discord-ask-form";

async function project(html: string) {
  const form = await projectAskForm(html);
  expect(form).toBeDefined();
  return form!;
}

describe("Discord native ASK projection", () => {
  test("projects a realistic native form and keeps hidden defaults private", async () => {
    const form = await project(`
      <form>
        <h2>Deployment decision</h2>
        <p>Choose the rollout plan. Existing jobs keep running.</p>
        <input type="hidden" name="request_id" value="synthetic-private-default">
        <fieldset><legend>Rollout</legend>
          <label for="plan">Release strategy</label>
          <select id="plan" name="plan" required>
            <option value="gradual" selected>Gradual rollout</option>
            <option value="all">All at once</option>
            <option value="retired" disabled>Retired strategy</option>
          </select>
          <label>Reason <textarea name="reason" required minlength="3" placeholder="Describe the change">Keep the queue stable</textarea></label>
          <label>Batch size <input type="number" name="batch" min="1" max="20" value="4"></label>
        </fieldset>
      </form>`);
    expect(form.summary).toContain("Deployment decision");
    expect(form.summary).toContain("Existing jobs keep running.");
    expect(form.summary).toContain("Rollout");
    expect(form.summary).toContain('`"plan"`');
    expect(form.summary).toContain('`"gradual"` (Gradual rollout)');
    expect(form.summary).toContain("required");
    expect(form.summary).toContain("Describe the change");
    expect(form.summary).not.toContain("retired");
    expect(form.summary).not.toContain("synthetic-private-default");
    expect(Object.keys(form)).toEqual(["summary"]);
    expect(JSON.stringify(form)).not.toContain("synthetic-private-default");
    expect(form.summary.length).toBeLessThanOrEqual(1_500);
    expect(parseAskAnswer(form, '{"plan":"all","reason":"Owner approved"}')).toEqual({
      data: { request_id: "synthetic-private-default", plan: "all", reason: "Owner approved", batch: 4 },
    });
    expect(parseAskAnswer(form, '{"request_id":"replace"}')).toMatchObject({
      error: expect.stringContaining("Unknown or disabled field"),
    });
  });

  test("uses native defaults for omitted text, numbers and single selects", async () => {
    const form = await project(`<form>
      <input name="title" value="Existing title">
      <input name="count" type="number" value="2">
      <select name="mode"><option disabled value="old">Old</option><option value="new">New</option></select>
    </form>`);
    expect(parseAskAnswer(form, "{}")).toEqual({ data: { title: "Existing title", count: 2, mode: "new" } });
    expect(parseAskAnswer(form, '{"title":"Changed"}')).toEqual({ data: { title: "Changed", count: 2, mode: "new" } });
    expect(parseAskAnswer(form, "Changed")).toEqual({ error: "Use a JSON field map for multiple fields." });
  });

  test("retains multiline textarea content and validates free text", async () => {
    const form = await project(`<form><p>Write the release note.</p>
      <textarea name="note" required minlength="3" maxlength="20">\nFirst line\nSecond</textarea></form>`);
    expect(parseAskAnswer(form, "{}")).toEqual({ data: { note: "First line\nSecond" } });
    expect(parseAskAnswer(form, "New\nrelease note")).toEqual({ data: { note: "New\nrelease note" } });
    expect(parseAskAnswer(form, '{"note":"ok"}')).toEqual({ error: "note: Needs at least 3 characters." });
    expect(parseAskAnswer(form, '{"note":"                     "}')).toEqual({ error: "note: Required." });
    expect(parseAskAnswer(form, JSON.stringify({ note: "x".repeat(21) }))).toEqual({
      error: "note: At most 20 characters.",
    });
    expect(parseAskAnswer(form, '{"note":5}')).toEqual({ error: "note: Enter text." });
  });

  test("converts numbers and reports native required, finite and min/max failures", async () => {
    const form = await project(
      '<form><label>Workers <input name="workers" type="number" min="1" max="8" required value="3"></label></form>',
    );
    expect(parseAskAnswer(form, "4")).toEqual({ data: { workers: 4 } });
    expect(parseAskAnswer(form, '{"workers":"2.5"}')).toEqual({ data: { workers: 2.5 } });
    expect(parseAskAnswer(form, "{}")).toEqual({ data: { workers: 3 } });
    expect(parseAskAnswer(form, "")).toEqual({ error: "Enter an answer or a JSON field map." });
    expect(parseAskAnswer(form, "nope")).toEqual({ error: "workers: Enter a number." });
    expect(parseAskAnswer(form, "Infinity")).toEqual({ error: "workers: Enter a number." });
    expect(parseAskAnswer(form, '{"workers":1e309}')).toEqual({ error: "workers: Enter a number." });
    expect(parseAskAnswer(form, "0")).toEqual({ error: "workers: Must be at least 1." });
    expect(parseAskAnswer(form, "9")).toEqual({ error: "workers: Must be at most 8." });
    const optional = await project('<input name="count" type="number">');
    expect(parseAskAnswer(optional, "{}")).toEqual({ data: { count: "" } });
    expect(parseAskAnswer(optional, "")).toEqual({ error: "Enter an answer or a JSON field map." });
    const normalized = await project('<input name="count" type="number" minlength="2">');
    expect(parseAskAnswer(normalized, "01")).toEqual({ error: "count: Needs at least 2 characters." });
    expect(parseAskAnswer(normalized, "010")).toEqual({ data: { count: 10 } });
  });

  test("validates wrong fields, disabled fields and malformed maps before submission", async () => {
    const form = await project('<form><input name="note"><input name="locked" disabled value="unchanged"></form>');
    expect(parseAskAnswer(form, '{"typo":"answer"}')).toEqual({ error: "Unknown or disabled field: typo." });
    expect(parseAskAnswer(form, '{"locked":"changed"}')).toEqual({ error: "Unknown or disabled field: locked." });
    expect(parseAskAnswer(form, "raw note")).toEqual({ data: { note: "raw note", locked: "unchanged" } });
    expect(parseAskAnswer(form, '{"note":')).toEqual({ error: "Enter a valid JSON field map." });
    expect(parseAskAnswer(form, '["note"]')).toEqual({ error: "Enter a valid JSON field map." });
    expect(parseAskAnswer(form, '{"note":null}')).toEqual({ error: "note: Enter text." });
    expect(parseAskAnswer(form, '{"note":{"nested":true}}')).toEqual({ error: "note: Enter text." });
    expect(parseAskAnswer(form, '{"__proto__":"pollution"}')).toMatchObject({
      error: expect.stringContaining("Unknown or disabled"),
    });
  });

  test("accepts single-select values and enabled labels, but rejects disabled choices", async () => {
    const form = await project(`<form><label for="color">Pick a color</label><select id="color" name="color">
      <option value="blue">Ocean blue</option><option disabled value="red">Retired red</option>
    </select></form>`);
    expect(parseAskAnswer(form, "blue")).toEqual({ data: { color: "blue" } });
    expect(parseAskAnswer(form, "Ocean blue")).toEqual({ data: { color: "blue" } });
    expect(parseAskAnswer(form, "Retired red")).toEqual({
      error: "color: Choose only enabled values shown in the form.",
    });
    expect(parseAskAnswer(form, '{"color":"red"}')).toEqual({
      error: "color: Choose only enabled values shown in the form.",
    });
    expect(parseAskAnswer(form, '{"color":["blue"]}')).toEqual({ error: "color: Enter one choice value." });
    expect(form.summary).not.toContain("red");
  });

  test("handles compatible radio groups and omits unselected single choices", async () => {
    const form = await project(`<form><p>Pick a deployment region.</p>
      <label><input type="radio" name="region" value="east" checked>East</label>
      <label><input type="radio" name="region" value="west">West</label>
      <label><input type="radio" name="region" value="old" disabled>Old</label></form>`);
    expect(form.summary).toContain("Pick a deployment region.");
    expect(parseAskAnswer(form, "{}")).toEqual({ data: { region: "east" } });
    expect(parseAskAnswer(form, "west")).toEqual({ data: { region: "west" } });
    expect(form.summary).toContain("Other");
    expect(parseAskAnswer(form, "  north  ")).toEqual({ data: { region: "north" } });
    expect(parseAskAnswer(form, "old")).toEqual({ error: "region: Choose only enabled values shown in the form." });
    const explicit = await project(`<input type="radio" name="region" value="east">
      <label><input type="radio" name="region" value="other">Other region</label>`);
    expect(parseAskAnswer(explicit, "north")).toEqual({
      error: "region: Choose only enabled values shown in the form.",
    });
    const empty = await project('<form><input name="note"><input type="radio" name="optional" value="yes"></form>');
    expect(parseAskAnswer(empty, "{}")).toEqual({ data: { note: "" } });
  });

  test("supports checkbox arrays, required groups and clearing a single checkbox", async () => {
    const form = await project(`<form><p>Select environments.</p>
      <label><input type="checkbox" name="env" value="dev" checked required>Development</label>
      <label><input type="checkbox" name="env" value="prod">Production</label>
      <label><input type="checkbox" name="env" value="old" disabled checked>Retired</label></form>`);
    expect(parseAskAnswer(form, "{}")).toEqual({ data: { env: ["dev"] } });
    expect(parseAskAnswer(form, '{"env":["dev","prod"]}')).toEqual({ data: { env: ["dev", "prod"] } });
    expect(parseAskAnswer(form, "prod")).toEqual({ data: { env: ["prod"] } });
    expect(parseAskAnswer(form, '{"env":[]}')).toEqual({ error: "env: Select at least one." });
    expect(parseAskAnswer(form, '{"env":["qa","prod","dev"]}')).toEqual({
      data: { env: ["dev", "prod", "qa"] },
    });
    expect(parseAskAnswer(form, '{"env":["qa","stage"]}')).toEqual({
      error: "env: Choose only enabled values shown in the form.",
    });
    expect(parseAskAnswer(form, '{"env":"dev"}')).toEqual({ error: "env: Enter an array of choice values." });
    expect(parseAskAnswer(form, '{"env":["dev",1]}')).toEqual({ error: "env: Enter an array of choice values." });
    expect(parseAskAnswer(form, '{"env":["dev","dev"]}')).toEqual({
      error: "env: Choose only enabled values shown in the form.",
    });
    expect(parseAskAnswer(form, '{"env":["old"]}')).toEqual({
      error: "env: Choose only enabled values shown in the form.",
    });
    const single = await project('<label><input name="confirmed" type="checkbox" checked>Confirmed</label>');
    expect(parseAskAnswer(single, "{}")).toEqual({ data: { confirmed: "on" } });
    expect(parseAskAnswer(single, '{"confirmed":[]}')).toEqual({ data: {} });
    expect(parseAskAnswer(single, "on")).toEqual({ data: { confirmed: "on" } });
  });

  test("uses OMP's scalar result for a multi-select with only one option", async () => {
    const form = await project(
      '<form><select name="features" multiple><option value="logs" selected>Logs</option></select></form>',
    );
    expect(parseAskAnswer(form, "{}")).toEqual({ data: { features: "logs" } });
    expect(parseAskAnswer(form, "logs")).toEqual({ data: { features: "logs" } });
    const multi = await project(
      '<select name="features" multiple><option value="a" selected>A</option><option value="b">B</option></select>',
    );
    expect(parseAskAnswer(multi, '{"features":["b"]}')).toEqual({ data: { features: ["b"] } });
    expect(parseAskAnswer(multi, '{"features":[]}')).toEqual({ data: { features: [] } });
  });

  test("revalidates stale defaults rather than submitting invalid data", async () => {
    const numeric = await project('<input name="count" type="number" min="1" max="4" value="9">');
    expect(parseAskAnswer(numeric, "{}")).toEqual({ error: "count: Must be at most 4." });
    expect(parseAskAnswer(numeric, "3")).toEqual({ data: { count: 3 } });
    const text = await project('<input name="note" minlength="4" value="old">');
    expect(parseAskAnswer(text, "{}")).toEqual({ error: "note: Needs at least 4 characters." });
    const choice = await project(
      '<select name="mode" required><option selected disabled value="old">Old</option><option value="new">New</option></select>',
    );
    expect(parseAskAnswer(choice, "{}")).toEqual({ error: "mode: Required." });
    expect(parseAskAnswer(choice, "new")).toEqual({ data: { mode: "new" } });
  });

  test("keeps optgroup context and leaves ambiguous disabled groups local", async () => {
    const form = await project(`<select name="mode">
      <optgroup label="Current"><option value="a">A</option></optgroup>
      <optgroup label="More"><option value="b">B</option></optgroup>
    </select>`);
    expect(form.summary).toContain("Current: A");
    expect(parseAskAnswer(form, "{}")).toEqual({ data: { mode: "a" } });
    expect(
      await projectAskForm(`<select name="mode">
        <optgroup label="Retired" disabled><option value="old">Old</option></optgroup>
        <option value="new">New</option>
      </select>`),
    ).toBeUndefined();
  });

  test("decodes visible entities and sanitizes Discord markup without altering submitted data", async () => {
    const form = await project(
      '<form><p>Review &amp; approve &lt;@123&gt; @everyone ```payload``` **loud**</p><input name="note" value="&lt;@123&gt; &amp; `tick`"></form>',
    );
    expect(form.summary).toContain("Review & approve");
    expect(form.summary).not.toContain("<@123>");
    expect(form.summary).not.toContain("@everyone");
    expect(form.summary).not.toContain("```");
    expect(parseAskAnswer(form, "{}")).toEqual({ data: { note: "<@123> & `tick`" } });
    const choice = await project(
      '<select name="pick"><option value="@everyone">Mention-looking value</option><option value="plain">Plain</option></select>',
    );
    expect(choice.summary).toContain('"\\u0040everyone"');
    expect(parseAskAnswer(choice, '{"pick":"\\u0040everyone"}')).toEqual({ data: { pick: "@everyone" } });
  });

  test("never exports forms containing secret or file inputs", async () => {
    for (const control of [
      '<input name="answer" type="password" value="synthetic-secret">',
      '<input name="answer" type="file">',
      '<input name="api_key" value="synthetic-secret">',
      '<textarea name="password">synthetic-secret</textarea>',
      '<input name="answer" autocomplete="one-time-code">',
      '<input name="answer" autocomplete="current-password">',
    ])
      expect(await projectAskForm(`<form><p>Secret prompt</p>${control}</form>`)).toBeUndefined();
  });

  test("leaves unsupported and ambiguous presentations entirely native", async () => {
    for (const html of [
      '<form><input name="answer" type="email"></form>',
      '<form><input name="answer" type="range"></form>',
      '<form><input name="answer" pattern="[a-z]+"></form>',
      '<form><input name="answer" readonly></form>',
      '<form><input name="answer" list="choices"></form>',
      '<form><input name="answer" style="display:none"></form>',
      '<form><input name="answer" onclick="something()"></form>',
      '<form><input name="answer" step="2" type="number"></form>',
      '<form><input name="answer"><img src="synthetic.png" alt="Important diagram"></form>',
      '<form><input name="answer"><table><tr><td>Special context</td></tr></table></form>',
      '<form><input name="answer"><details><summary>Hidden context</summary>More</details></form>',
      '<form><input name="answer"><script>synthetic()</script></form>',
      '<form><input name="answer"><div hidden>Hidden context</div></form>',
      '<form><input name="answer"></form><form><input name="other"></form>',
      '<form><input name="answer"><option value="orphan">Orphan</option></form>',
      '<form><label>Ambiguous<input name="one"><input name="two"></label></form>',
      '<form><label for="answer">One</label><label for="answer">Two</label><input name="answer" id="answer"></form>',
      '<form><select name="answer"></select></form>',
      '<form><input name="answer" min="bad" type="number"></form>',
      '<form><input name="answer" min="3" max="1" type="number"></form>',
      '<form><input name="answer" minlength="5" maxlength="2"></form>',
      '<form><input name="answer" minlength="1.5"></form>',
      '<form><input name="answer" multiple></form>',
      '<form><input name="answer"',
      '<form><input name="answer" disabled></form>',
      '<form><input type="hidden" name="id" value="fixture"></form>',
      "<p>No controls</p>",
    ])
      expect(await projectAskForm(html)).toBeUndefined();
  });

  test("rejects irregular names and incompatible duplicate fields", async () => {
    for (const html of [
      '<input name="bad.name">',
      '<input name="bad[name]">',
      '<input name="bad name">',
      '<input name="__proto__">',
      '<input name="constructor">',
      '<input name="prototype">',
      "<input>",
      '<input name="same"><textarea name="same"></textarea>',
      '<input name="same"><input name="same">',
      '<input name="same" type="hidden"><input name="same">',
      '<input name="same" type="radio"><input name="same" type="checkbox">',
      '<input name="same" type="radio" value="a"><input name="same" type="radio" value="a">',
      '<input name="same" type="radio" value="a" checked><input name="same" type="radio" value="b" checked>',
      '<select name="same"><option value="a" selected>A</option><option value="b" selected>B</option></select>',
      '<input name="one" id="duplicate"><input name="two" id="duplicate">',
    ])
      expect(await projectAskForm(html)).toBeUndefined();
  });

  test("falls back instead of truncating large context, form shapes or answers", async () => {
    const context = "x".repeat(1_000);
    const fit = await project(`<form><p>${context}</p><input name="answer"></form>`);
    expect(fit.summary).toContain(context);
    expect(fit.summary.length).toBeLessThanOrEqual(1_500);
    expect(await projectAskForm(`<form><p>${"x".repeat(1_501)}</p><input name="answer"></form>`)).toBeUndefined();
    expect(await projectAskForm(`<form><p>${"😀".repeat(750)}</p><input name="answer"></form>`)).toBeUndefined();
    expect(await projectAskForm(`<form><input name="answer" value="${"x".repeat(17_000)}"></form>`)).toBeUndefined();
    expect(
      await projectAskForm(
        `<form>${Array.from({ length: 17 }, (_, index) => `<input name="f${index}">`).join("")}</form>`,
      ),
    ).toBeUndefined();
    expect(
      await projectAskForm(
        `<select name="answer">${Array.from({ length: 33 }, (_, index) => `<option value="${index}">${index}</option>`).join("")}</select>`,
      ),
    ).toBeUndefined();
    expect(parseAskAnswer(fit, "x".repeat(2_000))).toEqual({ data: { answer: "x".repeat(2_000) } });
    expect(parseAskAnswer(fit, "x".repeat(2_001))).toEqual({ error: "Answer is too long." });
    expect(parseAskAnswer({ summary: "expired" }, "value")).toEqual({ error: "This form is no longer available." });
  });
});
