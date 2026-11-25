import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readMonitorManifests } from "../src/boot-monitors.ts";
import { Reports } from "../src/reports.ts";
import { laneStatus } from "../src/status.ts";
import { renderBoard, renderStatus } from "../src/status-render.ts";
import { depsFor, fakeClock, newWorld, withState } from "./fakes.ts";

const now = Date.parse("2026-01-01T13:00:00Z");
const lane = {
  key: "healthy",
  title: "Healthy",
  thread: "discord:40",
  openedAt: "2026-01-01T12:00:00Z",
  brief: "brief",
  done: "file proof",
};
let state: ReturnType<typeof withState>;
const deps = () => depsFor(newWorld(), fakeClock(now), state.dir, { sessionsDir: join(state.dir, "sessions") });
beforeEach(async () => {
  state = withState();
  await deps().registry.write(lane);
});
afterEach(() => state.done());

test.each([
  ["/home/Alice Smith", "/home/Alice Smith/PRIVATE_SUFFIX.txt"],
  ["/Users/Alice Smith", "/Users/Alice Smith/PRIVATE_SUFFIX.txt"],
  [String.raw`C:\Users\Alice Smith`, String.raw`C:\Users\Alice Smith\PRIVATE_SUFFIX.txt`],
  ["/home/test", "/srv/Project Name/PRIVATE_SUFFIX.txt"],
  ["/home/test", String.raw`\\server\Shared Folder\PRIVATE_SUFFIX.txt`],
  ["/home/test", "~/Folder Name/PRIVATE_SUFFIX.txt"],
  ["/home/test", "Log:[/tmp/Folder Name/PRIVATE_SUFFIX.txt]"],
  ["/home/test", "//server/Shared Folder/PRIVATE_SUFFIX.txt"],
  ["/home/test", "/tmp/https://example.test/PRIVATE_SUFFIX.txt"],
  ["/home/Alice\u00a0Smith", "/home/Alice\u00a0Smith/PRIVATE_SUFFIX.txt"],
  ["/home/test", "\u001b[32m/tmp/PRIVATE_SUFFIX.txt\u001b[0m"],
  ["/home/test", "\u001b[32mC:\\Users\\Alice Smith\\PRIVATE_SUFFIX.txt\u001b[0m"],
  ["/home/test", "\u001b[32m\\\\server\\Shared Folder\\PRIVATE_SUFFIX.txt\u001b[0m"],
  ["/home/test", "\u001b[32m//server/Shared Folder/PRIVATE_SUFFIX.txt\u001b[0m"],
  ["/home/test", "C:\u001b[32m\\Users\\Alice Smith\\PRIVATE_SUFFIX.txt\u001b[0m"],
  ["/home/test", "\u001b]8;;https://example.test/\u0007/tmp/PRIVATE_SUFFIX.txt\u001b]8;;\u0007"],
  ["/home/test", "\u001b[38;2;255;0;0m/tmp/PRIVATE_SUFFIX.txt\u001b[0m"],
  ["/home/test", "\u009b32m/tmp/PRIVATE_SUFFIX.txt\u009b0m"],
])("board hides the complete spaced path %s -> %s", async (home, path) => {
  const url = "https://example.test/home/reports/test";
  await new Reports(state.dir).report(lane.key, "milestone", `Build passed. Evidence: ${path} ${url}?ref=1`, now);
  const body = renderBoard(await laneStatus(deps()), home, 1960);
  expect(body).not.toContain("PRIVATE_SUFFIX");
  expect(body).not.toContain("Smith");
  expect(body).toContain("Build passed");
  expect(body).toContain(url);
});

test.each([0, 1, 8, 0x7f, 0x85, 0x2028, 0x2029, 0xad, 0x200b, 0x200c, 0x200d, 0x202e, 0x2060, 0x2066, 0xfeff])(
  "board separates URL and local path at control %s",
  async (code) => {
    const url = "https://example.test/evidence";
    await new Reports(state.dir).report(
      lane.key,
      "milestone",
      `Build passed ${url}${String.fromCodePoint(code)}/srv/Alice Smith/PRIVATE_SUFFIX.txt`,
      now,
    );
    const body = renderBoard(await laneStatus(deps()), "/home/test", 1960);
    expect(body).not.toContain("PRIVATE_SUFFIX");
    expect(body).not.toContain("Smith");
    expect(body).toContain(url);
  },
);

test("board preserves ANSI-colored evidence URLs after normalization", async () => {
  const url = "https://example.test/home/reports/test";
  await new Reports(state.dir).report(lane.key, "milestone", `Build passed. \u001b[32m${url}?ref=1\u001b[0m`, now);
  const body = renderBoard(await laneStatus(deps()), "/home/test", 1960);
  expect(body).toContain(url);
  expect(body).not.toContain("\u001b");
});

test.each([
  ["invalid JSON", "{broken"],
  ["null", "null"],
  ["array", "[]"],
  ["primitive", "42"],
  ["missing fields", '{"key":"damaged"}'],
  ["thread type", JSON.stringify({ ...lane, key: "damaged", thread: 7 })],
  ["title type", JSON.stringify({ ...lane, key: "damaged", title: {} })],
  ["unsafe key", JSON.stringify({ ...lane, key: "../escape" })],
  ["filename identity mismatch", JSON.stringify(lane)],
  ["note type", JSON.stringify({ ...lane, key: "damaged", lastFreshnessNote: 17 })],
  ["status enum", JSON.stringify({ ...lane, key: "damaged", status: "unknown" })],
  ["runtime enum", JSON.stringify({ ...lane, key: "damaged", sessionRef: { runtime: "invalid", id: "7" } })],
  ["timestamp type", JSON.stringify({ ...lane, key: "damaged", lastNudgeAt: "0" })],
  ["opened timestamp", JSON.stringify({ ...lane, key: "damaged", openedAt: "false" })],
  ["closed timestamp", JSON.stringify({ ...lane, key: "damaged", closedAt: "false" })],
])("status retains healthy lanes when a registry record has %s", async (_label, data) => {
  writeFileSync(join(state.dir, "lanes", "damaged.json"), data);
  const snapshot = await laneStatus(deps());
  expect(snapshot.lanes.map((item) => item.key)).toEqual([lane.key]);
  expect(snapshot.registryIncomplete).toBe(true);
  expect(snapshot.errors.some((error) => error.includes("registry"))).toBe(true);
  expect(renderBoard(snapshot, "/home/test", 1960)).toContain("incomplete");
});

test("a lane in a Tern block is a readable registry record", async () => {
  const tern = { ...lane, key: "tern-lane", sessionRef: { runtime: "tern", id: "5001" } };
  writeFileSync(join(state.dir, "lanes", "tern-lane.json"), JSON.stringify(tern));
  const snapshot = await laneStatus(deps());
  expect(snapshot.lanes.map((item) => item.key).sort()).toEqual([lane.key, "tern-lane"]);
  expect(snapshot.registryIncomplete).toBe(false);
});

test("a specifically requested damaged lane is unknown, not an absent lane or a crash", async () => {
  writeFileSync(join(state.dir, "lanes", "damaged.json"), "{broken");
  const snapshot = await laneStatus(deps(), "damaged");
  expect(snapshot.registryIncomplete).toBe(true);
  expect(snapshot.lanes).toEqual([]);
  expect(renderStatus(snapshot)).toContain("LANES unknown");
  expect(renderStatus(snapshot)).not.toContain("none open");
});

const malformed = [{ name: false }, { cwd: 7 }, { filter: [] }, { argv: ["cataly", null] }];
test.each(malformed)("monitor fields are validated before counting: %j", async (patch) => {
  const root = join(state.dir, "monitors");
  mkdirSync(root, { recursive: true });
  const monitor = { name: "watch", argv: ["cataly", "watch"], cwd: "/repo" };
  for (const [name, item] of [
    ["good", monitor],
    ["bad", { ...monitor, ...patch }],
  ] as const)
    writeFileSync(join(root, `${name}.json`), JSON.stringify({ version: 1, sessionId: "session", monitors: [item] }));
  const snapshot = await laneStatus(deps());
  expect(snapshot.monitors).toEqual({ recorded: null });
  const read = readMonitorManifests(root);
  expect(read.manifests).toHaveLength(1);
  expect(read.errors).toHaveLength(1);
});
