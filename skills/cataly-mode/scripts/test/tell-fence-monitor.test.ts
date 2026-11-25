import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeliverOutcome } from "../../../../src/runtime/types.ts";
import type { Manifest } from "../src/boot-monitors.ts";
import { makeCli } from "../src/cli-context.ts";
import { opsCommands } from "../src/cli-ops.ts";
import { monitorFilterFindings } from "../src/doctor-monitors.ts";
import { monitorPresets } from "../src/monitor-presets.ts";
import { withDeliveryLock } from "../src/delivery-lock.ts";
import { type DeliveryRecord, DeliveryState } from "../src/delivery-state.ts";
import { claimDone, type FlowDeps, objectDone, watchTick } from "../src/done-flow.ts";
import { freshnessTick } from "../src/freshness.ts";
import { type Lane, statusOf } from "../src/registry.ts";
import { Reports } from "../src/reports.ts";
import { resolveTell, tellLane } from "../src/tell.ts";
import { depsFor, fakeClock, nativeLane, newWorld, sent, sid, withState, type World } from "./fakes.ts";

const T0 = Date.parse("2026-01-01T12:00:00.000Z");
/** The supervisor took the text but its answer was lost: the delivery cannot be confirmed either way. */
const lost: DeliverOutcome = { kind: "ambiguous", detail: "host response lost", failure: new Error("lost") };
let lane: Lane;
let good: Lane;
let state: ReturnType<typeof withState>;
let world: World;
const deps = (now = T0 + 30 * 60_000) => depsFor(world, fakeClock(now), state.dir);
const store = () => new DeliveryState(deps().registry, lane.key);
/** Lane session ids the supervisor was asked to deliver to, in order. */
const offeredTo = () => world.calls.filter((c) => c[0] === "headless" && c[1] === "deliver").map((c) => c[2]);
const orderLanes = (base: FlowDeps) => {
  const list = base.registry.list.bind(base.registry);
  spyOn(base.registry, "list").mockImplementation(async () =>
    (await list()).sort((a, b) => a.key.localeCompare(b.key)),
  );
};
const filter = (name: string) => {
  const setup = readFileSync(new URL("../../references/setup.md", import.meta.url), "utf8");
  const row = setup.split("\n").find((line) => line.startsWith(`| ${name} |`));
  const pattern = row?.match(/`(\^[^`]+)`/)?.[1];
  if (!pattern) throw new Error(`missing documented ${name} monitor filter`);
  return new RegExp(pattern.replaceAll("\\|", "|"));
};
beforeEach(async () => {
  state = withState();
  world = newWorld();
  // Idle native sessions with active goals, so freshness may nudge them. Only the fenced lane's answers are lost.
  world.deliverOutcome = (id) => (id === sid(7) ? lost : undefined);
  const base = {
    title: "tell",
    brief: "/b.md",
    done: "merged acme/app#1",
    openedAt: new Date(T0).toISOString(),
    reportProtocol: "jsonl-v1",
  } as const;
  lane = { ...base, key: "a-fenced", thread: "none", ...nativeLane(world, 7) };
  good = { ...base, key: "z-good", thread: "chat:test/9", ...nativeLane(world, 8) };
  await deps().registry.write(lane);
});
afterEach(() => {
  mock.restore();
  state.done();
});

test.each([
  ["freshness", "HELD"],
  ["freshness", "DELIVERY-ERROR"],
  ["watch", "LANE_WATCH_ERROR"],
  ["watch", "LANE_NOTIFY_HELD"],
  ["watch", "LANE_NOTIFY_UNCONFIRMED"],
])("canonical %s monitors and doctor probes cover %s", (name, event) => {
  const preset = monitorPresets.find((item) => item.name === name);
  if (!preset) throw new Error(`missing ${name} preset`);
  expect(preset.events).toContain(event);
  expect(new RegExp(preset.filter).test(event)).toBe(true);
  expect(filter(name === "watch" ? "done flow" : name).test(event)).toBe(true);
  const manifest: Manifest = {
    path: join(state.dir, "monitor.json"),
    data: {
      version: 1,
      sessionId: "owner",
      monitors: [{ name, argv: [...preset.argv], cwd: state.dir, filter: `^(?!${event}(?: |$))` }],
    },
  };
  const findings = monitorFilterFindings([manifest], "owner");
  expect(findings).toHaveLength(1);
  expect(findings[0]?.severity).toBe("WARN");
  expect(findings[0]?.detail).toContain(`misses probes: ${event};`);
});

test("a working lane's claim hold and later objection reach the lead's documented stdout filter", async () => {
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  await claimDone(deps(T0), lane, "done evidence");
  const request = store().read();
  if (!request) throw new Error("missing claim notification request");
  expect(request.status).toBe("uncertain");
  expect(stdout.mock.calls.some(([line]) => String(line).startsWith("LANE_NOTIFY_UNCONFIRMED"))).toBe(true);
  stdout.mockClear();
  world.prState = "OPEN";
  const lines = await watchTick(deps());
  expect(lines.some((line) => line.startsWith("LANE_NOT_DONE a-fenced"))).toBe(true);
  const visible = stdout.mock.calls.map(([line]) => String(line)).filter((line) => filter("done flow").test(line));
  expect(visible).toHaveLength(1);
  expect(visible[0]).toStartWith("LANE_NOTIFY_HELD a-fenced");
  expect(visible[0]).toContain(request.id);
  expect(visible[0]).toContain("--resolve");
  expect(statusOf((await deps().registry.read(lane.key)) ?? lane)).toBe("not-done");
  expect(sent(world)).toHaveLength(1);
  expect(sent(world)[0]).toContain("done claim recorded");
  expect((await resolveTell(deps(), lane.key, request.id, "claim notice inspected; release its hold")).code).toBe(0);
  expect(sent(world)).toHaveLength(1);
  delete world.deliverOutcome;
  const current = await deps().registry.read(lane.key);
  if (!current) throw new Error("missing objected lane");
  expect((await tellLane(deps(), current, "fix the failed signal")).code).toBe(0);
  expect(sent(world)).toHaveLength(2);
  expect(sent(world)[1]).toBe("fix the failed signal");
});

test("a lock-held objection is also visible without waiting or sending", async () => {
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  const held = await withDeliveryLock(deps(), lane.key, () => objectDone(deps(), lane, ["not finished"]));
  expect(held.ok).toBe(true);
  const visible = stdout.mock.calls.map(([line]) => String(line)).find((line) => filter("done flow").test(line));
  expect(visible).toStartWith("LANE_NOTIFY_HELD a-fenced");
  expect(visible).toContain("delivery lock");
  expect(sent(world)).toEqual([]);
});

test("freshness command stdout exposes a durable hold through its documented monitor filter", async () => {
  await tellLane(deps(), lane, "owner request");
  const request = store().read();
  if (!request) throw new Error("missing request");
  const stdout = spyOn(console, "log").mockImplementation(() => {});
  const base = deps();
  const cli = makeCli("freshness", [], { values: { loop: "0" }, positionals: [] }, base.config, base);
  await opsCommands["freshness"]?.(cli);
  const visible = stdout.mock.calls.map(([line]) => String(line)).filter((line) => filter("freshness").test(line));
  expect(visible).toHaveLength(1);
  expect(visible[0]).toStartWith("HELD a-fenced TELL_HELD");
  expect(visible[0]).toContain(request.id);
  expect(sent(world)).toEqual(["owner request"]);
  expect(store().read()).toEqual(request);
});

for (const fault of ["corrupt", "write-failure"] as const) {
  const inject = () => {
    if (fault === "corrupt") writeFileSync(store().path, "not json");
    else {
      const write = DeliveryState.prototype.write;
      spyOn(DeliveryState.prototype, "write").mockImplementation(function (
        this: DeliveryState,
        record: DeliveryRecord,
      ) {
        if (this.path === store().path) throw new Error("ENOSPC: delivery state write failed");
        write.call(this, record);
      });
    }
  };
  test(`freshness isolates ${fault} and still nudges and posts another lane`, async () => {
    const base = depsFor(world, fakeClock(T0 + 30 * 60_000), state.dir, {
      postAfterMin: 1,
      hooks: { threadReply: ["notify", "{thread}", "{text}"] },
    });
    orderLanes(base);
    await base.registry.write(good);
    new Reports(state.dir).report(good.key, "milestone", "verified progress", T0);
    inject();
    const acts = await freshnessTick(base, "/home/test");
    expect(acts.map(({ kind, lane: key }) => [kind, key])).toEqual([
      ["delivery-error", lane.key],
      ["nudged", "z-good"],
      ["posted", "z-good"],
    ]);
    expect(filter("freshness").test(`DELIVERY-ERROR ${lane.key} ${acts[0]?.detail}`)).toBe(true);
    expect(acts[0]?.detail).toContain("do not resend");
    expect(offeredTo()).toEqual([sid(8)]);
    expect(world.calls.filter((argv) => argv[0] === "notify")).toHaveLength(1);
    if (fault === "corrupt") expect(readFileSync(store().path, "utf8")).toBe("not json");
    else expect(store().read()).toBeNull();
  });

  test(`watch isolates ${fault} without closing the affected lane or skipping the next objection`, async () => {
    const claim = { at: new Date(T0).toISOString(), evidence: "done", emitted: true };
    await deps().registry.write({ ...lane, status: "done-claimed", claim });
    await deps().registry.write({ ...good, status: "done-claimed", claim });
    world.prState = "OPEN";
    inject();
    const base = deps();
    orderLanes(base);
    const lines = await watchTick(base);
    expect(lines[0]).toStartWith("LANE_WATCH_ERROR a-fenced");
    expect(lines[0]).toContain("inspect the lane lifecycle");
    expect(lines[0]).toContain("do not resend");
    expect(filter("done flow").test(lines[0] ?? "")).toBe(true);
    expect(lines[1]).toStartWith("LANE_NOT_DONE z-good");
    expect(statusOf((await deps().registry.read(lane.key)) ?? lane)).toBe("not-done");
    expect(world.calls.some((argv) => argv[1] === "close")).toBe(false);
    expect(offeredTo()).toEqual([sid(8)]);
  });
}

test("freshness repeats delivery errors only after a reason change or recovery", async () => {
  const base = deps();
  await tellLane(base, lane, "owner request");
  const request = store().read();
  if (!request) throw new Error("missing original request");
  writeFileSync(store().path, "not json");
  const first = await freshnessTick(base, "/home/test");
  expect(first.map((act) => act.kind)).toEqual(["delivery-error"]);
  expect(await freshnessTick(base, "/home/test")).toEqual([]);
  writeFileSync(store().path, "[");
  const changed = await freshnessTick(base, "/home/test");
  expect(changed.map((act) => act.kind)).toEqual(["delivery-error"]);
  expect(changed[0]?.detail).not.toBe(first[0]?.detail);
  expect(sent(world)).toEqual(["owner request"]);
  const repaired = await withDeliveryLock(base, lane.key, async () => store().write(request));
  expect(repaired.ok).toBe(true);
  expect((await freshnessTick(base, "/home/test")).map((act) => act.kind)).toEqual(["held"]);
  await base.registry.update(lane.key, (current) => current && { ...current, lastNudgeAt: 0 });
  writeFileSync(store().path, "not json");
  expect((await freshnessTick(base, "/home/test")).map((act) => act.kind)).toEqual(["delivery-error"]);
  expect(readFileSync(store().path, "utf8")).toBe("not json");
  expect(sent(world)).toEqual(["owner request"]);
});
