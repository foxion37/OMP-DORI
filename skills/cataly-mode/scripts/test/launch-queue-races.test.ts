import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cancelQueued, enqueueLaunch, queueTick, startQueued } from "../src/launch-queue.ts";
import { LaunchQueue } from "../src/launch-queue-store.ts";
import { reopenLane } from "../src/reopen.ts";
import { statusOf } from "../src/registry.ts";
import { href, sid } from "./fakes.ts";
import { queueFixture, roomy, type QueueFixture } from "./launch-queue-fixture.ts";

let f: QueueFixture;
beforeEach(async () => {
  f = await queueFixture();
});
afterEach(() => f.state.done());

test.each(["Done", "host"])("expiry during the asynchronous %s check cannot authorize startup", async (stage) => {
  await enqueueLaunch(f.deps, f.input, [f.prior.key], 1 / 3600);
  const deps = {
    ...f.deps,
    run: async (...args: Parameters<typeof f.deps.run>) => {
      if (stage === "Done" && args[0][0] === "gh") f.advance(2000);
      return f.deps.run(...args);
    },
  };
  const sample = async () => {
    if (stage === "host") f.advance(2000);
    return roomy();
  };
  const result = await startQueued(deps, f.input.key, sample);
  expect(result.code).toBe(4);
  expect(result.lines[0]).toContain("expired");
  expect(f.creates()).toBe(0);
  expect(new LaunchQueue(f.state.dir).read(f.input.key)?.status).toBe("pending");
  expect(await f.deps.registry.read(f.input.key)).toBeNull();
});

test("reopening a completed predecessor during the live Done check keeps the dependent pending", async () => {
  const session = "01a11440-ee81-7f90-b2ed-dcc7d51a0adf";
  const sessionFile = join(f.state.dir, "prior-session.jsonl");
  const cwd = f.deps.config.defaultCwd;
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: session, cwd })}\n`);
  // A headless lane reopens only from its recorded (now gone) native session.
  const closed = { ...f.prior, session, sessionFile, cwd, sessionRef: href(sid(9)) };
  await f.deps.registry.write(closed);
  await enqueueLaunch(f.deps, f.input, [closed.key]);
  const deps = {
    ...f.deps,
    run: async (...args: Parameters<typeof f.deps.run>) => {
      if (args[0][0] === "gh") {
        // The native agent fails to start, but the new paused generation is already durable.
        f.failStart();
        const reopened = await reopenLane(
          { ...f.deps, config: { ...f.deps.config, agentCommand: ["omp", "{prompt}"], startupWaitSeconds: 1 } },
          closed,
        );
        expect(statusOf(reopened.lane)).toBe("paused");
        expect(reopened.lane.receipt).toBeUndefined();
      }
      return f.deps.run(...args);
    },
  };

  const result = await startQueued(deps, f.input.key, roomy);

  expect(result.code).toBe(4);
  expect(result.lines[0]).toContain(`${closed.key}(predecessor changed during checks)`);
  expect(f.creates()).toBe(1);
  expect(new LaunchQueue(f.state.dir).read(f.input.key)?.status).toBe("pending");
  expect(await deps.registry.read(f.input.key)).toBeNull();
});

test.each(["generation", "successful receipt"])(
  "a changed predecessor %s during host sampling holds",
  async (change) => {
    await enqueueLaunch(f.deps, f.input, [f.prior.key]);
    const sample = async () => {
      await f.deps.registry.update(f.prior.key, (current) =>
        current
          ? change === "generation"
            ? { ...current, lifecycleEpoch: "reclosed-generation" }
            : { ...current, receipt: { checks: [{ signal: current.done, ok: true, detail: "replacement" }] } }
          : null,
      );
      return roomy();
    };

    const result = await startQueued(f.deps, f.input.key, sample);

    expect(result.code).toBe(4);
    expect(result.lines[0]).toContain("predecessor changed during checks");
    expect(f.creates()).toBe(0);
  },
);

test("different queue keys share the last session slot once the winner's reservation exists", async () => {
  const other = { ...f.input, key: "other-lane" };
  await enqueueLaunch(f.deps, f.input, [f.prior.key]);
  await enqueueLaunch(f.deps, other, [f.prior.key]);
  const creating = Promise.withResolvers<void>();
  const allowCreate = Promise.withResolvers<void>();
  const waitingForAdmission = Promise.withResolvers<void>();
  const allowRetry = Promise.withResolvers<void>();
  const config = {
    ...f.deps.config,
    guard: { ...f.deps.config.guard, panesMax: 1, memFreeMinPct: 0, diskFreeMinGb: 0 },
  };
  const count = f.world.onCreate;
  f.world.onCreate = async (spec) => {
    await count?.(spec);
    creating.resolve();
    await allowCreate.promise;
  };
  const first = startQueued({ ...f.deps, config }, f.input.key);
  await Promise.race([creating.promise, first]);
  const second = startQueued(
    {
      ...f.deps,
      config,
      clock: {
        ...f.deps.clock,
        sleep: async (ms) => {
          waitingForAdmission.resolve();
          await allowRetry.promise;
          await f.deps.clock.sleep(ms);
        },
      },
    },
    other.key,
  );
  try {
    await Promise.race([waitingForAdmission.promise, second]);
    allowCreate.resolve();
    await first;
    allowRetry.resolve();

    expect(await second).toEqual({ code: 4, lines: [`QUEUE_HELD ${other.key} panes 1 >= 1`] });
    expect(f.creates()).toBe(1);
    expect(await f.deps.registry.read(other.key)).toBeNull();
  } finally {
    allowCreate.resolve();
    allowRetry.resolve();
    await Promise.allSettled([first, second]);
  }
  expect((await first).code).toBe(0);
});

test("watch skips an active start's pending key without delaying another queue notice", async () => {
  const busy = { ...f.input, key: "aa-busy" };
  const ready = { ...f.input, key: "zz-ready" };
  await enqueueLaunch(f.deps, busy, [f.prior.key]);
  await enqueueLaunch(f.deps, ready, [f.prior.key]);
  f.world.issueState = "OPEN";
  const checking = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const start = startQueued(
    {
      ...f.deps,
      run: async (...args) => {
        if (args[0][0] === "gh") {
          checking.resolve();
          await release.promise;
        }
        return f.deps.run(...args);
      },
    },
    busy.key,
    roomy,
  );
  try {
    await Promise.race([checking.promise, start]);
    const notices = await queueTick({
      ...f.deps,
      clock: {
        ...f.deps.clock,
        sleep: async () => {
          throw new Error("the watch waited on a contended queue key");
        },
      },
    });
    expect(notices).toEqual([
      expect.stringContaining(`LANE_QUEUE_HELD ${busy.key} lock:`),
      `LANE_QUEUE_READY ${ready.key}; live checks run on explicit cataly queue start ${ready.key}`,
    ]);
    expect(new LaunchQueue(f.state.dir).read(busy.key)?.status).toBe("pending");
  } finally {
    release.resolve();
    await start;
  }
  expect((await start).code).toBe(4);
  expect(f.creates()).toBe(0);
});

test("concurrent requeues cannot introduce a dependency cycle", async () => {
  const other = { ...f.input, key: "other-lane" };
  await enqueueLaunch(f.deps, f.input, [f.prior.key]);
  await enqueueLaunch(f.deps, other, [f.prior.key]);
  await cancelQueued(f.deps, f.input.key);
  await cancelQueued(f.deps, other.key);
  const results = await Promise.allSettled([
    enqueueLaunch(f.deps, f.input, [other.key]),
    enqueueLaunch(f.deps, other, [f.input.key]),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  expect(String(results.find((r) => r.status === "rejected")?.reason)).toContain("cycle");
  const entries = new LaunchQueue(f.state.dir).scan().entries;
  expect(entries.filter((entry) => entry.status === "pending")).toHaveLength(1);
  expect(f.creates()).toBe(0);
});
