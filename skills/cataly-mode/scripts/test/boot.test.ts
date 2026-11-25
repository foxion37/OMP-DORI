import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootCheck } from "../src/boot.ts";
import { shellQuote } from "../src/launch-footer.ts";
import type { Lane, LaneStatus } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { ChosenRuntimes, runtimeChoice, runtimesOf } from "../src/run.ts";
import { Worklog } from "../src/worklog.ts";
import { FakeHeadless } from "./fake-headless.ts";
import {
  depsFor,
  fakeClock,
  href,
  nativeLane,
  nativeLead,
  newWorld,
  sid,
  type TestState,
  withState,
  type World,
} from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00Z");
const LEAD = `headless:${sid(1)}`;

/** A lane bound to headless session `sid(n)`; whether that session is live is up to the test's world. */
const lane = (key: string, status: LaneStatus, n: number): Lane => ({
  key,
  status,
  sessionRef: href(sid(n)),
  title: key,
  thread: "none",
  brief: "/b.md",
  done: "file /done.md",
  openedAt: new Date(T0).toISOString(),
});

const launched = (key: string, status: LaneStatus, n: number): Lane => ({
  ...lane(key, status, n),
  reportProtocol: "jsonl-v1",
});

let state: TestState;

beforeEach(() => {
  state = withState();
});

afterEach(() => state.done());

// Every directory and file under the state dir, with file bytes, so a created directory counts as a write too.
const snapshot = (dir: string) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => [
      join(e.parentPath, e.name),
      e.isFile() ? readFileSync(join(e.parentPath, e.name), "utf8") : e.isDirectory() ? "<dir>" : "<other>",
    ])
    .sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));

/** Boot deps over `world`, whose live native lead is session 1. */
const bootDeps = (world: World, slack: () => Promise<{ userId: string; teamId: string } | null> = async () => null) => {
  const deps = depsFor(world, fakeClock(T0), state.dir, {
    sessionsDir: join(state.dir, "sessions"),
    leadPane: nativeLead(world, 1),
  });
  return { ...deps, reports: new Reports(state.dir), worklog: new Worklog(state.dir), slack };
};

/** An OMP desired-monitor file in the state dir, the metadata boot reads for headless lanes. */
const ompWatch = (name: string, argv: string[]): void => {
  mkdirSync(join(state.dir, "monitors"), { recursive: true });
  writeFileSync(
    join(state.dir, "monitors", "owner.json"),
    JSON.stringify({ version: 1, sessionId: "owner", monitors: [{ name, argv, cwd: "/repo" }] }),
  );
};

test("boot reports vanished sessions, journals and stale watches, and writes nothing", async () => {
  // Given a lane whose session vanished, a live lane, a stray session, a closed lane with a watch, a halted journal.
  const world = newWorld();
  const deps = bootDeps(world, async () => ({ userId: "U_FIXTURE", teamId: "T_FIXTURE" }));
  nativeLane(world, 2);
  nativeLane(world, 3);
  for (const l of [launched("api-release", "working", 8), lane("live", "working", 3), lane("closed", "closed", 9)])
    await deps.registry.write(l);
  await deps.reports.report("api-release", "halted", "work pushed, waiting for the owner", T0);
  ompWatch("closed-watch", ["cataly", "watch", "closed"]);
  const before = snapshot(state.dir);
  // When boot runs.
  const result = await bootCheck(deps);
  // Then every finding is printed, the vanished open lane fails the boot as drift, and no file changed.
  expect(result.exitCode).toBe(1);
  expect(result.lines).toContain("DRIFT n=1 api-release");
  expect(result.lines).toContain(
    "SLACK authenticated user=U_FIXTURE team=T_FIXTURE (auth.test only; inbox delivery unverified)",
  );
  expect(result.lines).toContain(
    `VANISHED api-release pane=${sid(8)} status=working; registry and worktrees preserved; no relaunch`,
  );
  expect(result.lines).toContain(`PANES lead=${LEAD} leadState=live registeredLive=1 vanished=1 unregistered=1`);
  expect(result.lines).toContain(`UNREGISTERED ${sid(2)}`);
  expect(result.lines).toContain(
    "REPORT api-release kind=halted at=2026-01-01T12:00:00.000Z state=halted registryStatus=working",
  );
  expect(result.lines).toContain('STOP in the owner session only: monitor({"op":"stop","name":"closed-watch"})');
  expect(result.lines.some((l) => l.startsWith("VANISHED closed"))).toBe(false);
  expect(snapshot(state.dir)).toEqual(before);
  expect(world.calls.every((c) => c[0] === "headless" && c[1] === "list")).toBe(true);
});

test("boot on a state dir with no lanes directory leaves it byte-identical", async () => {
  // Given a state dir that has never held a lane.
  const world = newWorld();
  const deps = bootDeps(world);
  writeFileSync(join(state.dir, "messenger.json"), "{}");
  const before = snapshot(state.dir);
  // When boot runs; then it finishes clean and creates no lanes directory or anything else.
  const result = await bootCheck(deps);
  expect(result.exitCode).toBe(0);
  expect(snapshot(state.dir)).toEqual(before);
});

test("a closed lane owns no session, so a session left behind by a failed close is unregistered", async () => {
  // Given a stray session, a closed lane whose session is still open, and a working lane on a live session.
  const world = newWorld();
  const deps = bootDeps(world);
  nativeLane(world, 2);
  nativeLane(world, 3);
  nativeLane(world, 4);
  await deps.registry.write(lane("gone", "closed", 4));
  await deps.registry.write(lane("current", "working", 3));
  // When boot runs; then the leftover session is listed and only the open lane counts as registered.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`PANES lead=${LEAD} leadState=live registeredLive=1 vanished=0 unregistered=2`);
  expect(result.lines).toContain(`UNREGISTERED ${sid(2)} ${sid(4)}`);
});

test("an unreadable lane file is named and the other lanes are still checked", async () => {
  // Given a partial lane record next to a lane whose session vanished.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("healthy", "working", 7));
  writeFileSync(deps.registry.path("broken"), "{partial");
  writeFileSync(deps.registry.path("null-record"), "null");
  // When boot runs; then the file is named, the healthy lane is still reported, and the run is incomplete.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`REGISTRY unreadable ${shellQuote(deps.registry.path("broken"))}`);
  expect(result.lines).toContain(`REGISTRY unreadable ${shellQuote(deps.registry.path("null-record"))}`);
  expect(result.lines).toContain(
    `VANISHED healthy pane=${sid(7)} status=working; registry and worktrees preserved; no relaunch`,
  );
  expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  expect(result.exitCode).toBe(1);
});

test("a lanes path that cannot be listed is named and the rest of boot still runs", async () => {
  // Given a lanes path that is a file, not a directory.
  const world = newWorld();
  const deps = bootDeps(world);
  writeFileSync(join(state.dir, "lanes"), "not a directory");
  // When boot runs; then the registry is named unreadable and the later checks still print.
  const result = await bootCheck(deps);
  expect(result.lines).toContain(`REGISTRY unreadable ${shellQuote(join(state.dir, "lanes"))}`);
  expect(result.lines.some((l) => l.startsWith("MONITORS cleanupCandidates="))).toBe(true);
  expect(result.exitCode).toBe(1);
});

test("a verified-done lane whose session is gone is not flagged VANISHED", async () => {
  // Given a verified-done lane and a working lane, both on sessions that no longer exist.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("verified", "verified-done", 7));
  await deps.registry.write(lane("working", "working", 8));
  // When boot runs; then only the working lane is flagged.
  const result = await bootCheck(deps);
  expect(result.lines.filter((l) => l.startsWith("VANISHED"))).toEqual([
    `VANISHED working pane=${sid(8)} status=working; registry and worktrees preserved; no relaunch`,
  ]);
  expect(result.lines).toContain(`PANES lead=${LEAD} leadState=live registeredLive=0 vanished=1 unregistered=0`);
});

test("a journal-done lane whose session is gone is finished in both checks: not VANISHED, and its watch is offered for cleanup", async () => {
  // Given a working lane whose journal says done, on a session that is gone, with a persistent watch naming it.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(launched("reported", "working", 9));
  await deps.reports.report("reported", "done", "finished", T0);
  ompWatch("reported-watch", ["cataly", "watch", "reported"]);
  // When boot runs; then the lane is not flagged and its watch is a cleanup candidate.
  const result = await bootCheck(deps);
  expect(result.lines.some((l) => l.startsWith("VANISHED"))).toBe(false);
  expect(result.lines).toContain("DRIFT n=0");
  expect(result.lines).toContain(`PANES lead=${LEAD} leadState=live registeredLive=0 vanished=0 unregistered=0`);
  expect(result.lines).toContain("MONITORS cleanupCandidates=1 (from metadata; liveness unverified)");
  expect(result.lines).toContain('STOP in the owner session only: monitor({"op":"stop","name":"reported-watch"})');
});

test("a failed session list stays unknown instead of declaring every lane vanished", async () => {
  // Given the native supervisor failing to list sessions.
  const world = newWorld();
  const deps = bootDeps(world);
  await deps.registry.write(lane("active", "working", 7));
  spyOn(runtimesOf(deps).default, "list").mockRejectedValue(new Error("supervisor not running"));
  // When boot runs; then it is incomplete and no lane is called vanished.
  const result = await bootCheck(deps);
  expect(result.exitCode).toBe(1);
  expect(result.lines).toContain("PANES unavailable (session list failed)");
  expect(result.lines.some((line) => line.startsWith("VANISHED"))).toBe(false);
});

/** Boot deps whose runtime choice is read from `env`, over the world's fake native supervisor. */
const choosing = (world: World, env: Record<string, string>) => {
  const deps = { ...bootDeps(world), env };
  const runtime = new FakeHeadless(world, state.dir);
  return {
    ...deps,
    rts: new ChosenRuntimes(
      () => runtimeChoice(deps.config, env),
      () => runtime,
    ),
  };
};

test("boot prints the runtime and where its choice came from as its first line", async () => {
  const result = await bootCheck(choosing(newWorld(), { CATALY_RUNTIME: "headless" }));
  expect(result.lines[0]).toBe("RUNTIME headless (from env)");
  expect(result.exitCode).toBe(0);
});

test("a runtime choice that fails is printed first as RUNTIME unavailable and fails boot", async () => {
  for (const [value, reason] of [["tmux", "tmux"]] as const) {
    const result = await bootCheck(choosing(newWorld(), { CATALY_RUNTIME: value }));
    expect(result.lines[0]).toStartWith("RUNTIME unavailable: ");
    expect(result.lines[0]).toContain(reason);
    expect(result.exitCode).toBe(1);
    expect(result.lines.at(-1)).toBe("BOOT incomplete read-only; nothing restarted, written or stopped");
  }
});
