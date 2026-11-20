import { expect, test } from "bun:test";
import { dirname } from "node:path";
import { Registry, type LaneStatus } from "../src/registry.ts";
import { ids, withDiscordCli } from "./discord-fakes.ts";

const get = `GET /channels/${ids.thread}`;
const patch = `PATCH /channels/${ids.thread}`;

test("thread status preserves the current owner title and changes no archive or tags", async () => {
  await withDiscordCli(async (f) => {
    const done = await f.invoke(["thread", "discord", "status", ids.thread, "done"], {
      routes: { [get]: { body: { id: ids.thread, type: 11, name: "Owner's latest title" } } },
    });
    expect(done.code).toBe(0);
    expect(done.keys).toEqual([get, patch]);
    expect(done.requests[1]?.body).toEqual({ name: "\u2705 Owner's latest title" });
    expect(done.out).toContain("done changed");
    // The owner renamed the thread again. Working must use that live title, not the earlier one.
    const working = await f.invoke(["thread", "discord", "status", ids.thread, "working"], {
      routes: { [get]: { body: { id: ids.thread, type: 11, name: "\u2705 New owner title" } } },
    });
    expect(working.code).toBe(0);
    expect(working.requests[1]?.body).toEqual({ name: "New owner title" });
  });
});

test.each(["done", "working"])("thread status %s is idempotent without a PATCH", async (status) => {
  await withDiscordCli(async (f) => {
    const name = status === "done" ? "\u2705 Current title" : "Current title";
    const r = await f.invoke(["thread", "discord", "status", ids.thread, status], {
      routes: { [get]: { body: { id: ids.thread, type: 12, name } } },
    });
    expect(r.code).toBe(0);
    expect(r.keys).toEqual([get]);
    expect(r.out).toContain(`${status} unchanged`);
  });
});

test.each(["", "closed"])("status refuses invalid state %j without a request", async (state) => {
  await withDiscordCli(async (f) => {
    const result = await f.invoke(["thread", "discord", "status", ids.thread, state]);
    expect(result.code).not.toBe(0);
    expect(result.err).toContain("thread status needs done or working");
    expect(result.requests).toEqual([]);
  });
});

test.each(["working", "paused", "not-done", "done-claimed", "verified-done"] as const)(
  "done refuses a %s lane before any request",
  async (status: LaneStatus) => {
    await withDiscordCli(async (f) => {
      await new Registry(dirname(f.tmp)).write({
        key: "group-member",
        title: "member",
        thread: `discord:${ids.thread}`,
        status,
        brief: "/b",
        done: "file /done",
        openedAt: new Date().toISOString(),
      });
      const r = await f.invoke(["thread", "discord", "status", ids.thread, "done"]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("thread still has open lanes: group-member");
      expect(r.requests).toEqual([]);
    });
  },
);

test("a registered lane cannot manage a shared thread title", async () => {
  await withDiscordCli(async (f) => {
    await new Registry(dirname(f.tmp)).write({
      key: "group-member",
      title: "member",
      thread: `discord:${ids.thread}`,
      pane: "w:p7",
      brief: "/b",
      done: "file /done",
      openedAt: new Date().toISOString(),
    });
    const r = await f.invoke(["thread", "discord", "status", ids.thread, "working"], {
      environment: { HERDR_PANE_ID: "w:p7" },
    });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain("thread status is the lead's");
    expect(r.requests).toEqual([]);
  });
});

test.each([{ type: 0, name: "Text channel" }, { type: 11 }, { type: 11, name: "x".repeat(100) }])(
  "status never truncates or renames an invalid target %#",
  async (channel) => {
    await withDiscordCli(async (f) => {
      const r = await f.invoke(["thread", "discord", "status", ids.thread, "done"], {
        routes: { [get]: { body: { id: ids.thread, ...channel } } },
      });
      expect(r.code).not.toBe(0);
      expect(r.keys).toEqual([get]);
    });
  },
);

test.each(["--archive", "--unarchive", "--title=Replacement", "--tag=Done"])(
  "status refuses incompatible %s without a request",
  async (flag) => {
    await withDiscordCli(async (f) => {
      const result = await f.invoke(["thread", "discord", "status", ids.thread, "done", flag]);
      expect(result.code).not.toBe(0);
      expect(result.err).toContain("thread status takes only");
      expect(result.requests).toEqual([]);
    });
  },
);

test("lookup and write failures propagate, without a success receipt", async () => {
  await withDiscordCli(async (f) => {
    const read = await f.invoke(["thread", "discord", "status", ids.thread, "done"], {
      routes: { [get]: { status: 403, body: { message: "denied" } } },
    });
    expect(read.code).not.toBe(0);
    expect(read.keys).toEqual([get]);
    expect(read.out).not.toContain("THREAD_STATUS");
    const write = await f.invoke(["thread", "discord", "status", ids.thread, "done"], {
      routes: { [get]: { body: { id: ids.thread, type: 11, name: "Live title" } }, [patch]: { status: 403 } },
    });
    expect(write.code).not.toBe(0);
    expect(write.keys).toEqual([get, patch]);
    expect(write.out).not.toContain("THREAD_STATUS");
  });
});
