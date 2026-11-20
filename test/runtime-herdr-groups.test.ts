import { expect, test } from "bun:test";
import { HerdrRuntime } from "../src/runtime/herdr/index.ts";
import { ok, recorder } from "./herdr-recorder.ts";

for (const workspace_id of [undefined, null, ""]) {
  test(`group listing ignores an ungrouped pane with workspace_id=${String(workspace_id)}`, async () => {
    const panes = [
      { pane_id: "watched", workspace_id: "w" },
      { pane_id: "ungrouped", workspace_id },
      { pane_id: "elsewhere", workspace_id: "other" },
    ];
    const h = new HerdrRuntime(recorder(() => ok({ panes })).exec, "");
    expect((await h.list({ group: "w" })).map((p) => p.ref.id)).toEqual(["watched"]);
    expect((await h.list()).map((p) => p.ref.id)).toEqual(["watched", "ungrouped", "elsewhere"]);
    panes.shift();
    expect(await h.list({ group: "w" })).toEqual([]);
  });
}

test("a malformed pane is not mistaken for an empty watched snapshot", async () => {
  const panes = [{ pane_id: "watched", workspace_id: "w" }, { workspace_id: "other" }];
  const h = new HerdrRuntime(recorder(() => ok({ panes })).exec, "");
  await expect(h.list({ group: "w" })).rejects.toThrow("valid pane list");
  await expect(h.list()).rejects.toThrow("valid pane list");
});

for (const bad of [
  null,
  {},
  { pane_id: "", workspace_id: "w" },
  { workspace_id: "w" },
  { pane_id: "p", workspace_id: 1 },
]) {
  test(`an invalid row cannot erase a watched snapshot: ${JSON.stringify(bad)}`, async () => {
    const h = new HerdrRuntime(recorder(() => ok({ panes: [bad] })).exec, "");
    await expect(h.list({ group: "w" })).rejects.toThrow("valid pane list");
    await expect(h.list()).rejects.toThrow("valid pane list");
  });
}
