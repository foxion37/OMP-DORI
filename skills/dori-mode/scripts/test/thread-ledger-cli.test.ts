import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { Registry } from "../src/registry.ts";
import { Worklog } from "../src/worklog.ts";
import { footer } from "../src/launch-footer.ts";
import { withDiscordCli } from "./discord-fakes.ts";

const lane = {
  key: "first-lane",
  title: "first",
  thread: "discord:40",
  brief: "/b",
  done: "file /done",
  openedAt: "2026-01-01T12:00:00.000Z",
};

test("launch plans an ungrouped lane when --thread is blank", async () => {
  await withDiscordCli(async (f) => {
    const planned = await f.invoke([
      "launch",
      lane.key,
      "--title",
      lane.title,
      "--brief",
      f.local,
      "--done",
      lane.done,
      "--thread=",
      "--dry-run",
    ]);
    expect(planned.code).toBe(0);
    expect(planned.out).toContain("Work thread: none.");
  });
});

test("adopt persists the ungrouped sentinel for a blank --thread", async () => {
  await withDiscordCli(async (f) => {
    const adopted = await f.invoke([
      "adopt",
      lane.key,
      "--title",
      lane.title,
      "--brief",
      f.local,
      "--done",
      lane.done,
      "--pane",
      "w1:p1",
      "--thread=",
    ]);
    expect(adopted.code).toBe(0);
    const registry = new Registry(dirname(f.tmp));
    expect(await registry.read(lane.key)).toMatchObject({ thread: "none" });
  });
});

test("lanes --thread groups completion states without changing any records", async () => {
  await withDiscordCli(async (f) => {
    const registry = new Registry(dirname(f.tmp));
    await registry.write(lane);
    await registry.write({ ...lane, key: "closed-lane", status: "closed", closedAt: lane.openedAt });
    await registry.write({ ...lane, key: "other-lane", thread: "discord:41" });
    const all = await f.invoke(["lanes", "--thread", "discord:40"]);
    expect(all.code).toBe(0);
    expect(
      JSON.parse(all.out)
        .map((row: { key: string }) => row.key)
        .sort(),
    ).toEqual(["closed-lane", "first-lane"]);
    const open = await f.invoke(["lanes", "--thread", "discord:40", "--open"]);
    expect(open.code).toBe(0);
    expect(JSON.parse(open.out).map((row: { key: string; status: string }) => [row.key, row.status])).toEqual([
      ["first-lane", "working"],
    ]);
    expect(await registry.read(lane.key)).toEqual(lane);
    const bad = await f.invoke(["lanes", "--thread"]);
    expect(bad.code).not.toBe(0);
  });
});

test("worklog --thread survives a new reader, renders and keeps old entries compatible", async () => {
  await withDiscordCli(async (f) => {
    const created = await f.invoke([
      "worklog",
      "add",
      "Owner request",
      "--source",
      "discord:20/50",
      "--thread",
      "discord:40",
    ]);
    expect(created.code).toBe(0);
    const item = JSON.parse(created.out);
    expect(item.thread).toBe("discord:40");
    const worklog = new Worklog(dirname(f.tmp));
    expect(worklog.read().items[0]?.thread).toBe("discord:40");
    expect(readFileSync(worklog.markdownPath, "utf8")).toContain("- Thread: discord:40");
    worklog.add("Old-style item", "source", Date.now());
    expect(worklog.read().problems).toEqual([]);
    expect(worklog.read().items[1]?.thread).toBeUndefined();
    for (const thread of ["", "none", "discord:40 bad"]) {
      const bad = await f.invoke(["worklog", "add", "Bad request", "--source", "message", "--thread", thread]);
      expect(bad.code).not.toBe(0);
    }
    expect(worklog.read().items).toHaveLength(2);
  });
});

test("lane launch footer assigns thread title and completion to the lead", () => {
  expect(footer(lane, "lead:p1")).toContain("A lane must not rename or archive it when its own work finishes");
});
