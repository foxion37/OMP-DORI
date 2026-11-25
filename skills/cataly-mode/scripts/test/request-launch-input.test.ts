import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { QueueError } from "../src/launch-errors.ts";
import { LaunchQueue } from "../src/launch-queue-store.ts";
import { LaunchError, launchLane } from "../src/launch.ts";
import { catalyOwnWords } from "../src/monitor-cataly.ts";
import { Registry } from "../src/registry.ts";
import { withDiscordCli } from "./discord-fakes.ts";
import { depsFor, fakeClock, newWorld, withState, type TestState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const thread = "discord:111111111111111111";
const requestId = `${thread}:222222222222222222`;
const runA = "00000000-0000-4000-8000-00000000000a";
let state: TestState;
let world: World;
beforeEach(() => {
  state = withState();
  world = newWorld();
});
afterEach(() => state.done());

test.each(["", "discord:0:222222222222222222", thread, "telegram:1:", "slack:c1:1.2", `unread:${requestId}`, runA])(
  "a launch refuses a request that is not an original input ID: %p",
  async (bad) => {
    const deps = depsFor(world, fakeClock(T0), state.dir);
    const brief = join(state.dir, "bad.md");
    writeFileSync(brief, "# brief\n");
    const input = { key: "bad-request", title: "t", brief, done: "closed acme/app#3", requestId: bad };
    await expect(launchLane(deps, input)).rejects.toThrow(LaunchError);
    expect(await deps.registry.read("bad-request")).toBeNull();
    expect(world.calls).toEqual([]);
  },
);

test.each(["request", "delivery"])("the monitor consumes --%s as a value, never a messenger platform", (option) => {
  expect(catalyOwnWords(["cataly", "send", `--${option}`, "slack", "discord"], 0)).toEqual([0, 1, 4]);
});

test("a queued sourced launch keeps its request and a damaged request is refused on read", () => {
  const queue = new LaunchQueue(state.dir);
  const entry = {
    id: "00000000-0000-4000-8000-0000000000aa",
    input: { key: "queued-request", title: "t", brief: "/brief", done: "closed acme/app#3", cwd: "/work", requestId },
    briefText: "# brief",
    after: ["first-lane"],
    queuedAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 3_600_000).toISOString(),
    status: "pending",
  } as const;
  queue.write(entry);
  expect(queue.read("queued-request")?.input.requestId).toBe(requestId);
  queue.write({ ...entry, input: { ...entry.input, requestId: "discord:latest-unread" } });
  expect(() => queue.read("queued-request")).toThrow(QueueError);
});

test("the CLI refuses a bare, empty or malformed --request and names a real one", async () => {
  await withDiscordCli(async (f) => {
    const dir = dirname(f.tmp);
    const brief = join(dir, "cli-brief.md");
    writeFileSync(brief, "# cli brief\n");
    const base = ["launch", "cli-lane", "--title", "t", "--brief", brief, "--done", "closed acme/app#3", "--dry-run"];
    for (const args of [
      [...base, "--request"],
      [...base, "--request", ""],
      [...base, "--request", "  "],
    ]) {
      const result = await f.invoke(args);
      expect([result.code, result.out, result.err]).toEqual([1, "", "--request needs the input ID"]);
    }
    const malformed = await f.invoke([...base, "--request", "discord:0:2"]);
    expect([malformed.code, malformed.out]).toEqual([1, ""]);
    expect(malformed.err).toStartWith("request must be the original input ID");
    const sourced = await f.invoke([...base, "--request", requestId]);
    expect(sourced.code).toBe(0);
    expect(sourced.out).toContain(`- Original request (metadata only): ${requestId}.`);
    expect(sourced.out).not.toContain("CATALY_LANE_RUN=");
    const legacy = await f.invoke(base);
    expect(legacy.code).toBe(0);
    expect(legacy.out).not.toContain("Original request");
    expect(await new Registry(dir).read("cli-lane")).toBeNull();
  });
});
