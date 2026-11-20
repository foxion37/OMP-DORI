import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { linkSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { FlowDeps } from "../src/done-flow.ts";
import { launchLane } from "../src/launch.ts";
import { depsFor, fakeClock, newWorld, type TestState, withState, type World } from "./fakes.ts";

// The in-place brief write after registration can fail part-way (a file size limit, a full disk): the brief must
// never be left cut short.
const T0 = Date.parse("2026-01-01T12:00:00.000Z");
const DONE = "closed acme/app#1";
const ORIGINAL = "owner instructions line\n".repeat(400);
let state: TestState;
let world: World;
let briefs: string;
let brief: string;
let shared: string;
beforeEach(() => {
  state = withState();
  world = newWorld();
  mkdirSync(join(state.dir, "briefs"));
  briefs = realpathSync(join(state.dir, "briefs"));
  brief = join(briefs, "lane.md");
  shared = join(briefs, "shared.md");
  writeFileSync(brief, ORIGINAL);
  linkSync(brief, shared);
});
afterEach(() => state.done());

const withTab = (base: FlowDeps): FlowDeps => ({
  ...base,
  run: async (argv, opts) =>
    argv[0] === "herdr" && argv[1] === "tab" && argv[2] === "create"
      ? { code: 0, out: JSON.stringify({ result: { root_pane: { pane_id: "w:p9" }, tab_id: "w:t9" } }), err: "" }
      : base.run(argv, opts),
});

/** Writes to the brief: the first is cut at 1024 bytes and fails; later ones fail too while `restoreFails`. */
const shortWrites = (restoreFails: boolean) => {
  const write = fs.writeFileSync;
  let writes = 0;
  return spyOn(fs, "writeFileSync").mockImplementation(((...args: Parameters<typeof fs.writeFileSync>) => {
    if (String(args[0]) !== brief) return write(...args);
    if (writes++ === 0) {
      write(brief, String(args[1]).slice(0, 1024));
      throw new Error("EFBIG: file too large, write");
    }
    if (restoreFails) throw new Error("ENOSPC: no space left on device, write");
    return write(...args);
  }) as typeof fs.writeFileSync);
};

const launch = async (restoreFails: boolean): Promise<string> => {
  const deps = withTab(depsFor(world, fakeClock(T0), state.dir));
  const spy = shortWrites(restoreFails);
  try {
    await launchLane(deps, { key: "short-lane", title: "t", brief, done: DONE });
    return "launched";
  } catch (error) {
    return (error as Error).message;
  } finally {
    spy.mockRestore();
    expect(await deps.registry.read("short-lane")).toBeNull();
    expect(world.calls.filter((c) => c[0] === "herdr" && c[2] === "close")).toEqual([
      ["herdr", "tab", "close", "w:t9"],
    ]);
  }
};

test("a brief write that fails part-way puts the original brief back in place", async () => {
  const inode = statSync(brief).ino;

  expect(await launch(false)).toStartWith("brief not written: EFBIG");

  expect(readFileSync(brief, "utf8")).toBe(ORIGINAL);
  expect(readFileSync(shared, "utf8")).toBe(ORIGINAL);
  expect(statSync(brief).ino).toBe(inode);
  expect(readdirSync(briefs).sort()).toEqual(["lane.md", "shared.md"]);
});

test("a brief that cannot be put back keeps its original beside it and names it", async () => {
  const message = await launch(true);

  expect(message).toStartWith("brief not written: EFBIG");
  const kept = readdirSync(briefs).filter((f) => f !== "lane.md" && f !== "shared.md");
  expect(kept).toHaveLength(1);
  const backup = join(briefs, kept[0]!);
  expect(message).toContain(`the original brief is kept at ${backup}`);
  expect(readFileSync(backup, "utf8")).toBe(ORIGINAL);
  // Windows reports 0666 for any writable file; the 0600 check is POSIX-only.
  if (process.platform !== "win32") expect(statSync(backup).mode & 0o777).toBe(0o600);
});
