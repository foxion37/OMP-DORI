import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { launchLane } from "../src/launch.ts";
import { cancelQueued, enqueueLaunch, queueTick, startQueued } from "../src/launch-queue.ts";
import { LaunchQueue } from "../src/launch-queue-store.ts";
import { QueueError } from "../src/launch-errors.ts";
import { queueFixture, roomy, type QueueFixture } from "./launch-queue-fixture.ts";

let f: QueueFixture;
beforeEach(async () => {
  f = await queueFixture();
});
afterEach(() => f.state.done());

const enqueue = () => enqueueLaunch(f.deps, f.input, [f.prior.key]);
const store = () => new LaunchQueue(f.state.dir);

test("queue snapshots its brief across restart and only an explicit start creates a lane", async () => {
  const original = readFileSync(f.input.brief, "utf8").trim();
  await enqueue();
  expect(f.creates()).toBe(0);
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
  expect(store().read(f.input.key)?.briefText.trim()).toBe(original);
  writeFileSync(f.input.brief, "changed after queueing");
  expect((await queueTick(f.deps))[0]).toContain("LANE_QUEUE_READY");
  expect(await queueTick(f.deps)).toEqual([]);
  expect(f.creates()).toBe(0);
  const result = await startQueued(f.deps, f.input.key, roomy);
  expect(result.code).toBe(0);
  expect(f.creates()).toBe(1);
  expect(store().read(f.input.key)?.status).toBe("started");
  const lane = await f.deps.registry.read(f.input.key);
  expect(readFileSync(lane!.brief, "utf8")).toContain(original);
  expect(readFileSync(lane!.brief, "utf8")).not.toContain("changed after queueing");
  await expect(startQueued(f.deps, f.input.key, roomy)).rejects.toThrow("no launch retried");
  expect(f.creates()).toBe(1);
});

test.each(["working", "not-done", "paused"] as const)("predecessor %s never counts as completion", async (status) => {
  const { closedAt: _closed, receipt: _receipt, ...active } = f.prior;
  await f.deps.registry.write({ ...active, status });
  await enqueue();
  expect((await startQueued(f.deps, f.input.key, roomy)).code).toBe(4);
  expect(f.creates()).toBe(0);
});

test.each(["parked", "abandoned", "missing"])("predecessor %s receipt never starts dependent work", async (outcome) => {
  await f.deps.registry.write({
    ...f.prior,
    receipt: outcome === "missing" ? undefined : { outcome, checks: [{ ok: true }] },
  });
  await enqueue();
  expect((await startQueued(f.deps, f.input.key, roomy)).lines[0]).toContain("no successful completion receipt");
  expect(f.creates()).toBe(0);
});

test("start rechecks live Done and host capacity rather than trusting an earlier ready notice", async () => {
  await enqueue();
  expect((await queueTick(f.deps))[0]).toContain("READY");
  f.world.issueState = "OPEN";
  expect((await startQueued(f.deps, f.input.key, roomy)).lines[0]).toContain("Done no longer live");
  f.world.issueState = "CLOSED";
  // canLaunch gates memory, disk and pane count; CPU load is an alert, not admission policy.
  const scarceMemory = async () => ({ ...(await roomy()), memFreePct: 0 });
  expect((await startQueued(f.deps, f.input.key, scarceMemory)).code).toBe(4);
  const fullDisk = async () => ({ ...(await roomy()), diskFreeGb: 0 });
  expect((await startQueued(f.deps, f.input.key, fullDisk)).code).toBe(4);
  const unknownPanes = async () => ({ ...(await roomy()), panes: -1 });
  expect((await startQueued(f.deps, f.input.key, unknownPanes)).code).toBe(4);
  expect(f.creates()).toBe(0);
});

test("expiry holds until explicit cancel and a fresh queue request", async () => {
  const old = await enqueue();
  f.advance(25 * 3_600_000);
  expect((await startQueued(f.deps, f.input.key, roomy)).lines[0]).toContain("expired");
  expect(await cancelQueued(f.deps, f.input.key)).toContain("no pane or worktree removed");
  expect((await enqueue()).id).not.toBe(old.id);
  expect(f.creates()).toBe(0);
});

test("concurrent starts create exactly one agent and never retry the completed reservation", async () => {
  await enqueue();
  const results = await Promise.allSettled([
    startQueued(f.deps, f.input.key, roomy),
    startQueued(f.deps, f.input.key, roomy),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(f.creates()).toBe(1);
});

test("a failed agent start keeps its registered lane and cannot be automatically retried or cancelled", async () => {
  await enqueue();
  f.failStart();
  expect((await startQueued(f.deps, f.input.key, roomy)).code).toBe(3);
  expect(await f.deps.registry.read(f.input.key)).not.toBeNull();
  await expect(startQueued(f.deps, f.input.key, roomy)).rejects.toThrow("no launch retried");
  await expect(cancelQueued(f.deps, f.input.key)).rejects.toThrow("never stops an agent");
  expect(f.creates()).toBe(1);
});

test("a pending reservation cannot be bypassed by ordinary launch", async () => {
  await enqueue();
  await expect(launchLane(f.deps, f.input)).rejects.toThrow("is queued");
  expect(f.creates()).toBe(0);
});

test("cycles, unknown predecessors, malformed keys and invalid expiry are refused before launch", async () => {
  await expect(enqueueLaunch(f.deps, f.input, ["unknown-lane"])).rejects.toThrow("unknown predecessor");
  await expect(enqueueLaunch(f.deps, { ...f.input, key: "../escape" }, [f.prior.key])).rejects.toThrow(QueueError);
  await expect(enqueueLaunch(f.deps, f.input, [f.input.key])).rejects.toThrow(QueueError);
  await expect(enqueueLaunch(f.deps, f.input, [f.prior.key], Infinity)).rejects.toThrow("positive");
  await expect(enqueueLaunch(f.deps, f.input, [f.prior.key], 1e100)).rejects.toThrow("valid expiry date");
  await enqueue();
  await enqueueLaunch(f.deps, { ...f.input, key: "third-lane" }, [f.input.key]);
  await cancelQueued(f.deps, f.input.key);
  await expect(enqueueLaunch(f.deps, f.input, ["third-lane"])).rejects.toThrow("cycle");
  expect(f.creates()).toBe(0);
});

test("corrupt records and unsafe persistent ids hold rather than writing outside queued briefs", async () => {
  const entry = await enqueue();
  writeFileSync(store().path(f.input.key), "{");
  expect(() => store().read(f.input.key)).toThrow("invalid queue JSON");
  store().write({ ...entry, id: "../../escape" });
  await expect(startQueued(f.deps, f.input.key, roomy)).rejects.toThrow("invalid queue record");
  expect(f.creates()).toBe(0);
});
